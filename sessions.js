const fs = require("node:fs");
const pty = require("node-pty");
const { EventEmitter } = require("node:events");
const { execSync } = require("node:child_process");
const { STATES } = require("./shared/states");
const { createOscTitleSource } = require("./detection/osc-title-source");
const { createStatusSource } = require("./detection/status-source");
const { writeSessionSettings } = require("./detection/settings-injector");

const KILL_POLL_INTERVAL_MS = 200;
const KILL_MAX_WAIT_MS = 3000;
const SLEEP_KILL_TIMEOUT_MS = 15 * 60 * 1000;

// Classify a resolved `claude` path by extension. Only real PE images (.exe/.com)
// can be handed straight to node-pty (CreateProcess); .cmd/.bat/.ps1 are shims that
// must go through a shell, so they (and anything unrecognized) fall back to cmd.exe.
function classifyClaudeKind(resolvedPath) {
  if (!resolvedPath) return "unresolved";
  const ext = (resolvedPath.match(/\.[^.\\/]+$/) || [""])[0].toLowerCase();
  return ext === ".exe" || ext === ".com" ? "exe" : "shim";
}

// Resolve `claude` once at module load. On Windows we prefer spawning the resolved
// .exe directly (node-pty -> CreateProcess), falling back to `cmd.exe /c claude` only
// for .cmd/.bat/.ps1 shim installs or when resolution fails. Resolving here also
// surfaces a Bun shim shadowing claude.exe in the boot log instead of at runtime.
function resolveClaudeCommand() {
  let matches = [];
  try {
    const cmd = process.platform === "win32" ? "where claude" : "which -a claude";
    const out = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    matches = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    // fall through to "could not resolve" warning below
  }
  if (matches.length === 0) {
    console.warn(`[glissa] could not resolve 'claude' on PATH`);
    return { path: null, kind: "unresolved" };
  }
  const resolvedPath = matches[0];
  console.log(`[glissa] resolved 'claude' (first match wins): ${resolvedPath}`);
  if (matches.length > 1) {
    console.warn(
      `[glissa] multiple 'claude' on PATH (Bun shim risk):\n  ${matches.join("\n  ")}`,
    );
  }
  const kind = classifyClaudeKind(resolvedPath);
  if (process.platform === "win32") {
    console.log(
      `[glissa] claude spawn strategy: ${kind === "exe" ? "direct exe" : "cmd.exe shim fallback"}`,
    );
  }
  return { path: resolvedPath, kind };
}

// Cached resolution used by every Session unless overridden via the constructor.
const CLAUDE_CMD = resolveClaudeCommand();

// Pure spawn-command builder (the unit-test seam). Decides whether to spawn the
// resolved claude .exe directly or route through `cmd.exe /c claude`. Keeps the
// shell path byte-identical to the historical behavior for shim/unresolved installs.
function buildSpawnCommand({ platform, resolved, settingsArgs = [], claudeArgs = [] }) {
  const childArgs = [...settingsArgs, ...claudeArgs];
  if (platform !== "win32") {
    return { file: "claude", args: childArgs };
  }
  if (resolved && resolved.kind === "exe" && resolved.path) {
    return { file: resolved.path, args: childArgs };
  }
  // .cmd/.bat/.ps1 shim or unresolved -> let cmd.exe resolve PATH+PATHEXT at spawn time.
  return { file: "cmd.exe", args: ["/c", "claude", ...childArgs] };
}

