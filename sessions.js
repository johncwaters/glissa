const fs = require('fs');
const pty = require('node-pty');
const { EventEmitter } = require('events');
const { execSync } = require('child_process');
const { PatternDetector } = require('./patterns');
const { notify } = require('./notify');
const { STATES } = require('./shared/states');

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
    process_exit_ok:  STATES.DONE,
    process_exit_fail:STATES.FAILED,
    user_kill:        STATES.DONE
  },
  [STATES.WAITING]: {
    user_input:       STATES.RUNNING,  // reserved — no UI yet, but valid state machine path
    user_skip:        STATES.RUNNING,  // reserved — no UI yet, but valid state machine path
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
  user_input(session) {
    return session.ptyProcess !== null;
  },
  user_skip(session) {
    return session.ptyProcess !== null;
  },
  user_restart(session) {
    return session.state === STATES.DONE || session.state === STATES.FAILED;
  }
};

// Entry/exit hooks keyed by state
const ENTRY_HOOKS = {
  [STATES.WAITING](session) {
    session.emit('needs-attention', { name: session.name });
    if (!session._destroying) {
      notify('Glissa', `${session.name} needs your input`);
      session._escalationTimer = setInterval(() => {
        if (session.state === STATES.WAITING) {
          notify('Glissa', `${session.name} needs your input`);
        }
      }, session.waitingEscalationMs);
    }
  },
  [STATES.FAILED](session) {
    session.emit('session-failed', { name: session.name });
    if (!session._destroying) {
      notify('Glissa', `${session.name} failed`);
    }
  },
  [STATES.DONE](session) {
    session.emit('session-done', { name: session.name });
  }
};

const EXIT_HOOKS = {
  [STATES.WAITING](session) {
    session.emit('attention-cleared', { name: session.name });
    if (session._escalationTimer !== null) {
      clearInterval(session._escalationTimer);
      session._escalationTimer = null;
    }
    session._clearAutoRecoverTimer();
    session._autoRecoverDataCount = 0;
    if (session.patternDetector) {
      session.patternDetector.reset();
    }
  }
};

class Session extends EventEmitter {
  constructor({ name, path, startingWatchdogSeconds = 10, attentionTimeoutSeconds = 60, waitingEscalationSeconds = 300, autoRecoverSeconds = 3 }) {
    super();
    this.name = name;
    this.path = path;
    this.ptyProcess = null;
    this.state = STATES.INITIALIZING;
    this.auditLog = [];
    this.startingWatchdogMs = startingWatchdogSeconds * 1000;
    this.attentionTimeoutMs = attentionTimeoutSeconds * 1000;
    this.waitingEscalationMs = waitingEscalationSeconds * 1000;
    this._autoRecoverMs = autoRecoverSeconds * 1000;
    this._watchdogTimer = null;
    this._idleTimer = null;
    this._escalationTimer = null;
    this._autoRecoverTimer = null;
    this._autoRecoverDataCount = 0;
    this._receivedFirstOutput = false;
    this._outputBuffer = [];       // ring buffer of recent PTY chunks
    this._outputBufferSize = 0;
    this._outputBufferMax = 100000; // ~100KB replay cap

    this._destroying = false;
    this.patternDetector = new PatternDetector();
    this.patternDetector.on('prompt-detected', (detection) => {
      console.log(`[session:${this.name}] prompt-detected: layer=${detection.layer} pattern=${detection.pattern} line=${JSON.stringify(detection.line)}`);
      this.transition('prompt_detected', detection);
    });
  }

  get pid() {
    return this.ptyProcess ? this.ptyProcess.pid : null;
  }

  toSnapshot() {
    return {
      name: this.name,
      state: this.state,
      auditLog: this.auditLog.slice(-100)
    };
  }

