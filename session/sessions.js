const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const pty = require("node-pty");
const { EventEmitter } = require("node:events");
const { execFileSync, execFile } = require("../server/child-process-safe");
const { STATES, MERGEABLE_LIVE_STATES, KILLABLE_STATES, RESTARTABLE_STATES } = require("../shared/states");
const { isSameDirectoryPath } = require("../shared/paths");
const { createOscTitleSource } = require("../detection/osc-title-source");
const { createStatusSource } = require("../detection/status-source");
const { createWorktreeWatcher, readWorktreeGitdirPointer } = require("../detection/worktree-watch");
const { createIntegrationRefWatcher } = require("../detection/integration-ref-watch");
const { writeSessionSettings } = require("../detection/settings-injector");
const {
  classifyClaudeKind,
  buildSpawnCommand,
  CLAUDE_CMD,
} = require("./core/spawn-command");
const { buildSpawnEnv } = require("./core/spawn-env");
const { buildAntiSlopArgs } = require("./core/anti-slop-prompt");
const {
  TRANSITIONS,
  GUARDS,
  ENTRY_HOOKS,
  EXIT_HOOKS,
} = require("./core/state-machine");
const { mapSignalToEvent } = require("./core/status-mapper");
const { decideExitTransition } = require("./core/exit-transition");
const { buildMergePrompt } = require("./core/merge-prompt");
const { createOutputRing } = require("./core/output-ring");
const { decideSignatureDemotion, decideDiffSelfHeal } = require("./core/merge-gate");
const { decideAutoRebase, AUTO_REBASE_STATES } = require("./core/rebase-gate");
const {
  parseLeftRightCount,
  decideBranchSyncState,
  parseRemoteFromUpstream,
  decideResyncAction,
  firstGitErrorLine,
} = require("../server/core/branch-sync-core");
const { normalizePackNames } = require("../server/core/pack-core");
const { defaultBuiltRoot, resolveBuiltPack } = require("../server/pack-builder");
const { buildPackNotice, listStalePacks } = require("./core/pack-notice");
const packReadTracker = require("./core/pack-read-tracker");
const agentTracker = require("./core/agent-tracker");
const { decideGateRelease, DEFAULT_GATE_RELEASE_SETTLE_MS } = require("./core/gate-release");
const { pushDecision } = require("./core/decision-log");
const wakeupTracker = require("./core/wakeup-tracker");
const { RESUME_ID_RE } = require("./core/auto-resume");

const KILL_POLL_INTERVAL_MS = 200;
const KILL_MAX_WAIT_MS = 3000;
const SLEEP_KILL_TIMEOUT_MS = 15 * 60 * 1000;

// States in which Claude's TUI is up and reading input, so a bracketed paste actually lands. A
// deferred paste (pasteTextWhenReady) waits for the session to enter one of these; INITIALIZING and
// STARTING deliberately are not here (bytes written before first_output are read by nothing).
const PASTE_READY_STATES = new Set([
  STATES.IDLE, STATES.RUNNING, STATES.WAITING, STATES.COMPLETE,
]);

// The two states an operator can dismiss a card out of: an unanswered prompt and an unopened result.
const DISMISSIBLE_STATES = new Set([STATES.WAITING, STATES.COMPLETE]);

// Trailing debounce for the worktree-change funnel: a single `git commit` touches
// several gitdir files and a turn-end can race the fs.watch, so collapse a burst
// into one signature recompute. The triggers are all event-driven (no poll): the per-worktree gitdir
// fs.watch, the turn-end hook, and the integration-branch reflog fs.watch.
const WORKTREE_CHECK_DEBOUNCE_MS = 400;

// Stop one fs.watch listener and hand back the null its field should hold. Best-effort: a watcher whose
// directory already vanished throws from close(), which must never break a teardown.
function stopWatcher(watcher) {
  if (watcher) {
    try { watcher.stop(); } catch { /* already gone */ }
  }
  return null;
}

// Async git. The review-gate probes (signature, diff) run on hot, recurring paths
// (every turn-end, every gitdir fs.watch nudge, and every integration-branch reflog
// nudge). The synchronous execFileSync they used to call BLOCKS the single Node
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

// Table-driven mapping from a resyncBranch decision (decideResyncAction's return) to the concrete git
// command + past-tense outcome label. 'none' has no entry (the caller's lookup misses and mutates
// nothing), so a diverged branch can never fall through to a command by construction.
const RESYNC_COMMANDS = {
  "ff-merge": ({ upstream, opts }) => ({ args: ["merge", "--ff-only", upstream], opts, successAction: "fast-forwarded" }),
  "ff-fetch": ({ branch, remote, opts }) => ({ args: ["fetch", "--quiet", remote, `${branch}:${branch}`], opts: { ...opts, timeout: 8000 }, successAction: "fast-forwarded" }),
  push: ({ branch, remote, opts }) => ({ args: ["push", remote, branch], opts: { ...opts, timeout: 15000 }, successAction: "pushed" }),
};

// ---------------------------------------------------------------------------
// State machine. Status is driven by structural signals from StatusSource
// (Claude Code hooks = authoritative; OSC-0 title = degraded fallback), mapped
// to transitions in _onStatus per the signal x state matrix. There is NO
// screen-content parsing and NO detection timer here. The transition tables
// (TRANSITIONS, GUARDS, ENTRY_HOOKS, EXIT_HOOKS) live in
// session/core/state-machine.js; the transition() engine below consumes them.
// ---------------------------------------------------------------------------

