const fs = require("node:fs");
const path = require("node:path");
const pty = require("node-pty");
const { EventEmitter } = require("node:events");
const { execSync, execFileSync } = require("node:child_process");
const { STATES } = require("./shared/states");
const { createOscTitleSource } = require("./detection/osc-title-source");
const { createStatusSource } = require("./detection/status-source");
const { writeSessionSettings } = require("./detection/settings-injector");
const {
  classifyClaudeKind,
  resolveClaudeCommand,
  buildSpawnCommand,
  CLAUDE_CMD,
} = require("./session-core/spawn-command");
const { buildSpawnEnv } = require("./session-core/spawn-env");
const {
  TRANSITIONS,
  GUARDS,
  ENTRY_HOOKS,
  EXIT_HOOKS,
} = require("./session-core/state-machine");
const { mapSignalToEvent } = require("./session-core/status-mapper");
const agentTracker = require("./session-core/agent-tracker");

const KILL_POLL_INTERVAL_MS = 200;
const KILL_MAX_WAIT_MS = 3000;
const SLEEP_KILL_TIMEOUT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// State machine. Status is driven by structural signals from StatusSource
// (Claude Code hooks = authoritative; OSC-0 title = degraded fallback), mapped
// to transitions in _onStatus per the signal x state matrix. There is NO
// screen-content parsing and NO detection timer here. The transition tables
// (TRANSITIONS, GUARDS, ENTRY_HOOKS, EXIT_HOOKS) live in
// session-core/state-machine.js; the transition() engine below consumes them.
// ---------------------------------------------------------------------------

// A linked git worktree marks its working dir with a `.git` FILE containing
// `gitdir: .../.git/worktrees/<name>`, whereas a normal checkout has a `.git`
// DIRECTORY. A submodule also uses a `.git` file, but it points at
// `.../.git/modules/<name>`, so we require a `worktrees/` path segment to avoid
// flagging submodules as worktrees. The `(^|/)` anchor also catches relative
// pointers (Git 2.48+ `--relative-paths`, e.g. `../.git/worktrees/x` or a bare
// `worktrees/x`). fs-only: no subprocess, no dependency, in keeping with the
// "structural signals, no scraping" rule.
function detectLinkedWorktree(dir) {
  if (!dir) return false;
  try {
    const dotGit = path.join(dir, ".git");
    if (!fs.statSync(dotGit).isFile()) return false;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
    // .trim() drops the trailing CR from a CRLF `.git` file (the form git writes
    // on Windows); .replace normalizes Windows backslash gitdir paths to forward
    // slashes so the `worktrees/` segment test is separator-agnostic.
    return !!m && /(^|\/)worktrees\//.test(m[1].trim().replace(/\\/g, "/"));
  } catch {
    return false;
  }
}