// Pure: map the requested Windows console backend to node-pty spawn options.
// Non-Windows always returns {} (these flags are Windows-only and ignored elsewhere).
//
// Why this exists: on Win11 node-pty defaults to the OS ConPTY, whose *headless*
// pseudoconsole makes a grandchild console process (e.g. Claude Code's
// UserPromptSubmit command hooks spawning node.exe) allocate a brand-new console
// window -> a focus-steal that raises the host terminal on every prompt send.
// 'dll' selects node-pty's bundled, newer ConPTY (useConptyDll), which fixes that
// behavior -- the same lever VS Code shipped for the identical bug -- while keeping
// full ConPTY fidelity. 'os-conpty' is the historical default (no flag); it is also
// the automatic fallback when the bundled dll fails to load. 'winpty' is the legacy
// last-rung backend (real-but-hidden console) selectable only by explicit override.
function buildPtyBackendOpts({ platform, conptyMode = "dll" }) {
  if (platform !== "win32") return {};
  switch (conptyMode) {
    case "dll":
      return { useConptyDll: true };
    case "winpty":
      return { useConpty: false };
    case "os-conpty":
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// State machine. Status is driven by structural signals from StatusSource
// (Claude Code hooks = authoritative; OSC-0 title = degraded fallback), mapped
// to transitions in _onStatus per the signal x state matrix. There is NO
// screen-content parsing and NO detection timer here.
// ---------------------------------------------------------------------------

const TRANSITIONS = Object.freeze({
  [STATES.DORMANT]: {
    user_start: STATES.INITIALIZING,
  },
  [STATES.INITIALIZING]: {
    spawn_success: STATES.STARTING,
    spawn_fail: STATES.FAILED,
  },
  [STATES.STARTING]: {
    first_output: STATES.RUNNING,
    watchdog_timeout: STATES.FAILED,
    process_exit: STATES.FAILED,
  },
  [STATES.RUNNING]: {
    prompt_detected: STATES.WAITING,
    task_complete: STATES.COMPLETE,
    process_exit_ok: STATES.DONE,
    process_exit_fail: STATES.FAILED,
    user_kill: STATES.DONE,
  },
  [STATES.WAITING]: {
    user_input: STATES.RUNNING,
    user_dismiss: STATES.RUNNING,
    // Authoritative late `ready` (Stop/idle hook) while WAITING -> COMPLETE.
    task_complete: STATES.COMPLETE,
    user_kill: STATES.DONE,
    process_exit_ok: STATES.DONE,
    process_exit_fail: STATES.FAILED,
  },
  [STATES.IDLE]: {
    new_output: STATES.RUNNING,
    prompt_detected: STATES.WAITING,
    // Authoritative late `ready` while IDLE -> COMPLETE.
    task_complete: STATES.COMPLETE,
    process_exit_ok: STATES.DONE,
    process_exit_fail: STATES.FAILED,
    user_kill: STATES.DONE,
  },
  [STATES.COMPLETE]: {
    new_output: STATES.RUNNING,
    user_dismiss: STATES.IDLE,
    prompt_detected: STATES.WAITING,
    process_exit_ok: STATES.DONE,
    process_exit_fail: STATES.FAILED,
    user_kill: STATES.DONE,
  },
  [STATES.DONE]: {
    user_restart: STATES.INITIALIZING,
  },
  [STATES.FAILED]: {
    user_restart: STATES.INITIALIZING,
    process_exit_fail: STATES.FAILED,
  },
});

// Guards: return true if transition is allowed, false otherwise
const GUARDS = {
  spawn_success(session) {
    return fs.existsSync(session.path);
  },
  user_restart(session) {
    return session.state === STATES.DONE || session.state === STATES.FAILED;
  },
};

// Entry/exit hooks keyed by state
const ENTRY_HOOKS = {
  [STATES.WAITING](session) {
    session.emit("needs-attention", { name: session.name });
  },
  [STATES.FAILED](session) {
    session.emit("session-failed", { name: session.name });
  },
  [STATES.DONE](session) {
    session.emit("session-done", { name: session.name });
  },
};

const EXIT_HOOKS = {
  [STATES.WAITING](session) {
    session.emit("attention-cleared", { name: session.name });
  },
};

class Session extends EventEmitter {
  constructor({
    id,
    name,
    path,
    dangerouslySkipPermissions = false,
    startingWatchdogSeconds = 10,
    attentionTimeoutSeconds = 60,
    waitingEscalationSeconds = 300,
    replayBufferKB = 512,
    noFlicker = true,
    // Detection wiring (injected by backend). When absent, the session runs
    // title-source-only (no hooks) — used by unit tests constructing a Session directly.
    hookRouter = null,
    getHookPort = null,
    hooksBaseDir = undefined,
    titleStabilizationMs = 1500,
    statusConflictMs = undefined,
    statusDedupMs = undefined,
    // Resolved claude command ({ path, kind }). Defaults to the module-load
    // resolution; tests inject a stub to exercise the spawn branches deterministically.
    spawnCommand = CLAUDE_CMD,
    // Team-stage spawn options. initialPrompt is appended as the FINAL positional arg (proven safe
    // as a single argv element on the direct-exe path by the Phase-0 probe); extraClaudeArgs carries
    // e.g. ["-p", "--model", "sonnet"]; ephemeral marks orchestrator-owned stage sessions that live
    // in a separate map and must never be persisted to config.json.
    initialPrompt = null,
    extraClaudeArgs = [],
    ephemeral = false,
    // Optional Claude Code permissions ({ deny: [...] }) merged into the injected --settings file
    // (team-stage deny blacklist, mechanism M2). Null for ordinary user sessions.
    settingsPermissions = null,
    // PTY spawner seam. Defaults to node-pty; tests inject a fake to assert the
    // spawn wiring (file/args) without launching a real process.
    ptySpawn = null,
    // Windows console backend: 'dll' (bundled ConPTY, default — fixes the
    // grandchild-console focus-steal on prompt send), 'os-conpty' (historical OS
    // ConPTY, also the auto-fallback if the bundled dll fails to load), or 'winpty'
    // (legacy). Ignored on non-Windows. See buildPtyBackendOpts.
    conptyMode = "dll",
  }) {
    super();
    this.id = id;
    this.name = name;
    this.path = path;
    this.dangerouslySkipPermissions = dangerouslySkipPermissions;
    this.ptyProcess = null;
    this.state = STATES.DORMANT;
    this.auditLog = [];
    this.startingWatchdogMs = startingWatchdogSeconds * 1000;
    this.attentionTimeoutMs = attentionTimeoutSeconds * 1000;
    this.waitingEscalationMs = waitingEscalationSeconds * 1000;
    this._watchdogTimer = null;
    this._receivedFirstOutput = false;
    this._outputBuffer = []; // ring buffer of recent PTY chunks
    this._outputBufferHead = 0; // index of oldest valid entry; advances instead of shift()
    this._outputBufferSize = 0;
    this._outputBufferMax = replayBufferKB * 1024;
    this._killPollTimer = null;
    this._noFlicker = noFlicker;
    this._sleeping = false;
    this._sleepKillTimer = null;
    this._autoKilled = false;
    this._destroyed = false;
    this._pendingRestart = false;
    this._recorder = null; // Set via setRecorder() after construction

    // -- Detection: structural signal sources --
    this._hookRouter = hookRouter;
    this._getHookPort = getHookPort;
    this._hooksBaseDir = hooksBaseDir;
    this._hookToken = null;
    this._settingsHandle = null;
    this._hookSeen = false;
    this._lastSignal = null;
    this._spawnCommand = spawnCommand;
    this._initialPrompt = initialPrompt;
    this._extraClaudeArgs = Array.isArray(extraClaudeArgs) ? extraClaudeArgs : [];
    this.ephemeral = !!ephemeral;
    this._settingsPermissions = settingsPermissions;
    this._conptyMode = conptyMode;
    this._ptySpawn = ptySpawn || ((file, args, opts) => pty.spawn(file, args, opts));

    this._titleSource = createOscTitleSource({ stabilizationMs: titleStabilizationMs });
    this._statusSource = createStatusSource({
      sessionId: id,
      ...(statusConflictMs != null ? { conflictWindowMs: statusConflictMs } : {}),
      ...(statusDedupMs != null ? { dedupWindowMs: statusDedupMs } : {}),
    });
    this._titleSource.on("signal", (s) => this._statusSource.ingest(s));
    this._statusSource.on("status", (s) => this._onStatus(s));
    this._statusSource.on("meta", (m) => this._onMeta(m));
  }

  setRecorder(recorder) {
    this._recorder = recorder;
  }

  // -- Detection signal handling (replaces all content scraping) --

  // Push a hook callback's normalized signal into the StatusSource. Called by the
  // shared HookRouter the backend registers per session.
  ingestHookSignal(raw) {
    if (this._destroyed) return;
    this._hookSeen = true;
    if (this._recorder && raw && raw.event) {
      this._recorder.writeHook(raw.event, raw.payload);
    }
    this._statusSource.ingest(raw);
  }

  _onStatus(s) {
    if (this._destroyed) return;
    this._lastSignal = { signal: s.signal, source: s.source, confidence: s.confidence, ts: s.ts };
    const st = this.state;
    switch (s.signal) {
      case "working":
      case "resume":
        // Claude is active again — wake a quiescent card.
        if (st === STATES.IDLE || st === STATES.COMPLETE) {
          this.transition("new_output", { source: s.source, signal: s.signal });
        } else if (st === STATES.WAITING) {
          this.transition("user_input", { source: s.source, signal: s.signal });
        }
        break;
      case "ready":
        // Turn finished. Authoritative (hook) `ready` may complete from WAITING/IDLE
        // too (a late Stop after a permission/idle prompt). The title fallback only
        // completes from RUNNING (it only emits ready after seeing a spinner).
        if (st === STATES.RUNNING) {
          this.transition("task_complete", { source: s.source, signal: "ready" });
        } else if ((st === STATES.WAITING || st === STATES.IDLE) && s.confidence === "high") {
          this.transition("task_complete", { source: s.source, signal: "ready" });
        }
        break;
      case "awaiting-input":
        // Needs the user. Authoritative-only (title never emits this).
        if (st === STATES.RUNNING || st === STATES.IDLE || st === STATES.COMPLETE) {
          this.transition("prompt_detected", { source: s.source, signal: "awaiting-input" });
        }
        break;
      case "session-start":
      case "session-end":
        // Lifecycle telemetry only — PTY first-output / exit drive these states.
        break;
      default:
        break;
    }
  }

  _onMeta(m) {
    // `unknown` glyph / degraded telemetry — recorded for observability, no transition.
    this._lastSignal = { signal: m.signal, source: m.source, ts: m.ts, meta: true };
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
      ephemeral: this.ephemeral,
      auditLog: this.auditLog.slice(-100),
    };
  }

  getDetectionStats() {
    return {
      lastSignal: this._lastSignal,
      hookSeen: this._hookSeen,
      hooksInjected: this._settingsHandle !== null,
      titleState: this._titleSource.getState(),
    };
  }

  getHealthStats() {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      sleeping: this._sleeping,
      autoKilled: this._autoKilled,
      destroyed: this._destroyed,
      pendingRestart: this._pendingRestart,
      hasPty: this.ptyProcess !== null,
      ptyPid: this.ptyProcess ? this.ptyProcess.pid : null,
      outputBufferEntries: this._outputBuffer.length - this._outputBufferHead,
      outputBufferBytes: this._outputBufferSize,
      auditLogLength: this.auditLog.length,
      dataListenerCount: this.listenerCount("data"),
      hookSeen: this._hookSeen,
      timers: {
        sleepKill: this._sleepKillTimer !== null,
        killPoll: this._killPollTimer !== null,
        watchdog: this._watchdogTimer !== null,
      },
    };
  }

  getDebugState() {
    return {
      state: this.state,
      transitions: this.auditLog.slice(-5).map((e) => ({
        from: e.from,
        to: e.to,
        event: e.event,
        timestamp: e.timestamp,
        detail: e.detail,
      })),
      detection: this.getDetectionStats(),
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
        from,
        to,
        event,
        detail: detail || null,
        timestamp: Date.now(),
        selfTransition: true,
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
      timestamp: Date.now(),
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
    this.emit("state-change", { from, to, event, detail: detail || null });

    return true;
  }

  start() {
    if (this._destroyed) return;
    // Defensive cleanup: if a prior PTY is still alive (e.g. _handlePtyExit
    // hasn't propagated yet after a sleep-kill race), force-kill it before
    // respawning. Without this, ptyProcess assignment below would orphan the
    // previous PTY's onData/onExit subscriptions and leak the process.
    if (this.ptyProcess) {
      console.warn(`[session:${this.name}] start() called while PTY exists — killing previous PTY first`);
      const oldPid = this.ptyProcess.pid;
      try {
        if (process.platform === "win32") {
          execSync(`taskkill /PID ${Number(oldPid)} /T /F`, { stdio: "ignore", timeout: 2000 });
        } else {
          this.ptyProcess.kill();
        }
      } catch {
        // Already dead, unkillable, or timed out — proceed
      }
      this.ptyProcess = null;
    }
    if (this.state === STATES.DORMANT) {
      this.transition("user_start");
    }
    this._receivedFirstOutput = false;
    this._sleeping = false;
    this._autoKilled = false;
    this._outputBuffer = [];
    this._outputBufferHead = 0;
    this._outputBufferSize = 0;
    this._clearWatchdog();
    this._titleSource.reset();
    this._statusSource.reset();

    const env = this._buildSpawnEnv();

    // Inject Claude Code hooks via a per-session managed settings file (HTTP hooks
    // POSTing to Glissa's localhost server). No repo modification; no shell command.
    const settingsArgs = this._injectHooks();

    // Prefer spawning the resolved claude .exe directly (node-pty -> CreateProcess).
    // Fall back to `cmd.exe /c claude` only for .cmd/.bat/.ps1 shim installs or when
    // resolution failed (see resolveClaudeCommand / buildSpawnCommand at module top).
    const claudeArgs = this.dangerouslySkipPermissions
      ? ["--dangerously-skip-permissions"]
      : [];
    // Team stages pass extra flags (e.g. -p, --model <m>) then the prompt as the final positional.
    // The positional is a single argv element on the direct-exe path (proven by the Phase-0 probe);
    // on the cmd.exe shim fallback a very large/multiline prompt is subject to cmd parsing.
    if (this._extraClaudeArgs.length > 0) {
      claudeArgs.push(...this._extraClaudeArgs);
    }
    if (this._initialPrompt != null) {
      claudeArgs.push(this._initialPrompt);
    }
    const { file, args } = buildSpawnCommand({
      platform: process.platform,
      resolved: this._spawnCommand,
      settingsArgs,
      claudeArgs,
    });

    const baseOpts = {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: this.path,
      env,
    };
    const backendOpts = buildPtyBackendOpts({
      platform: process.platform,
      conptyMode: this._conptyMode,
    });
    try {
      this.ptyProcess = this._spawnWithBackendFallback(file, args, baseOpts, backendOpts);
    } catch (err) {
      this._cleanupHooks();
      this.transition("spawn_fail", { error: err.message });
      this.emit("error", err);
      return;
    }

    this.transition("spawn_success");

    // Redact a positional initialPrompt (team stages) from the spawn log — it can be a multi-KB
    // RUN CONTEXT block that does not belong in the console. Run detail lives in the Teams view.
    const argsForLog = this._initialPrompt
      ? args.map((a) => (a === this._initialPrompt ? `<prompt:${this._initialPrompt.length}c>` : a)).join(" ")
      : args.join(" ");
    console.log(
      `[session ${this.id}] spawn: ${file} ${argsForLog} (cwd=${this.path})`,
    );

    if (this._recorder) {
      this._recorder.writeHeader({
        attentionTimeoutMs: this.attentionTimeoutMs,
        startingWatchdogMs: this.startingWatchdogMs,
        hooksInjected: this._settingsHandle !== null,
        cols: 80,
        rows: 24,
      });
    }

    // Start watchdog timer for STARTING state
    this._watchdogTimer = setTimeout(() => {
      this._watchdogTimer = null;
      if (this.state === STATES.STARTING) {
        this.transition("watchdog_timeout");
      }
    }, this.startingWatchdogMs);

    this.ptyProcess.onData((data) => this._handlePtyData(data));
    this.ptyProcess.onExit(({ exitCode, signal }) =>
      this._handlePtyExit(exitCode, signal),
    );
  }

  // Spawn the PTY, tolerating a bundled-ConPTY load failure. Only the 'dll' backend
  // can fail to LOAD (node-pty throws when conpty.dll can't be loaded); in that one
  // case we retry once with the OS ConPTY (no backend flag) so a missing/unloadable
  // dll never regresses spawning. Any other failure (or a failure of the fallback
  // itself) propagates to start()'s spawn_fail handler.
  _spawnWithBackendFallback(file, args, baseOpts, backendOpts) {
    try {
      return this._ptySpawn(file, args, { ...baseOpts, ...backendOpts });
    } catch (err) {
      if (backendOpts && backendOpts.useConptyDll) {
        console.warn(
          `[session ${this.id}] useConptyDll spawn failed (${err.message}); falling back to OS ConPTY`,
        );
        return this._ptySpawn(file, args, { ...baseOpts });
      }
      throw err;
    }
  }

  // Write the per-session hook settings file and register with the shared
  // HookRouter. Returns the --settings arg array (empty when hooks unavailable).
  _injectHooks() {
    if (!this._hookRouter || !this._getHookPort) return [];
    let port;
    try {
      port = this._getHookPort();
    } catch {
      port = null;
    }
    if (!port) return [];
    try {
      this._settingsHandle = writeSessionSettings({
        port,
        glissaId: this.id,
        baseDir: this._hooksBaseDir,
        permissions: this._settingsPermissions,
      });
      this._hookToken = this._settingsHandle.token;
      this._hookRouter.register(this.id, {
        token: this._hookToken,
        onSignal: (raw) => this.ingestHookSignal(raw),
      });
      return ["--settings", this._settingsHandle.settingsPath];
    } catch (err) {
      console.warn(`[session:${this.name}] hook injection failed: ${err.message} — falling back to OSC title only`);
      this._cleanupHooks();
      return [];
    }
  }

  _cleanupHooks() {
    if (this._hookRouter) {
      try { this._hookRouter.unregister(this.id); } catch { /* ignore */ }
    }
    if (this._settingsHandle) {
      try { this._settingsHandle.cleanup(); } catch { /* ignore */ }
      this._settingsHandle = null;
    }
    this._hookToken = null;
  }

  _buildSpawnEnv() {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.GLISSA_PORT;
    delete env.GLISSA_CONFIG;
    if (this._noFlicker) {
      env.CLAUDE_CODE_NO_FLICKER = "1";
    }
    return env;
  }

  _handlePtyData(data) {
    if (this._destroyed) return;
    if (this._recorder) {
      this._recorder.writeData(data);
    }

    // First-output detection (pre-dispatch, only fires once in STARTING)
    if (this.state === STATES.STARTING && !this._receivedFirstOutput) {
      this._receivedFirstOutput = true;
      this._clearWatchdog();
      this.transition("first_output");
    }

    // Feed the OSC-title fallback source. Skipped while sleeping (state frozen).
    // This is the ONLY parsing on the hot path: it scans for OSC-0 titles and
    // ignores all other bytes — no tokenizer, no line assembly, no body scraping.
    if (!this._sleeping) {
      try {
        this._titleSource.feed(data);
      } catch (err) {
        console.error(`[session:${this.name}] title source error: ${err.message}`);
      }
    }

    // Buffer for late-joining data WS clients. Uses a head-index ring instead
    // of Array.shift() (O(n) per call) to keep the hot path O(1) amortized.
    this._outputBuffer.push(data);
    this._outputBufferSize += data.length;
    while (
      this._outputBufferSize > this._outputBufferMax &&
      this._outputBuffer.length - this._outputBufferHead > 1
    ) {
      this._outputBufferSize -= this._outputBuffer[this._outputBufferHead].length;
      this._outputBuffer[this._outputBufferHead] = null;
      this._outputBufferHead++;
    }
    if (this._outputBufferHead > 1024) {
      this._outputBuffer = this._outputBuffer.slice(this._outputBufferHead);
      this._outputBufferHead = 0;
    }

    if (this.listenerCount("data") > 0) {
      this.emit("data", data);
    }
  }

  _handlePtyExit(exitCode, signal) {
    const pid = this.ptyProcess ? this.ptyProcess.pid : null;
    this._clearWatchdog();
    this._titleSource.reset();
    this._statusSource.reset();
    this._cleanupHooks();
    this.ptyProcess = null;

    // Reap orphan grandchildren on Windows.
    if (pid && process.platform === "win32") {
      try {
        execSync(`taskkill /PID ${Number(pid)} /T /F`, { stdio: "ignore" });
      } catch {
        // pid already exited or taskkill unavailable — nothing to do
      }
    }

    let reason = null;
    if (this.state === STATES.STARTING && !this._receivedFirstOutput) {
      reason = "no_output_before_exit";
      this.transition("process_exit", { exitCode, signal, reason });
    } else if (exitCode === 0) {
      this.transition("process_exit_ok", { exitCode, signal });
    } else if (this.state === STATES.STARTING) {
      this.transition("process_exit", { exitCode, signal });
    } else {
      this.transition("process_exit_fail", { exitCode, signal });
    }

    if (this._recorder) {
      this._recorder.writeFooter("pty_exit", exitCode);
      this._recorder.close();
    }

    this.emit("exit", { exitCode, signal, reason });
  }

  getReplayBuffer() {
    return this._outputBufferHead === 0
      ? this._outputBuffer.join("")
      : this._outputBuffer.slice(this._outputBufferHead).join("");
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
    // Apply immediately, even when quiescent (IDLE/COMPLETE/WAITING), so Claude
    // gets SIGWINCH and reflows to fit. The redraw is harmless under structural
    // detection: the OSC-title source only reacts to the activity glyph (which a
    // reflow does not change) and hooks are event-based, not output-based.
    if (this.ptyProcess) {
      try {
        this.ptyProcess.resize(cols, rows);
      } catch {
        // PTY exited between our check and the resize call (Windows ConPTY race).
      }
    }
  }

  kill() {
    if (!this.ptyProcess) return;

    const pid = this.ptyProcess.pid;

    if (process.platform === "win32") {
      try {
        execSync(`taskkill /PID ${Number(pid)} /T /F`, { stdio: "ignore" });
      } catch (err) {
        if (this.listenerCount("error") > 0) {
          this.emit("error", err);
        }
      }
    } else {
      try {
        this.ptyProcess.kill();
      } catch (err) {
        if (this.listenerCount("error") > 0) {
          this.emit("error", err);
        }
      }
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
      if (this._destroyed) return;
      if (!checkAlive()) return;
      elapsed += KILL_POLL_INTERVAL_MS;
      if (elapsed >= KILL_MAX_WAIT_MS) {
        try {
          if (process.platform === "win32") {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
          } else {
            process.kill(pid, "SIGKILL");
          }
        } catch (err) {
          if (this.listenerCount("error") > 0) {
            this.emit("error", err);
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
      return this.transition("user_dismiss");
    }
    if (this.state === STATES.COMPLETE) return this.transition("user_dismiss");
    return false;
  }

  sleep() {
    if (this._sleeping) return;
    const sleepable = [STATES.IDLE, STATES.COMPLETE, STATES.DONE, STATES.FAILED];
    if (!sleepable.includes(this.state)) return;
    this._sleeping = true;
    this._titleSource.reset();
    this._statusSource.reset();
    this._scheduleSleepKill();
    this.emit("sleep");
  }

  wake() {
    if (this._destroyed) return;
    if (!this._sleeping) return;
    this._sleeping = false;
    this._clearSleepKill();
    this.emit("wake");
    // Sleep-kill terminated the PTY while user was away. Auto-restart on wake
    // so opening the card brings the session back instead of stranding it as DONE.
    if (this._autoKilled
        && (this.state === STATES.DONE || this.state === STATES.FAILED)) {
      this.restart();
    }
  }

  _scheduleSleepKill() {
    this._clearSleepKill();
    this._sleepKillTimer = setTimeout(() => {
      this._sleepKillTimer = null;
      if (!this._sleeping) return;
      const wasActive = this.state === STATES.RUNNING
        || this.state === STATES.WAITING
        || this.state === STATES.IDLE
        || this.state === STATES.COMPLETE;
      this.killSession();
      if (wasActive
          && (this.state === STATES.DONE || this.state === STATES.FAILED)) {
        this._autoKilled = true;
      }
    }, SLEEP_KILL_TIMEOUT_MS);
  }

  _clearSleepKill() {
    if (this._sleepKillTimer !== null) {
      clearTimeout(this._sleepKillTimer);
      this._sleepKillTimer = null;
    }
  }

  killSession() {
    const killable = [
      STATES.RUNNING,
      STATES.WAITING,
      STATES.IDLE,
      STATES.COMPLETE,
    ];
    if (!killable.includes(this.state)) return false;
    this.kill();
    return this.transition("user_kill");
  }

  restart() {
    if (this._destroyed) return false;
    if (this.state !== STATES.DONE && this.state !== STATES.FAILED)
      return false;
    this.transition("user_restart");
    this.start();
    return true;
  }

  forceRestart() {
    if (this._destroyed) return;
    if (this._pendingRestart) return;
    const killable = [
      STATES.RUNNING,
      STATES.WAITING,
      STATES.IDLE,
      STATES.COMPLETE,
    ];
    if (killable.includes(this.state)) {
      this._pendingRestart = true;
      this.once("exit", () => {
        this._pendingRestart = false;
        if (this._destroyed) return;
        if (this.state === STATES.DONE || this.state === STATES.FAILED) {
          this.transition("user_restart");
          this.start();
        }
      });
      this.kill();
      this.transition("user_kill");
    } else if (this.state === STATES.DONE || this.state === STATES.FAILED) {
      this.restart();
    }
  }

  updateSettings(cfg) {
    if (cfg.startingWatchdogSeconds != null)
      this.startingWatchdogMs = cfg.startingWatchdogSeconds * 1000;
    if (cfg.attentionTimeoutSeconds != null)
      this.attentionTimeoutMs = cfg.attentionTimeoutSeconds * 1000;
    if (cfg.waitingEscalationSeconds != null)
      this.waitingEscalationMs = cfg.waitingEscalationSeconds * 1000;
    if (cfg.replayBufferKB != null)
      this._outputBufferMax = cfg.replayBufferKB * 1024;
    if (cfg.noFlicker != null) this._noFlicker = !!cfg.noFlicker;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    this._clearWatchdog();
    this._clearSleepKill();

    this._cleanupHooks();

    this.kill();

    if (this._killPollTimer !== null) {
      clearTimeout(this._killPollTimer);
      this._killPollTimer = null;
    }

    if (this._recorder) {
      this._recorder.close(); // Idempotent — safe if already closed by _handlePtyExit
    }
    this._titleSource.destroy();
    this._statusSource.destroy();
    this.removeAllListeners();
  }

  _clearWatchdog() {
    if (this._watchdogTimer !== null) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }
}

module.exports = {
  Session,
  buildSpawnCommand,
  buildPtyBackendOpts,
  resolveClaudeCommand,
  classifyClaudeKind,
  CLAUDE_CMD,
};