  transition(event, detail) {
    const stateTransitions = TRANSITIONS[this.state];
    if (!stateTransitions || !(event in stateTransitions)) {
      console.warn(
        `[session:${this.name}] Invalid transition: ${this.state} + ${event} (ignored)`
      );
      return false;
    }

    // Run guard if one exists for this event
    const guard = GUARDS[event];
    if (guard && !guard(this)) {
      console.warn(
        `[session:${this.name}] Guard rejected: ${this.state} + ${event}`
      );
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

    // Record in audit log
    const entry = {
      from,
      to,
      event,
      detail: detail || null,
      timestamp: Date.now()
    };
    this.auditLog.push(entry);

    // Emit state-change event
    this.emit('state-change', { from, to, event, detail: detail || null });

    return true;
  }

  start() {
    this._receivedFirstOutput = false;
    this._outputBuffer = [];
    this._outputBufferSize = 0;
    this._clearWatchdog();
    this._clearIdleTimer();
    this.patternDetector.reset();

    const env = Object.assign({}, process.env);
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.GLISSA_PORT;
    delete env.GLISSA_CONFIG;

    // On Windows, node-pty can't resolve .cmd shims directly.
    // Spawn via cmd.exe /c which handles PATH + .cmd resolution.
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : 'claude';
    const args = isWindows ? ['/c', 'claude'] : [];

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

    // Start watchdog timer for STARTING state
    this._watchdogTimer = setTimeout(() => {
      this._watchdogTimer = null;
      if (this.state === STATES.STARTING) {
        this.transition('watchdog_timeout');
      }
    }, this.startingWatchdogMs);

    this.ptyProcess.onData((data) => {
      // State-driven logic on each data event
      if (this.state === STATES.STARTING && !this._receivedFirstOutput) {
        this._receivedFirstOutput = true;
        this._clearWatchdog();
        this.transition('first_output');
      }

      if (this.state === STATES.RUNNING) {
        this.patternDetector.feed(data);
        this._resetIdleTimer();
      } else if (this.state === STATES.IDLE) {
        this.transition('new_output');
        // After transitioning to RUNNING, feed and start idle timer
        if (this.state === STATES.RUNNING) {
          this.patternDetector.feed(data);
          this._resetIdleTimer();
        }
      } else if (this.state === STATES.WAITING) {
        // Auto-recovery: continued PTY output suggests false positive.
        // Require >= 2 data events before auto-recovering.
        this._autoRecoverDataCount++;
        this._resetAutoRecoverTimer();
      }

      // Buffer for late-joining data WS clients
      this._outputBuffer.push(data);
      this._outputBufferSize += data.length;
      while (this._outputBufferSize > this._outputBufferMax && this._outputBuffer.length > 1) {
        this._outputBufferSize -= this._outputBuffer.shift().length;
      }

      // Always emit raw data for WebSocket broadcasting
      this.emit('data', data);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this._clearWatchdog();
      this._clearIdleTimer();
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

      this.emit('exit', { exitCode, signal });
    });
  }

  getReplayBuffer() {
    return this._outputBuffer.join('');
  }

  write(text) {
    if (this.ptyProcess) {
      this.ptyProcess.write(text);
    }
  }

  resize(cols, rows) {
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

    const checkAlive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    // Non-blocking graceful wait: check every 200ms up to 3s, then force kill
    let elapsed = 0;
    const interval = 200;
    const maxWait = 3000;

    const poll = () => {
      if (!checkAlive()) return;
      elapsed += interval;
      if (elapsed >= maxWait) {
        // Force kill (Windows: taskkill with /T to kill child tree)
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
        } catch (err) {
          this.emit('error', err);
        }
        return;
      }
      setTimeout(poll, interval);
    };

    setTimeout(poll, interval);
  }

  dismiss() {
    if (this.state !== STATES.WAITING) return false;
    return this.transition('user_dismiss');
  }

  killSession() {
    const killable = [STATES.RUNNING, STATES.WAITING, STATES.IDLE];
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
    const killable = [STATES.RUNNING, STATES.WAITING, STATES.IDLE];
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
  }

  destroy() {
    this._destroying = true;
    if (this._watchdogTimer !== null) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    if (this._idleTimer !== null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    if (this._escalationTimer !== null) {
      clearInterval(this._escalationTimer);
      this._escalationTimer = null;
    }
    this._clearAutoRecoverTimer();
    this.kill();
    this.removeAllListeners();
    if (this.patternDetector) {
      this.patternDetector.reset();
      this.patternDetector.removeAllListeners();
    }
  }

  // -- Private timer helpers --

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
        this.transition('silence_timeout');
      }
    }, this.attentionTimeoutMs);
  }

  _resetAutoRecoverTimer() {
    this._clearAutoRecoverTimer();
    this._autoRecoverTimer = setTimeout(() => {
      this._autoRecoverTimer = null;
      if (this.state === STATES.WAITING && this._autoRecoverDataCount >= 2) {
        console.log(`[session:${this.name}] Auto-recovering from WAITING (continued output detected, ${this._autoRecoverDataCount} chunks)`);
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

module.exports = { Session };