class Session extends EventEmitter {
  constructor({
    id,
    name,
    path,
    dangerouslySkipPermissions = false,
    replayBufferKB = 512,
    // Detection wiring (injected by backend). When absent, the session runs
    // title-source-only (no hooks) - used by unit tests constructing a Session directly.
    hookRouter = null,
    getHookPort = null,
    hooksBaseDir = undefined,
    titleStabilizationMs = 1500,
    statusConflictMs = undefined,
    statusDedupMs = undefined,
    // Background sub-agent detection (see session-core/agent-tracker.js). When true (default), a
    // main-agent Stop fired while a background sub-agent is still running does NOT complete the card.
    // The kill switch (config detectBackgroundAgents=false) makes the session ignore subagent signals
    // so behavior is exactly as before. agentTtlMs bounds a dropped-SubagentStop leak.
    detectBackgroundAgents = true,
    agentTtlMs = agentTracker.DEFAULT_AGENT_TTL_MS,
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
    // Worktree isolation (injected by backend). When gitWorkspace + integrationBranch are present and
    // `path` is a git repo, the session runs in a throwaway worktree forked off integrationBranch and
    // merges back on review. Absent (unit tests, no-git) -> runs in place at `path` exactly as before.
    gitWorkspace = null,
    integrationBranch = null,
    // Session worktree location + the gitignored local context to bring in (see _provisionWorktree).
    worktreeRoot = null,
    worktreeShare = null,
  }) {
    super();
    this.id = id;
    this.name = name;
    this.path = path;
    // Whether this session's cwd is a linked git worktree (vs a normal checkout).
    // Surfaced to the dashboard as a small card marker; refreshed on the health tick.
    this.isWorktree = detectLinkedWorktree(this.path);
    this.dangerouslySkipPermissions = dangerouslySkipPermissions;
    this.ptyProcess = null;
    this.state = STATES.DORMANT;
    this.auditLog = [];
    this._receivedFirstOutput = false;
    this._outputBuffer = []; // ring buffer of recent PTY chunks
    this._outputBufferHead = 0; // index of oldest valid entry; advances instead of shift()
    this._outputBufferSize = 0;
    this._outputBufferMax = replayBufferKB * 1024;
    // Monotonic count of total bytes ever produced (never decremented by eviction).
    // This is the "end" offset for getBufferSince(); per-client ws-senders track how
    // far they have durably sent against it so a backpressure drop can be backfilled.
    this._outputBufferTotal = 0;
    this._killPollTimer = null;
    this._sleeping = false;
    this._sleepKillTimer = null;
    this._autoKilled = false;
    this._destroyed = false;
    this._pendingRestart = false;
    // True between a "Merge & finish" on a live session and its post-exit merge, so a double-click
    // cannot kick off a second merge against a worktree whose PTY is still tearing down.
    this._finishing = false;
    // True only between a successful spawn and the kill/exit that follows. Gates
    // write() so we never push input into a pty whose console pipe is already
    // dead (see write() and the conin-socket guard in start()).
    this._ptyAlive = false;
    // Last cols/rows pushed from the browser. A restarted PTY respawns at these
    // (not the 80x24 default) so Claude initializes its TUI at the correct size
    // instead of relying on a single post-reconnect resize that races startup.
    this._lastCols = null;
    this._lastRows = null;
    this._recorder = null; // Set via setRecorder() after construction

    // -- Detection: structural signal sources --
    this._hookRouter = hookRouter;
    this._getHookPort = getHookPort;
    this._hooksBaseDir = hooksBaseDir;
    this._hookToken = null;
    this._settingsHandle = null;
    this._hookSeen = false;
    this._lastSignal = null;
    // Live background sub-agents, keyed by Claude Code agent_id -> last-seen ts. Non-empty means
    // background work is still running after the main agent's Stop, which gates ready->task_complete
    // (see _onStatus / mapSignalToEvent). Lazily pruned by agentTtlMs; never drives a state transition.
    this._detectBackgroundAgents = detectBackgroundAgents;
    this._activeAgents = new Map();
    this._agentTtlMs = agentTtlMs;
    this._spawnCommand = spawnCommand;
    this._initialPrompt = initialPrompt;
    this._extraClaudeArgs = Array.isArray(extraClaudeArgs) ? extraClaudeArgs : [];
    this.ephemeral = !!ephemeral;
    this._settingsPermissions = settingsPermissions;
    this._ptySpawn = ptySpawn || ((file, args, opts) => pty.spawn(file, args, opts));

    // -- Worktree isolation state (see _provisionWorktree / _settleWorktreeOnExit) --
    this._gitWorkspace = gitWorkspace;
    this._integrationBranch = integrationBranch;
    this._worktreeRoot = worktreeRoot;
    this._worktreeShare = worktreeShare;
    this.worktreeDir = null;     // active session worktree cwd (null = in-place at this.path)
    this.baseSha = null;         // integration-branch SHA the worktree forked from
    this._workspace = null;      // opaque team-git workspace handle for merge/discard
    this.mergeStatus = 'none';   // none | pending-review | merging | parked | merged
    this.worktreeNotice = null;  // operator-facing blocker (e.g. integration branch missing)

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
    // Background sub-agent lifecycle is COUNTED, not a state transition: it never reaches the
    // StatusSource (which merges hook+title timing for the real transition signals). Tracking the
    // live set lets a main-agent Stop fired while a background sub-agent is still running avoid a
    // false COMPLETE (see _onStatus + the activeAgents gate in status-mapper.js).
    if (raw && (raw.signal === "subagent-start" || raw.signal === "subagent-stop")) {
      this._trackSubagent(raw);
      return;
    }
    this._statusSource.ingest(raw);
  }

