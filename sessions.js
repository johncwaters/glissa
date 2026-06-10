const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const pty = require("node-pty");
const { EventEmitter } = require("node:events");
const { execSync, execFileSync, execFile } = require("node:child_process");
const { STATES, MERGEABLE_LIVE_STATES } = require("./shared/states");
const { createOscTitleSource } = require("./detection/osc-title-source");
const { createStatusSource } = require("./detection/status-source");
const { createWorktreeWatcher } = require("./detection/worktree-watch");
const { writeSessionSettings } = require("./detection/settings-injector");
const {
  classifyClaudeKind,
  resolveClaudeCommand,
  buildSpawnCommand,
  CLAUDE_CMD,
} = require("./session-core/spawn-command");
const { buildSpawnEnv } = require("./session-core/spawn-env");
const { buildAntiSlopArgs } = require("./session-core/anti-slop-prompt");
const {
  TRANSITIONS,
  GUARDS,
  ENTRY_HOOKS,
  EXIT_HOOKS,
} = require("./session-core/state-machine");
const { mapSignalToEvent } = require("./session-core/status-mapper");
const { buildMergePrompt } = require("./session-core/merge-prompt");
const agentTracker = require("./session-core/agent-tracker");
const wakeupTracker = require("./session-core/wakeup-tracker");

const KILL_POLL_INTERVAL_MS = 200;
const KILL_MAX_WAIT_MS = 3000;
const SLEEP_KILL_TIMEOUT_MS = 15 * 60 * 1000;

// Trailing debounce for the worktree-change funnel: a single `git commit` touches
// several gitdir files and a turn-end can race the fs.watch, so collapse a burst
// into one signature recompute. The triggers are all event-driven (no poll): the per-worktree gitdir
// fs.watch, the turn-end hook, and the backend's integration-ref watcher fan-out.
const WORKTREE_CHECK_DEBOUNCE_MS = 400;

