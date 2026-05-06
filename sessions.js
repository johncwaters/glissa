const fs = require('node:fs');
const pty = require('node-pty');
const { EventEmitter } = require('node:events');
const { execSync } = require('node:child_process');
const { PatternDetector } = require('./patterns');
const { STATES } = require('./shared/states');


const KILL_POLL_INTERVAL_MS = 200;
const KILL_MAX_WAIT_MS = 3000;

// ---------------------------------------------------------------------------
// Layer 4 filters — pending content that looks like UI chrome, not a prompt.
// These fire only from the idle-timer safety net (idle_pending_content).
// ---------------------------------------------------------------------------

const LAYER4_CHROME_STRINGS = [
  '⏵⏵',              // Claude Code "accept edits" hint
  'accept edits',
  'shift+tab to cycle',
  'Pasting text',
  'Hyperspacing',
  'Galloping',        // Claude Code animated spinner phase
  'Brewed for',       // Claude Code completion summary
  '/effort',          // effort indicator (e.g. "◐ medium · /effort")
  '[OMC#',            // OMC HUD status line
  'Auto-update failed',   // Claude Code auto-update status bar message
  'Auto-updating',        // Claude Code auto-update in progress
  'claude doctor',        // Auto-update failure hint text
  'switched from npm to native', // Claude Code installer migration notice
  'claude install',       // Installer migration hint
  'Bypass Permissions',   // Claude Code bypass-permissions mode warning
  '[Pasted text',         // Pasted text indicator (e.g. "[Pasted text #4 +165 lines]")
  'l:cancel',             // OMC cancel hint fragment in garbled redraws
  '-+-',                  // Companion cactus ASCII art (trunk pattern in garbled redraws)
];

const LAYER4_SPINNER = /[◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻✢✶✽]/;

// OMC HUD fragments that survive ANSI stripping in garbled redraws
const LAYER4_HUD_PATTERNS = [
  /session:\d+m/,     // e.g. "session:0m", "session:5m"
  /ctx:\d+%/,         // e.g. "ctx:0%", "ctx:42%"
  /wk:\d+%/,          // e.g. "wk:33%"
  /[TS]:\d+/,         // HUD task/session counters: "T:42", "S:2"
  /\d+m\s+\d+m/,      // Repeated time patterns in garbled HUD: "4m  4m  4m"
];

// Box-drawing characters used in Claude Code's separator/border lines
const BOX_DRAWING = /[─│┌┐└┘├┤┬┴┼╭╮╯╰━]/g;