  // Apply one subagent-start/stop signal to the live set. Off (kill switch) or a payload with no
  // agent_id is ignored, so the count stays 0 and behavior is exactly as before. Emits an
  // 'agents-change' delta only when the live count actually changed.
  _trackSubagent(raw) {
    if (!this._detectBackgroundAgents) return;
    const agentId = raw.payload && raw.payload.agent_id;
    if (!agentId) return;
    const changed = raw.signal === "subagent-start"
      ? agentTracker.addAgent(this._activeAgents, agentId, raw.ts || Date.now())
      : agentTracker.removeAgent(this._activeAgents, agentId);
    if (changed) this._emitAgentsChange();
  }

  // Pruned count of live background sub-agents. Lazy prune (no per-session timer) bounds a dropped
  // SubagentStop. Returns 0 when detection is off so the gate is inert.
  _activeAgentCount() {
    if (!this._detectBackgroundAgents) return 0;
    agentTracker.pruneAgents(this._activeAgents, Date.now(), this._agentTtlMs);
    return this._activeAgents.size;
  }

  _emitAgentsChange() {
    // Internal event; the backend listener already has the session (id/name), so carry only the count.
    this.emit("agents-change", { activeAgents: this._activeAgentCount() });
  }

  // Drop all live ids (PTY exit, (re)start). Emits a clearing delta only if something was live.
  _clearAgents() {
    if (this._activeAgents.size === 0) return;
    this._activeAgents.clear();
    this._emitAgentsChange();
  }

  _onStatus(s) {
    if (this._destroyed) return;
    this._lastSignal = { signal: s.signal, source: s.source, confidence: s.confidence, ts: s.ts };
    // Pure decision in session-core/status-mapper.js; this wrapper owns the side effects:
    // the _destroyed guard + _lastSignal write above, and the transition below. The detail
    // { source, signal } is uniform across every firing case (byte-identical to the prior
    // per-branch details), so it is assembled here rather than in the pure mapper.
    const event = mapSignalToEvent(s.signal, this.state, s.confidence, this._activeAgentCount());
    if (event) {
      this.transition(event, { source: s.source, signal: s.signal });
    }
  }