// Async git. The review-gate probes (signature, diff) run on hot, recurring paths
// (every turn-end, every gitdir fs.watch nudge, and the backend's integration-ref
// watcher fan-out). The synchronous execFileSync they used to call BLOCKS the single Node
// event loop for the whole subprocess - on a slower machine, with several sessions,
// that stalls every session's PTY streaming and keystroke handling at once. execFile
// runs git in a child process while the loop keeps pumping that I/O.
//
// gitOut resolves stdout on success AND on a non-zero exit (git diff prints to stdout
// even when it exits non-zero), mirroring the old getDiff helper that returned
// e.stdout from its catch. gitStrict rejects on a non-zero exit / spawn error so a
// caller's try/catch can treat an unreadable worktree as UNKNOWN, mirroring the old
// signature helper whose throw was caught into a null signature.
function gitOut(args, opts) {
  return new Promise((resolve) => {
    execFile("git", args, opts, (_err, stdout) => resolve(stdout != null ? String(stdout) : ""));
  });
}
function gitStrict(args, opts) {
  return new Promise((resolve, reject) => {
    execFile("git", args, opts, (err, stdout) => (err ? reject(err) : resolve(stdout != null ? String(stdout) : "")));
  });
}

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
    // Scheduled-revival visibility (see session-core/wakeup-tracker.js). When true (default), a
    // ScheduleWakeup / cron task seen via PostToolUse hooks rides toSnapshot().pendingWakeup as an
    // ADVISORY card chip ("sleeping until ~HH:MM"); it never gates a transition. The kill switch
    // (config detectScheduledWakeups=false) drops the PostToolUse hook group at the source and
    // makes the session ignore the signals, so behavior is exactly as before.
    detectScheduledWakeups = true,
    // Optional LLM proxy (config proxyBaseUrl). Injected as a GETTER (like getHookPort) so a
    // settings change applies on the next PTY (re)spawn without rebuilding the Session. A non-empty
    // return becomes ANTHROPIC_BASE_URL in the spawn env (see session-core/spawn-env.js); Glissa
    // never spawns or manages the proxy itself. Null/empty -> no injection (default behavior).
    getProxyBaseUrl = null,
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
    // Lever B: append a fixed anti-slop note to the system prompt at spawn (user sessions,
    // opt-in via config antiSlopPrompt). Off by default and never set for team/pack-setup
    // stage sessions. See session-core/anti-slop-prompt.js.
    antiSlopPrompt = false,
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
    // True between a live "Park" and its post-exit discard+reset, mirroring _finishing. Part of the
    // shared teardown mutex (_teardownPending) so no other lifecycle action respawns on the worktree
    // a queued park is about to discard.
    this._pendingPark = false;
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
    // Pending scheduled revivals, keyed by cron task id or a synthetic one-shot key. Advisory
    // only (see _trackWakeup); lazily pruned (fireAt + grace / cron TTL); never a transition.
    this._detectScheduledWakeups = detectScheduledWakeups;
    this._wakeups = new Map();
    this._wakeupSeq = 0;
    this._getProxyBaseUrl = getProxyBaseUrl;
    this._spawnCommand = spawnCommand;
    this._initialPrompt = initialPrompt;
    this._extraClaudeArgs = Array.isArray(extraClaudeArgs) ? extraClaudeArgs : [];
    this._antiSlopPrompt = !!antiSlopPrompt;
    this.ephemeral = !!ephemeral;
    this._settingsPermissions = settingsPermissions;
    this._ptySpawn = ptySpawn || ((file, args, opts) => pty.spawn(file, args, opts));

    // -- Worktree isolation state (see _provisionWorktree / _settleWorktreeOnExit) --
    this._gitWorkspace = gitWorkspace;
    this._integrationBranch = integrationBranch;
    this._effectiveBase = null;    // cached result of _resolveEffectiveBase(); null until first diff
    this._worktreeRoot = worktreeRoot;
    this._worktreeShare = worktreeShare;
    this.worktreeDir = null;     // active session worktree cwd (null = in-place at this.path)
    this.commonGitDir = null;    // shared gitdir all linked worktrees write refs into (git rev-parse
                                 // --git-common-dir); the key the backend groups integration-ref watchers by
    this.baseSha = null;         // integration-branch SHA the worktree forked from
    this._workspace = null;      // opaque team-git workspace handle for merge/discard
    this.mergeStatus = 'none';   // none | pending-review | merging | parked | merged
    // Park context (set only while mergeStatus === 'parked'): why the auto-merge could not complete and
    // which files conflict. Feeds the manual-merge handoff prompt (pasteMergePrompt); cleared otherwise.
    this.mergeReason = null;
    this.mergeConflicts = [];
    this.worktreeNotice = null;  // operator-facing blocker (e.g. integration branch missing)
    // Live worktree-change detection (see checkWorktreeChange / _startWorktreeWatcher). The watcher
    // is the fast fs.watch nudge; _lastWorktreeSig dedups the cheap signature so only real deltas
    // broadcast; the debounce timer coalesces a write/turn-end burst into one recompute.
    this._worktreeWatcher = null;
    this._worktreeCheckTimer = null;
    this._lastWorktreeSig = null;

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
    // Scheduled-revival lifecycle is likewise tracking-only: it must never reach the
    // StatusSource (a pending wakeup is metadata, not a state signal).
    if (raw && (raw.signal === "wakeup-scheduled" || raw.signal === "cron-created" || raw.signal === "cron-deleted")) {
      this._trackWakeup(raw);
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

  // Apply one scheduled-revival signal to the pending-wakeup set. ADVISORY metadata only: a Stop
  // with a pending wakeup IS a finished turn, so unlike activeAgents this NEVER gates a transition.
  // Cancellation is invisible (Esc fires no hook, claude-code#58235), so entries are self-expiring
  // via the lazy prune in _pendingWakeup. Payload field names are extracted defensively; the exact
  // shapes are an open probe item (plan WS2 step 0) and a miss simply drops the signal.
  _trackWakeup(raw) {
    if (!this._detectScheduledWakeups) return;
    const payload = raw.payload || {};
    const ts = raw.ts || Date.now();
    if (raw.signal === "wakeup-scheduled") {
      const input = payload.tool_input || {};
      const delaySec = Number(input.delaySeconds);
      if (!Number.isFinite(delaySec) || delaySec <= 0) return;
      const key = `w${++this._wakeupSeq}`; // collision-free synthetic key (one-shot, never re-referenced)
      const reason = typeof input.reason === "string" && input.reason ? input.reason : null;
      if (wakeupTracker.addWakeup(this._wakeups, key, { kind: "wakeup", fireAt: ts + delaySec * 1000, reason, ts })) {
        this._emitWakeupChange();
      }
      return;
    }
    if (raw.signal === "cron-created") {
      // No cron-expression parsing in v1: tracked without a fire time, bounded by the cron TTL.
      // A synthetic-key fallback entry (id fields not yet pinned, plan WS2 step 0) can never be
      // matched by its CronDelete; it is TTL/PTY-exit bound only. Advisory chip, acceptable.
      const key = wakeupTracker.extractCronTaskId(payload) || `c${++this._wakeupSeq}`;
      if (wakeupTracker.addWakeup(this._wakeups, key, { kind: "cron", fireAt: null, reason: null, ts })) {
        this._emitWakeupChange();
      }
      return;
    }
    // cron-deleted
    const key = wakeupTracker.extractCronTaskId(payload);
    if (!key) return;
    if (wakeupTracker.removeWakeup(this._wakeups, key)) this._emitWakeupChange();
  }

  // Pruned earliest pending revival, or null. Returns null when detection is off.
  _pendingWakeup() {
    if (!this._detectScheduledWakeups) return null;
    wakeupTracker.pruneWakeups(this._wakeups, Date.now());
    const e = wakeupTracker.earliestWakeup(this._wakeups);
    if (!e) return null;
    return { at: e.fireAt, kind: e.kind, reason: e.reason };
  }

  _emitWakeupChange() {
    this.emit("wakeup-change", { pendingWakeup: this._pendingWakeup() });
  }

  // Drop all pending revivals (PTY exit, (re)start): scheduled tasks are session-scoped and die
  // with the PTY. Emits a clearing delta only if something was pending.
  _clearWakeups() {
    if (this._wakeups.size === 0) return;
    this._wakeups.clear();
    this._emitWakeupChange();
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
    // A turn end (`ready`) is the precise moment a batch of edits/commits has settled, so refresh the
    // review diff right then (debounced). The signature dedup makes a no-change turn a cheap no-op.
    if (s.signal === "ready") this._scheduleWorktreeCheck();
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
      path: this.path,
      state: this.state,
      sleeping: this._sleeping,
      dangerouslySkipPermissions: this.dangerouslySkipPermissions,
      ephemeral: this.ephemeral,
      isWorktree: this.isWorktree,
      activeAgents: this._activeAgentCount(),
      pendingWakeup: this._pendingWakeup(),
      mergeStatus: this.mergeStatus,
      worktreeNotice: this.worktreeNotice,
      effectiveBase: (this._effectiveBase || this._integrationBranch || null)
        ?.replace(/^[^/]+\//, "") ?? null,
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

  // The integration branch this session forks from / merges into. Public read accessor so the backend
  // can group sessions for the shared integration-ref watcher without reaching into the private field.
  get integrationBranch() {
    return this._integrationBranch;
  }

  // Resolve the SHARED gitdir (git rev-parse --git-common-dir) of this session's worktree: the dir every
  // linked worktree writes refs/reflogs into, and the key the backend groups integration-ref watchers by.
  // One-shot on the cold provision/adopt path, so sync git is fine (MEMORY single-event-loop-no-sync-git:
  // keep one-shot cold paths sync). Absolute-ized against the worktree; null off a worktree / on failure.
  _resolveCommonGitDir() {
    if (!this.worktreeDir) return null;
    try {
      const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: this.worktreeDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
      });
      return path.resolve(this.worktreeDir, out.trim());
    } catch { return null; }
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
    this.commonGitDir = this._resolveCommonGitDir();
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
      // Keep watching the kept-for-review worktree: a post-exit CLI merge/clean still self-heals fast.
      this._setMergeStatus("pending-review");
    } else {
      this._stopWorktreeWatcher(); // dir about to be removed
      try { this._gitWorkspace.discard({ projectPath: this.path, workspace: this._workspace }); } catch { /* best-effort */ }
      this._workspace = null;
      this.worktreeDir = null;
      this.commonGitDir = null;
      this.isWorktree = false;
      this._setMergeStatus("none");
    }
  }

  _setMergeStatus(status, extra = {}) {
    this.mergeStatus = status;
    // Retain the park context only while parked; clear it on any other status so a stale conflict list
    // never rides a later clean/merged state.
    if (status === "parked") {
      this.mergeReason = extra.reason || null;
      this.mergeConflicts = Array.isArray(extra.conflicts) ? extra.conflicts : [];
    } else {
      this.mergeReason = null;
      this.mergeConflicts = [];
    }
    this.emit("merge-status", { id: this.id, mergeStatus: status, ...extra });
  }

  // Hand a parked merge back to the Claude agent running in this session's worktree: build a context-rich
  // prompt (why it parked + the conflicting files + how to rebase/resolve) and PASTE it into the live PTY.
  // Bracketed paste keeps the multi-line prompt one input (raw newlines would submit each line); no
  // trailing CR, so the operator reviews then sends. No-op unless parked with a live PTY.
  pasteMergePrompt() {
    if (this._destroyed) return { ok: false, reason: "destroyed" };
    if (this.mergeStatus !== "parked") return { ok: false, reason: "not-parked" };
    if (!this.ptyProcess || !this._ptyAlive) return { ok: false, reason: "no-pty" };
    const prompt = buildMergePrompt({
      branch: this._workspace ? this._workspace.branch : null,
      target: this._integrationBranch,
      reason: this.mergeReason,
      conflicts: this.mergeConflicts,
      worktreeDir: this.worktreeDir,
    });
    this.write(`\x1b[200~${prompt}\x1b[201~`);
    return { ok: true };
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

  // Two diffs the review sidebar draws a hard line between: COMMITTED changes (the commits a merge would
  // move into the integration branch) and still-UNCOMMITTED working-tree changes (vs HEAD, shown for
  // awareness but never merged until committed). `hasCommits` is the merge gate: nothing committed means
  // nothing to merge. NEW files are made visible in the uncommitted diff via intent-to-add. The committed
  // range and the gate are taken from the LIVE relationship to the integration branch, so they reset
  // themselves once the work lands on it (whether merged via Glissa or out-of-band).
  async getDiff() {
    const empty = { stat: "", diff: "" };
    if (!this.worktreeDir) return { committed: empty, uncommitted: empty, hasCommits: false };
    // maxBuffer is generous: a review diff can be large, and unlike execFileSync (which threw on
    // overflow and we recovered partial e.stdout) execFile would error and gitOut would yield "".
    const opts = { cwd: this.worktreeDir, encoding: "utf8", timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
    const g = (args) => gitOut(args, opts); // awaited serially below: order matters (intent-to-add before the diffs)
    await g(["add", "-N", "--", "."]); // intent-to-add so new files appear in the uncommitted diff
    // What a merge would actually move is the commits on HEAD that the integration branch does NOT already
    // have. Derive both the committed range (merge-base..HEAD) and the gate (integrationBranch..HEAD) from
    // the LIVE relationship to the integration branch, NOT the stored fork SHA: baseSha is captured at fork
    // and goes stale once the integration branch advances or this branch is merged out-of-band (e.g. a CLI
    // rebase-then-FF), which would otherwise keep phantom-showing already-merged commits as "needs merge".
    // Fall back to baseSha (then to nothing) only when no integration branch is known - unit tests and
    // in-place, non-isolated sessions, where baseSha (or the worktree-vs-HEAD diff) is all we have.
    let base = "";
    let aheadCount = "0";
    const baseRef = await this._resolveEffectiveBase(opts);
    if (baseRef && (await g(["rev-parse", "--verify", "--quiet", baseRef])).trim()) {
      base = (await g(["merge-base", baseRef, "HEAD"])).trim();
      aheadCount = (await g(["rev-list", "--count", `${baseRef}..HEAD`])).trim();
    } else if (this.baseSha) {
      base = this.baseSha;
      aheadCount = (await g(["rev-list", "--count", `${base}..HEAD`])).trim();
    }
    const committed = base
      ? { stat: (await g(["diff", "--stat", `${base}..HEAD`])).trim(), diff: await g(["diff", `${base}..HEAD`]) }
      : empty;
    const uncommitted = { stat: (await g(["diff", "--stat", "HEAD"])).trim(), diff: await g(["diff", "HEAD"]) };
    const hasCommits = aheadCount !== "" && aheadCount !== "0";
    // Self-heal a stranded review gate. mergeStatus is set at PTY exit / boot re-adoption, but the
    // operator can commit-and-merge or clean the worktree inside the still-live PTY (the design is
    // "commit as you go"), which leaves the gate stuck at pending-review/parked over an empty diff - a
    // phantom "1" on the review badge with "No changes in this worktree" below it. getDiff is the one
    // place that re-derives what is actually reviewable, so when nothing is, drop the gate to 'none'
    // (broadcast via the merge-status event, which clears the badge and the note).
    if ((this.mergeStatus === "pending-review" || this.mergeStatus === "parked")
        && committed.diff.trim() === "" && uncommitted.diff.trim() === "") {
      this._setMergeStatus("none");
    }
    return { committed, uncommitted, hasCommits };
  }

  // Resolve the best git base ref for diff computation. Tries HEAD@{upstream} first so a
  // session whose branch has an upstream (e.g. Claude Code ran `git push --set-upstream`)
  // uses the tracked remote ref rather than the globally configured _integrationBranch. Falls
  // back to _integrationBranch when no upstream is configured. Caches in _effectiveBase so
  // toSnapshot() can read a display-ready value synchronously.
  async _resolveEffectiveBase(opts) {
    const upstream = (await gitOut(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "HEAD@{upstream}"], opts)).trim();
    if (upstream && !upstream.includes("@{")) {
      this._effectiveBase = upstream; // e.g. "origin/main"
      return upstream;
    }
    this._effectiveBase = this._integrationBranch || null;
    return this._integrationBranch || null;
  }

  // A CHEAP fingerprint of the worktree's reviewable state: uncommitted+untracked (porcelain), the
  // HEAD sha (commits), and how far HEAD is ahead of the integration branch (the merge gate, which a
  // cross-session merge into develop can move WITHOUT touching this worktree). One `git status` + a
  // couple of rev-parses, all timeout-bounded. Returns { sig, dirty, ahead } or null with no worktree.
  // This is the funnel's truth; the heavy getDiff() is only fetched for the selected session.
  async _computeWorktreeSignature() {
    if (!this.worktreeDir) return null;
    const opts = { cwd: this.worktreeDir, encoding: "utf8", timeout: 10000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
    // --no-optional-locks: this runs on background event nudges (watchers / turn-end), so it must NEVER
    // take git's index lock and contend with the session's own `git add` / `git commit` in the worktree.
    const run = (args) => gitStrict(["--no-optional-locks", ...args], opts);
    let status, head, ahead = "0", behind = "0", rebaseInProgress = false;
    try {
      status = await run(["status", "--porcelain"]);
      head = (await run(["rev-parse", "HEAD"])).trim();
      // A missing integration branch is EXPECTED (this probe exits non-zero); swallow only that, so it
      // never counts as the worktree being unreadable.
      let baseRef = null;
      try {
        const resolved = await this._resolveEffectiveBase(opts);
        if (resolved && (await run(["rev-parse", "--verify", "--quiet", resolved])).trim()) baseRef = resolved;
      } catch { /* no integration branch / upstream */ }
      if (!baseRef && this.baseSha) baseRef = this.baseSha;
      if (baseRef) ahead = (await run(["rev-list", "--count", `${baseRef}..HEAD`])).trim();
      // `behind` is measured against the MERGE TARGET (the local branch the merge engine fast-forwards),
      // NOT the effective/display base above: HEAD@{upstream} can sit at a stale commit while the local
      // integration branch moved, and the parked->pending-review demotion must mirror what an actual
      // merge would do. The two counts deliberately use different bases.
      try {
        const mergeTarget = this._integrationBranch || (this._workspace && this._workspace.base) || this.baseSha;
        if (mergeTarget && (await run(["rev-parse", "--verify", "--quiet", mergeTarget])).trim()) {
          behind = (await run(["rev-list", "--count", `HEAD..${mergeTarget}`])).trim();
        }
      } catch { /* no merge target; behind stays "0" */ }
      // In-progress rebase probe: a rebase can pause on a clean tree, which must never look mergeable.
      // The rev-parse calls stay async; the trailing fs.existsSync is a deliberate sync stat on an
      // already-resolved path (no git subprocess, no repo walk), cheap enough for this recurring path.
      const rebaseMerge = (await run(["rev-parse", "--git-path", "rebase-merge"])).trim();
      const rebaseApply = (await run(["rev-parse", "--git-path", "rebase-apply"])).trim();
      const resolveGitPath = (p) => (path.isAbsolute(p) ? p : path.resolve(this.worktreeDir, p));
      rebaseInProgress = fs.existsSync(resolveGitPath(rebaseMerge)) || fs.existsSync(resolveGitPath(rebaseApply));
    } catch {
      // Worktree momentarily unreadable (mid-rebase, lock contention, pruned dir). Return UNKNOWN, never
      // a false-empty signature: that would wrongly self-heal a real pending-review gate to 'none'.
      return null;
    }
    // behind/rebaseInProgress are demotion-condition inputs only; the change-detection hash is unchanged.
    const sig = crypto.createHash("sha1").update(`${status} ${head} ${ahead}`).digest("hex");
    return { sig, dirty: status.trim() !== "", ahead, behind, rebaseInProgress };
  }

  // The funnel every change TRIGGER converges on (turn-end hook, gitdir fs.watch, integration-ref watcher):
  // recompute the cheap signature, run the gate demotions (empty worktree -> 'none'; resolved parked
  // rebase -> 'pending-review' so Merge comes back), and emit `worktree-changed` so the dashboard
  // auto-refreshes the SELECTED session's diff. The emit dedups on the signature EXCEPT when a demotion
  // fired (a demotion must always broadcast). Suppressed mid-merge (the index is being rewritten) so a
  // transient never broadcasts.
  async checkWorktreeChange() {
    if (this._destroyed || !this.worktreeDir) return;
    if (this.mergeStatus === "merging") return;
    const sig = await this._computeWorktreeSignature();
    // Re-check liveness after the await: the session may have been destroyed or entered a merge while
    // the git probe ran, in which case a stale broadcast/demotion must not fire.
    if (this._destroyed || this.mergeStatus === "merging") return;
    if (!sig) return;
    // Gate demotions run BEFORE the signature dedup: a park can leave the worktree byte-identical to the
    // established baseline (a lost fast-forward does not abort the no-op rebase, and the merge flow never
    // resets _lastWorktreeSig), so a dedup-gated demotion would never fire and 'parked' would stick forever.
    let demoted = false;
    if ((this.mergeStatus === "pending-review" || this.mergeStatus === "parked")
        && !sig.dirty && (sig.ahead === "" || sig.ahead === "0")) {
      this._setMergeStatus("none");
      demoted = true;
    }
    // A parked merge whose worktree is clean, sits on top of the merge target (behind 0), and is not
    // mid-rebase is mergeable again: the rebase-then-FF will now succeed, so hand Merge back by demoting
    // to pending-review (NOT 'none': the committed work is still unmerged and reviewable).
    if (this.mergeStatus === "parked"
        && !sig.dirty && sig.ahead !== "" && sig.ahead !== "0"
        && (sig.behind === "" || sig.behind === "0") && !sig.rebaseInProgress) {
      this._setMergeStatus("pending-review");
      demoted = true;
    }
    if (sig.sig === this._lastWorktreeSig && !demoted) return;
    this._lastWorktreeSig = sig.sig;
    this.emit("worktree-changed", { id: this.id, sig: sig.sig });
  }

  // Debounced entry for the IMMEDIATE triggers (fs.watch onChange + the `ready` turn-end). Collapses a
  // burst (a commit touches several gitdir files; a turn-end can race the watch) into one check. The
  // backend's integration-ref watcher fan-out calls checkWorktreeChange() directly (its nudge is coarse).
  _scheduleWorktreeCheck() {
    if (this._destroyed || !this.worktreeDir || this._worktreeCheckTimer) return;
    this._worktreeCheckTimer = setTimeout(() => {
      this._worktreeCheckTimer = null;
      // Fire-and-forget: checkWorktreeChange catches its own git errors (returns a null signature),
      // so the only thing to guard here is an unexpected rejection becoming an unhandledRejection.
      this.checkWorktreeChange().catch(() => { /* best-effort; the watch + a later nudge retry */ });
    }, WORKTREE_CHECK_DEBOUNCE_MS);
    if (this._worktreeCheckTimer.unref) this._worktreeCheckTimer.unref();
  }

  // (Re)start the fs.watch over this session's gitdir. Idempotent: a fresh watcher replaces any prior
  // one, so it is safe to call on every provision/adopt/restart. A non-worktree (in-place) session has
  // no gitdir, so start() declines; an in-place session has no review worktree to track anyway.
  // _lastWorktreeSig is reset so the first post-(re)start check re-establishes the baseline.
  _startWorktreeWatcher() {
    this._stopWorktreeWatcher();
    if (this._destroyed || !this.worktreeDir) return;
    this._worktreeWatcher = createWorktreeWatcher({
      worktreeDir: this.worktreeDir,
      onChange: () => this._scheduleWorktreeCheck(),
    });
    this._worktreeWatcher.start();
  }

  _stopWorktreeWatcher() {
    if (this._worktreeWatcher) {
      try { this._worktreeWatcher.stop(); } catch { /* best-effort */ }
      this._worktreeWatcher = null;
    }
    if (this._worktreeCheckTimer) {
      clearTimeout(this._worktreeCheckTimer);
      this._worktreeCheckTimer = null;
    }
    this._lastWorktreeSig = null;
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
      });
    } catch (err) {
      this._setMergeStatus("pending-review", { reason: err.message });
      return { merged: false, reason: err.message };
    }
    if (r.merged) {
      this._stopWorktreeWatcher();
      this._workspace = null;
      this.worktreeDir = null;
      this.commonGitDir = null;
      this.isWorktree = false;
      this._setMergeStatus("merged");
    } else if (r.parked) {
      this._setMergeStatus("parked", { reason: r.reason || null, conflicts: r.conflicts || [] });
    } else {
      this._setMergeStatus("pending-review", { reason: r.reason || null });
    }
    return r;
  }

  // Operator action behind the sidebar's "Merge" on a LIVE quiescent session (WAITING/IDLE/COMPLETE):
  // commit the worktree's changes, merge them into the integration branch, and rebase this worktree onto
  // it, KEEPING the session running on the same worktree (now on top of develop) so the operator commits
  // as they go. Unlike finishAndMerge it never ends the session or tears the worktree down. Refused only
  // while the PTY is actively working (RUNNING: we must not rewrite a worktree mid-edit); a session that
  // paused awaiting the operator (WAITING) is quiescent and mergeable, same as IDLE/COMPLETE. A rebase
  // conflict / lost FF PARKS (worktree preserved). Returns the engine result.
  mergeAndContinue() {
    if (this._destroyed) return { merged: false, reason: "destroyed" };
    if (!this._gitWorkspace || !this._workspace) return { merged: false, reason: "no-worktree" };
    if (!MERGEABLE_LIVE_STATES.includes(this.state)) {
      return { merged: false, reason: "not-continuable" };
    }
    this._setMergeStatus("merging");
    let r;
    try {
      r = this._gitWorkspace.mergeKeep({
        projectPath: this.path,
        workspace: this._workspace,
        targetBranch: this._integrationBranch,
      });
    } catch (err) {
      this._setMergeStatus("pending-review", { reason: err.message });
      return { merged: false, reason: err.message };
    }
    if (r.merged) {
      // Worktree kept alive on its branch (now == the integration tip); track the new base it sits on.
      if (r.baseSha) { this.baseSha = r.baseSha; this._workspace.baseSha = r.baseSha; }
      // Committed work merged out, so the gate normally returns to 'none'. But if the stashed uncommitted
      // work reapplied WITH conflicts, the worktree now holds conflict markers the operator must resolve -
      // surface that as pending-review instead of silently reporting clean.
      if (r.restoreConflict) this._setMergeStatus("pending-review", { reason: "restore-conflict" });
      else this._setMergeStatus("none");
    } else if (r.parked) {
      this._setMergeStatus("parked", { reason: r.reason || null, conflicts: r.conflicts || [] });
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
    this.commonGitDir = this._resolveCommonGitDir();
    this.isWorktree = true;
    this._setMergeStatus("pending-review");
    // Watch the re-adopted worktree too: an operator who merges/cleans it from the CLI then sees the
    // stranded gate self-heal fast, without starting the session.
    this._startWorktreeWatcher();
  }

  // Operator action: throw the worktree away unmerged (junction-safe), reset to no-worktree.
  discardWorktree() {
    this._stopWorktreeWatcher(); // stop before the dir is removed (fs.watch would ENOENT)
    if (this._gitWorkspace && this._workspace) {
      try { this._gitWorkspace.discard({ projectPath: this.path, workspace: this._workspace }); } catch { /* best-effort */ }
    }
    this._workspace = null;
    this.worktreeDir = null;
    this.commonGitDir = null;
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

    // Detection re-sync: entering a quiescent state while the PTY may still be spinning (a
    // premature hook `ready`, e.g. a Stop fired mid-work) would otherwise strand the card: the
    // title source's working-kind dedup latch swallows every later spinner frame, so no signal
    // ever maps IDLE/COMPLETE -> new_output -> RUNNING. Re-opening the latch lets the next REAL
    // braille frame re-wake the card (self-heal); on a genuine completion the next frame is the
    // idle glyph, which cannot wake anything from here.
    if (to === STATES.IDLE || to === STATES.COMPLETE) {
      this._titleSource.resyncWorkingLatch();
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
    // Listen for changes in the (isolated) worktree so the review diff stays live without a manual
    // refresh. Idempotent across restart-reuse; a non-git in-place session has no worktreeDir to watch.
    if (this.worktreeDir) this._startWorktreeWatcher();
    if (this.state === STATES.DORMANT) {
      this.transition("user_start");
    }
    this._receivedFirstOutput = false;
    this._sleeping = false;
    // A (re)started PTY begins with no live background sub-agents; drop any stale ids from a prior run.
    this._clearAgents();
    this._clearWakeups();
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
    // Lever B: preventive anti-slop note (no-op unless antiSlopPrompt is on). Pushed before
    // the initial-prompt positional so the prompt stays the final argv element.
    const antiSlopArgs = buildAntiSlopArgs(this._antiSlopPrompt);
    if (antiSlopArgs.length > 0) {
      claudeArgs.push(...antiSlopArgs);
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
        detectScheduledWakeups: this._detectScheduledWakeups,
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
    let proxyBaseUrl = "";
    if (this._getProxyBaseUrl) {
      try {
        proxyBaseUrl = this._getProxyBaseUrl() || "";
      } catch {
        proxyBaseUrl = ""; // a broken getter must never block a spawn
      }
    }
    return buildSpawnEnv(process.env, { proxyBaseUrl });
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
    this._clearWakeups();
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

    // ORDER CONTRACT: settle the worktree BEFORE emitting "exit". On a changed tree _settleWorktreeOnExit
    // sets mergeStatus='pending-review' and keeps worktreeDir; parkToDormant's queued once("exit") handler
    // (_discardAndReset) runs after this and INTENTIONALLY overrides that to discard. Moving the emit ahead
    // of this call would let Park discard an unsettled worktree. Keep settle-then-emit.
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
    // Skipped while a teardown (park/finish/force-restart) is queued: respawning here would
    // race the queued exit handler. restart() also self-guards on _teardownPending, so this is
    // belt-and-suspenders, but skipping the call keeps the intent explicit. (The sleep-kill timer
    // never restarts directly; it only kills + sets _autoKilled, deferring the restart to here.)
    if (this._autoKilled
        && !this._teardownPending()
        && (this.state === STATES.DONE || this.state === STATES.FAILED)) {
      this.restart();
    }
  }

  // Shared teardown mutex. True while any lifecycle action has a kill-then-settle queued (a live park,
  // a "Merge & finish", or a force-restart). Every action that could respawn a PTY or rewrite/discard a
  // worktree checks this first, so a second action cannot race the queued once("exit") handler of the
  // first (e.g. Park kills -> the card shows DONE -> a Restart click would otherwise respawn on the very
  // worktree Park is about to discard). Each action clears ONLY its own flag in its own exit callback.
  _teardownPending() {
    return this._pendingRestart || this._finishing || this._pendingPark;
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
    // A queued teardown (park/finish/force-restart) is mid-flight; respawning now would race its
    // exit handler. This is the load-bearing guard: once a live park's killSession() flips the card
    // to DONE, the dashboard's Restart button sends a plain `restart` (not `force-restart`), so the
    // mutex MUST live here too, not only in forceRestart.
    if (this._teardownPending()) return false;
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
    if (this._destroyed || this._teardownPending()) {
      return { ok: false, reason: this._teardownPending() ? "in-progress" : "destroyed" };
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
    if (this._teardownPending()) return;
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

  // Park a quiescent or finished session back to DORMANT so its card parks for reuse. DESTRUCTIVE: any
  // unmerged worktree (pending-review OR parked) is discarded. Acceptance is QUIESCENT-ONLY, mirroring
  // finishAndMerge - MERGEABLE_LIVE_STATES (WAITING/IDLE/COMPLETE) + the finished states (DONE/FAILED).
  // RUNNING is REFUSED (force-restart it first): unlike forceRestart, which kills anything because restart
  // *preserves* the worktree, Park *discards*, so it must never nuke a tree the agent is mid-edit in.
  // Gated by the shared _teardownPending mutex. Returns { ok, pending?, reason? }.
  parkToDormant() {
    if (this._destroyed || this._teardownPending()) {
      return { ok: false, reason: this._teardownPending() ? "in-progress" : "destroyed" };
    }
    if (this.state === STATES.DONE || this.state === STATES.FAILED) {
      this._discardAndReset(); // settled: PTY already dead, discard (if any) + reset now
      return { ok: true };
    }
    if (MERGEABLE_LIVE_STATES.includes(this.state)) {
      // Live but quiescent: end first (we must not discard a worktree the PTY is still in), then on the
      // real exit settle -> discard -> reset. Mirrors finishAndMerge's structure exactly.
      this._pendingPark = true;
      this.once("exit", () => {
        this._pendingPark = false; // clear ONLY our own flag
        if (!this._destroyed) this._discardAndReset();
      });
      this.killSession(); // -> DONE now; _handlePtyExit settles the worktree, then our handler discards
      return { ok: true, pending: true };
    }
    // RUNNING / INITIALIZING / STARTING / DORMANT: no-op, state untouched.
    return { ok: false, reason: "not-parkable" };
  }

  // Discard any live worktree, then return to DORMANT. discardWorktree nulls worktreeDir, so the
  // (unchanged) user_reset guard then passes. On a tree already settled clean by _settleWorktreeOnExit
  // the worktreeDir!=null check skips the redundant discard; on a changed tree (settled as
  // pending-review) this intentionally OVERRIDES that and throws the work away - the destructive point
  // of Park, which the dashboard's inline confirm warns about.
  _discardAndReset() {
    if (this.worktreeDir != null) this.discardWorktree();
    this.resetToDormant();
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
    this._stopWorktreeWatcher();
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