function isLayer4Chrome(line) {
  // Known chrome substrings
  if (LAYER4_CHROME_STRINGS.some(s => line.includes(s))) return true;

  // Spinner characters anywhere in the line
  if (LAYER4_SPINNER.test(line)) return true;

  // OMC HUD fragments in garbled redraws
  if (LAYER4_HUD_PATTERNS.some(re => re.test(line))) return true;

  const nonWs = line.replace(/\s/g, '');

  // Very short fragments — garbled redraws, not real prompts.
  // Real prompts caught by Layer 4 need at least a few characters
  // (e.g. "Enter password:"). Single digits/letters are noise.
  if (nonWs.length < 4) return true;

  // Line is mostly box-drawing characters (>50% of non-whitespace)
  if (nonWs.length > 0) {
    const boxCount = (nonWs.match(BOX_DRAWING) || []).length;
    if (boxCount / nonWs.length > 0.5) return true;
  }

  // Garbled screen redraw: very little non-whitespace content spread across a long line
  // e.g. "7                                      5"
  if (line.length > 20 && nonWs.length < 10) return true;

  // Wide-spaced user typing: PTY echoes keystrokes as individual characters
  // separated by spaces. Pattern: "T h o s e   t h r e e   t h i n g s ."
  const words = line.trim().split(/\s+/);
  if (words.length >= 4) {
    const singleCharCount = words.filter(w => w.length === 1).length;
    if (singleCharCount / words.length > 0.6) return true;
  }

  // URLs — informational output, not prompts
  if (/https?:\/\//.test(line)) return true;

  // Task checkbox rendering (Claude Code task display) — multiple checkboxes
  // in one line indicate a task list, not a prompt waiting for input
  if ((line.match(/[✔◼◻✓✗☐☑]/g) || []).length >= 2) return true;

  return false;
}

const TRANSITIONS = Object.freeze({
  [STATES.INITIALIZING]: {
    spawn_success:    STATES.STARTING,
    spawn_fail:       STATES.FAILED
  },
  [STATES.STARTING]: {
    first_output:     STATES.RUNNING,
    watchdog_timeout: STATES.FAILED,
    process_exit:     STATES.FAILED
  },
  [STATES.RUNNING]: {
    prompt_detected:  STATES.WAITING,
    silence_timeout:  STATES.IDLE,
    task_complete:    STATES.COMPLETE,
    process_exit_ok:  STATES.DONE,
    process_exit_fail:STATES.FAILED,
    user_kill:        STATES.DONE
  },
  [STATES.WAITING]: {
    user_input:       STATES.RUNNING,
    user_dismiss:     STATES.RUNNING,
    auto_recover:     STATES.RUNNING,
    user_kill:        STATES.DONE,
    process_exit_ok:  STATES.DONE,
    process_exit_fail:STATES.FAILED
  },
  [STATES.IDLE]: {
    new_output:       STATES.RUNNING,
    prompt_detected:  STATES.WAITING,
    process_exit_ok:  STATES.DONE,
    process_exit_fail:STATES.FAILED,
    user_kill:        STATES.DONE
  },
  [STATES.COMPLETE]: {
    new_output:       STATES.RUNNING,
    user_dismiss:     STATES.IDLE,
    prompt_detected:  STATES.WAITING,
    process_exit_ok:  STATES.DONE,
    process_exit_fail:STATES.FAILED,
    user_kill:        STATES.DONE
  },
  [STATES.DONE]: {
    user_restart:     STATES.INITIALIZING
  },
  [STATES.FAILED]: {
    user_restart:      STATES.INITIALIZING,
    process_exit_fail: STATES.FAILED
  }
});

// Guards: return true if transition is allowed, false otherwise
const GUARDS = {
  spawn_success(session) {
    return fs.existsSync(session.path);
  },
  user_restart(session) {
    return session.state === STATES.DONE || session.state === STATES.FAILED;
  },
  prompt_detected(session) {
    if (session._lastUserInputAt === 0) return true;
    const elapsed = Date.now() - session._lastUserInputAt;
    if (elapsed < session._inputGraceMs) {
      // Re-arm Layer 3 silence timer so it re-fires after silence timeout.
      // Do NOT call reset() — that clears _pendingLine and kills re-detection.
      session.patternDetector.rearmSilenceTimer();
      return false;
    }
    return true;
  }
};

// Data handlers keyed by state — dispatched on each PTY data event
const DATA_HANDLERS = {
  [STATES.RUNNING](session, data) {
    if (!session._startupGraceActive) {
      session._debounceFeed(data);
    }
    session._resetIdleTimer();
  },
  [STATES.IDLE](session, data) {
    session.patternDetector.reset();
    session.transition('new_output');
    // After transitioning to RUNNING, apply a brief grace period so
    // resize-triggered redraws (e.g. browser connect) don't immediately
    // match Claude's idle prompt as "needs input".
    if (session.state === STATES.RUNNING) {
      session._startStartupGrace(3000);
      session._resetIdleTimer();
    }
  },
  [STATES.COMPLETE](session, data) {
    session.patternDetector.reset();
    session.transition('new_output');
    if (session.state === STATES.RUNNING) {
      session._startStartupGrace(3000);
      session._resetIdleTimer();
    }
  },
  [STATES.WAITING](session) {
    // Auto-recovery: continued PTY output suggests false positive.
    // Require >= 2 data events before auto-recovering.
    session._autoRecoverDataCount++;
    session._resetAutoRecoverTimer();
  },
};

// Entry/exit hooks keyed by state
const ENTRY_HOOKS = {
  [STATES.RUNNING](session) {
    if (!session._runningStartedAt) {
      session._runningStartedAt = Date.now();
    }
    // Apply any resize that was deferred while the session was quiescent.
    // The resulting redraw data is harmless in RUNNING state (handled by
    // the RUNNING data handler which just resets the idle timer).
    session._applyPendingResize();
  },
  [STATES.COMPLETE](session) {
    session._runningStartedAt = null;
  },
  [STATES.WAITING](session) {
    session.emit('needs-attention', { name: session.name });
  },
  [STATES.FAILED](session) {
    session.emit('session-failed', { name: session.name });
  },
  [STATES.DONE](session) {
    session.emit('session-done', { name: session.name });
  }
};

const EXIT_HOOKS = {
  [STATES.WAITING](session) {
    session._lastUserInputAt = 0;
    session.emit('attention-cleared', { name: session.name });
    session._clearAutoRecoverTimer();
    session._autoRecoverDataCount = 0;
    if (session.patternDetector) {
      session.patternDetector.reset();
    }
    // Grace period so echoed keystrokes and the still-visible prompt
    // don't immediately re-trigger prompt detection after user input.
    session._startStartupGrace(3000);
  }
};

class Session extends EventEmitter {
  constructor({ id, name, path, dangerouslySkipPermissions = false, startingWatchdogSeconds = 10, attentionTimeoutSeconds = 60, waitingEscalationSeconds = 300, autoRecoverSeconds = 3, inputGraceSeconds = 5, promptDetectionMs = 1500, replayBufferKB = 512, noFlicker = true, feedDebounceMs = 50 }) {
    super();
    this.id = id;
    this.name = name;
    this.path = path;
    this.dangerouslySkipPermissions = dangerouslySkipPermissions;
    this.ptyProcess = null;
    this.state = STATES.INITIALIZING;
    this.auditLog = [];
    this.startingWatchdogMs = startingWatchdogSeconds * 1000;
    this.attentionTimeoutMs = attentionTimeoutSeconds * 1000;
    this.waitingEscalationMs = waitingEscalationSeconds * 1000;
    this._autoRecoverMs = autoRecoverSeconds * 1000;
    this._watchdogTimer = null;
    this._idleTimer = null;
    this._autoRecoverTimer = null;
    this._autoRecoverDataCount = 0;
    this._runningStartedAt = null;
    this._completeThresholdMs = 30000;
    this._receivedFirstOutput = false;
    this._startupGraceActive = false;
    this._startupGraceTimer = null;
    this._outputBuffer = [];       // ring buffer of recent PTY chunks
    this._outputBufferSize = 0;
    this._outputBufferMax = replayBufferKB * 1024;
    this._lastUserInputAt = 0;
    this._inputGraceMs = inputGraceSeconds * 1000;
    this._killPollTimer = null;
    this._feedBuffer = '';
    this._feedDebounceTimer = null;
    this._feedDebounceMs = feedDebounceMs;
    this._noFlicker = noFlicker;
    this._pendingResize = null;
    this._sleeping = false;

    this._promptDetectionMs = promptDetectionMs;
    this._confirmationMs = 300; // PatternDetector default, recorded for capture header
    this._recorder = null; // Set via setRecorder() after construction

    this.patternDetector = new PatternDetector(promptDetectionMs);
    this.patternDetector.on('prompt-detected', (detection) => {
      // Record detection BEFORE session guards (transition may suppress it)
      if (this._recorder) {
        this._recorder.writeDetection(detection.layer, detection.pattern, detection.line, detection.pending);
      }
      this.transition('prompt_detected', detection);
    });
  }

  setRecorder(recorder) {
    this._recorder = recorder;
  }

  recordUserInput() {
    this._lastUserInputAt = Date.now();
  }

  get pid() {
    return this.ptyProcess ? this.ptyProcess.pid : null;
  }

  get sleeping() {
    return this._sleeping;
  }

  toSnapshot() {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      sleeping: this._sleeping,
      dangerouslySkipPermissions: this.dangerouslySkipPermissions,
      auditLog: this.auditLog.slice(-100)
    };
  }

  transition(event, detail) {
    const stateTransitions = TRANSITIONS[this.state];
    if (!stateTransitions || !(event in stateTransitions)) {
      return false;
    }

    // Run guard if one exists for this event
    const guard = GUARDS[event];
    if (guard && !guard(this)) {
      return false;
    }

    const from = this.state;
    const to = stateTransitions[event];

    // Self-transition: record but skip hooks
    if (from === to) {
      this.auditLog.push({
        from, to, event,
        detail: detail || null,
        timestamp: Date.now(),
        selfTransition: true
      });
      if (this._recorder) {
        this._recorder.writeState(from, to, event, detail);
      }
      return true;
    }

    // Exit hook for old state
    const exitHook = EXIT_HOOKS[from];
    if (exitHook) {
      exitHook(this);
    }

    // Update state
    this.state = to;

    // Entry hook for new state
    const entryHook = ENTRY_HOOKS[to];
    if (entryHook) {
      entryHook(this);
    }

    // Record in audit log (capped to prevent unbounded growth)
    const entry = {
      from,
      to,
      event,
      detail: detail || null,
      timestamp: Date.now()
    };
    this.auditLog.push(entry);
    if (this.auditLog.length > 200) {
      this.auditLog.splice(0, this.auditLog.length - 200);
    }

    // Record state transition
    if (this._recorder) {
      this._recorder.writeState(from, to, event, detail);
    }

    // Emit state-change event
    this.emit('state-change', { from, to, event, detail: detail || null });

    return true;
  }

  start() {
    this._receivedFirstOutput = false;
    this._sleeping = false;
    this._outputBuffer = [];
    this._outputBufferSize = 0;
    this._clearWatchdog();
    this._clearIdleTimer();
    this._clearStartupGrace();
    this._clearFeedDebounce();
    this._pendingResize = null;
    this.patternDetector.reset();

    const env = this._buildSpawnEnv();

    // On Windows, node-pty can't resolve .cmd shims directly.
    // Spawn via cmd.exe /c which handles PATH + .cmd resolution.
    const isWindows = process.platform === 'win32';
    const claudeArgs = this.dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : [];
    const shell = isWindows ? 'cmd.exe' : 'claude';
    const args = isWindows ? ['/c', 'claude', ...claudeArgs] : claudeArgs;

    try {
      this.ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: this.path,
        env
      });
    } catch (err) {
      this.transition('spawn_fail', { error: err.message });
      this.emit('error', err);
      return;
    }

    this.transition('spawn_success');

    // Write capture header with all timing params
    if (this._recorder) {
      this._recorder.writeHeader({
        promptDetectionMs: this._promptDetectionMs,
        confirmationMs: this._confirmationMs,
        attentionTimeoutMs: this.attentionTimeoutMs,
        autoRecoverMs: this._autoRecoverMs,
        inputGraceMs: this._inputGraceMs,
        completeThresholdMs: this._completeThresholdMs,
        startingWatchdogMs: this.startingWatchdogMs,
        cols: 80,
        rows: 24,
      });
    }

    // Start watchdog timer for STARTING state
    this._watchdogTimer = setTimeout(() => {
      this._watchdogTimer = null;
      if (this.state === STATES.STARTING) {
        this.transition('watchdog_timeout');
      }
    }, this.startingWatchdogMs);

    this.ptyProcess.onData((data) => this._handlePtyData(data));
    this.ptyProcess.onExit(({ exitCode, signal }) => this._handlePtyExit(exitCode, signal));
  }

  _buildSpawnEnv() {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.GLISSA_PORT;
    delete env.GLISSA_CONFIG;
    // No-flicker mode prevents Claude Code from resetting scrollback position
    // on every turn. Increases PTY output volume — mitigated by feed debounce.
    if (this._noFlicker) {
      env.CLAUDE_CODE_NO_FLICKER = '1';
    }
    return env;
  }

  _handlePtyData(data) {
    if (this._recorder) {
      this._recorder.writeData(data);
    }

    // First-output detection (pre-dispatch, only fires once in STARTING)
    if (this.state === STATES.STARTING && !this._receivedFirstOutput) {
      this._receivedFirstOutput = true;
      this._clearWatchdog();
      this._startStartupGrace();
      this.transition('first_output');
    }

    // State-driven data handling via lookup table.
    // When sleeping, skip handlers to freeze state machine. Ring buffer + emit still run.
    if (!this._sleeping) {
      const handler = DATA_HANDLERS[this.state];
      if (handler) {
        try {
          handler(this, data);
        } catch (err) {
          console.error(`[session:${this.name}] data handler error: ${err.message}`);
          if (this.listenerCount('error') > 0) {
            this.emit('error', err);
          }
        }
      }
    }

    // Buffer for late-joining data WS clients
    this._outputBuffer.push(data);
    this._outputBufferSize += data.length;
    while (this._outputBufferSize > this._outputBufferMax && this._outputBuffer.length > 1) {
      this._outputBufferSize -= this._outputBuffer.shift().length;
    }

    // Always emit raw data for WebSocket broadcasting
    this.emit('data', data);
  }

  _handlePtyExit(exitCode, signal) {
    this._clearWatchdog();
    this._clearIdleTimer();
    this._clearStartupGrace();
    this._clearFeedDebounce();
    this.patternDetector.reset();
    this.ptyProcess = null;

    if (exitCode === 0) {
      this.transition('process_exit_ok', { exitCode, signal });
    } else if (this.state === STATES.STARTING) {
      // STARTING only has process_exit, not process_exit_ok/fail
      this.transition('process_exit', { exitCode, signal });
    } else {
      this.transition('process_exit_fail', { exitCode, signal });
    }

    if (this._recorder) {
      this._recorder.writeFooter('pty_exit', exitCode);
      this._recorder.close();
    }

    this.emit('exit', { exitCode, signal });
  }

  getReplayBuffer() {
    return this._outputBuffer.join('');
  }

  write(text) {
    if (this._recorder) {
      this._recorder.writeInput(text);
    }
    if (this.ptyProcess) {
      this.ptyProcess.write(text);
    }
  }

  resize(cols, rows) {
    if (this._recorder) {
      this._recorder.writeResize(cols, rows);
    }
    // Defer PTY resize for quiescent states. Resizing a PTY causes the
    // application inside (Claude CLI) to redraw, producing output that
    // DATA_HANDLERS would interpret as genuine new work — transitioning
    // IDLE/COMPLETE → RUNNING, or inflating WAITING's auto-recover
    // counter into a false recovery. Store the resize and apply it when
    // the session next enters RUNNING (via genuine output or user input).
    if (this.state === STATES.IDLE || this.state === STATES.COMPLETE || this.state === STATES.WAITING) {
      this._pendingResize = { cols, rows };
      return;
    }
    this._pendingResize = null;
    if (this.ptyProcess) {
      this.ptyProcess.resize(cols, rows);
    }
  }

  kill() {
    if (!this.ptyProcess) return;

    const pid = this.ptyProcess.pid;

    try {
      this.ptyProcess.kill();
    } catch (err) {
      this.emit('error', err);
    }

    this._forceKillAfterTimeout(pid);
  }

  _forceKillAfterTimeout(pid) {
    const checkAlive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    let elapsed = 0;
    const poll = () => {
      this._killPollTimer = null;
      if (!checkAlive()) return;
      elapsed += KILL_POLL_INTERVAL_MS;
      if (elapsed >= KILL_MAX_WAIT_MS) {
        try {
          if (process.platform === 'win32') {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
          } else {
            process.kill(pid, 'SIGKILL');
          }
        } catch (err) {
          if (this.listenerCount('error') > 0) {
            this.emit('error', err);
          }
        }
        return;
      }
      this._killPollTimer = setTimeout(poll, KILL_POLL_INTERVAL_MS);
    };

    this._killPollTimer = setTimeout(poll, KILL_POLL_INTERVAL_MS);
  }

  dismiss() {
    if (this.state === STATES.WAITING) {
      this.recordUserInput();
      return this.transition('user_dismiss');
    }
    if (this.state === STATES.COMPLETE) return this.transition('user_dismiss');
    return false;
  }

  sleep() {
    if (this._sleeping) return;
    // Only allow sleeping in quiescent states — refuse if the session has
    // moved back to an active state (guards against client/server race).
    const sleepable = [STATES.IDLE, STATES.COMPLETE, STATES.DONE, STATES.FAILED];
    if (!sleepable.includes(this.state)) return;
    this._sleeping = true;
    this._clearFeedDebounce();
    this._clearIdleTimer();
    this._clearStartupGrace();
    this.patternDetector.reset();
    this.emit('sleep');
  }

  wake() {
    if (!this._sleeping) return;
    this._sleeping = false;
    if (this.state === STATES.RUNNING) {
      this._resetIdleTimer();
    }
    this.emit('wake');
  }

  killSession() {
    const killable = [STATES.RUNNING, STATES.WAITING, STATES.IDLE, STATES.COMPLETE];
    if (!killable.includes(this.state)) return false;
    this.kill();
    return this.transition('user_kill');
  }

  restart() {
    if (this.state !== STATES.DONE && this.state !== STATES.FAILED) return false;
    this.transition('user_restart');
    this.start();
    return true;
  }

  forceRestart() {
    const killable = [STATES.RUNNING, STATES.WAITING, STATES.IDLE, STATES.COMPLETE];
    if (killable.includes(this.state)) {
      // Kill first, then restart once process exits
      this.once('exit', () => {
        if (this.state === STATES.DONE || this.state === STATES.FAILED) {
          this.transition('user_restart');
          this.start();
        }
      });
      this.kill();
      this.transition('user_kill');
    } else if (this.state === STATES.DONE || this.state === STATES.FAILED) {
      this.restart();
    }
  }

  updateSettings(cfg) {
    if (cfg.startingWatchdogSeconds != null) this.startingWatchdogMs = cfg.startingWatchdogSeconds * 1000;
    if (cfg.attentionTimeoutSeconds != null) this.attentionTimeoutMs = cfg.attentionTimeoutSeconds * 1000;
    if (cfg.waitingEscalationSeconds != null) this.waitingEscalationMs = cfg.waitingEscalationSeconds * 1000;
    if (cfg.autoRecoverSeconds != null) this._autoRecoverMs = cfg.autoRecoverSeconds * 1000;
    if (cfg.inputGraceSeconds != null) this._inputGraceMs = cfg.inputGraceSeconds * 1000;
    if (cfg.promptDetectionMs != null) this.patternDetector.updateSilenceTimeout(cfg.promptDetectionMs);
    if (cfg.replayBufferKB != null) this._outputBufferMax = cfg.replayBufferKB * 1024;
    if (cfg.feedDebounceMs != null) this._feedDebounceMs = cfg.feedDebounceMs;
    if (cfg.noFlicker != null) this._noFlicker = !!cfg.noFlicker;
  }

  destroy() {
    if (this._watchdogTimer !== null) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    if (this._idleTimer !== null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    this._clearAutoRecoverTimer();
    this._clearStartupGrace();
    this._clearFeedDebounce();
    this._pendingResize = null;
    if (this._killPollTimer !== null) {
      clearTimeout(this._killPollTimer);
      this._killPollTimer = null;
    }
    this.kill();
    if (this._recorder) {
      this._recorder.close(); // Idempotent — safe if already closed by _handlePtyExit
    }
    this.removeAllListeners();
    if (this.patternDetector) {
      this.patternDetector.reset();
      this.patternDetector.removeAllListeners();
    }
  }

  _applyPendingResize() {
    if (this._pendingResize && this.ptyProcess) {
      this.ptyProcess.resize(this._pendingResize.cols, this._pendingResize.rows);
      this._pendingResize = null;
    }
  }

  // -- Feed debounce (batches PTY data before pattern detection) --

  _debounceFeed(data) {
    this._feedBuffer += data;
    // Cap buffer size to prevent unbounded growth during sustained output
    if (this._feedBuffer.length > 65536) {
      if (this._feedDebounceTimer !== null) clearTimeout(this._feedDebounceTimer);
      this._feedDebounceTimer = null;
      this._flushFeedBuffer();
      return;
    }
    if (this._feedDebounceTimer !== null) {
      clearTimeout(this._feedDebounceTimer);
    }
    this._feedDebounceTimer = setTimeout(() => {
      this._feedDebounceTimer = null;
      this._flushFeedBuffer();
    }, this._feedDebounceMs);
  }

  _flushFeedBuffer() {
    if (this._feedBuffer.length === 0) return;
    if (this._startupGraceActive) {
      this._feedBuffer = '';
      return;
    }
    const buffered = this._feedBuffer;
    this._feedBuffer = '';
    this.patternDetector.feed(buffered);
  }

  _clearFeedDebounce() {
    this._feedBuffer = '';
    if (this._feedDebounceTimer !== null) {
      clearTimeout(this._feedDebounceTimer);
      this._feedDebounceTimer = null;
    }
  }

  // -- Private timer helpers --

  _startStartupGrace(durationMs = 5000) {
    this._clearStartupGrace();
    this._clearFeedDebounce();
    this._startupGraceActive = true;
    this._startupGraceTimer = setTimeout(() => {
      this._startupGraceTimer = null;
      this._startupGraceActive = false;
    }, durationMs);
  }

  _clearStartupGrace() {
    this._startupGraceActive = false;
    if (this._startupGraceTimer !== null) {
      clearTimeout(this._startupGraceTimer);
      this._startupGraceTimer = null;
    }
  }

  _clearWatchdog() {
    if (this._watchdogTimer !== null) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  _clearIdleTimer() {
    if (this._idleTimer !== null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  _resetIdleTimer() {
    this._clearIdleTimer();
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this.state === STATES.RUNNING) {
        const runDuration = this._runningStartedAt ? Date.now() - this._runningStartedAt : 0;

        // Safety net: if the pattern detector has a non-empty pending line
        // (last output didn't end with newline) after prolonged silence,
        // this strongly signals a prompt waiting for input — not completion.
        // Layers 1-3 may have missed it (e.g. short '>' prompt filtered by
        // Layer 3's length check). Treat as Layer 4 prompt detection.
        // Only applies to short runs — long runs with pending content are
        // Claude's idle prompt after task completion, not a mid-task input request.
        if (runDuration < this._completeThresholdMs && this.patternDetector.hasPendingContent()) {
          const pendingLine = this.patternDetector.getPendingLine();
          if (isLayer4Chrome(pendingLine)) {
            // Layer 4 suppressed — UI chrome, not a real prompt
          } else {
            this._runningStartedAt = null;
            this.transition('prompt_detected', {
              layer: 4,
              pattern: 'idle_pending_content',
              line: pendingLine
            });
            return;
          }
        }

        this._runningStartedAt = null;
        if (runDuration >= this._completeThresholdMs) {
          // Long run — but check if pending content matches a known prompt pattern
          // (layers 1/2). A prompt that arrived late in a long run should still
          // trigger WAITING, not COMPLETE.
          if (this.patternDetector.hasPendingContent()) {
            const pendingLine = this.patternDetector.getPendingLine();
            const match = this.patternDetector.checkLine(pendingLine);
            if (match) {
              this.transition('prompt_detected', {
                layer: match.layer,
                pattern: match.pattern,
                line: pendingLine
              });
              return;
            }
          }
          this.transition('task_complete');
        } else {
          this.transition('silence_timeout');
        }
      }
    }, this.attentionTimeoutMs);
  }

  _resetAutoRecoverTimer() {
    this._clearAutoRecoverTimer();
    this._autoRecoverTimer = setTimeout(() => {
      this._autoRecoverTimer = null;
      if (this.state === STATES.WAITING && this._autoRecoverDataCount >= 2) {
        this.transition('auto_recover');
        if (this.state === STATES.RUNNING) {
          this._resetIdleTimer();
        }
      }
    }, this._autoRecoverMs);
  }

  _clearAutoRecoverTimer() {
    if (this._autoRecoverTimer !== null) {
      clearTimeout(this._autoRecoverTimer);
      this._autoRecoverTimer = null;
    }
  }
}

module.exports = { Session, isLayer4Chrome };