  _onMeta(m) {
    // `unknown` glyph / degraded telemetry - recorded for observability, no transition.
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
      isWorktree: this.isWorktree,
      activeAgents: this._activeAgentCount(),
      mergeStatus: this.mergeStatus,
      worktreeNotice: this.worktreeNotice,
      auditLog: this.auditLog.slice(-100),
    };
  }

  // Recompute worktree status (a cwd can be turned into, or removed as, a linked
  // worktree mid-session). Returns true when the value changed so the caller can
  // rebroadcast just the delta instead of recreating the card.
  refreshGitContext() {
    const next = detectLinkedWorktree(this.worktreeDir || this.path);
    if (next === this.isWorktree) return false;
    this.isWorktree = next;
    return true;
  }

  // The directory the PTY actually runs in: the isolated worktree when provisioned, else the repo
  // root / in-place path. Single source of truth for cwd, worktree detection, and the review diff.
  effectiveCwd() {
    return this.worktreeDir || this.path;
  }

  // Create (or reuse) this session's isolated worktree off the integration branch. Returns false ONLY
  // when isolation is required but BLOCKED (integration branch absent): the session then stays put with
  // a surfaced notice and never runs in the operator's real tree. Isolation disabled (no injected
  // gitWorkspace/integrationBranch) or a non-git path -> runs in place (returns true, worktreeDir null).
  _provisionWorktree() {
    if (!this._gitWorkspace || !this._integrationBranch) return true;
    if (this.worktreeDir && fs.existsSync(this.worktreeDir)) return true; // reuse across restart/wake
    let ws;
    try {
      ws = this._gitWorkspace.create({
        projectPath: this.path,
        teamId: "session",
        label: this.id,
        baseBranch: this._integrationBranch,
        outputPath: "",
        worktreeBase: this._worktreeRoot,
        shareList: this._worktreeShare,
      });
    } catch (err) {
      console.warn(`[session ${this.id}] worktree create failed: ${err.message} - running in place`);
      return true;
    }
    if (ws && ws.reason === "no-base-branch") {
      this.worktreeNotice = `Integration branch "${this._integrationBranch}" not found. Create it, then start this session.`;
      this.emit("worktree-blocked", { id: this.id, branch: this._integrationBranch, notice: this.worktreeNotice });
      return false;
    }
    if (!ws || !ws.isGit) { // non-git path: the ONLY in-place fallback
      this.worktreeDir = null;
      this.isWorktree = false;
      return true;
    }
    this._workspace = ws;
    this.worktreeDir = ws.cwd;
    this.baseSha = ws.baseSha || null;
    this.worktreeNotice = null;
    this.mergeStatus = "none";
    this.isWorktree = true;
    this.emit("worktree-ready", { id: this.id, worktreeDir: ws.cwd, branch: ws.branch });
    return true;
  }

  // On a real PTY exit (DONE/FAILED) decide the review gate: a changed worktree becomes
  // pending-review (the operator merges/discards); an unchanged one (chat/research) is discarded
  // silently so it leaves no branch. Transient COMPLETE never reaches here (it has no PTY exit).
  _settleWorktreeOnExit() {
    if (!this._gitWorkspace || !this._workspace) return;
    if (this.state !== STATES.DONE && this.state !== STATES.FAILED) return;
    if (this.hasChanges()) {
      this._setMergeStatus("pending-review");
    } else {
      try { this._gitWorkspace.discard({ projectPath: this.path, workspace: this._workspace }); } catch { /* best-effort */ }
      this._workspace = null;
      this.worktreeDir = null;
      this.isWorktree = false;
      this._setMergeStatus("none");
    }
  }

  _setMergeStatus(status, extra = {}) {
    this.mergeStatus = status;
    this.emit("merge-status", { id: this.id, mergeStatus: status, ...extra });
  }

  // True when the worktree has any uncommitted change vs its base, COUNTING untracked new files
  // (a feature session's deliverable is usually new files, which a plain `git diff` would miss).
  hasChanges() {
    if (!this.worktreeDir) return false;
    try {
      const out = execFileSync("git", ["status", "--porcelain"], {
        cwd: this.worktreeDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
      });
      return out.trim().length > 0;
    } catch { return false; }
  }

  // Unified diff of the worktree vs its base, with NEW files made visible via intent-to-add.
  getDiff() {
    if (!this.worktreeDir) return { stat: "", diff: "" };
    const g = (args) => {
      try {
        return execFileSync("git", args, { cwd: this.worktreeDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
      } catch (e) { return String(e.stdout || ""); }
    };
    g(["add", "-N", "--", "."]); // intent-to-add so new files appear in the diff
    return { stat: g(["diff", "--stat"]).trim(), diff: g(["diff"]) };
  }

  // Operator action: rebase-then-FF merge the session's worktree into the integration branch, then
  // tear it down. On a conflict/lost-FF the branch PARKS (worktree preserved). Returns the engine result.
  mergeWorktree() {
    if (!this._gitWorkspace || !this._workspace) return { merged: false, reason: "no-worktree" };
    this._setMergeStatus("merging");
    let r;
    try {
      r = this._gitWorkspace.mergeBack({
        projectPath: this.path,
        workspace: this._workspace,
        targetBranch: this._integrationBranch,
        message: `glissa session: ${this.name}`,
      });
    } catch (err) {
      this._setMergeStatus("pending-review", { reason: err.message });
      return { merged: false, reason: err.message };
    }
    if (r.merged) {
      this._workspace = null;
      this.worktreeDir = null;
      this.isWorktree = false;
      this._setMergeStatus("merged");
    } else if (r.parked) {
      this._setMergeStatus("parked", { reason: r.reason || null });
    } else {
      this._setMergeStatus("pending-review", { reason: r.reason || null });
    }
    return r;
  }

  // Operator action behind the sidebar's "Merge" on a LIVE quiescent session (COMPLETE/IDLE): commit the
  // worktree's changes, merge them into the integration branch, and rebase this worktree onto it, KEEPING
  // the session running on the same worktree (now on top of develop) so the operator commits as they go.
  // Unlike finishAndMerge it never ends the session or tears the worktree down. Refused while the PTY is
  // actively working (we must not rewrite a worktree mid-edit). A rebase conflict / lost FF PARKS
  // (worktree preserved). Returns the engine result.
  mergeAndContinue() {
    if (this._destroyed) return { merged: false, reason: "destroyed" };
    if (!this._gitWorkspace || !this._workspace) return { merged: false, reason: "no-worktree" };
    if (this.state !== STATES.COMPLETE && this.state !== STATES.IDLE) {
      return { merged: false, reason: "not-continuable" };
    }
    this._setMergeStatus("merging");
    let r;
    try {
      r = this._gitWorkspace.mergeKeep({
        projectPath: this.path,
        workspace: this._workspace,
        targetBranch: this._integrationBranch,
        message: `glissa session: ${this.name}`,
      });
    } catch (err) {
      this._setMergeStatus("pending-review", { reason: err.message });
      return { merged: false, reason: err.message };
    }
    if (r.merged) {
      // Worktree kept alive on its branch (now == the integration tip); track the new base it sits on.
      // The worktree is clean again, so the gate returns to 'none' until the session produces more work.
      if (r.baseSha) { this.baseSha = r.baseSha; this._workspace.baseSha = r.baseSha; }
      this._setMergeStatus("none");
    } else if (r.parked) {
      this._setMergeStatus("parked", { reason: r.reason || null });
    } else if (r.reason === "nothing-to-commit") {
      this._setMergeStatus("none");
    } else {
      this._setMergeStatus("pending-review", { reason: r.reason || null });
    }
    return r;
  }

  // Re-adopt an existing on-disk session worktree at boot (e.g. a pending-review/parked session that
  // survived a server restart), so its unreviewed work is resurfaced as pending-review instead of
  // stranded. The session stays DORMANT; the operator can then review/merge it, or starting it reuses
  // this same worktree (_provisionWorktree early-returns on an existing worktreeDir).
  adoptWorktree({ worktreeDir, branch, base }) {
    if (!worktreeDir) return;
    this._workspace = { cwd: worktreeDir, isGit: true, branch, base: base || this._integrationBranch };
    this.worktreeDir = worktreeDir;
    this.isWorktree = true;
    this._setMergeStatus("pending-review");
  }

  // Operator action: throw the worktree away unmerged (junction-safe), reset to no-worktree.
  discardWorktree() {
    if (this._gitWorkspace && this._workspace) {
      try { this._gitWorkspace.discard({ projectPath: this.path, workspace: this._workspace }); } catch { /* best-effort */ }
    }
    this._workspace = null;
    this.worktreeDir = null;
    this.isWorktree = false;
    this._setMergeStatus("none");
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
      outputBufferTotal: this._outputBufferTotal,
      auditLogLength: this.auditLog.length,
      dataListenerCount: this.listenerCount("data"),
      hookSeen: this._hookSeen,
      timers: {
        sleepKill: this._sleepKillTimer !== null,
        killPoll: this._killPollTimer !== null,
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
      console.warn(`[session:${this.name}] start() called while PTY exists - killing previous PTY first`);
      const oldPid = this.ptyProcess.pid;
      try {
        if (process.platform === "win32") {
          execSync(`taskkill /PID ${Number(oldPid)} /T /F`, { stdio: "ignore", timeout: 2000 });
        } else {
          this.ptyProcess.kill();
        }
      } catch {
        // Already dead, unkillable, or timed out - proceed
      }
      this.ptyProcess = null;
    }
    // Provision (or reuse) this session's isolated worktree before spawn. All spawn entry points
    // funnel through start(), so each inherits isolation. A blocked provision (integration branch
    // absent) leaves the session DORMANT with a notice and does NOT run in the operator's real tree.
    if (!this._provisionWorktree()) return;
    if (this.state === STATES.DORMANT) {
      this.transition("user_start");
    }
    this._receivedFirstOutput = false;
    this._sleeping = false;
    // A (re)started PTY begins with no live background sub-agents; drop any stale ids from a prior run.
    this._clearAgents();
    this._autoKilled = false;
    this._outputBuffer = [];
    this._outputBufferHead = 0;
    this._outputBufferSize = 0;
    this._outputBufferTotal = 0;
    // A restarted PTY re-bases its monotonic output offset at 0. Signal the backend so
    // it force-closes any LIVE data-WS client (whose ws-sender.sentOffset is now
    // stale-high relative to the reset total) and lets it reconnect + re-baseline.
    // Covers restart(), forceRestart(), and sleep-kill auto-restart (all funnel through
    // start()); harmless no-op on the first start() (no data clients attached yet).
    // See backend.js wireSessionEvents -> closeSessionDataClients.
    this.emit("rebaseline");
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

    // Reuse the last browser-pushed size so a restart spawns at the card's real
    // dimensions; fall back to 80x24 on the very first spawn (no size known yet).
    const spawnCols = this._lastCols ?? 80;
    const spawnRows = this._lastRows ?? 24;
    try {
      this.ptyProcess = this._ptySpawn(file, args, {
        name: "xterm-256color",
        cols: spawnCols,
        rows: spawnRows,
        cwd: this.effectiveCwd(),
        env,
      });
    } catch (err) {
      this._cleanupHooks();
      this.transition("spawn_fail", { error: err.message });
      this.emit("error", err);
      return;
    }
    this._ptyAlive = true;
    this._guardPtyInputSocket();

    this.transition("spawn_success");

    // Redact a positional initialPrompt (team stages) from the spawn log - it can be a multi-KB
    // RUN CONTEXT block that does not belong in the console. Run detail lives in the Teams view.
    const argsForLog = this._initialPrompt
      ? args.map((a) => (a === this._initialPrompt ? `<prompt:${this._initialPrompt.length}c>` : a)).join(" ")
      : args.join(" ");
    console.log(
      `[session ${this.id}] spawn: ${file} ${argsForLog} (cwd=${this.effectiveCwd()})`,
    );

    if (this._recorder) {
      this._recorder.writeHeader({
        hooksInjected: this._settingsHandle !== null,
        cols: spawnCols,
        rows: spawnRows,
      });
    }

    this.ptyProcess.onData((data) => this._handlePtyData(data));
    this.ptyProcess.onExit(({ exitCode, signal }) =>
      this._handlePtyExit(exitCode, signal),
    );
  }

  // node-pty 1.1.0 attaches an 'error' handler to the conout socket only, never
  // to the conin (input) socket it writes to in _doWrite. A write that lands
  // after the child's console pipe has died (e.g. our taskkill on restart, in
  // the gap before node-pty's exit callback fires) surfaces asynchronously as
  // `write EAGAIN`/EPIPE on that unguarded socket and crashes the whole process
  // (it cannot be caught by try/catch around .write()). Attach our own handler
  // so it is logged, not fatal. Remove if node-pty starts guarding inSocket.
  // Windows-conpty internal; optional chaining keeps the test fake-pty and any
  // non-conpty backend safe.
  _guardPtyInputSocket() {
    try {
      this.ptyProcess?._agent?.inSocket?.on("error", (err) => {
        console.warn(`[session ${this.id}] pty input socket error (ignored): ${err.message}`);
      });
    } catch {
      // node-pty internal shape differs (version/backend): non-fatal.
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
      console.warn(`[session:${this.name}] hook injection failed: ${err.message} - falling back to OSC title only`);
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
    return buildSpawnEnv(process.env);
  }

  _handlePtyData(data) {
    if (this._destroyed) return;
    if (this._recorder) {
      this._recorder.writeData(data);
    }

    // First-output detection (pre-dispatch, only fires once in STARTING)
    if (this.state === STATES.STARTING && !this._receivedFirstOutput) {
      this._receivedFirstOutput = true;
      this.transition("first_output");
    }

    // Feed the OSC-title fallback source. Skipped while sleeping (state frozen).
    // This is the ONLY parsing on the hot path: it scans for OSC-0 titles and
    // ignores all other bytes - no tokenizer, no line assembly, no body scraping.
    if (!this._sleeping) {
      try {
        this._titleSource.feed(data);
      } catch (err) {
        console.error(`[session:${this.name}] title source error: ${err.message}`);
      }
    }

    // Buffer for late-joining data WS clients. Uses a head-index ring instead
    // of Array.shift() (O(n) per call) to keep the hot path O(1) amortized.
    //
    // ORDER CONTRACT: the ring push + _outputBufferTotal increment MUST stay BEFORE
    // emit("data") below. ws-sender.maybeBackfill() reads getBufferSince() from inside
    // the "data" listener and relies on the just-arrived chunk already being
    // retained and counted (see ws-sender.js maybeBackfill). Reordering would make a
    // backfill miss the in-flight chunk.
    this._outputBuffer.push(data);
    this._outputBufferSize += data.length;
    this._outputBufferTotal += data.length;
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

    // ORDER CONTRACT (see the ring-push block above): emit AFTER the push +
    // _outputBufferTotal increment so a backfill triggered from this listener sees
    // the in-flight chunk already in the ring.
    if (this.listenerCount("data") > 0) {
      this.emit("data", data);
    }
  }

  _handlePtyExit(exitCode, signal) {
    const pid = this.ptyProcess ? this.ptyProcess.pid : null;
    this._titleSource.reset();
    this._statusSource.reset();
    this._clearAgents();
    this._cleanupHooks();
    this._ptyAlive = false;
    this.ptyProcess = null;

    // Reap orphan grandchildren on Windows.
    if (pid && process.platform === "win32") {
      try {
        execSync(`taskkill /PID ${Number(pid)} /T /F`, { stdio: "ignore" });
      } catch {
        // pid already exited or taskkill unavailable - nothing to do
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

    this._settleWorktreeOnExit();

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

  // Current monotonic output offset (== total bytes ever produced). A data-WS client
  // captures this at connect as its live baseline (startOffset).
  getOutputOffset() {
    return this._outputBufferTotal;
  }

  // Return the slice of output produced at or after `offset`. Offsets are monotonic
  // byte counts in JS string .length units (UTF-16 code units), consistent with the
  // ring's sizing. Returns { data, base, end, evicted }:
  //   - end  = current total (the offset the caller should adopt after consuming).
  //   - base = oldest retained offset = end - retained bytes.
  //   - offset >= end  -> nothing new ({ data: "" }).
  //   - offset <  base -> the missed range was evicted from the ring; `data` is the
  //                       full current replay and `evicted` is true (caller must
  //                       screen-clear before writing it).
  //   - otherwise      -> the exact tail from `offset`, slicing the boundary chunk.
  // `offset` is always a previous cumulative .length (a chunk-append boundary), never an
  // arbitrary mid-chunk index, so the boundary slice never splits a UTF-16 surrogate pair.
  getBufferSince(offset) {
    const end = this._outputBufferTotal;
    const base = end - this._outputBufferSize; // oldest retained offset (bytes evicted)
    if (offset >= end) {
      return { data: "", base, end, evicted: false };
    }
    if (offset < base) {
      return { data: this.getReplayBuffer(), base, end, evicted: true };
    }
    let pos = base;
    let out = "";
    for (let i = this._outputBufferHead; i < this._outputBuffer.length; i++) {
      const chunk = this._outputBuffer[i];
      if (chunk == null) continue; // eviction nulls entries before head compaction
      const len = chunk.length;
      if (pos + len <= offset) {
        pos += len;
        continue;
      }
      out += offset > pos ? chunk.slice(offset - pos) : chunk;
      pos += len;
    }
    return { data: out, base, end, evicted: false };
  }

  write(text) {
    if (this._recorder) {
      this._recorder.writeInput(text);
    }
    // Only write to a live pty. After kill()/exit the conin pipe peer is gone,
    // so writing would fail async with EAGAIN/EPIPE on node-pty's unguarded
    // input socket (see _guardPtyInputSocket); this closes the common window.
    if (this.ptyProcess && this._ptyAlive) {
      this.ptyProcess.write(text);
    }
  }

  resize(cols, rows) {
    // Remember the latest size so a restart respawns the PTY at this dimension
    // (see start()), rather than the 80x24 default that leaves Claude cramped.
    this._lastCols = cols;
    this._lastRows = rows;
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

    // Stop writing the instant we kill: the conin pipe peer dies with the child,
    // so any further write() would hit the dead pipe (see _guardPtyInputSocket).
    this._ptyAlive = false;
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
    // Only sleep dead-PTY terminal states. Sleeping a live PTY (IDLE/COMPLETE)
    // would arm the sleep-kill timer below and terminate a session whose work
    // can still continue.
    const sleepable = [STATES.DONE, STATES.FAILED];
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

  // Close-out: return a finished, fully-settled session (PTY dead, worktree already merged/discarded)
  // to DORMANT so its card parks for reuse. Guarded by user_reset (see state-machine.js), so it is a
  // no-op on a live or unmerged session. mergeStatus is cleared to 'none' only on a successful reset
  // (silently; the dashboard recreates the card as dormant from the state-change). Returns whether the
  // reset happened.
  resetToDormant() {
    if (this._destroyed) return false;
    const did = this.transition("user_reset");
    if (did) this.mergeStatus = "none";
    return did;
  }

  // One-click close-out behind the sidebar's "Merge & finish": merge the worktree into the integration
  // branch and return the session to DORMANT. A settled session (DONE/FAILED) merges immediately. A
  // quiescent live session (COMPLETE/IDLE) is ENDED first (we must not rewrite a worktree the PTY is
  // still running in), then merged once it settles on exit. RUNNING/WAITING and the startup states are
  // refused (mid-work, or no worktree yet). Returns { ok, pending?, reason? }.
  finishAndMerge() {
    if (this._destroyed || this._finishing) {
      return { ok: false, reason: this._finishing ? "in-progress" : "destroyed" };
    }
    if (this.state === STATES.DONE || this.state === STATES.FAILED) {
      this._mergeAndReset();
      return { ok: true };
    }
    if (this.state === STATES.COMPLETE || this.state === STATES.IDLE) {
      this._finishing = true;
      this.once("exit", () => {
        this._finishing = false;
        if (!this._destroyed) this._mergeAndReset();
      });
      this.killSession(); // -> DONE now; the real PTY exit settles the worktree, then the handler merges
      return { ok: true, pending: true };
    }
    return { ok: false, reason: "not-finishable" };
  }

  // Merge the worktree, then (self-guarded) return to DORMANT once the worktree is gone. A parked merge
  // keeps its worktree, so resetToDormant no-ops and the session stays parked for manual resolution; a
  // clean settle (nothing to merge) already cleared the worktree, so the session still finishes dormant.
  _mergeAndReset() {
    const r = this.mergeWorktree();
    this.resetToDormant();
    return r;
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
    if (cfg.replayBufferKB != null)
      this._outputBufferMax = cfg.replayBufferKB * 1024;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    this._clearSleepKill();

    this._cleanupHooks();

    this.kill();

    if (this._killPollTimer !== null) {
      clearTimeout(this._killPollTimer);
      this._killPollTimer = null;
    }

    if (this._recorder) {
      this._recorder.close(); // Idempotent - safe if already closed by _handlePtyExit
    }
    this._titleSource.destroy();
    this._statusSource.destroy();
    this.removeAllListeners();
  }
}

module.exports = {
  Session,
  buildSpawnCommand,
  resolveClaudeCommand,
  classifyClaudeKind,
  CLAUDE_CMD,
};