// The card marker only asks whether this cwd IS a linked worktree, so a pointer at all is the whole
// answer (unlike the watch target, which must also still exist on disk).
function detectLinkedWorktree(dir) {
  return readWorktreeGitdirPointer(dir) !== null;
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
    // Background sub-agent detection (see session/core/agent-tracker.js). When true (default), a
    // main-agent Stop fired while a background sub-agent is still running does NOT complete the card.
    // The kill switch (config detectBackgroundAgents=false) makes the session ignore subagent signals
    // so behavior is exactly as before. agentTtlMs bounds a dropped-SubagentStop leak.
    detectBackgroundAgents = true,
    agentTtlMs = agentTracker.DEFAULT_AGENT_TTL_MS,
    // shell/monitor background_tasks entries never get a completion hook (no SubagentStop, no
    // TaskCompleted/TeammateIdle), so past this long since the declaring Stop they stop gating.
    shellTaskTtlMs = agentTracker.DEFAULT_SHELL_TASK_TTL_MS,
    // A declared teammate entry is near-redundant with the counted SubagentStart/Stop map (real
    // teammate work is already tracked there); it only matters for a dropped SubagentStart, while
    // an idle-but-alive teammate is declared running forever. Bounding it short keeps a dropped
    // TeammateIdle/TaskCompleted from pinning the card WORKING for the full agent TTL.
    teammateTaskTtlMs = agentTracker.DEFAULT_TEAMMATE_TASK_TTL_MS,
    // Quiet window a drained gate-held ready waits out before it actually releases. Why a
    // window at all: see session/core/gate-release.js.
    gateReleaseSettleMs = DEFAULT_GATE_RELEASE_SETTLE_MS,
    // Scheduled-revival visibility (see session/core/wakeup-tracker.js). When true (default), a
    // ScheduleWakeup / cron task seen via PostToolUse hooks rides toSnapshot().pendingWakeup as an
    // ADVISORY card chip ("sleeping until ~HH:MM"); it never gates a transition. The kill switch
    // (config detectScheduledWakeups=false) drops the PostToolUse hook group at the source and
    // makes the session ignore the signals, so behavior is exactly as before.
    detectScheduledWakeups = true,
    // Resolved claude command ({ path, kind }). Defaults to the module-load
    // resolution; tests inject a stub to exercise the spawn branches deterministically.
    spawnCommand = CLAUDE_CMD,
    // Headless-lane spawn options (PR review, PostHog investigations). initialPrompt is appended as
    // the FINAL positional arg (proven safe as a single argv element on the direct-exe path by the
    // Phase-0 probe); extraClaudeArgs carries e.g. ["-p", "--model", "sonnet"]; ephemeral marks
    // lane-owned sessions that live in a separate map and must never be persisted to config.json.
    initialPrompt = null,
    extraClaudeArgs = [],
    ephemeral = false,
    // Resume a prior Claude conversation by session id. At spawn this becomes `--resume <id>`, which
    // Claude resolves across ALL linked worktrees of the repo - so a card can pick up a conversation
    // that was started in a DIFFERENT worktree's project dir. Sticky: a non-fork resume keeps the same
    // id, so a restart re-resumes idempotently. Null = fresh conversation (the historical behavior).
    resumeSessionId = null,
    // Lever B: append a fixed anti-slop note to the system prompt at spawn (user sessions,
    // opt-in via config antiSlopPrompt). Off by default and never set for the headless lane
    // sessions. See session/core/anti-slop-prompt.js.
    antiSlopPrompt = false,
    // Optional Claude Code permissions ({ deny: [...] }) merged into the injected --settings file
    // (the PR-review and PostHog lane deny-lists). Null for ordinary user sessions.
    settingsPermissions = null,
    // Extra environment variables for the spawned PTY, merged over the scrubbed base env. Lane
    // credentials that must NOT be exported process-wide (a poller-owned API key would otherwise
    // reach every user session) travel this way. Null for ordinary user sessions.
    spawnEnv = null,
    // Opt-in: add `enableAllProjectMcpServers: true` to the injected --settings file so a headless
    // (`-p`) session loads the project's `.mcp.json` servers (e.g. Playwright MCP) without an
    // interactive trust prompt it can never answer. Off by default; set by a headless lane that needs it.
    enableProjectMcp = false,
    rtkPath = null,
    // Context packs delivered at spawn: names of built packs whose `current` dir becomes an
    // --add-dir (see _resolvePacks and AGENTS.md "Context Packs"). Comes from the project record's
    // `packs` array, or from a headless lane's own pack config.
    packs = [],
    // Where built packs live. Defaults to ~/.glissa/packs/built; tests point it at a fixture root.
    packsBuiltRoot = null,
    // Count Read tool calls that land inside a delivered pack dir (config kill switch). Costs one
    // matcher-scoped PostToolUse hook, and only for a session that actually delivers packs.
    packReadTelemetry = true,
    // Inject the managed statusLine relay so Claude Code publishes its OFFICIAL plan rate limits to
    // Glissa (config usage.planLimits; see AGENTS.md "Usage Tracking"). The relay chains whatever
    // statusLine the operator already had, because a managed one REPLACES it.
    planLimits = false,
    // PTY spawner seam. Defaults to node-pty; tests inject a fake to assert the
    // spawn wiring (file/args) without launching a real process.
    ptySpawn = null,
    // Kill executor seam (Windows taskkill). Defaults to async execFile; tests inject a fake to assert
    // the kill args (['/PID', pid, '/T', '/F']) without spawning a real taskkill. Mirrors ptySpawn/
    // spawnCommand injection. Signature: (args, opts, cb) -> matches child_process.execFile.
    killProc = null,
    // Worktree isolation (injected by backend). When gitWorkspace + integrationBranch are present and
    // `path` is a git repo, the session runs in a throwaway worktree forked off integrationBranch and
    // merges back on review. Absent (unit tests, no-git) -> runs in place at `path` exactly as before.
    gitWorkspace = null,
    integrationBranch = null,
    // Rebase a quiescent, clean worktree onto the integration branch as soon as that branch moves
    // (config worktreeAutoRebase). Read at construction like every other spawn-time option, so a
    // settings change applies to the next construction of this session, not to the live one.
    autoRebase = true,
    // Master kill switch for the live cross-session review liveness: with it false the integration-ref
    // watcher is never started, so a branch move reaches this session only via the turn-end recheck.
    liveWorktreeReview = true,
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
    // Ring buffer of recent PTY chunks (see session/core/output-ring.js for the
    // eviction, monotonic-total, and offset semantics).
    this._outputRing = createOutputRing(replayBufferKB * 1024);
    this._killPollTimer = null;
    // In-flight reap (taskkill) promise from the most recent kill(), or null. The server lifecycle
    // (shutdown -> requestRestart/requestShutdown) awaits these before exit/respawn so the PTY tree
    // (cmd/claude/conhost) is reaped instead of orphaned. Set in kill(); never gates a transition.
    this._killReap = null;
    this._sleeping = false;
    this._sleepKillTimer = null;
    this._autoKilled = false;
    this._destroyed = false;
    // A paste waiting for this session's TUI to come up (see pasteTextWhenReady). At most one.
    this._pendingPaste = null;
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
    // Advisory: which flavor of "waiting on you" a WAITING session is parked on (null | 'permission' |
    // 'elicitation'), surfaced as a card chip. Set from an authoritative hook awaiting-input signal;
    // mirrors activeAgents/pendingWakeup in that it NEVER gates a transition. Cleared on resume,
    // user_input, working, any transition leaving WAITING, /clear, and PTY exit/restart.
    this._pendingPromptKind = null;
    // Live background sub-agents, keyed by Claude Code agent_id -> last-seen ts. Non-empty means
    // background work is still running after the main agent's Stop, which gates ready->task_complete
    // (see _onStatus / mapSignalToEvent). Lazily pruned by agentTtlMs; never drives a state transition.
    this._detectBackgroundAgents = detectBackgroundAgents;
    this._activeAgents = new Map();
    this._agentTtlMs = agentTtlMs;
    this._shellTaskTtlMs = shellTaskTtlMs;
    this._teammateTaskTtlMs = teammateTaskTtlMs;
    this._gateReleaseSettleMs = gateReleaseSettleMs;
    // Authoritative in-flight background work declared by the latest Stop/SubagentStop
    // payload (`background_tasks`, Claude Code v2.1.145+): an array of { id, type } entries,
    // or null when the running Claude does not send it. Covers background Bash tasks and
    // native-team teammates that the SubagentStart/Stop counting cannot see. Cleared on
    // resume (new turn) and PTY exit/(re)start; each Stop refreshes it. TTL-bounded (lazy,
    // in _activeAgentCount) so a stale snapshot cannot pin the card out of COMPLETE forever.
    this._bgDeclared = null;
    this._bgDeclaredTs = 0;
    // Task ids known settled out-of-band via TaskCompleted / TeammateIdle hooks. An
    // idle-but-alive teammate stays status:running in Claude's task registry (ground truth,
    // 2.1.199 binary), so every later Stop re-declares it; this set filters those entries
    // out of the gate. Survives resume (the teammate stays idle across the user's next
    // prompt); pruned to the declared snapshot on each refresh; an id is removed when a
    // TaskCreated reactivates it; cleared with the rest on PTY exit/(re)start.
    this._idleTaskIds = new Set();
    // Teammates known idle BY NAME: a TeammateIdle payload carries only the name, and a declared
    // entry can NOT be matched to one (a teammate's `description` is the spawn prompt, live-
    // verified), so the drain is count-based rather than per-id. Map<name, ts>, insertion-ordered.
    // Persists across resume (an idle teammate stays declared by every later Stop); subtracted
    // from the declared teammate count in agent-tracker.declaredActiveCount, clamped there to the
    // live teammate count. Re-gated by TaskCreated (reactivation) or a SubagentStart whose
    // agent_id embeds the name (`a<name>-<hex>`, the only signal for a teammate the lead re-wakes
    // via mailbox, since no TaskCreated ever fires for a named-agent teammate). TTL-pruned lazily in
    // _activeAgentCount so a stale name can never mask a future same-named teammate forever.
    this._idleTeammateNames = new Map();
    // The teammate-entry ids seen in the last background_tasks snapshot. Persists across resume
    // exactly like _idleTeammateNames (both outlive the snapshot they were learned from), so a
    // departed teammate can be detected on the NEXT snapshot: without this, a name idled for a
    // teammate that then shuts down stays in _idleTeammateNames forever and wrongly offsets a
    // later, unrelated teammate declared under a different id (the count-based subtraction has
    // no other way to tell "the teammate I idled" from "a different teammate that happens to
    // keep the count the same"). Cleared in _clearAgents.
    this._declaredTeammateIds = new Set();
    // A main-agent `ready` suppressed by the activeAgents gate, held so the card can still
    // complete when the background count later drains WITHOUT another Stop (idle teammate
    // declared in background_tasks, dropped SubagentStop bounded only by the TTL). Without
    // this latch the suppressed ready is gone forever and the card pins WORKING until some
    // new signal happens to arrive. Cleared by any newer activity (working/resume/
    // awaiting-input), any state change since the stash, /clear, and PTY exit/(re)start.
    // Released in _evaluateGateHeldReady, which re-validates the hold against live evidence
    // (session/core/gate-release.js) instead of trusting a drained count alone.
    this._gateHeldReady = null;
    this._gateHeldReadyTimer = null;
    // When the hold was first observed free of background work, or null while it is still gating.
    // Evaluations are event/TTL driven, so the first look that SEES the drain is what starts the
    // settle window: carrying a timestamp from the last still-gated look released a held ready
    // instantly at the drain, before the mailbox wake could disprove it (false COMPLETE, 2026-08-14).
    this._gateQuietSince = null;
    // Arrival order of the signals reaching _onStatus, and the sequence number of the last
    // non-ready (activity) one. A hold stashed BEFORE that activity is stale: the main agent
    // opened a new turn, so it must never complete the card (incident 2026-07-30; see
    // session/core/gate-release.js). Sequence rather than clock: signals share milliseconds.
    this._signalSeq = 0;
    this._lastActivitySeq = 0;
    // Decision trace: why each detection/gate/notification decision came out the way it did. Pure
    // observability (session/core/decision-log.js owns the ring), read by getDebugState and mirrored
    // into the recorder; nothing in the detection path reads it back.
    this._decisionLog = [];
    // Components behind the last _activeAgentCount() result, so a trace entry can say WHICH source
    // gated a ready (counted sub-agents vs a declared background_tasks snapshot) instead of a total.
    this._agentBreakdown = { counted: 0, declared: 0, idleNames: 0, idleTasks: 0 };
    // True between a SessionStart(source: clear|compact) hook and the next real
    // UserPromptSubmit: the TUI redraw around /clear flashes a spinner + idle glyph in
    // the OSC title, which would otherwise open a fake work cycle (RUNNING) and close
    // it with a false COMPLETE ("finished working" on every /clear). While latched,
    // title signals are dropped; hooks still flow (they are authoritative).
    this._titleQuiet = false;
    // Pending scheduled revivals, keyed by cron task id or a synthetic one-shot key. Advisory
    // only (see _trackWakeup); lazily pruned (fireAt + grace / cron TTL); never a transition.
    this._detectScheduledWakeups = detectScheduledWakeups;
    this._wakeups = new Map();
    this._wakeupSeq = 0;
    this._spawnCommand = spawnCommand;
    this._initialPrompt = initialPrompt;
    this._extraClaudeArgs = Array.isArray(extraClaudeArgs) ? extraClaudeArgs : [];
    this._resumeSessionId = resumeSessionId || null;
    this._suppressResumeCapture = false;
    this._antiSlopPrompt = !!antiSlopPrompt;
    this.ephemeral = !!ephemeral;
    this._settingsPermissions = settingsPermissions;
    this._spawnEnv = spawnEnv;
    this._enableProjectMcp = !!enableProjectMcp;
    this._rtkPath = rtkPath || null;
    // Configured pack names, and the versions actually delivered by the last spawn (empty until one
    // resolves; a configured-but-unbuilt pack never appears here, only in the decision trace).
    const packNames = normalizePackNames(packs);
    for (const warning of packNames.warnings) console.warn(`[session:${name}] ${warning}`);
    this._packs = packNames.names;
    this._packsBuiltRoot = packsBuiltRoot;
    this._deliveredPacks = [];
    // Live pack-notice channel: latest built version per pack the backend pushed after a rebuild, and
    // whether the resulting staleness still owes this session one notice on its next UserPromptSubmit
    // hook response (see notePackUpdate / takePackNoticeContext).
    this._latestPackVersions = new Map();
    this._packNoticePending = false;
    // Consumption telemetry for those delivered packs: per-pack read counts, plus a since-notice
    // count armed the moment a staleness notice is taken (session/core/pack-read-tracker.js).
    this._packReadTelemetry = packReadTelemetry !== false;
    this._planLimits = planLimits === true;
    this._packReads = packReadTracker.createPackReadState();
    this._ptySpawn = ptySpawn || ((file, args, opts) => pty.spawn(file, args, opts));
    // Async kill executor (taskkill). Default wraps execFile; the callback form keeps the call truly
    // non-blocking. Injected in tests to assert the kill without spawning a real process.
    this._killProc = killProc || ((args, opts, cb) => execFile("taskkill", args, opts, cb));

    // -- Worktree isolation state (see _provisionWorktree / _settleWorktreeOnExit) --
    this._gitWorkspace = gitWorkspace;
    this._integrationBranch = integrationBranch;
    this._autoRebase = autoRebase !== false;
    this._liveWorktreeReview = liveWorktreeReview !== false;
    this._autoRebasing = false;    // re-entry mutex: one auto-rebase per session at a time
    this._rebaseConflictKey = null; // head::target the last auto-rebase conflicted on (see _maybeAutoRebase)
    this._effectiveBase = null;    // cached result of _resolveEffectiveBase(); null until first diff
    this._resyncPromise = null;    // in-flight resyncBranch() call, so a second click rides the same one
    this._worktreeRoot = worktreeRoot;
    this._worktreeShare = worktreeShare;
    this.worktreeDir = null;     // active session worktree cwd (null = in-place at this.path)
    this._startPending = null;   // in-flight start() promise (single-flight; see start())
    this.commonGitDir = null;    // shared gitdir all linked worktrees write refs into (git rev-parse
                                 // --git-common-dir); where the integration branch's reflog is watched
    this.baseSha = null;         // integration-branch SHA the worktree forked from
    this._workspace = null;      // opaque git-workspace handle for merge/discard
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
    this._integrationWatcher = null;
    this._worktreeCheckTimer = null;
    this._lastWorktreeSig = null;

    this._titleSource = createOscTitleSource({ stabilizationMs: titleStabilizationMs });
    this._statusSource = createStatusSource({
      sessionId: id,
      ...(statusConflictMs != null ? { conflictWindowMs: statusConflictMs } : {}),
      ...(statusDedupMs != null ? { dedupWindowMs: statusDedupMs } : {}),
    });
    this._titleSource.on("signal", (s) => {
      if (this._titleQuiet) return; // /clear redraw noise; see _titleQuiet above
      this._statusSource.ingest(s);
    });
    this._statusSource.on("status", (s) => this._onStatus(s));
    this._statusSource.on("meta", (m) => this._onMeta(m));
  }

  setRecorder(recorder) {
    this._recorder = recorder;
  }

  // -- Private timer fields (one shape: replace any pending timer, null the field from inside the
  // callback, unref only where named). The kill and sleep-kill timers deliberately do NOT unref: the
  // process must stay alive long enough to finish the kill they drive.

  _armTimer(field, ms, fn, { unref = false } = {}) {
    this._clearTimer(field);
    this[field] = setTimeout(() => {
      this[field] = null;
      fn();
    }, ms);
    if (unref && typeof this[field].unref === "function") this[field].unref();
  }

  _clearTimer(field) {
    if (!this[field]) return;
    clearTimeout(this[field]);
    this[field] = null;
  }

  // -- Detection signal handling (replaces all content scraping) --

  // Push a hook callback's normalized signal into the StatusSource. Called by the
  // shared HookRouter the backend registers per session.
  ingestHookSignal(raw) {
    if (this._destroyed) return;
    this._hookSeen = true;
    // Pack-read telemetry fires once per Read tool call, so recording each callback would bury a
    // signals recording under them; the footer's aggregate carries it instead (a `full` capture,
    // whose whole point is the raw stream, still keeps every callback).
    const quietRead = raw?.signal === "pack-read" && this._recorder && !this._recorder.recordsData;
    if (this._recorder && raw && raw.event && !quietRead) {
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
    // Task lifecycle is tracking-only too: TaskCreated/TaskCompleted/TeammateIdle drain (or
    // reactivate) individual entries of the declared background_tasks gate. TeammateIdle is
    // the only signal that an idle-but-alive teammate (still declared status:running on every
    // Stop) has stopped gating completion.
    if (raw && (raw.signal === "task-created" || raw.signal === "task-completed" || raw.signal === "teammate-idle")) {
      this._trackTaskLifecycle(raw);
      return;
    }
    // Scheduled-revival lifecycle is likewise tracking-only: it must never reach the
    // StatusSource (a pending wakeup is metadata, not a state signal).
    if (raw && (raw.signal === "wakeup-scheduled" || raw.signal === "cron-created" || raw.signal === "cron-deleted")) {
      this._trackWakeup(raw);
      return;
    }
    // Pack reads are consumption telemetry, not detection: they must never reach the StatusSource
    // (a Read mid-turn says nothing about whether the turn finished).
    if (raw && raw.signal === "pack-read") {
      this._trackPackRead(raw);
      return;
    }
    // Keys off whichever main-agent hook arrives, never one event name: Claude Code does not
    // reliably fire SessionStart. Tracking-only background-agent signals returned above and are
    // deliberately excluded, since they can describe a different Claude session than the one
    // this card resumes (AGENTS.md, "Auto-Resume and Shutdown").
    if (raw?.payload) this._captureClaudeSessionId(raw.payload.session_id, raw.payload.source);
    // /clear and /compact fire SessionEnd+SessionStart with NO UserPromptSubmit and no
    // Stop; the only movement they cause is TUI title noise. Reset the merged stream
    // (cancels a held ready from the pre-clear turn) and latch titles quiet until the
    // next real prompt.
    // An authoritative awaiting-input hook (PermissionRequest / permission_prompt / elicitation*
    // Notification) carries WHICH kind of prompt this is; see mapHookPromptKind in hook-source.js.
    if (raw && raw.signal === "awaiting-input") this._setPendingPromptKind(raw.promptKind || null);
    if (raw && raw.signal === "session-start") this._onSessionStartHook(raw);
    if (raw && raw.signal === "resume") {
      this._titleQuiet = false;
      this._setPendingPromptKind(null);
      // Drop the held ready BEFORE the override clear: clearing may drain the count to 0,
      // and a stale ready must not fire COMPLETE on the very prompt that starts a new turn.
      this._clearGateHeldReady();
      this._clearBgDeclared(); // a new turn starts with no settled background snapshot
      // Only a hook ever produces "resume" (UserPromptSubmit; the title source cannot), so this
      // means exactly "authoritative user prompt". Emitted separately from the state-change this
      // signal may (or may not) cause: both "working" (title) and "resume" (hook) are IMMEDIATE
      // in status-source.js, so the racing title spinner can win the IDLE/COMPLETE->RUNNING
      // transition first, carrying signal "working" instead of "resume" in its detail. The
      // notify-cycle reset must not depend on winning that race, so the backend resets on this
      // event directly instead of only reading the transition detail.
      this.emit("user-prompt");
    }
    // A main-agent Stop carries the authoritative background-work count (v2.1.145+).
    if (raw && raw.signal === "ready" && raw.source === "hook") {
      this._applyBackgroundTasks(raw.payload);
    }
    this._statusSource.ingest(raw);
  }

  // clear/compact need the quiet-title handling below: nothing is running, nothing completed.
  // See _titleQuiet.
  _onSessionStartHook(raw) {
    const payload = raw.payload || {};
    const src = String(payload.source || "").toLowerCase();
    if (src !== "clear" && src !== "compact") return;
    this._resetDetectionSources({ quiet: true });
    this._clearGateHeldReady();
    this._setPendingPromptKind(null);
  }

  // Malformed/absent ids are a no-op: crash-safe persistence depends on this only ever recording
  // a real, resumable id. Mirrors into the live binding immediately, so a plain dashboard restart
  // after a PTY crash already resumes even without a server reboot; the backend listens for the
  // emitted event to persist it to config.json. Emits only on an actual CHANGE: every hook now
  // feeds this, and each emission is a synchronous config.json write on a per-turn path.
  _captureClaudeSessionId(id, source) {
    if (this._suppressResumeCapture) return;
    if (typeof id !== "string" || !RESUME_ID_RE.test(id)) return;
    if (id === this._resumeSessionId) return;
    this.setResumeConversation(id);
    this.emit("claude-session-id", { id, source: source || null });
  }

  // Advisory pending-prompt-kind setter (see _pendingPromptKind above). Emits 'prompt-kind-change'
  // only when the value actually changes, mirroring _emitAgentsChange/_emitWakeupChange.
  _setPendingPromptKind(kind) {
    const next = kind || null;
    if (next === this._pendingPromptKind) return;
    this._pendingPromptKind = next;
    this.emit("prompt-kind-change", { pendingPromptKind: next });
  }

  // Reconcile against an authoritative `background_tasks` payload array. A declaration of
  // 0 running entries also drains the counted id map (bounds a dropped SubagentStop
  // immediately instead of waiting for the TTL prune). The idle set is pruned to ids still
  // declared: an id gone from Claude's registry no longer needs remembering. Absent field
  // (older Claude) changes nothing.
  _applyBackgroundTasks(payload) {
    if (!this._detectBackgroundAgents) return;
    const entries = agentTracker.extractBackgroundTasks(payload);
    if (entries === null) return;
    this._withAgentCount(() => this._reconcileDeclared(entries));
  }

  _reconcileDeclared(entries) {
    this._bgDeclared = entries;
    this._bgDeclaredTs = Date.now();
    const declaredIds = new Set(entries.map((e) => e.id).filter(Boolean));
    for (const id of this._idleTaskIds) {
      if (!declaredIds.has(id)) this._idleTaskIds.delete(id);
    }
    // A teammate id that was declared last snapshot but is gone from this one has departed
    // (shut down); any name idled against it no longer means anything, and left in place it
    // would wrongly offset a DIFFERENT teammate that happens to keep the surviving count the
    // same. See agent-tracker.evictDepartedTeammateNames for the eviction rule.
    this._declaredTeammateIds = agentTracker.evictDepartedTeammateNames(
      this._idleTeammateNames, this._declaredTeammateIds, entries,
    );
    // Deliberately no ageMs here: this snapshot is fresh (age 0), so weak (shell/monitor)
    // entries always count. Only _activeAgentCount ages them (see its declaredActiveCount call).
    // Same reasoning covers the teammate TTL: this raw count must see EVERY declared entry (it
    // only answers "did Claude declare zero"), so this._teammateTaskTtlMs is deliberately NOT
    // threaded in here either. Doing so could age out a teammates-only declaration and read as
    // zero, which would wrongly clear the counted map (this._activeAgents) out from under a
    // still-running turn the counted map alone would otherwise still be gating.
    //
    // The counted-map drain below must key off the RAW count (no idleNameCount): that heuristic
    // is Glissa-side bookkeeping, not something Claude declared, so it must never be the reason
    // a live counted agent_id gets wiped out from under a still-running turn.
    const rawDeclaredActive = agentTracker.declaredActiveCount(entries, this._idleTaskIds);
    if (rawDeclaredActive === 0 && this._activeAgents.size > 0) this._activeAgents.clear();
  }

  _clearBgDeclared() {
    if (this._bgDeclared === null) return;
    this._withAgentCount(() => {
      this._bgDeclared = null;
      this._bgDeclaredTs = 0;
    });
  }

  // Apply one TaskCreated/TaskCompleted/TeammateIdle signal to the idle bookkeeping.
  // Never a transition; a drain can release a gate-held ready via _emitAgentsChange.
  _trackTaskLifecycle(raw) {
    if (!this._detectBackgroundAgents) return;
    this._withAgentCount(() => this._applyTaskLifecycle(raw));
  }

  _applyTaskLifecycle(raw) {
    const p = raw.payload || {};
    const taskId = typeof p.task_id === "string" && p.task_id ? p.task_id : null;
    const name = typeof p.teammate_name === "string" ? p.teammate_name : "";
    if (raw.signal === "task-created") {
      // New background work: like subagent-start, it invalidates a held ready, and a
      // reactivated teammate (new task) must gate again.
      this._clearGateHeldReady();
      // A reactivated teammate cancels any idle-by-name record for it, even on a payload
      // with no task_id (the name map is independent of the id bookkeeping).
      if (name) this._idleTeammateNames.delete(name);
      if (taskId) this._idleTaskIds.delete(taskId);
      return;
    }
    if (raw.signal === "task-completed") {
      if (!taskId) return;
      this._idleTaskIds.add(taskId);
      // Task ids and subagent agent_ids can share a namespace; a no-op removal is harmless.
      agentTracker.removeAgent(this._activeAgents, taskId);
      // A payload that carries both an id and a name must drain by id only ONCE: leaving the
      // name behind would also subtract it from a different, still-live teammate.
      if (name) this._idleTeammateNames.delete(name);
      return;
    }
    // teammate-idle: name only, no task_id, and a declared entry can NOT be matched to a name
    // (its `description` is the spawn prompt, live-verified), so the idle is recorded BY NAME:
    // agent-tracker's declaredActiveCount subtracts the idle-name count from the declared
    // teammate count, so several simultaneous idle teammates each drain the gate by one.
    // A nameless payload can never be re-gated (no a<name>- prefix match), so recording it would
    // be a pure false-drain vector with no way back. Ground truth says the payload always carries
    // teammate_name; drop it rather than guess a synthetic key.
    if (!name) return;
    this._idleTeammateNames.set(name, Date.now());
  }

  // Apply one subagent-start/stop signal to the live set. Off (kill switch) or a payload with no
  // agent_id is ignored, so the count stays 0 and behavior is exactly as before. Emits an
  // 'agents-change' delta only when the live count actually changed.
  _trackSubagent(raw) {
    if (!this._detectBackgroundAgents) return;
    const agentId = raw.payload?.agent_id;
    if (raw.signal === "subagent-start") {
      // Fresh background work is newer activity: a held ready from before it must not release
      // when only the OLDER ids drain (subagent-start never reaches _onStatus's clearing path).
      this._clearGateHeldReady();
      // Teammate agent_ids embed the spawn name (live-captured: "a<name>-<hex>"). This is the
      // only re-gating signal for a teammate the lead wakes via mailbox: no TaskCreated ever
      // fires for a named-agent teammate (memory: named-agent-teammate-hook-sequence).
      if (typeof agentId === "string") {
        this._withAgentCount(() => {
          for (const name of this._idleTeammateNames.keys()) {
            const prefix = `a${name}-`;
            // The remainder after the prefix must be pure hex: without this check, idle name
            // "foo" would be falsely re-gated by a DIFFERENT teammate "foo-bar" starting
            // (agent_id "afoo-bar-1a2b" also starts with "afoo-").
            if (agentId.startsWith(prefix) && /^[0-9a-f]+$/i.test(agentId.slice(prefix.length))) {
              this._idleTeammateNames.delete(name);
            }
          }
        });
      }
    }
    if (agentId) {
      const changed = raw.signal === "subagent-start"
        ? agentTracker.addAgent(this._activeAgents, agentId, raw.ts || Date.now())
        : agentTracker.removeAgent(this._activeAgents, agentId);
      if (changed) this._emitAgentsChange();
    }
    // SubagentStop also carries `background_tasks` (v2.1.145+): reconcile even when the
    // id was missing/unknown, so a drain is authoritative rather than TTL-bounded.
    if (raw.signal === "subagent-stop") this._applyBackgroundTasks(raw.payload);
  }

  // Pruned count of live background sub-agents. Lazy prune (no per-session timer) bounds a dropped
  // SubagentStop. Returns 0 when detection is off so the gate is inert.
  _activeAgentCount() {
    if (!this._detectBackgroundAgents) {
      this._agentBreakdown = { counted: 0, declared: 0, idleNames: 0, idleTasks: 0 };
      return 0;
    }
    const now = Date.now();
    agentTracker.pruneAgents(this._activeAgents, now, this._agentTtlMs);
    // Same lazy TTL bound as the counted map: a stale idle-by-name record (e.g. a teammate
    // that never gets reactivated) can never mask a future, unrelated same-named teammate.
    agentTracker.pruneAgents(this._idleTeammateNames, now, this._agentTtlMs);
    // Same lazy TTL bound as the counted map: a snapshot whose refreshing Stop never
    // arrived (hung background task, dropped hook) ages out instead of suppressing
    // completion forever.
    if (this._bgDeclared !== null && now - this._bgDeclaredTs >= this._agentTtlMs) {
      this._bgDeclared = null;
      this._bgDeclaredTs = 0;
    }
    // The declared count (minus out-of-band idled ids/names) wins when larger: it sees
    // background Bash tasks and teammates that never fire SubagentStart. The counted map wins
    // when larger: it is fresher than a pre-drain Stop snapshot.
    const declared = agentTracker.declaredActiveCount(
      this._bgDeclared, this._idleTaskIds, this._bgDeclared ? now - this._bgDeclaredTs : 0,
      this._shellTaskTtlMs, this._idleTeammateNames.size, this._teammateTaskTtlMs,
    );
    this._agentBreakdown = {
      counted: this._activeAgents.size,
      declared,
      idleNames: this._idleTeammateNames.size,
      idleTasks: this._idleTaskIds.size,
    };
    return Math.max(this._activeAgents.size, declared);
  }

  // Append one decision-trace entry. Mirrored to the forensic recorder only when it is genuinely
  // new: a collapsed repeat (an unchanged gate verdict re-evaluated on a TTL tick) already has a
  // line on disk.
  _recordDecision(entry) {
    const outcome = pushDecision(this._decisionLog, entry);
    if (outcome === "appended" && this._recorder) this._recorder.writeDecision(entry);
  }

  // Push a decision the BACKEND made for this session (notification category + reason, and the
  // notification lifecycle hops it caused) into the same per-session trace, so the debug overlay
  // shows the detection decision and its notification outcome as one sequence.
  recordNotifyDecision(entry) {
    this._recordDecision(entry);
  }

  _emitAgentsChange() {
    // Internal event; the backend listener already has the session (id/name), so carry only the count.
    this.emit("agents-change", { activeAgents: this._activeAgentCount() });
    this._evaluateGateHeldReady();
  }

  // Run one piece of background-work bookkeeping and emit a single 'agents-change' delta only if
  // the live count actually moved. Every mutator of the counted map, the declared snapshot and the
  // idle sets goes through here, so the emit rule lives in one place.
  _withAgentCount(mutate) {
    const before = this._activeAgentCount();
    mutate();
    if (this._activeAgentCount() !== before) this._emitAgentsChange();
  }

  // Hold a main-agent ready that only the background-agent gate suppressed;
  // decideGateRelease (session/core/gate-release.js) decides whether it may ever fire.
  // The latch re-open makes "activity since the stash" observable at all, since the
  // edge-triggered title source would otherwise never re-report a still-spinning title
  // (full rationale: AGENTS.md, Background sub-agents / completion gate).
  _stashGateHeldReady(s) {
    const now = Date.now();
    this._gateHeldReady = {
      source: s.source,
      signal: s.signal,
      confidence: s.confidence,
      state: this.state,
      ts: now,
      seq: this._signalSeq,
    };
    // Each hold's settle tracking starts clean; the first evaluation below observes the real count.
    this._gateQuietSince = null;
    this._titleSource.resyncWorkingLatch();
    this._evaluateGateHeldReady();
  }

  _armGateTimer(ms) {
    this._armTimer("_gateHeldReadyTimer", ms, () => this._evaluateGateHeldReady(), { unref: true });
  }

  // How long a still-gated hold should wait before re-checking. The TTLs it waits on age from
  // their own timestamps (the declaring Stop, each SubagentStart), so a full interval measured
  // from now bounded the stuck-WORKING window at up to 2x the TTL: a snapshot 60s into its 90s
  // teammate TTL got a fresh 90s. Capped by the old full interval so this can only ever shorten
  // the wait; msUntilNextDrain returns strictly positive values, so no floor is needed.
  _gateRecheckMs(now) {
    const fullInterval = Math.min(this._agentTtlMs, this._shellTaskTtlMs, this._teammateTaskTtlMs) + 50;
    const remaining = agentTracker.msUntilNextDrain({
      countedAgents: this._activeAgents,
      declaredEntries: this._bgDeclared,
      declaredTs: this._bgDeclaredTs,
      idleIds: this._idleTaskIds,
      now,
      agentTtlMs: this._agentTtlMs,
      weakTtlMs: this._shellTaskTtlMs,
      teammateTtlMs: this._teammateTaskTtlMs,
    });
    if (remaining === null) return fullInterval;
    return Math.min(remaining + 50, fullInterval);
  }

  _clearGateHeldReady() {
    this._gateHeldReady = null;
    this._gateQuietSince = null;
    this._clearTimer("_gateHeldReadyTimer");
  }

  // Re-validate the held ready and act on the verdict. Runs whenever the background count changes
  // (a drain) and whenever the timer re-checks; the timer covers the TTL-only drain, where no
  // further hook ever arrives and only the lazy prune in _activeAgentCount moves the count.
  _evaluateGateHeldReady() {
    const held = this._gateHeldReady;
    if (!held || this._destroyed) return;
    const now = Date.now();
    const activeAgents = this._activeAgentCount();
    // First look that sees the drain: the settle window runs from HERE, never from an earlier look.
    if (activeAgents === 0 && this._gateQuietSince === null) this._gateQuietSince = now;
    const { decision, waitMs } = decideGateRelease({
      heldState: held.state,
      currentState: this.state,
      activeAgents,
      stashSeq: held.seq,
      lastActivitySeq: this._lastActivitySeq,
      stashTs: held.ts,
      quietSince: this._gateQuietSince || 0,
      now,
      settleMs: this._gateReleaseSettleMs,
    });
    // Recorded before acting, so a cancel/release leaves its evidence even though the branches
    // below drop the hold the entry describes.
    this._recordDecision({
      ts: now,
      kind: "gate",
      decision,
      waitMs,
      active: activeAgents,
      heldSeq: held.seq,
      lastActivitySeq: this._lastActivitySeq,
      quietMs: now - held.ts,
    });
    if (decision === "cancel") {
      this._clearGateHeldReady();
      return;
    }
    if (decision === "gated") {
      // Still gating, so no quiet window has started yet; the look that sees the drain starts it.
      this._gateQuietSince = null;
      this._armGateTimer(this._gateRecheckMs(now));
      return;
    }
    if (decision === "wait") {
      this._armGateTimer(waitMs);
      return;
    }
    const event = mapSignalToEvent(held.signal, this.state, held.confidence, 0);
    this._clearGateHeldReady();
    if (event) this.transition(event, { source: held.source, signal: held.signal, deferred: true });
  }

  // Drop all live ids + the declared snapshot + the task-lifecycle bookkeeping (PTY exit,
  // (re)start). Emits a clearing delta only if something was live.
  _clearAgents() {
    const had = this._activeAgentCount() > 0;
    this._activeAgents.clear();
    this._bgDeclared = null;
    this._bgDeclaredTs = 0;
    this._idleTaskIds.clear();
    this._idleTeammateNames.clear();
    this._declaredTeammateIds.clear();
    if (had) this._emitAgentsChange();
  }

  // Drop both signal sources back to a clean stream, and optionally latch the title source quiet or
  // clear the background-work bookkeeping with them. Called from a PTY (re)start, a PTY exit, /clear
  // and sleep. `quiet` omitted leaves the latch alone (sleep freezes state, it does not re-open a turn).
  _resetDetectionSources({ quiet, clearTracking = false } = {}) {
    this._titleSource.reset();
    this._statusSource.reset();
    if (quiet !== undefined) this._titleQuiet = quiet;
    // Ahead of the caller's transition, never after: a drain-release here would fire a COMPLETE
    // before the process_exit that follows it.
    if (clearTracking) this._clearDetectionTracking();
  }

  // The full background-work reset a PTY start or exit needs. Order matters: a pending held ready
  // must go FIRST, because _clearAgents emits an agents-change that would otherwise release it.
  _clearDetectionTracking() {
    this._clearGateHeldReady();
    this._clearAgents();
    this._clearWakeups();
    this._setPendingPromptKind(null);
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
    // Any non-ready signal is proof the turn a held ready announced did not settle. Recorded as
    // arrival order so decideGateRelease is the ONE place that judges a hold stale (it cancels
    // any hold stashed before this); no separate eager-clear path to keep in sync.
    this._signalSeq += 1;
    if (s.signal !== "ready") this._lastActivitySeq = this._signalSeq;
    // A working signal means the operator answered (or the agent resumed) - the prompt this
    // session was waiting on no longer applies.
    if (s.signal === "working") this._setPendingPromptKind(null);
    // Pure decision in session/core/status-mapper.js; this wrapper owns the side effects:
    // the _destroyed guard + _lastSignal write above, and the transition below. The detail
    // { source, signal } is uniform across every firing case (byte-identical to the prior
    // per-branch details), so it is assembled here rather than in the pure mapper.
    const active = this._activeAgentCount();
    const event = mapSignalToEvent(s.signal, this.state, s.confidence, active);
    // A ready suppressed ONLY by the background-agent gate is held, not dropped: when the
    // count drains without another Stop (idle teammate, dropped SubagentStop) the drain
    // releases it and the card still completes (see _evaluateGateHeldReady). Decided before
    // the transition below, which cannot change the answer (a fired event rules the hold out)
    // but would move this.state under the second mapper call.
    const gateHeld = !event && s.signal === "ready" && active > 0
      && !!mapSignalToEvent(s.signal, this.state, s.confidence, 0);
    this._recordDecision({
      ts: Date.now(),
      kind: "signal",
      signal: s.signal,
      source: s.source,
      confidence: s.confidence || null,
      state: this.state,
      seq: this._signalSeq,
      active,
      ...this._agentBreakdown,
      event: event || null,
      action: event ? "transition" : (gateHeld ? "gate-held" : "no-op"),
    });
    if (event) this.transition(event, { source: s.source, signal: s.signal });
    if (gateHeld) this._stashGateHeldReady(s);
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

  // Whether this session has ever received a Claude Code hook callback. The notify-gate RUNNING
  // reset (session/core/notify-gate.js decideNotification) falls back to the legacy per-RUNNING
  // reset for a degraded, title-only session, since it has no resume signal to key off.
  get hookSeen() {
    return this._hookSeen;
  }

  get sleeping() {
    return this._sleeping;
  }

  // Whether write() would actually reach a terminal. The same three conditions pasteMergePrompt
  // guards on, exposed for callers outside this file (the upload route pastes a saved image path and
  // must refuse - and delete the file - rather than write into a dead PTY nobody can see).
  get hasLivePty() {
    return !this._destroyed && !!this.ptyProcess && !!this._ptyAlive;
  }

  // True from forceRestart()'s kill through its queued exit handler (see forceRestart / restart).
  // The state-change this window fires is a transient user_kill on the way back to a respawn, not
  // an intentional stop - a listener that treats every user_kill as "gone for good" (e.g. the
  // backend's wasActive persistence, graceful-shutdown-auto-resume design B) must read this first.
  get pendingRestart() {
    return this._pendingRestart;
  }

  // Bind (or clear, with a falsy id) the conversation this session resumes on its next spawn. Set by the
  // control layer when the operator picks a conversation; persisted on the project record so it survives
  // a server restart. Takes effect on the next start()/restart() - never mutates a live PTY.
  setResumeConversation(id) {
    this._resumeSessionId = id || null;
  }

  get resumeSessionId() {
    return this._resumeSessionId;
  }

  _prepareRestart(options = {}) {
    if (options.fresh !== true) return;
    // The dying PTY's late SessionEnd hook must not re-capture the id this fresh restart clears.
    this._suppressResumeCapture = true;
    this.setResumeConversation(null);
    this.emit("resume-cleared", { id: this.id });
  }

  // Normalized pack names this session would deliver on its next spawn. Public so the backend can
  // compare a reloaded project record against the live session without reaching into the private field.
  get packNames() {
    return [...this._packs];
  }

  // Record the version a pack was just rebuilt to (the backend's pack-updated fan-out). Only a pack
  // this session actually SPAWNED against can arm a notice: a session that never delivered the pack
  // has no stale context to warn about. Returns whether this call armed one, for the caller's logs.
  notePackUpdate(name, version) {
    if (typeof name !== "string" || typeof version !== "string" || version.length === 0) return false;
    const delivered = this._deliveredPacks.find((pack) => pack.name === name);
    if (!delivered) return false;
    if (this._latestPackVersions.get(name) === version) return false;
    this._latestPackVersions.set(name, version);
    // A rebuild that landed back on the version this session runs on leaves nothing to say.
    if (delivered.version === version) return false;
    this._packNoticePending = true;
    return true;
  }

  // The pack-staleness notice this session owes its next turn, or null. Consumed on read (the hook
  // route injects it into ONE UserPromptSubmit response), and re-armed only when a newer version
  // arrives through notePackUpdate - never once per turn for the same staleness.
  takePackNoticeContext() {
    if (!this._packNoticePending) return null;
    this._packNoticePending = false;
    const notice = buildPackNotice(this._deliveredPacks, this._latestPackVersions);
    if (!notice) return null;
    const names = listStalePacks(this._deliveredPacks, this._latestPackVersions).map((pack) => pack.name);
    const ts = Date.now();
    // Restart the per-pack count here, so the next reads answer whether the notice actually made the
    // agent re-open the pack it was told had changed.
    packReadTracker.armNoticeCounter(this._packReads, ts);
    this._recordDecision({ kind: "pack", ts, decision: "notice", names });
    return notice;
  }

  // Count one Read tool call against the delivered pack whose dir contains it. Tracking-only, and
  // silent for every other path: the hook is matcher-scoped to Read, so most callbacks describe
  // ordinary repo files the session was going to read anyway.
  _trackPackRead(raw) {
    if (!this._packReadTelemetry || this._deliveredPacks.length === 0) return;
    const name = packReadTracker.packForPath(raw?.payload?.tool_input?.file_path, this._deliveredPacks);
    if (!name) return;
    packReadTracker.notePackRead(this._packReads, name, raw.ts || Date.now());
  }

  // Per-pack read counters for the delivered packs, newest state: the debug overlay and the
  // recording footer report this shape.
  packReadSummary() {
    return packReadTracker.summarizePackReads(this._packReads, this._deliveredPacks);
  }

  // A spawn re-resolves what is delivered, so notices owed by the previous spawn are void.
  _clearPackNotice() {
    this._latestPackVersions.clear();
    this._packNoticePending = false;
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
      resumeSessionId: this._resumeSessionId,
      activeAgents: this._activeAgentCount(),
      // Delivered packs plus what the agent has actually read of them. Built field by field, not
      // spread: the resolved `dir` is a server-side absolute path a paired remote client has no use for.
      packs: this._deliveredPacks.map((pack) => {
        const stats = packReadTracker.packReadStats(this._packReads, pack.name);
        const entry = { name: pack.name, version: pack.version, reads: stats.reads };
        if (stats.readsSinceNotice !== null) entry.readsSinceNotice = stats.readsSinceNotice;
        return entry;
      }),
      pendingWakeup: this._pendingWakeup(),
      pendingPromptKind: this._pendingPromptKind,
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

  // Resolve the SHARED gitdir (git rev-parse --git-common-dir) of this session's worktree: the dir every
  // linked worktree writes refs/reflogs into, and where this session watches its integration branch's reflog.
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

  // Create (or reuse) this session's isolated worktree off the integration branch. A missing local
  // integration branch is auto-created by git-workspace.js (from origin/<branch>, then main/master, then
  // HEAD); this method returns false ONLY when that creation itself FAILED (reason:'no-base-branch'):
  // the session then stays put with a surfaced notice and never runs in the operator's real tree.
  // Isolation disabled (no injected gitWorkspace/integrationBranch) or a non-git path -> runs in place
  // (returns true, worktreeDir null).
  async _provisionWorktree() {
    if (!this._gitWorkspace || !this._integrationBranch) return true;
    if (this.worktreeDir && fs.existsSync(this.worktreeDir)) return true; // reuse across restart/wake
    let ws;
    try {
      ws = await this._gitWorkspace.create({
        projectPath: this.path,
        teamId: "session",
        label: this.id,
        baseBranch: this._integrationBranch,
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
    if (ws && ws.reason === "branch-in-use") {
      // The conflicting branch is this session's UNIQUE branch (it embeds the session id), so the
      // worktree holding it is this session's own survivor: a boot-reconcile removal or an exit-time
      // discard that failed on a locked dir (Windows: an orphaned Claude process keeps the cwd alive),
      // or a missed recreate carry. Re-adopt and run in it instead of degrading to the operator's real
      // tree. The one unsafe target is the main checkout itself (an operator `git checkout` of the
      // session branch): adopting that would treat the real tree as disposable, so it stays in place.
      let adopted = false;
      if (ws.branch && ws.conflictPath && fs.existsSync(ws.conflictPath)
          && !isSameDirectoryPath(ws.conflictPath, this.path)) {
        try {
          this.adoptWorktree({ worktreeDir: ws.conflictPath, branch: ws.branch });
          adopted = true;
        } catch (err) {
          // Survivor vanished mid-adopt (concurrent reconcile) or the adopt itself failed; log it so
          // an unrelated adopt bug is diagnosable, then fall through to the in-place notice.
          console.warn(`[session ${this.id}] survivor adopt failed: ${err.message} - running in place`);
        }
      }
      if (adopted && this.worktreeDir) {
        this.worktreeNotice = null;
        // The failed removal that left this survivor stripped its junctions first (removeWorktreeLinks
        // runs before `worktree remove`), so re-share the gitignored context (node_modules, .claude,
        // ...) before the PTY spawns into a checkout with no dependencies. Idempotent: entries already
        // present are skipped. Promise.resolve: a sync fake engine's populate would otherwise make the
        // bare .catch throw and reject _startBody unhandled. (The self-heal check for the adopted
        // pending-review is armed in _startBody AFTER _startWorktreeWatcher, which would cancel one
        // scheduled here.)
        await Promise.resolve(
          this._gitWorkspace.populate({ projectPath: this.path, wtDir: this.worktreeDir, shareList: this._worktreeShare }),
        ).catch(() => { /* best-effort: the session runs without the shared context */ });
        this.emit("worktree-ready", { id: this.id, worktreeDir: this.worktreeDir, branch: ws.branch });
        return true;
      }
      this.worktreeNotice = `session branch already checked out at ${ws.conflictPath}; running in place`;
      this.emit("worktree-blocked", { id: this.id, branch: this._integrationBranch, notice: this.worktreeNotice });
    }
    if (!ws || !ws.isGit) { // non-git path (including an unadoptable branch-in-use): the ONLY in-place fallback
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
  //
  // A DESTROYED session's PTY exit is not the operator ending the work: it is a server shutdown or a
  // config-driven recreate, where the tree must SURVIVE so the next boot re-adopts it and auto-resume
  // lands back in the same worktree (the boot reconcile adopts a clean claimed tree; the recreate carry
  // settles it explicitly). Discarding here would delete the worktree merely because the process closed.
  async _settleWorktreeOnExit() {
    if (this._destroyed) return;
    if (!this._gitWorkspace || !this._workspace) return;
    if (!RESTARTABLE_STATES.includes(this.state)) return;
    if (await this.discardWorktreeIfClean()) return;
    // Keep watching the kept-for-review worktree: a post-exit CLI merge/clean still self-heals fast.
    this._setMergeStatus("pending-review");
  }

  // Shared keep-if-dirty/discard-if-clean settle: discard the worktree (junction-safe) only when it has
  // no uncommitted work, and report which way it went. Used by the exit settle above and the backend's
  // config-modify carry-over, so both apply the same never-destroy-work test.
  async discardWorktreeIfClean() {
    if (!this.worktreeDir) return false;
    if (await this.hasChanges()) return false; // unmerged work is never destroyed
    await this.discardWorktree();
    return true;
  }

  _setMergeStatus(status, extra = {}) {
    this.mergeStatus = status;
    // Retain the park context only while parked; clear it on any other status so a stale conflict list
    // never rides a later clean/merged state.
    const isParked = status === "parked";
    this.mergeReason = isParked ? (extra.reason || null) : null;
    this.mergeConflicts = isParked && Array.isArray(extra.conflicts) ? extra.conflicts : [];
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
    return this.pasteText(prompt);
  }

  // THE bracketed-paste seam for a multi-line prompt: one input the terminal takes literally (raw
  // newlines would submit each line) with no trailing CR, so the operator reviews it and presses
  // Enter. Every caller that hands a session a prompt to review goes through here.
  pasteText(text) {
    if (!this.hasLivePty) return { ok: false, reason: "no-pty" };
    this.write(`\x1b[200~${text}\x1b[201~`);
    return { ok: true };
  }

  /*
   * Paste as soon as this session can receive it, starting it first when it is DORMANT.
   *
   * A spawn is not a terminal: bytes written between pty.spawn and Claude's TUI coming up are read by
   * whatever is on stdin at the time and are simply lost. The structural signal for "the TUI is up"
   * already exists - STARTING -> IDLE on first_output - so the paste waits on that state-change
   * rather than on a sleep. It is dropped if the session dies on the way up or a newer deferred paste
   * replaces it; only one can be pending at a time.
   */
  pasteTextWhenReady(text, { timeoutMs = 120000 } = {}) {
    if (this._destroyed) return { ok: false, reason: "destroyed" };
    if (this.hasLivePty && PASTE_READY_STATES.has(this.state)) return this.pasteText(text);
    // Read before the listener is armed: a spawn that fails lands in FAILED, and re-reading the state
    // after start() would then take the restart branch and respawn in a loop.
    const stateBeforeWaiting = this.state;
    this._clearPendingPaste();
    const onStateChange = ({ to }) => {
      if (!PASTE_READY_STATES.has(to)) return;
      this._clearPendingPaste();
      this.pasteText(text);
    };
    const onExit = () => this._clearPendingPaste();
    const timer = setTimeout(() => this._clearPendingPaste(), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    this._pendingPaste = { timer, onStateChange, onExit };
    this.on("state-change", onStateChange);
    this.once("exit", onExit);
    if (stateBeforeWaiting === STATES.DORMANT) this.start();
    // A finished or failed card is the ordinary resting state of a project session, so opening an
    // issue against one respawns it exactly as the dashboard's Restart button would.
    if (RESTARTABLE_STATES.includes(stateBeforeWaiting)) this.restart();
    return { ok: true, deferred: true };
  }

  _clearPendingPaste() {
    const pending = this._pendingPaste;
    if (!pending) return;
    this._pendingPaste = null;
    clearTimeout(pending.timer);
    this.off("state-change", pending.onStateChange);
    this.off("exit", pending.onExit);
  }

  // True when the worktree has any uncommitted change vs its base, COUNTING untracked new files
  // (a feature session's deliverable is usually new files, which a plain `git diff` would miss).
  // Async: this runs on every PTY exit; a sync git subprocess here stalls every other session's
  // streaming. gitOut resolves "" on a git error, which keeps the old catch -> false semantics.
  async hasChanges() {
    if (!this.worktreeDir) return false;
    const out = await gitOut(["status", "--porcelain"], {
      cwd: this.worktreeDir, encoding: "utf8", timeout: 10000,
    });
    return out.trim().length > 0;
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
    const opts = { cwd: this.worktreeDir, encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 * 1024 };
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
    const { ref: baseRef, verified } = await this._resolveVerifiedBaseRef(g, opts);
    if (verified) {
      base = (await g(["merge-base", baseRef, "HEAD"])).trim();
      aheadCount = (await g(["rev-list", "--count", `${baseRef}..HEAD`])).trim();
    }
    if (!verified && baseRef) {
      base = baseRef;
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
    const healed = decideDiffSelfHeal(this.mergeStatus, committed.diff, uncommitted.diff);
    if (healed) this._setMergeStatus(healed);
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

  // The base ref both git probes measure against: the effective base above once it actually resolves
  // in this worktree, otherwise the stored fork SHA, otherwise null. `verified` says which of the two
  // the caller got, since only a resolved REF is worth a merge-base. `swallowResolveError` is the
  // signature probe's: a missing integration branch is EXPECTED there and must not be mistaken for
  // the unreadable worktree its outer catch reports as UNKNOWN.
  async _resolveVerifiedBaseRef(run, opts, { swallowResolveError = false } = {}) {
    let verifiedRef = null;
    try {
      const candidate = await this._resolveEffectiveBase(opts);
      if (candidate && (await run(["rev-parse", "--verify", "--quiet", candidate])).trim()) verifiedRef = candidate;
    } catch (err) {
      if (!swallowResolveError) throw err;
    }
    if (verifiedRef) return { ref: verifiedRef, verified: true };
    return { ref: this.baseSha || null, verified: false };
  }

  // Ahead/behind of the project's LOCAL base branch (this._integrationBranch, e.g. develop) against
  // its remote upstream tracking branch. Distinct from getDiff()'s worktree-vs-integration-branch
  // gate: this answers "did the operator's agents commit to local develop without pushing, or did
  // origin move while they worked", neither of which the worktree diff surfaces. Runs in `this.path`
  // (the main checkout, never a session worktree) and touches only refs - no checkout - so it never
  // disturbs whatever the operator has checked out there. The freshness fetch is best-effort and
  // timeout-bounded: a failure (offline, slow remote) still returns the (possibly stale) counts,
  // flagged `fetched: false` so the UI can hint the "behind" number may be outdated. Only called on an
  // explicit sidebar open/refresh request - never on a recurring timer.
  async getBranchSync() {
    const branch = this._integrationBranch;
    if (!branch || !this.path) return this._branchSyncNoUpstream(branch);
    const opts = { cwd: this.path, encoding: "utf8", timeout: 10000 };
    const upstream = await this._branchSyncUpstream(branch, opts);
    if (!upstream) return this._branchSyncNoUpstream(branch);

    const fetched = await this._branchSyncFetch(parseRemoteFromUpstream(upstream), branch, opts);
    const counts = await this._branchSyncCounts(upstream, branch, opts);
    return { branch, upstream, fetched, ...counts };
  }

  // On-demand resync: fetch, then RESOLVE the drift rather than just report it. behind-only fast-
  // forwards the local base branch (never a rebase); ahead-only pushes it; every other state (diverged,
  // in-sync, no-upstream, unknown) mutates nothing - decideResyncAction is the single place that
  // decision is made, and it never returns anything but 'none' for a diverged branch, so this method
  // can never rebase or force-push no matter what future state values are added. Only called on an
  // explicit operator action (the sidebar's Resync button or its alt+r shortcut) - never on a timer.
  // Concurrency: a second call while one is still running rides the SAME in-flight promise instead of
  // starting a fresh git mutation (this._resyncPromise), so two clicks can never race two `git push`es.
  async resyncBranch() {
    if (this._resyncPromise) return this._resyncPromise;
    this._resyncPromise = this._resyncBranchBody().finally(() => { this._resyncPromise = null; });
    return this._resyncPromise;
  }

  async _resyncBranchBody() {
    const branch = this._integrationBranch;
    if (!branch || !this.path) return { ...this._branchSyncNoUpstream(branch), action: "none", error: null };
    const opts = { cwd: this.path, encoding: "utf8", timeout: 10000 };
    const upstream = await this._branchSyncUpstream(branch, opts);
    if (!upstream) return { ...this._branchSyncNoUpstream(branch), action: "none", error: null };

    const remote = parseRemoteFromUpstream(upstream);
    const fetched = await this._branchSyncFetch(remote, branch, opts);
    const before = await this._branchSyncCounts(upstream, branch, opts);

    const checkedOut = (await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], opts)).trim();
    const decision = decideResyncAction(before.state, checkedOut === branch);

    let action = "none";
    let error = null;
    const cmd = RESYNC_COMMANDS[decision]?.({ upstream, branch, remote, opts });
    if (cmd) {
      try {
        await gitStrict(cmd.args, cmd.opts);
        action = cmd.successAction;
      } catch (err) {
        error = firstGitErrorLine(err);
      }
    }

    // Recompute AFTER the mutation (no re-fetch: the remote has not moved further, only the local ref
    // may have) so the UI lands on the post-resync truth, not the pre-mutation snapshot.
    const after = await this._branchSyncCounts(upstream, branch, opts);
    return { branch, upstream, fetched, ...after, action, error };
  }

  // fetched: null means no fetch was ever attempted (there is no upstream to fetch from), which the UI
  // must not render as a failed/stale fetch - distinct from fetched: false (a real fetch that failed).
  _branchSyncNoUpstream(branch) {
    return { branch: branch || null, upstream: null, state: decideBranchSyncState({ hasUpstream: false }), ahead: 0, behind: 0, fetched: null };
  }

  // The branch's upstream tracking ref (e.g. "origin/develop"), or null when none is configured.
  // gitOut (not gitStrict): "no upstream configured for branch" is an EXPECTED outcome here, not an
  // error to reject on, so it must resolve to empty stdout rather than throw.
  async _branchSyncUpstream(branch, opts) {
    const upstream = (await gitOut(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`], opts)).trim();
    return upstream && !upstream.includes("@{") ? upstream : null;
  }

  // Best-effort freshness fetch, bounded so an offline/slow remote never stalls the caller for long.
  // Returns whether it actually succeeded; the caller reports counts either way (possibly stale).
  async _branchSyncFetch(remote, branch, opts) {
    try {
      await gitStrict(["fetch", "--quiet", remote, branch], { ...opts, timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  // Ahead/behind + display state for an already-resolved upstream, shared by getBranchSync (called
  // once, after its own fetch) and resyncBranch (called twice: before and after its mutation, without
  // fetching again in between - the remote has not moved, only the local ref may have).
  async _branchSyncCounts(upstream, branch, opts) {
    const counts = parseLeftRightCount(await gitOut(["rev-list", "--left-right", "--count", `${upstream}...${branch}`], opts));
    return {
      ahead: counts ? counts.ahead : 0,
      behind: counts ? counts.behind : 0,
      state: decideBranchSyncState({ hasUpstream: true, ahead: counts?.ahead, behind: counts?.behind }),
    };
  }

  // A CHEAP fingerprint of the worktree's reviewable state: uncommitted+untracked (porcelain), the
  // HEAD sha (commits), and how far HEAD is ahead of the integration branch (the merge gate, which a
  // cross-session merge into develop can move WITHOUT touching this worktree). One `git status` + a
  // couple of rev-parses, all timeout-bounded. Returns { sig, dirty, ahead, behind, rebaseInProgress,
  // headSha, targetSha } or null with no worktree.
  // This is the funnel's truth; the heavy getDiff() is only fetched for the selected session.
  async _computeWorktreeSignature() {
    if (!this.worktreeDir) return null;
    const opts = { cwd: this.worktreeDir, encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024 };
    // --no-optional-locks: this runs on background event nudges (watchers / turn-end), so it must NEVER
    // take git's index lock and contend with the session's own `git add` / `git commit` in the worktree.
    const run = (args) => gitStrict(["--no-optional-locks", ...args], opts);
    let status, head, ahead = "0", behind = "0", rebaseInProgress = false, targetSha = null;
    try {
      status = await run(["status", "--porcelain"]);
      head = (await run(["rev-parse", "HEAD"])).trim();
      const { ref: baseRef } = await this._resolveVerifiedBaseRef(run, opts, { swallowResolveError: true });
      if (baseRef) ahead = (await run(["rev-list", "--count", `${baseRef}..HEAD`])).trim();
      // `behind` is measured against the MERGE TARGET (the local branch the merge engine fast-forwards),
      // NOT the effective/display base above: HEAD@{upstream} can sit at a stale commit while the local
      // integration branch moved, and the parked->pending-review demotion must mirror what an actual
      // merge would do. The two counts deliberately use different bases.
      try {
        const mergeTarget = this._integrationBranch || (this._workspace?.base) || this.baseSha;
        // The verify probe already RESOLVES the target, so the auto-rebase cooldown key gets its half
        // of the fingerprint for free rather than costing another rev-parse on this recurring path.
        const resolvedTarget = mergeTarget ? (await run(["rev-parse", "--verify", "--quiet", mergeTarget])).trim() : "";
        if (resolvedTarget) {
          targetSha = resolvedTarget;
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
    return { sig, dirty: status.trim() !== "", ahead, behind, rebaseInProgress, headSha: head, targetSha };
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
    // Same reason as the merging guard: mid-rebase the worktree reads clean and detached with ahead 0,
    // which decideSignatureDemotion would self-heal a real pending-review/parked gate to 'none' on, with
    // nothing left to re-arm it. _maybeAutoRebase always ends its window with one final recheck.
    if (this._autoRebasing) return;
    const sig = await this._computeWorktreeSignature();
    // Re-check liveness after the await: the session may have been destroyed or entered a merge while
    // the git probe ran, in which case a stale broadcast/demotion must not fire.
    if (this._destroyed || this.mergeStatus === "merging") return;
    if (!sig) return;
    // Gate demotions run BEFORE the signature dedup: a park can leave the worktree byte-identical to the
    // established baseline (a lost fast-forward does not abort the no-op rebase, and the merge flow never
    // resets _lastWorktreeSig), so a dedup-gated demotion would never fire and 'parked' would stick forever.
    // The decision matrix itself is pure (session/core/merge-gate.js).
    const next = decideSignatureDemotion(this.mergeStatus, sig);
    const demoted = next !== null;
    if (demoted) this._setMergeStatus(next);
    // Evaluated BEFORE the signature dedup, because the trigger it exists for leaves the signature
    // byte-identical: `behind` is not part of the hash, so an integration branch that moved under an
    // otherwise untouched worktree would never get past the early return below.
    await this._maybeAutoRebase(sig);
    if (this._destroyed || this.mergeStatus === "merging") return;
    if (sig.sig === this._lastWorktreeSig && !demoted) return;
    this._lastWorktreeSig = sig.sig;
    this.emit("worktree-changed", { id: this.id, sig: sig.sig });
  }

  // Eager conflict avoidance: when the integration branch has moved ahead of a worktree that is clean,
  // quiescent and not mid-anything, replay this session's commits on top of it right now. Paying the
  // drift off in small pieces as it appears is what keeps a long-lived session from meeting one large
  // conflict at merge time. The decision itself is pure (session/core/rebase-gate.js); this is the thin
  // shell that runs it, holds the re-entry mutex, and records what happened.
  //
  // A conflict is NOT escalated: the status gate, the notification and the operator handoff all stay
  // where they were, on the eventual Merge click, which hits the same conflict and parks exactly as it
  // does today. All this records is a cooldown key, so the same doomed rebase is not retried on every
  // watcher nudge; head or target moving is what makes it worth another attempt.
  async _maybeAutoRebase(sig) {
    if (this._autoRebasing) return;
    const currentKey = `${sig.headSha || ""}::${sig.targetSha || ""}`;
    const verdict = decideAutoRebase({
      enabled: this._autoRebase && Boolean(this._gitWorkspace && this._workspace),
      state: this.state,
      mergeStatus: this.mergeStatus,
      dirty: sig.dirty,
      behind: sig.behind,
      rebaseInProgress: sig.rebaseInProgress,
      teardownPending: this._teardownPending(),
      currentKey,
      lastConflictKey: this._rebaseConflictKey,
    });
    if (verdict.action !== "rebase") return;
    this._autoRebasing = true;
    try {
      const r = await this._gitWorkspace.rebaseOnly({
        projectPath: this.path,
        workspace: this._workspace,
        targetBranch: this._integrationBranch,
      });
      // The gate cleared this rebase against a quiescent session, but a turn can start while it runs.
      // Nothing can be undone at this point, so record it: an agent that comes back confused about its
      // own files has the rewrite and the state it landed in sitting next to each other in the trace.
      if (!AUTO_REBASE_STATES.includes(this.state)) {
        this._recordDecision({ kind: "rebase", ts: Date.now(), decision: "state-moved", state: this.state });
      }
      if (r?.ok && r.rebased) {
        this._rebaseConflictKey = null;
        if (r.baseSha) { this.baseSha = r.baseSha; this._workspace.baseSha = r.baseSha; }
        this._recordDecision({
          kind: "rebase", ts: Date.now(), decision: "auto-rebased",
          from: sig.headSha || null, to: r.headSha || null, rerereReplayed: r.rerereReplayed === true,
        });
        return;
      }
      // 'rebase-failed' (a rebase that never started) is deliberately NOT cooled down: it is transient,
      // and the debounce already bounds how often a later event can retry it.
      if (r?.reason === "rebase-conflict") {
        this._rebaseConflictKey = currentKey;
        this._recordDecision({
          kind: "rebase", ts: Date.now(), decision: "conflict", conflicts: r.conflicts || [],
        });
      }
    } catch (err) {
      // Additive hygiene: an engine failure must never break the change funnel it rides on.
      console.warn(`[session ${this.id}] auto-rebase failed: ${err.message}`);
    } finally {
      this._autoRebasing = false;
      // Every outcome, including a conflict and a throw: this method suppressed the funnel while it ran,
      // so it owes it one recheck to re-establish the signature and the gate it may have skipped.
      this._scheduleWorktreeCheck();
    }
  }

  // Debounced entry for the IMMEDIATE triggers (fs.watch onChange + the `ready` turn-end). Collapses a
  // burst (a commit touches several gitdir files; a turn-end can race the watch) into one check. The
  // backend's integration-ref watcher fan-out calls checkWorktreeChange() directly (its nudge is coarse).
  _scheduleWorktreeCheck() {
    if (this._destroyed || !this.worktreeDir || this._worktreeCheckTimer) return;
    // Fire-and-forget: checkWorktreeChange catches its own git errors (returns a null signature), so
    // the only thing to guard is an unexpected rejection becoming an unhandledRejection.
    this._armTimer("_worktreeCheckTimer", WORKTREE_CHECK_DEBOUNCE_MS, () => {
      this.checkWorktreeChange().catch(() => { /* best-effort; the watch + a later nudge retry */ });
    }, { unref: true });
  }

  // (Re)start the two fs.watches this session's review gate rides on. Idempotent: fresh watchers replace
  // any prior ones, so it is safe to call on every provision/adopt/restart. A non-worktree (in-place)
  // session has no gitdir, so both decline; it has no review worktree to track anyway.
  // _lastWorktreeSig is reset so the first post-(re)start check re-establishes the baseline.
  //
  //   - this worktree's OWN gitdir: a commit/stage/reset inside it.
  //   - the integration branch's REFLOG in the shared gitdir: the branch moving WITHOUT this worktree
  //     changing (a sibling session merged, or the operator merged out-of-band), which shifts this
  //     session's merge gate with no local event. Both funnel into the same debounced recheck.
  _startWorktreeWatcher() {
    this._stopWorktreeWatcher();
    if (this._destroyed || !this.worktreeDir) return;
    const onChange = () => this._scheduleWorktreeCheck();
    this._worktreeWatcher = createWorktreeWatcher({ worktreeDir: this.worktreeDir, onChange });
    this._worktreeWatcher.start();
    if (!this._liveWorktreeReview || !this.commonGitDir || !this._integrationBranch) return;
    this._integrationWatcher = createIntegrationRefWatcher({
      commonGitDir: this.commonGitDir,
      branch: this._integrationBranch,
      onChange,
    });
    this._integrationWatcher.start();
  }

  _stopWorktreeWatcher() {
    this._worktreeWatcher = stopWatcher(this._worktreeWatcher);
    this._integrationWatcher = stopWatcher(this._integrationWatcher);
    this._clearTimer("_worktreeCheckTimer");
    this._lastWorktreeSig = null;
  }

  // The half both merge entry points share: arm the 'merging' gate, run one engine method against this
  // session's workspace, and turn a thrown engine into the pending-review fallback. Returns { result }
  // or { failure }, the caller's own return value, so a throw needs no second catch at each call site.
  async _runMergeEngine(method) {
    this._setMergeStatus("merging");
    try {
      const result = await this._gitWorkspace[method]({
        projectPath: this.path,
        workspace: this._workspace,
        targetBranch: this._integrationBranch,
      });
      return { result };
    } catch (err) {
      this._setMergeStatus("pending-review", { reason: err.message });
      return { failure: { merged: false, reason: err.message } };
    }
  }

  // Forget the worktree this session was running in and report the gate it lands on. The caller stops
  // the watchers first: an fs.watch on a dir the engine is about to remove would ENOENT.
  _clearWorktreeState(status) {
    this._workspace = null;
    this.worktreeDir = null;
    this.commonGitDir = null;
    this.isWorktree = false;
    this._setMergeStatus(status);
  }

  // The tail both merge paths share once the merge itself did not succeed: a conflicted/lost-FF rebase
  // PARKS with its context, anything else falls back to pending-review.
  _applyParkedOrPending(r) {
    if (r.parked) {
      this._setMergeStatus("parked", { reason: r.reason || null, conflicts: r.conflicts || [] });
      return r;
    }
    this._setMergeStatus("pending-review", { reason: r.reason || null });
    return r;
  }

  // Operator action: rebase-then-FF merge the session's worktree into the integration branch, then
  // tear it down. On a conflict/lost-FF the branch PARKS (worktree preserved). Returns the engine result.
  // `refused: true` on the early returns here (and in mergeAndContinue) marks a guard that fired BEFORE
  // any merge-status change: nothing is broadcast for these, so the control handler is the one that must
  // surface them to the operator (see reportMergeRefusal in server/control-handlers.js). Without that
  // flag a refused merge is invisible: the click does nothing and no feedback ever reaches the dashboard.
  async mergeWorktree() {
    if (!this._gitWorkspace || !this._workspace) return { merged: false, refused: true, reason: "no-worktree" };
    // Re-entry guard: a second merge click while a merge is already in flight would race the engine on
    // the same worktree. Keyed STRICTLY on 'merging' so it never blocks the legitimate finish path, which
    // calls mergeWorktree while mergeStatus is 'pending-review' (settled-on-exit) or 'none'.
    if (this.mergeStatus === "merging") return { merged: false, refused: true, reason: "merge-in-progress" };
    const { result: r, failure } = await this._runMergeEngine("mergeBack");
    if (failure) return failure;
    if (r.merged) {
      this._stopWorktreeWatcher();
      this._clearWorktreeState("merged");
      return r;
    }
    return this._applyParkedOrPending(r);
  }

  // Operator action behind the sidebar's "Merge" on a LIVE quiescent session (WAITING/IDLE/COMPLETE):
  // commit the worktree's changes, merge them into the integration branch, and rebase this worktree onto
  // it, KEEPING the session running on the same worktree (now on top of develop) so the operator commits
  // as they go. Unlike finishAndMerge it never ends the session or tears the worktree down. Refused only
  // while the PTY is actively working (RUNNING: we must not rewrite a worktree mid-edit); a session that
  // paused awaiting the operator (WAITING) is quiescent and mergeable, same as IDLE/COMPLETE. A rebase
  // conflict / lost FF PARKS (worktree preserved). Returns the engine result.
  //
  // force is the operator's explicit "merge anyway" for a card stuck WORKING (e.g. a background-agent
  // gate that never drained): it additionally allows RUNNING, but still refuses every other non-live
  // state (DORMANT/INITIALIZING/STARTING/DONE/FAILED all mean there is no live worktree to merge from).
  async mergeAndContinue({ force = false } = {}) {
    // refused: true = a pre-merge guard fired with NO merge-status side effect; the control handler
    // surfaces it (see the mergeWorktree header note).
    if (this._destroyed) return { merged: false, refused: true, reason: "destroyed" };
    if (!this._gitWorkspace || !this._workspace) return { merged: false, refused: true, reason: "no-worktree" };
    const runningOverride = force && this.state === STATES.RUNNING;
    if (!MERGEABLE_LIVE_STATES.includes(this.state) && !runningOverride) {
      return { merged: false, refused: true, reason: "not-continuable" };
    }
    // Re-entry guard (see mergeWorktree): refuse a second concurrent merge on the same worktree.
    if (this.mergeStatus === "merging") return { merged: false, refused: true, reason: "merge-in-progress" };
    const { result: r, failure } = await this._runMergeEngine("mergeKeep");
    if (failure) return failure;
    if (r.merged) {
      // Worktree kept alive on its branch (now == the integration tip); track the new base it sits on.
      if (r.baseSha) { this.baseSha = r.baseSha; this._workspace.baseSha = r.baseSha; }
      // Committed work merged out, so the gate normally returns to 'none'. But if the stashed uncommitted
      // work reapplied WITH conflicts, the worktree now holds conflict markers the operator must resolve -
      // surface that as pending-review instead of silently reporting clean.
      if (!r.restoreConflict) {
        this._setMergeStatus("none");
        return r;
      }
      this._setMergeStatus("pending-review", { reason: "restore-conflict" });
      return r;
    }
    if (!r.parked && r.reason === "nothing-to-commit") {
      this._setMergeStatus("none");
      return r;
    }
    return this._applyParkedOrPending(r);
  }

  // Re-adopt an existing on-disk session worktree at boot (e.g. a pending-review/parked session that
  // survived a server restart), so its unreviewed work is resurfaced as pending-review instead of
  // stranded. The session stays DORMANT; the operator can then review/merge it, or starting it reuses
  // this same worktree (_provisionWorktree early-returns on an existing worktreeDir).
  // `hasUnmergedWork: false` adopts WITHOUT the review gate: a tree that survived a shutdown with
  // nothing uncommitted has nothing to review, so gating it would put a stale review banner on the card.
  // Callers that know (or cannot cheaply tell) the tree holds work keep the pending-review default.
  adoptWorktree({ worktreeDir, branch, base, hasUnmergedWork = true }) {
    if (!worktreeDir) return;
    this._workspace = { cwd: worktreeDir, isGit: true, branch, base: base || this._integrationBranch };
    this.worktreeDir = worktreeDir;
    this.commonGitDir = this._resolveCommonGitDir();
    this.isWorktree = true;
    this._setMergeStatus(hasUnmergedWork ? "pending-review" : "none");
    // Watch the re-adopted worktree too: an operator who merges/cleans it from the CLI then sees the
    // stranded gate self-heal fast, without starting the session.
    this._startWorktreeWatcher();
  }

  // Operator action: throw the worktree away unmerged (junction-safe), reset to no-worktree.
  async discardWorktree() {
    this._stopWorktreeWatcher(); // stop before the dir is removed (fs.watch would ENOENT)
    if (this._gitWorkspace && this._workspace) {
      try { await this._gitWorkspace.discard({ projectPath: this.path, workspace: this._workspace }); } catch { /* best-effort */ }
    }
    this._clearWorktreeState("none");
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
      outputBufferEntries: this._outputRing.stats().entries,
      outputBufferBytes: this._outputRing.size,
      outputBufferTotal: this._outputRing.total,
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
    // Also refreshes _agentBreakdown (and prunes), so the breakdown below describes this instant.
    const active = this._activeAgentCount();
    const held = this._gateHeldReady;
    return {
      state: this.state,
      transitions: this.auditLog.slice(-5).map((e) => ({
        from: e.from,
        to: e.to,
        event: e.event,
        timestamp: e.timestamp,
        detail: e.detail,
      })),
      detection: {
        ...this.getDetectionStats(),
        agents: { ...this._agentBreakdown, active },
        gate: held
          ? { heldForMs: Date.now() - held.ts, seq: held.seq, lastActivitySeq: this._lastActivitySeq }
          : null,
      },
      packs: this.packReadSummary(),
      decisions: this._decisionLog.slice(-15),
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

    // Leaving WAITING for any reason (user_input included) means whatever prompt held it no
    // longer applies. Covers both a real hook signal and a direct transition('user_input') call
    // (backend.js manual-answer path).
    if (from === STATES.WAITING) this._setPendingPromptKind(null);

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

  // Single-flight: concurrent start() calls (a double-click, or focus-view's DORMANT auto-start racing
  // the resume dialog's start-session) collapse onto the in-flight run. Without this, both callers pass
  // the ptyProcess/DORMANT guards during the async provision gap: the first creates the session worktree,
  // the second then sees its OWN fresh branch as branch-in-use, clobbers worktreeDir back to null, and
  // spawns a SECOND Claude in place - leaking the first PTY inside the worktree it holds checked out.
  start() {
    if (this._startPending) return this._startPending;
    this._startPending = this._startBody().finally(() => { this._startPending = null; });
    return this._startPending;
  }

  async _startBody() {
    if (this._destroyed) return;
    // Defensive cleanup: if a prior PTY is still alive (e.g. _handlePtyExit
    // hasn't propagated yet after a sleep-kill race), force-kill it before
    // respawning. Without this, ptyProcess assignment below would orphan the
    // previous PTY's onData/onExit subscriptions and leak the process.
    if (this.ptyProcess) {
      console.warn(`[session:${this.name}] start() called while PTY exists - killing previous PTY first`);
      const oldPid = this.ptyProcess.pid;
      const oldPty = this.ptyProcess;
      if (process.platform === "win32") {
        // Await the reap (bounded by a 2s timeout) so the new PTY is not spawned until the old one is
        // gone, preserving the "kill previous first" intent now that start() is async.
        await this._taskkill(oldPid, { timeout: 2000 }).catch(() => { /* already dead/unkillable/timed out - proceed */ });
      }
      if (process.platform !== "win32") {
        try { oldPty.kill(); } catch { /* already dead - proceed */ }
      }
      this.ptyProcess = null;
    }
    // Provision (or reuse) this session's isolated worktree before spawn. All spawn entry points
    // funnel through start(), so each inherits isolation. A blocked provision (integration branch
    // absent) leaves the session DORMANT with a notice and does NOT run in the operator's real tree.
    if (!(await this._provisionWorktree())) return;
    // Re-check destruction AFTER the provision await: a destroy() that landed during the microtask gap
    // must not let the spawn below proceed (the teardown mutex blocks lifecycle re-entry, but a direct
    // destroy() races this await window). Guards against a double-spawn / spawn-after-destroy.
    if (this._destroyed) return;
    // Resolve context packs here, beside the provision await, so the state resets below stay in one
    // synchronous run down to pty.spawn. Pack dirs live under ~/.glissa, outside every repo, so an
    // isolated worktree needs no special casing.
    const packDelivery = await this._resolvePacks();
    if (this._destroyed) return;
    // Listen for changes in the (isolated) worktree so the review diff stays live without a manual
    // refresh. Idempotent across restart-reuse; a non-git in-place session has no worktreeDir to watch.
    if (this.worktreeDir) {
      this._startWorktreeWatcher();
      // Armed AFTER the watcher (re)start, which cancels any pending check timer: an adopted clean
      // survivor carries a provisional pending-review that this first check demotes to none.
      if (this.mergeStatus === "pending-review") this._scheduleWorktreeCheck();
    }
    if (this.state === STATES.DORMANT) {
      this.transition("user_start");
    }
    this._receivedFirstOutput = false;
    this._sleeping = false;
    // A (re)started PTY begins with no live background sub-agents; drop any stale ids from a prior run.
    this._clearDetectionTracking();
    this._autoKilled = false;
    this._outputRing.reset();
    // A restarted PTY re-bases its monotonic output offset at 0. Signal the backend so
    // it force-closes any LIVE data-WS client (whose ws-sender.sentOffset is now
    // stale-high relative to the reset total) and lets it reconnect + re-baseline.
    // Covers restart(), forceRestart(), and sleep-kill auto-restart (all funnel through
    // start()); harmless no-op on the first start() (no data clients attached yet).
    // See backend.js wireSessionEvents -> closeSessionDataClients.
    this.emit("rebaseline");
    this._resetDetectionSources({ quiet: false });

    const env = this._buildSpawnEnv({
      additionalDirsClaudeMd: packDelivery.packs.length > 0,
      prependPathDir: this._rtkPath ? path.dirname(this._rtkPath) : null,
    });

    // Inject Claude Code hooks via a per-session managed settings file (HTTP hooks
    // POSTing to Glissa's localhost server). No repo modification; no shell command.
    const settingsArgs = this._injectHooks();

    // Prefer spawning the resolved claude .exe directly (node-pty -> CreateProcess).
    // Fall back to `cmd.exe /c claude` only for .cmd/.bat/.ps1 shim installs or when
    // resolution failed (see resolveClaudeCommand / buildSpawnCommand at module top).
    const claudeArgs = this.dangerouslySkipPermissions
      ? ["--dangerously-skip-permissions"]
      : [];
    // Resume a prior conversation (possibly from another worktree's project dir). Claude resolves the
    // id across the repo's linked worktrees, so the session continues that thread in THIS worktree's cwd.
    // Placed before any lane extraClaudeArgs / the initial-prompt positional (both null for user sessions).
    this._suppressResumeCapture = false;
    if (this._resumeSessionId) {
      claudeArgs.push("--resume", this._resumeSessionId);
    }
    // A headless lane passes extra flags (e.g. -p, --model <m>) then the prompt as the final positional.
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
      packArgs: packDelivery.args,
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
      this._deliveredPacks = [];
      this.transition("spawn_fail", { error: err.message });
      this.emit("error", err);
      return;
    }
    this._ptyAlive = true;
    this._guardPtyInputSocket();

    this.transition("spawn_success");

    // Redact a positional initialPrompt (headless lanes) from the spawn log - it can be a multi-KB
    // context block that does not belong in the console.
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
    if (!port) {
      console.warn(`[session:${this.name}] hook injection skipped: HTTP listener port unavailable - hooks were not injected`);
      return [];
    }
    try {
      this._settingsHandle = writeSessionSettings({
        port,
        glissaId: this.id,
        baseDir: this._hooksBaseDir,
        permissions: this._settingsPermissions,
        detectScheduledWakeups: this._detectScheduledWakeups,
        // Only a session that actually delivered a pack can attribute a Read to one, so nothing else
        // pays for the extra matcher (and its settings file stays byte-identical to the pre-telemetry one).
        packReadTelemetry: this._packReadTelemetry && this._deliveredPacks.length > 0,
        enableProjectMcp: this._enableProjectMcp,
        rtkPath: this._rtkPath,
        planLimits: this._planLimits,
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

  // Resolve each configured context pack to the built `current` dir this spawn adds. A pack that was
  // never built, or whose manifest is unreadable, is SKIPPED with a decision-trace entry: pack
  // delivery is additive context, so it must never block a session from starting or guess at a dir.
  // Returns the --add-dir args and the { name, version } records toSnapshot reports.
  async _resolvePacks() {
    this._deliveredPacks = [];
    this._clearPackNotice();
    packReadTracker.clearPackReads(this._packReads);
    if (this._packs.length === 0) return { args: [], packs: [] };

    const builtRoot = this._packsBuiltRoot || defaultBuiltRoot();
    const args = [];
    for (const name of this._packs) {
      const resolved = await resolveBuiltPack(name, { builtRoot });
      const ts = Date.now();
      if (!resolved.dir) {
        console.warn(`[session:${this.name}] context pack "${name}" skipped: ${resolved.reason}`);
        this._recordDecision({ kind: "pack", ts, name, decision: "skipped", reason: resolved.reason });
        continue;
      }
      args.push("--add-dir", resolved.dir);
      // `dir` rides the delivered record so the read tracker can classify a path against it; it is
      // server-side only (toSnapshot rebuilds its entries without it).
      this._deliveredPacks.push({ name: resolved.name, version: resolved.version, dir: resolved.dir });
      this._recordDecision({ kind: "pack", ts, name, decision: "delivered", version: resolved.version });
    }
    return { args, packs: this._deliveredPacks };
  }

  _buildSpawnEnv(options) {
    return buildSpawnEnv(process.env, this._spawnEnv, options);
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

    // Buffer for late-joining data WS clients (session/core/output-ring.js).
    //
    // ORDER CONTRACT: the ring push (which advances the monotonic total) MUST stay
    // BEFORE emit("data") below. ws-sender.maybeBackfill() reads getBufferSince()
    // from inside the "data" listener and relies on the just-arrived chunk already
    // being retained and counted (see ws-sender.js maybeBackfill). Reordering would
    // make a backfill miss the in-flight chunk.
    this._outputRing.push(data);
    if (this.listenerCount("data") > 0) {
      this.emit("data", data);
    }
  }

  async _handlePtyExit(exitCode, signal) {
    const pid = this.ptyProcess ? this.ptyProcess.pid : null;
    this._resetDetectionSources({ quiet: false, clearTracking: true });
    // The next spawn re-resolves its packs, so a notice owed by the dead one has no turn to ride.
    this._clearPackNotice();
    this._cleanupHooks();
    this._ptyAlive = false;
    this.ptyProcess = null;

    // Reap orphan grandchildren on Windows. Fire-and-forget: the PTY is already nulled and the settle/emit
    // sequence below does not depend on the reap completing, so swallow any error (pid already exited).
    if (pid && process.platform === "win32") {
      this._taskkill(pid).catch(() => { /* pid already exited or taskkill unavailable - nothing to do */ });
    }

    const { event, detail } = decideExitTransition(this.state, exitCode, signal, this._receivedFirstOutput);
    const reason = detail.reason || null;
    this.transition(event, detail);

    // ORDER CONTRACT: settle the worktree BEFORE emitting "exit". On a changed tree _settleWorktreeOnExit
    // sets mergeStatus='pending-review' and keeps worktreeDir; a queued once("exit") handler (e.g.
    // finishAndMerge) runs after this and relies on the settle having already happened. Moving the emit
    // ahead of this call would let a queued handler act on an unsettled worktree. Keep settle-then-emit.
    //
    // The await is wrapped so a rejected settle (e.g. the engine's discard rejects) ALWAYS still reaches
    // the exit emit below. Skipping the emit would leave a queued once("exit") handler unfired, so
    // _finishing / _pendingRestart would never clear and the teardown mutex would DEADLOCK
    // this session. _settleWorktreeOnExit already self-catches its discard, so a reject is unlikely; this
    // catch is the hard guarantee against a future change reintroducing a throw.
    try { await this._settleWorktreeOnExit(); }
    catch { /* best-effort: settle failed, but the exit MUST still propagate (anti-deadlock) */ }

    if (this._recorder) {
      this._recorder.writeFooter("pty_exit", exitCode, { packReads: this.packReadSummary() });
      this._recorder.close();
    }

    this.emit("exit", { exitCode, signal, reason });
  }

  getReplayBuffer() {
    return this._outputRing.replay();
  }

  // Current monotonic output offset (== total bytes ever produced). A data-WS client
  // captures this at connect as its live baseline (startOffset).
  getOutputOffset() {
    return this._outputRing.total;
  }

  // Slice of output produced at or after `offset`; full offset/eviction semantics
  // documented on session/core/output-ring.js since().
  getBufferSince(offset) {
    return this._outputRing.since(offset);
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

  resize(cols, rows, { redraw = false } = {}) {
    const isUnchangedSize = this._lastCols === cols && this._lastRows === rows;
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
      // A same-size resize is an OS no-op (no SIGWINCH); nudge a row (or a col at one row) so the TUI repaints.
      if (redraw && isUnchangedSize) {
        try {
          if (rows > 1) this.ptyProcess.resize(cols, rows - 1);
          if (rows <= 1) this.ptyProcess.resize(cols + 1, rows);
        } catch {
          // A failed nudge must not block the real resize below.
        }
      }
      try {
        this.ptyProcess.resize(cols, rows);
      } catch {
        // PTY exited between our check and the resize call (Windows ConPTY race).
      }
    }
  }

  // Async Windows taskkill (process tree, forced). Returns a promise so a caller can await the reap
  // (start()'s prior-PTY kill) or fire-and-forget with a .catch (the reap / kill / force-kill paths).
  // Array args (no shell string interpolation): safer and faster than the old execSync template.
  _taskkill(pid, opts = {}) {
    return new Promise((resolve, reject) => {
      this._killProc(["/PID", String(Number(pid)), "/T", "/F"], { ...opts }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  // An 'error' emit with no listener is an uncaught throw, and every kill path is best-effort.
  _emitError(err) {
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  kill() {
    if (!this.ptyProcess) return;

    // Stop writing the instant we kill: the conin pipe peer dies with the child,
    // so any further write() would hit the dead pipe (see _guardPtyInputSocket).
    // The flip and the force-kill scheduling stay SYNCHRONOUS and in order; only the taskkill is async.
    this._ptyAlive = false;
    const pid = this.ptyProcess.pid;
    const ptyProcess = this.ptyProcess;

    if (process.platform === "win32") {
      // Retain the reap promise so the server lifecycle can await it before exit/respawn (orphan fix).
      // The .catch keeps the error-emission behavior; awaiters use Promise.allSettled so a reject is fine.
      this._killReap = this._taskkill(pid);
      this._killReap.catch((err) => this._emitError(err));
    }
    if (process.platform !== "win32") {
      this._killReap = Promise.resolve(); // SIGKILL is synchronous; nothing async to await
      try { ptyProcess.kill(); } catch (err) { this._emitError(err); }
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
      if (this._destroyed) return;
      if (!checkAlive()) return;
      elapsed += KILL_POLL_INTERVAL_MS;
      if (elapsed >= KILL_MAX_WAIT_MS) {
        // Terminal branch: the process outlived the poll budget. Force-kill async on Windows; the
        // non-win32 SIGKILL stays synchronous (already a non-blocking signal).
        if (process.platform === "win32") {
          this._taskkill(pid).catch((err) => this._emitError(err));
          return;
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch (err) {
          this._emitError(err);
        }
        return;
      }
      this._armTimer("_killPollTimer", KILL_POLL_INTERVAL_MS, poll);
    };

    this._armTimer("_killPollTimer", KILL_POLL_INTERVAL_MS, poll);
  }

  dismiss() {
    if (!DISMISSIBLE_STATES.has(this.state)) return false;
    return this.transition("user_dismiss");
  }

  sleep() {
    if (this._sleeping) return;
    // Only sleep dead-PTY terminal states. Sleeping a live PTY (IDLE/COMPLETE)
    // would arm the sleep-kill timer below and terminate a session whose work
    // can still continue.
    if (!RESTARTABLE_STATES.includes(this.state)) return;
    this._sleeping = true;
    this._resetDetectionSources();
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
    // Skipped while a teardown (finish/force-restart) is queued: respawning here would
    // race the queued exit handler. restart() also self-guards on _teardownPending, so this is
    // belt-and-suspenders, but skipping the call keeps the intent explicit. (The sleep-kill timer
    // never restarts directly; it only kills + sets _autoKilled, deferring the restart to here.)
    if (this._autoKilled
        && !this._teardownPending()
        && RESTARTABLE_STATES.includes(this.state)) {
      this.restart();
    }
  }

  // Shared teardown mutex. True while any lifecycle action has a kill-then-settle queued (a
  // "Merge & finish" or a force-restart). Every action that could respawn a PTY or rewrite/discard a
  // worktree checks this first, so a second action cannot race the queued once("exit") handler of the
  // first (e.g. a force-restart kills -> the card shows DONE -> a Restart click would otherwise respawn
  // on the worktree the first action is settling). Each action clears ONLY its own flag in its own exit callback.
  _teardownPending() {
    return this._pendingRestart || this._finishing;
  }

  _scheduleSleepKill() {
    this._armTimer("_sleepKillTimer", SLEEP_KILL_TIMEOUT_MS, () => {
      if (!this._sleeping) return;
      const wasActive = KILLABLE_STATES.includes(this.state);
      this.killSession();
      if (wasActive && RESTARTABLE_STATES.includes(this.state)) {
        this._autoKilled = true;
      }
    });
  }

  _clearSleepKill() {
    this._clearTimer("_sleepKillTimer");
  }

  killSession() {
    if (!KILLABLE_STATES.includes(this.state)) return false;
    this.kill();
    return this.transition("user_kill");
  }

  restart(options = {}) {
    if (this._destroyed) return false;
    // A queued teardown (finish/force-restart) is mid-flight; respawning now would race its exit
    // handler. This is the load-bearing guard: once a finish/force-restart's killSession() flips the
    // card to DONE, the dashboard's Restart button sends a plain `restart` (not `force-restart`), so
    // the mutex MUST live here too, not only in forceRestart.
    if (this._teardownPending()) return false;
    if (!RESTARTABLE_STATES.includes(this.state)) return false;
    this._prepareRestart(options);
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
    if (RESTARTABLE_STATES.includes(this.state)) {
      // Settled branch: set the mutex flag SYNCHRONOUSLY before the async reset fires, so a second click
      // (or a restart/force-restart) landing while the reset awaits git sees _teardownPending()===true and
      // is refused. .finally clears the flag whether the reset resolved or rejected (no stranded flag);
      // the trailing .catch swallows a reset rejection so it never escapes as an unhandledRejection,
      // mirroring the live branch's try/finally contract.
      this._finishing = true;
      this._mergeAndReset().finally(() => { this._finishing = false; }).catch(() => {});
      return { ok: true };
    }
    if (this.state === STATES.COMPLETE || this.state === STATES.IDLE) {
      this._finishing = true;
      this.once("exit", async () => {
        try { if (!this._destroyed) await this._mergeAndReset(); }
        finally { this._finishing = false; }
      });
      this.killSession(); // -> DONE now; the real PTY exit settles the worktree, then the handler merges
      return { ok: true, pending: true };
    }
    return { ok: false, reason: "not-finishable" };
  }

  // Merge the worktree, then (self-guarded) return to DORMANT once the worktree is gone. A parked merge
  // keeps its worktree, so resetToDormant no-ops and the session stays parked for manual resolution; a
  // clean settle (nothing to merge) already cleared the worktree, so the session still finishes dormant.
  async _mergeAndReset() {
    const r = await this.mergeWorktree();
    this.resetToDormant();
    return r;
  }

  forceRestart(options = {}) {
    if (this._destroyed) return false;
    if (this._teardownPending()) return false;
    if (KILLABLE_STATES.includes(this.state)) {
      this._prepareRestart(options);
      this._pendingRestart = true;
      this.once("exit", () => {
        this._pendingRestart = false;
        if (this._destroyed) return;
        if (!RESTARTABLE_STATES.includes(this.state)) return;
        this.transition("user_restart");
        this.start();
      });
      this.kill();
      this.transition("user_kill");
      return true;
    }
    if (!RESTARTABLE_STATES.includes(this.state)) return false;
    return this.restart(options);
  }

  updateSettings(cfg) {
    if (cfg.replayBufferKB != null)
      this._outputRing.setMax(cfg.replayBufferKB * 1024);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    this._clearSleepKill();

    this._clearPendingPaste();

    this._cleanupHooks();

    this.kill();

    this._clearTimer("_killPollTimer");

    this._clearGateHeldReady();
    this._clearPackNotice();

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
  classifyClaudeKind,
  CLAUDE_CMD,
};
