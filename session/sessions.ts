import fs from "node:fs";
import path from "node:path";
import pty from "node-pty";
import { EventEmitter } from "node:events";
import { execFile } from "../server/child-process-safe.js";
import { STATES, KILLABLE_STATES, RESTARTABLE_STATES } from "../shared/states.ts";
import type { SessionState } from "../shared/states.ts";
import { createOscTitleSource } from "../detection/osc-title-source.ts";
import { createStatusSource } from "../detection/status-source.ts";
import type { MetaStatusSignal, ResolvedStatusSignal } from "../detection/status-source.ts";
import type { HookSignal } from "../detection/hook-source.ts";
import { classifyClaudeKind, buildSpawnCommand } from "./core/spawn-command.ts";
import type { ResolvedCommand } from "./core/spawn-command.ts";
import { DEFAULT_AGENT_ID, resolveAdapter, commandFor } from "./adapters/index.ts";
import type { AgentAdapter, AgentCapabilities } from "./adapters/index.ts";

import {
  TRANSITIONS,
  GUARDS,
  ENTRY_HOOKS,
  EXIT_HOOKS,
} from "./core/state-machine.ts";
import { mapSignalToEvent } from "./core/status-mapper.ts";
import { decideExitTransition } from "./core/exit-transition.ts";
import type { ExitSignal } from "./core/exit-transition.ts";
import { shouldHoldTerminalStopForNotice } from "./core/pack-notice.ts";
import * as agentTracker from "./core/agent-tracker.ts";
import { DEFAULT_GATE_RELEASE_SETTLE_MS } from "./core/gate-release.ts";
import { RESUME_ID_RE } from "./core/auto-resume.ts";
import { projectSessionSnapshots } from "./core/snapshot-projection.ts";
import type { UserHook } from "./core/user-hooks-core.ts";
import type { DecisionEntry } from "./core/decision-log.ts";
import { createSessionObservability } from "./session-observability.ts";
import { createSessionOutput } from "./session-output.ts";
import { createSessionPackDelivery } from "./session-pack-delivery.ts";
import { createSessionHookLifecycle } from "./session-hook-lifecycle.ts";
import type { HookRouterPort } from "./session-hook-lifecycle.ts";
import { createSessionWorktreeLifecycle } from "./session-worktree-lifecycle.ts";
import type { GitWorkspace } from "./session-worktree-lifecycle.ts";
import { createSessionBackgroundTracking } from "./session-background-tracking.ts";
import type { HookPayload } from "../shared/contracts/index.ts";

const KILL_POLL_INTERVAL_MS = 200;
const KILL_MAX_WAIT_MS = 3000;
// The POSIX reap's own budget, deliberately SHORTER than KILL_MAX_WAIT_MS and separate from it. The
// shutdown coordinator awaits these reaps under a 3000ms cap (server-lifecycle.js awaitTeardown), so a
// reap that also ran to 3000ms plus timer drift would overrun the very bound it exists to settle inside;
// 12 poll ticks leave that headroom. The force-kill escalation keeps KILL_MAX_WAIT_MS, so the win32 path
// is unchanged.
const KILL_REAP_MAX_WAIT_MS = 2400;
const SLEEP_KILL_TIMEOUT_MS = 15 * 60 * 1000;

// Nothing below 2 may ever be signalled: NEGATED (the process-group form), pid 0 is our OWN group and
// pid 1 is every process this user can signal, so a pty object carrying a missing or absurd pid would
// take the server, or the box, down with the session. No child of ours is ever numbered that low.
function signalablePid(pid: unknown): number | null {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < 2) return null;
  return parsed;
}

// The two states an operator can dismiss a card out of: an unanswered prompt and an unopened result.
const DISMISSIBLE_STATES: Set<SessionState> = new Set([STATES.WAITING, STATES.COMPLETE]);

// What ended a run, as the measurement lane classifies it.
type SessionEndIntent = "operator-abort" | "close-out" | "natural";

// Only the hook fan-out reaches a Session; the rest of the measurement port is the backend's business.
interface SessionMillMetricsPort {
  onHookEvent: (sessionId: string, event: string, payload: Record<string, unknown>) => void;
}

// The four timer fields _armTimer/_clearTimer address by name; all carry the same handle type.
type TimerField = "_killPollTimer" | "_killReapTimer" | "_sleepKillTimer" | "_titleQuietFallbackTimer";

// The recorder surface a Session drives. Structural so a test can hand it a spy without the file IO.
interface SessionRecorderPort {
  writeHeader(config: { agent?: string | null; cols?: number; rows?: number } & Record<string, unknown>): void;
  writeData(data: string): void;
  writeHook(event: string, payload: HookPayload | null | undefined): void;
  writeState(from: SessionState, to: SessionState, event: string, detail: unknown): void;
  writeDecision(entry: DecisionEntry): void;
  writeInput(data: string): void;
  writeResize(cols: number, rows: number): void;
  writeFooter(reason: string, exitCode: number | null | undefined): void;
  close(): void;
}

// The PTY surface a Session actually drives, plus the two backend internals the socket guards below
// reach for (both optional, so a non-conpty backend and a test fake stay safe). Narrower than
// node-pty's IPty on purpose: this is the seam a fake is written against.
interface SessionPty {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  _agent?: { inSocket?: { on: (event: string, listener: (error: Error) => void) => unknown } };
  on?: (event: string, listener: (error: Error) => void) => unknown;
}

type PtySpawn = (
  file: string,
  args: string[],
  options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions,
) => SessionPty;

type KillProc = (
  args: string[],
  options: Record<string, unknown>,
  callback: (error: unknown, stdout?: string, stderr?: string) => void,
) => unknown;

type SignalProc = (pid: number, signal: NodeJS.Signals | 0) => void;

interface SessionOptions {
  id: string;
  name: string;
  path: string;
  dangerouslySkipPermissions?: boolean;
  replayBufferKB?: number;
  hookRouter?: HookRouterPort | null;
  getHookPort?: (() => number | null) | null;
  hooksBaseDir?: string;
  titleStabilizationMs?: number;
  statusConflictMs?: number;
  statusDedupMs?: number;
  detectBackgroundAgents?: boolean;
  agentTtlMs?: number;
  shellTaskTtlMs?: number;
  teammateTaskTtlMs?: number;
  gateReleaseSettleMs?: number;
  detectScheduledWakeups?: boolean;
  agent?: string;
  adapter?: AgentAdapter | null;
  bypassHookTrust?: boolean;
  titleQuietFallbackMs?: number;
  spawnCommand?: ResolvedCommand | null;
  initialPrompt?: string | null;
  extraClaudeArgs?: string[];
  ephemeral?: boolean;
  resumeSessionId?: string | null;
  antiSlopPrompt?: boolean;
  settingsPermissions?: Record<string, unknown> | null;
  spawnEnv?: Record<string, string> | null;
  enableProjectMcp?: boolean;
  rtkPath?: string | null;
  packs?: unknown;
  packsBuiltRoot?: string | null;
  packVariantSlug?: string | null;
  millMetricsPort?: SessionMillMetricsPort | null;
  planLimits?: boolean;
  getUserHooks?: (() => UserHook[]) | null;
  ptySpawn?: PtySpawn | null;
  killProc?: KillProc | null;
  signalProc?: SignalProc | null;
  platform?: NodeJS.Platform;
  gitWorkspace?: GitWorkspace | null;
  integrationBranch?: string | null;
  autoRebase?: boolean;
  syncOnStart?: boolean;
  liveWorktreeReview?: boolean;
  worktreeRoot?: string | null;
  worktreeShare?: string[] | null;
}

// ---------------------------------------------------------------------------
// State machine. Status is driven by structural signals from StatusSource
// (Claude Code hooks = authoritative; OSC-0 title = degraded fallback), mapped
// to transitions in _onStatus per the signal x state matrix. There is NO
// screen-content parsing and NO detection timer here. The transition tables
// (TRANSITIONS, GUARDS, ENTRY_HOOKS, EXIT_HOOKS) live in
// session/core/state-machine.ts; the transition() engine below consumes them.
// ---------------------------------------------------------------------------

class Session extends EventEmitter {
  id: string;
  name: string;
  path: string;
  dangerouslySkipPermissions: boolean;
  ptyProcess: SessionPty | null;
  state: SessionState;
  stateSince: number;
  ephemeral: boolean;
  agentId: string;
  usageVendor: string;
  bypassHookTrust: boolean;
  backgroundTracking: ReturnType<typeof createSessionBackgroundTracking>;
  worktreeLifecycle: ReturnType<typeof createSessionWorktreeLifecycle>;

  _receivedFirstOutput: boolean;
  _killPollTimer: NodeJS.Timeout | null;
  _killReapTimer: NodeJS.Timeout | null;
  _sleepKillTimer: NodeJS.Timeout | null;
  _titleQuietFallbackTimer: NodeJS.Timeout | null;
  _resolveKillReap: (() => void) | null;
  _killReap: Promise<void> | null;
  _exitReap: Promise<void> | null;
  _sleeping: boolean;
  _autoKilled: boolean;
  _destroyed: boolean;
  _pendingRestart: boolean;
  _finishing: boolean;
  _ptyAlive: boolean;
  _recorder: SessionRecorderPort | null;
  _output: ReturnType<typeof createSessionOutput>;
  _adapter: AgentAdapter;
  _observability: ReturnType<typeof createSessionObservability>;
  _titleQuietFallbackMs: number;
  _hookSeen: boolean;
  _lastSignal: Record<string, unknown> | null;
  _pendingPromptKind: string | null;
  _titleQuiet: boolean;
  _spawnCommand: ResolvedCommand | null;
  _initialPrompt: string | null;
  _extraClaudeArgs: string[];
  _resumeSessionId: string | null;
  _suppressResumeCapture: boolean;
  _antiSlopPrompt: boolean;
  _spawnEnv: Record<string, string> | null;
  _packsBuiltRoot: string | null;
  _rtkPath: string | null;
  _packDelivery: ReturnType<typeof createSessionPackDelivery>;
  _planLimits: boolean;
  _hooks: ReturnType<typeof createSessionHookLifecycle>;
  _ptySpawn: PtySpawn;
  _killProc: KillProc;
  _signalProc: SignalProc;
  _platform: NodeJS.Platform;
  _startPending: Promise<void> | null;
  _titleSource: ReturnType<typeof createOscTitleSource>;
  _statusSource: ReturnType<typeof createStatusSource>;

  constructor({
    id,
    name,
    path: projectPath,
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
    // Background sub-agent detection (see session/core/agent-tracker.ts). When true (default), a
    // main-agent Stop fired while a background sub-agent is still running does NOT complete the card.
    // The kill switch (config detectBackgroundAgents=false) makes the session ignore subagent signals
    // so behavior is exactly as before. agentTtlMs bounds a dropped-SubagentStop leak.
    detectBackgroundAgents = true,
    agentTtlMs = agentTracker.DEFAULT_AGENT_TTL_MS,
    // Bounds a lost shell/monitor task notification without cutting off normal external-agent runs.
    shellTaskTtlMs = agentTracker.DEFAULT_SHELL_TASK_TTL_MS,
    // A declared teammate entry is near-redundant with the counted SubagentStart/Stop map (real
    // teammate work is already tracked there); it only matters for a dropped SubagentStart, while
    // an idle-but-alive teammate is declared running forever. Bounding it short keeps a dropped
    // TeammateIdle/TaskCompleted from pinning the card WORKING for the full agent TTL.
    teammateTaskTtlMs = agentTracker.DEFAULT_TEAMMATE_TASK_TTL_MS,
    // Quiet window a drained gate-held ready waits out before it actually releases. Why a
    // window at all: see session/core/gate-release.ts.
    gateReleaseSettleMs = DEFAULT_GATE_RELEASE_SETTLE_MS,
    // Scheduled-revival visibility (see session/core/wakeup-tracker.ts). When true (default), a
    // ScheduleWakeup / cron task seen via PostToolUse hooks rides toSnapshot().pendingWakeup as an
    // ADVISORY card chip ("sleeping until ~HH:MM"); it never gates a transition. The kill switch
    // (config detectScheduledWakeups=false) drops the PostToolUse hook group at the source and
    // makes the session ignore the signals, so behavior is exactly as before.
    detectScheduledWakeups = true,
    // Which agent CLI this session supervises (session/adapters). Absent = claude-code, the only
    // adapter that exists; an unknown id warns and falls back to it rather than failing the spawn.
    agent = DEFAULT_AGENT_ID,
    // Resolved adapter object, overriding the `agent` lookup. Mirrors the spawnCommand seam: tests
    // build a capability-off agent with it while claude-code is still the only registered adapter.
    adapter = null,
    // Per-project opt-in to an agent's hook-trust bypass (codex `--dangerously-bypass-hook-trust`).
    // Default OFF because the bypass is not scoped to Glissa's own hooks; see _decideHookTrustBypass.
    bypassHookTrust = false,
    // Deadline for the boot title-quiet latch when no hook ever arrives (see _armTitleQuietFallback).
    titleQuietFallbackMs = 30000,
    // Resolved agent command ({ path, kind }). Null defers to the adapter registry's lazy cache at
    // spawn; tests inject a stub to exercise the spawn branches deterministically.
    spawnCommand = null,
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
    // sessions. See session/core/anti-slop-prompt.ts.
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
    // Context packs delivered at spawn: names of built packs whose immutable version dir becomes an
    // --add-dir (see _resolvePacks and AGENTS.md "Context Packs"). Comes from the project record's
    // `packs` array, or from a headless lane's own pack config.
    packs = [],
    // Where built packs live. Defaults to ~/.glissa/packs/built; tests point it at a fixture root.
    packsBuiltRoot = null,
    // The per-project variant slug this project resolves first (server/core/pack-core.ts
    // projectVariantSlug). Null for a lane session, which is delivered the base pack.
    packVariantSlug = null,
    millMetricsPort = null,
    // Inject the managed statusLine relay so Claude Code publishes its OFFICIAL plan rate limits to
    // Glissa (config usage.planLimits; see AGENTS.md "Usage Tracking"). The relay chains whatever
    // statusLine the operator already had, because a managed one REPLACES it.
    planLimits = false,
    // Operator hooks for this project (the Hooks tab), read at each spawn. Null for a lane session.
    getUserHooks = null,
    // PTY spawner seam. Defaults to node-pty; tests inject a fake to assert the
    // spawn wiring (file/args) without launching a real process.
    ptySpawn = null,
    // Kill executor seam (Windows taskkill). Defaults to async execFile; tests inject a fake to assert
    // the kill args (['/PID', pid, '/T', '/F']) without spawning a real taskkill. Mirrors ptySpawn/
    // spawnCommand injection. Signature: (args, opts, cb) -> matches child_process.execFile.
    killProc = null,
    // Process-signal seam (POSIX group kill, liveness probe). Defaults to process.kill; tests inject a
    // fake so a group SIGKILL is asserted rather than delivered. Signature: (pid, signal) -> void, where
    // a NEGATIVE pid means "the process group", exactly as process.kill reads it.
    signalProc = null,
    // The platform this session spawns and kills for. Defaults to the real one; tests pass it explicitly
    // so both the win32 taskkill branch and the POSIX group-kill branch run on a single host.
    platform = process.platform,
    // Worktree isolation (injected by backend). A null branch asks gitWorkspace to detect the repo's
    // default; only an absent gitWorkspace runs the session in place.
    gitWorkspace = null,
    integrationBranch = null,
    // Rebase a quiescent, clean worktree onto the integration branch as soon as that branch moves
    // (config worktreeAutoRebase). Read at construction like every other spawn-time option, so a
    // settings change applies to the next construction of this session, not to the live one.
    autoRebase = true,
    syncOnStart = true,
    // Master kill switch for the live cross-session review liveness: with it false the integration-ref
    // watcher is never started, so a branch move reaches this session only via the turn-end recheck.
    liveWorktreeReview = true,
    // Session worktree location + the gitignored local context to bring in (see _provisionWorktree).
    worktreeRoot = null,
    worktreeShare = null,
  }: SessionOptions) {
    super();
    this.id = id;
    this.name = name;
    this.path = projectPath;
    this.dangerouslySkipPermissions = dangerouslySkipPermissions;
    this.ptyProcess = null;
    this.state = STATES.DORMANT;
    this.stateSince = Date.now();
    this._receivedFirstOutput = false;
    this._killPollTimer = null;
    this._killReapTimer = null;
    // Settles the in-flight POSIX reap below, so a destroy() (or a second kill) can never strand it.
    this._resolveKillReap = null;
    // In-flight reap promise from the most recent kill(), or null: the taskkill on Windows, the bounded
    // process-gone poll after a group SIGKILL off it. The server lifecycle (shutdown ->
    // requestRestart/requestShutdown) awaits these before exit/respawn so the PTY tree (cmd/claude/conhost
    // there, the setsid'd process group here) is reaped instead of orphaned. Never gates a transition.
    this._killReap = null;
    // The reap of a NATURALLY exited PTY tree (see _handlePtyExit). A sibling of _killReap rather than
    // the same field: three subsystems await _killReap for "the kill I asked for is done", and a natural
    // exit is not that. Both are awaited together before a (re)start touches the worktree.
    this._exitReap = null;
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
    this._recorder = null; // Set via setRecorder() after construction
    this._output = createSessionOutput({
      maxBytes: replayBufferKB * 1024,
      getState: () => this.state,
      isDestroyed: () => this._destroyed,
      hasLivePty: () => this.hasLivePty,
      write: (text) => this.write(text),
      start: () => { this.start(); },
      restart: () => { this.restart(); },
      on: (event, listener) => { this.on(event, listener); },
      once: (event, listener) => { this.once(event, listener); },
      off: (event, listener) => { this.off(event, listener); },
    });

    // Resolved first, because the capability gates below read it: every CC-only feature this session
    // could run is asked of the adapter rather than assumed (M2 of docs/plan-agent-adapters.md).
    const resolvedAdapter = adapter || resolveAdapter(agent, { label: `session:${name}` });
    if (!resolvedAdapter) throw new TypeError("default agent adapter is unavailable");
    this._adapter = resolvedAdapter;
    this.agentId = this._adapter.id;
    this._observability = createSessionObservability({
      agentId: this.agentId,
      getRecorder: () => this._recorder,
    });
    // The usage lane's vendor namespace for this agent (claude/codex/grok), never the adapter id. It
    // rides the claude-session-id event and keys both the lane ledger and the per-card usage chip.
    this.usageVendor = this._adapter.usageVendor || "claude";
    this.bypassHookTrust = bypassHookTrust === true;
    this._titleQuietFallbackMs = titleQuietFallbackMs;
    this._titleQuietFallbackTimer = null;

    // -- Detection: structural signal sources --
    this._hookSeen = false;
    this._lastSignal = null;
    // Advisory: which flavor of "waiting on you" a WAITING session is parked on (null | 'permission' |
    // 'elicitation'), surfaced as a card chip. Set from an authoritative hook awaiting-input signal;
    // mirrors activeAgents/pendingWakeup in that it NEVER gates a transition. Cleared on resume,
    // user_input, working, any transition leaving WAITING, /clear, and PTY exit/restart.
    this._pendingPromptKind = null;
    // True between a SessionStart(source: clear|compact) hook and the next real
    // UserPromptSubmit: the TUI redraw around /clear flashes a spinner + idle glyph in
    // the OSC title, which would otherwise open a fake work cycle (RUNNING) and close
    // it with a false COMPLETE ("finished working" on every /clear). While latched,
    // title signals are dropped; hooks still flow (they are authoritative).
    this._titleQuiet = false;
    this.backgroundTracking = createSessionBackgroundTracking({
      detectBackgroundAgents: detectBackgroundAgents && this._can("backgroundAgents"),
      agentTtlMs,
      shellTaskTtlMs,
      teammateTaskTtlMs,
      gateReleaseSettleMs,
      detectScheduledWakeups,
      port: {
        state: () => this.state,
        isDestroyed: () => this._destroyed,
        emit: (event, detail) => this.emit(event, detail),
        recordDecision: (entry) => this._recordDecision(entry),
        transition: (event, detail) => this.transition(event, detail),
        resyncWorkingLatch: () => this._titleSource.resyncWorkingLatch(),
      },
    });
    this._spawnCommand = spawnCommand;
    this._initialPrompt = initialPrompt;
    this._extraClaudeArgs = Array.isArray(extraClaudeArgs) ? extraClaudeArgs : [];
    this._packsBuiltRoot = packsBuiltRoot;
    this._resumeSessionId = resumeSessionId || null;
    this._suppressResumeCapture = false;
    this._antiSlopPrompt = !!antiSlopPrompt && this._can("antiSlop");
    this.ephemeral = !!ephemeral;
    this._spawnEnv = spawnEnv;
    this._rtkPath = (this._can("rtk") && rtkPath) || null;
    this._packDelivery = createSessionPackDelivery({
      configuredPacks: packs,
      builtRoot: () => this._packsBuiltRoot,
      variantSlug: typeof packVariantSlug === "string" && packVariantSlug ? packVariantSlug : null,
      projectPath: this.path,
      sessionName: this.name,
      agentId: this.agentId,
      canDeliver: () => this._can("packs"),
      canNotify: () => this._can("packNotice"),
      renderArgs: (deliveredPacks, builtRoot) => this._adapter.renderPackArgs(deliveredPacks, builtRoot),
      recordDecision: (entry) => this._recordDecision(entry),
    });
    this._planLimits = planLimits === true && this._can("statusLine");
    this._hooks = createSessionHookLifecycle({
      id: this.id,
      name: this.name,
      agentId: this.agentId,
      adapter: this._adapter,
      hookRouter,
      getHookPort,
      hooksBaseDir,
      settingsPermissions,
      detectScheduledWakeups,
      detectPackReads: () => millMetricsPort != null
        && this._can("packReads")
        && this._packDelivery.deliveredWithDirs().length > 0,
      enableProjectMcp: !!enableProjectMcp,
      rtkPath: this._rtkPath,
      planLimits: this._planLimits,
      getUserHooks,
      bypassHookTrust: this.bypassHookTrust,
      effectiveCwd: () => this.effectiveCwd(),
      ingestSignal: (raw) => this.ingestHookSignal(raw),
      observeHook: (event, payload) => millMetricsPort?.onHookEvent(this.id, event, payload),
      recordDecision: (entry) => this._recordDecision(entry),
    });
    this._ptySpawn = ptySpawn || ((file, args, opts) => pty.spawn(file, args, opts));
    // Async kill executor (taskkill). Default wraps execFile; the callback form keeps the call truly
    // non-blocking. Injected in tests to assert the kill without spawning a real process.
    this._killProc = killProc || ((args, opts, cb) => execFile("taskkill", args, opts, cb));
    this._signalProc = signalProc || ((pid, signal) => process.kill(pid, signal));
    this._platform = platform;

    this._startPending = null;   // in-flight start() promise (single-flight; see start())
    this.worktreeLifecycle = createSessionWorktreeLifecycle({
      id: this.id,
      projectPath: this.path,
      integrationBranch,
      gitWorkspace,
      autoRebase,
      syncOnStart,
      liveWorktreeReview,
      worktreeRoot,
      worktreeShare,
      port: {
        projectPath: () => this.path,
        state: () => ({
          state: this.state,
          isDestroyed: this._destroyed,
          isTeardownPending: this._teardownPending(),
          hasLivePty: this.hasLivePty,
        }),
        emit: (event, detail) => this.emit(event, detail),
        recordDecision: (entry) => this._recordDecision(entry),
        pasteText: (text) => this.pasteText(text),
      },
    });

    this._titleSource = createOscTitleSource({
      stabilizationMs: titleStabilizationMs,
      titleProfile: this._adapter.titleProfile,
    });
    this._statusSource = createStatusSource({
      sessionId: id,
      ...(statusConflictMs != null ? { conflictWindowMs: statusConflictMs } : {}),
      ...(statusDedupMs != null ? { dedupWindowMs: statusDedupMs } : {}),
    });
    this._titleSource.on("signal", (s) => {
      if (this._titleQuiet) return; // /clear redraw noise; see _titleQuiet above
      this._statusSource.ingest(s);
    });
    this._statusSource.on("status", (s: ResolvedStatusSignal) => this._onStatus(s));
    this._statusSource.on("meta", (m: MetaStatusSignal) => this._onMeta(m));
  }

  setRecorder(recorder: SessionRecorderPort | null): void {
    this._recorder = recorder;
  }

  get auditLog(): Record<string, unknown>[] {
    return this._observability.auditLog;
  }

  // THE capability read. Every CC-only feature asks this rather than branching on the adapter id, and
  // an undeclared capability is absent: an adapter earns a feature by claiming it, never by omission.
  _can(capability: keyof AgentCapabilities): boolean {
    return this._adapter.capabilities?.[capability] === true;
  }

  // -- Private timer fields (one shape: replace any pending timer, null the field from inside the
  // callback, unref only where named). The kill and sleep-kill timers deliberately do NOT unref: the
  // process must stay alive long enough to finish the kill they drive.

  _armTimer(field: TimerField, ms: number, fn: () => void, { unref = false }: { unref?: boolean } = {}): void {
    this._clearTimer(field);
    const timer = setTimeout(() => {
      this[field] = null;
      fn();
    }, ms);
    this[field] = timer;
    if (unref && typeof timer.unref === "function") timer.unref();
  }

  _clearTimer(field: TimerField): void {
    const timer = this[field];
    if (!timer) return;
    clearTimeout(timer);
    this[field] = null;
  }

  // -- Detection signal handling (replaces all content scraping) --

  // Push a hook callback's normalized signal into the StatusSource. Called by the
  // shared HookRouter the backend registers per session.
  ingestHookSignal(raw: HookSignal): void {
    if (this._destroyed) return;
    this._hookSeen = true;
    if (this._recorder && raw && raw.event) {
      this._recorder.writeHook(raw.event, raw.payload);
    }
    // Background sub-agent lifecycle is COUNTED, not a state transition: it never reaches the
    // StatusSource (which merges hook+title timing for the real transition signals). Tracking the
    // live set lets a main-agent Stop fired while a background sub-agent is still running avoid a
    // false COMPLETE (see _onStatus + the activeAgents gate in status-mapper.ts).
    if (raw && (raw.signal === "subagent-start" || raw.signal === "subagent-stop")) {
      this.backgroundTracking.trackSubagent(raw);
      return;
    }
    // Task lifecycle is tracking-only too: TaskCreated/TaskCompleted/TeammateIdle drain (or
    // reactivate) individual entries of the declared background_tasks gate. TeammateIdle is
    // the only signal that an idle-but-alive teammate (still declared status:running on every
    // Stop) has stopped gating completion.
    if (raw && (raw.signal === "task-created" || raw.signal === "task-completed" || raw.signal === "teammate-idle")) {
      this.backgroundTracking.trackTaskLifecycle(raw);
      return;
    }
    // Scheduled-revival lifecycle is likewise tracking-only: it must never reach the
    // StatusSource (a pending wakeup is metadata, not a state signal).
    if (raw && (raw.signal === "wakeup-scheduled" || raw.signal === "cron-created" || raw.signal === "cron-deleted")) {
      this.backgroundTracking.trackWakeup(raw);
      return;
    }
    // Keys off whichever main-agent hook arrives, never one event name: Claude Code does not
    // reliably fire SessionStart. Tracking-only background-agent signals returned above and are
    // deliberately excluded, since they can describe a different Claude session than the one
    // this card resumes (AGENTS.md, "Auto-Resume and Shutdown").
    if (raw?.payload) {
      const sessionIdOf = typeof this._adapter.sessionIdOf === "function"
        ? this._adapter.sessionIdOf
        : (payload: HookPayload) => payload?.session_id;
      this._captureClaudeSessionId(sessionIdOf(raw.payload), raw.payload.source);
    }
    // /clear and /compact fire SessionEnd+SessionStart with NO UserPromptSubmit and no
    // Stop; the only movement they cause is TUI title noise. Reset the merged stream
    // (cancels a held ready from the pre-clear turn) and latch titles quiet until the
    // next real prompt.
    // An authoritative awaiting-input hook (PermissionRequest / permission_prompt / elicitation*
    // Notification) carries WHICH kind of prompt this is; see mapHookPromptKind in hook-source.ts.
    if (raw && raw.signal === "awaiting-input") this._setPendingPromptKind(raw.promptKind || null);
    if (raw && raw.signal === "session-start") this._onSessionStartHook(raw);
    if (raw && raw.signal === "resume") {
      this._titleQuiet = false;
      this._setPendingPromptKind(null);
      // Drop the held ready BEFORE the override clear: clearing may drain the count to 0,
      // and a stale ready must not fire COMPLETE on the very prompt that starts a new turn.
      this.backgroundTracking.clearGateHeldReady();
      this.backgroundTracking.resetTurnEvidence();
      this.backgroundTracking.clearBgDeclared(); // a new turn starts with no settled background snapshot
      // Only a hook ever produces "resume" (UserPromptSubmit; the title source cannot), so this
      // means exactly "authoritative user prompt". Emitted separately from the state-change this
      // signal may (or may not) cause: both "working" (title) and "resume" (hook) are IMMEDIATE
      // in status-source.ts, so the racing title spinner can win the IDLE/COMPLETE->RUNNING
      // transition first, carrying signal "working" instead of "resume" in its detail. The
      // notify-cycle reset must not depend on winning that race, so the backend resets on this
      // event directly instead of only reading the transition detail.
      this.emit("user-prompt", { state: this.state, stateSince: this.stateSince, ts: Date.now() });
    }
    // A main-agent Stop carries the authoritative background-work count (v2.1.145+).
    if (raw && raw.signal === "ready" && raw.source === "hook") {
      this.backgroundTracking.applyBackgroundTasks(raw.payload);
    }
    if (shouldHoldTerminalStopForNotice({
      event: raw?.event,
      signal: raw?.signal,
      isNoticePending: this._packDelivery.hasPendingNotice(),
      packNoticeHookEvent: this.packNoticeHookEvent,
    })) return;
    this._statusSource.ingest(raw);
  }

  // clear/compact need the quiet-title handling below: nothing is running, nothing completed.
  // See _titleQuiet.
  _onSessionStartHook(raw: HookSignal): void {
    const payload = raw.payload || {};
    const src = String(payload.source || "").toLowerCase();
    if (src !== "clear" && src !== "compact") return;
    this._resetDetectionSources({ quiet: true });
    this.backgroundTracking.clearGateHeldReady();
    this.backgroundTracking.resetTurnEvidence();
    this._setPendingPromptKind(null);
  }

  // Malformed/absent ids are a no-op: crash-safe persistence depends on this only ever recording
  // a real, resumable id. Mirrors into the live binding immediately, so a plain dashboard restart
  // after a PTY crash already resumes even without a server reboot; the backend listens for the
  // emitted event to persist it to config.json. Emits only on an actual CHANGE: every hook now
  // feeds this, and each emission is a synchronous config.json write on a per-turn path.
  _captureClaudeSessionId(id: unknown, source: unknown): void {
    if (this._suppressResumeCapture) return;
    if (typeof id !== "string" || !RESUME_ID_RE.test(id)) return;
    if (id === this._resumeSessionId) return;
    this.setResumeConversation(id);
    // Event name kept for wire/back-compat (M5 of docs/plan-agent-adapters.md); `id` stays the primary
    // field every existing listener reads. `vendor` + `sessionId` generalize it so the lane ledger can
    // namespace a codex/grok id away from a claude one that could otherwise collide.
    this.emit("claude-session-id", { id, source: source || null, vendor: this.usageVendor, sessionId: id });
  }

  // Advisory pending-prompt-kind setter (see _pendingPromptKind above). Emits 'prompt-kind-change'
  // only when the value actually changes, mirroring the agent and wakeup change emitters.
  _setPendingPromptKind(kind: string | null): void {
    const next = kind || null;
    if (next === this._pendingPromptKind) return;
    this._pendingPromptKind = next;
    this.emit("prompt-kind-change", { pendingPromptKind: next });
  }

  /*
   * The ONE append path for the audit log, so the cap cannot be bypassed. It was: the ordinary
   * transition trimmed after pushing, while the SELF-transition branch above pushed and returned, so
   * a session repeating a self-transition (a restart loop firing process_exit_fail against an already
   * FAILED state) grew the array without limit until something else transitioned. Found by the 2026-08
   * review pass.
   */
  _pushAuditEntry(entry: Record<string, unknown>): void {
    this._observability.pushAuditEntry(entry);
  }

  // Append one decision-trace entry. Mirrored to the forensic recorder only when it is genuinely
  // new: a collapsed repeat (an unchanged gate verdict re-evaluated on a TTL tick) already has a
  // line on disk.
  _recordDecision(entry: DecisionEntry): void {
    this._observability.recordDecision(entry);
  }

  // Push a decision the BACKEND made for this session (notification category + reason, and the
  // notification lifecycle hops it caused) into the same per-session trace, so the debug overlay
  // shows the detection decision and its notification outcome as one sequence.
  recordNotifyDecision(entry: DecisionEntry): void {
    this._recordDecision(entry);
  }

  // Drop both signal sources back to a clean stream, and optionally latch the title source quiet or
  // clear the background-work bookkeeping with them. Called from a PTY (re)start, a PTY exit, /clear
  // and sleep. `quiet` omitted leaves the latch alone (sleep freezes state, it does not re-open a turn).
  _resetDetectionSources({ quiet, clearTracking = false }: { quiet?: boolean; clearTracking?: boolean } = {}): void {
    this._titleSource.reset();
    this._statusSource.reset();
    if (quiet !== undefined) this._titleQuiet = quiet;
    // Ahead of the caller's transition, never after: a drain-release here would fire a COMPLETE
    // before the process_exit that follows it.
    if (clearTracking) this._clearDetectionTracking();
  }

  // The full background-work reset a PTY start or exit needs. Order matters: a pending held ready
  // must go FIRST, because clearAgents emits an agents-change that would otherwise release it.
  _clearDetectionTracking(): void {
    this.backgroundTracking.clearGateHeldReady();
    this.backgroundTracking.clearAgents();
    this.backgroundTracking.clearWakeups();
    this._setPendingPromptKind(null);
  }

  _onStatus(s: ResolvedStatusSignal): void {
    if (this._destroyed) return;
    this._lastSignal = { signal: s.signal, source: s.source, confidence: s.confidence, ts: s.ts };
    // Any non-ready signal is proof the turn a held ready announced did not settle. Recorded as
    // arrival order so decideGateRelease is the ONE place that judges a hold stale (it cancels
    // any hold stashed before this); no separate eager-clear path to keep in sync.
    const signalSeq = this.backgroundTracking.noteStatus(s.signal);
    // A working signal means the operator answered (or the agent resumed) - the prompt this
    // session was waiting on no longer applies.
    if (s.signal === "working") this._setPendingPromptKind(null);
    // Pure decision in session/core/status-mapper.ts; this wrapper owns the side effects:
    // the _destroyed guard + _lastSignal write above, and the transition below. The detail
    // { source, signal } is uniform across every firing case (byte-identical to the prior
    // per-branch details), so it is assembled here rather than in the pure mapper.
    const active = this.backgroundTracking.activeAgentCount();
    const eventWithoutGate = mapSignalToEvent(s.signal, this.state, s.confidence, 0);
    const orphanStopGate = s.signal === "ready" && s.source === "hook"
      && this.backgroundTracking.hasOrphanStopEvidence() && !!eventWithoutGate;
    const event = orphanStopGate
      ? null
      : mapSignalToEvent(s.signal, this.state, s.confidence, active);
    // A ready suppressed ONLY by the background-agent gate is held, not dropped: when the
    // count drains without another Stop (idle teammate, dropped SubagentStop) the drain
    // releases it and the card still completes (see evaluateGateHeldReady). Decided before
    // the transition below, which cannot change the answer (a fired event rules the hold out)
    // but would move this.state under the second mapper call.
    const gateHeld = !event && s.signal === "ready" && (active > 0 || orphanStopGate)
      && !!eventWithoutGate;
    this._recordDecision({
      ts: Date.now(),
      kind: "signal",
      signal: s.signal,
      source: s.source,
      confidence: s.confidence || null,
      state: this.state,
      seq: signalSeq,
      active,
      orphanStop: orphanStopGate,
      ...this.backgroundTracking.agentBreakdown(),
      event: event || null,
      action: event ? "transition" : (gateHeld ? "gate-held" : "no-op"),
    });
    if (event) this.transition(event, { source: s.source, signal: s.signal });
    if (gateHeld) this.backgroundTracking.stashGateHeldReady(s);
    // A turn end (`ready`) is the precise moment a batch of edits/commits has settled, so refresh the
    // review diff right then (debounced). The signature dedup makes a no-change turn a cheap no-op.
    if (s.signal === "ready") this.worktreeLifecycle.scheduleCheck();
  }

  _onMeta(m: MetaStatusSignal): void {
    // `unknown` glyph / degraded telemetry - recorded for observability, no transition.
    this._lastSignal = { signal: m.signal, source: m.source, ts: m.ts, meta: true };
  }

  get pid(): number | null {
    return this.ptyProcess ? this.ptyProcess.pid : null;
  }

  // Whether this session has ever received a Claude Code hook callback. The notify-gate RUNNING
  // reset (session/core/notify-gate.ts decideNotification) falls back to the legacy per-RUNNING
  // reset for a degraded, title-only session, since it has no resume signal to key off.
  get hookSeen(): boolean {
    return this._hookSeen;
  }

  get sleeping(): boolean {
    return this._sleeping;
  }

  // Whether write() would actually reach a terminal. The same three conditions pasteMergePrompt
  // guards on, exposed for callers outside this file (the upload route pastes a saved image path and
  // must refuse - and delete the file - rather than write into a dead PTY nobody can see).
  get hasLivePty(): boolean {
    return !this._destroyed && !!this.ptyProcess && !!this._ptyAlive;
  }

  // True from forceRestart()'s kill through its queued exit handler (see forceRestart / restart).
  // The state-change this window fires is a transient user_kill on the way back to a respawn, not
  // an intentional stop - a listener that treats every user_kill as "gone for good" (e.g. the
  // backend's wasActive persistence, graceful-shutdown-auto-resume design B) must read this first.
  get pendingRestart(): boolean {
    return this._pendingRestart;
  }

  // Bind (or clear, with a falsy id) the conversation this session resumes on its next spawn. Set by the
  // control layer when the operator picks a conversation; persisted on the project record so it survives
  // a server restart. Takes effect on the next start()/restart() - never mutates a live PTY.
  setResumeConversation(id: string | null): void {
    this._resumeSessionId = id || null;
  }

  get resumeSessionId(): string | null {
    return this._resumeSessionId;
  }

  _prepareRestart(options: { fresh?: boolean } = {}): void {
    if (options.fresh !== true) return;
    // The dying PTY's late SessionEnd hook must not re-capture the id this fresh restart clears.
    this._suppressResumeCapture = true;
    this.setResumeConversation(null);
    this.emit("resume-cleared", { id: this.id });
  }

  // Normalized pack names this session would deliver on its next spawn. Public so the backend can
  // compare a reloaded project record against the live session without reaching into the private field.
  get packNames(): string[] {
    return this._packDelivery.names();
  }

  // Record the version a pack was just rebuilt to (the backend's pack-updated fan-out). Only a pack
  // this session actually SPAWNED against can arm a notice: a session that never delivered the pack
  // has no stale context to warn about. Returns whether this call armed one, for the caller's logs.
  notePackUpdate(name: string, version: string): boolean {
    return this._packDelivery.noteUpdate(name, version);
  }

  // The pack-staleness notice this session owes its next turn, or null. Consumed on read (the hook
  // route injects it into ONE adapter-declared response), and re-armed only when a newer version
  // arrives through notePackUpdate - never once per turn for the same staleness.
  takePackNoticeContext(): string | null {
    return this._packDelivery.takeNotice();
  }

  get packNoticeHookEvent(): string | null {
    if (!this._can("packNotice")) return null;
    return this._adapter.packNoticeHookEvent || "UserPromptSubmit";
  }

  // A spawn re-resolves what is delivered, so notices owed by the previous spawn are void.
  _clearPackNotice(): void {
    this._packDelivery.clearNotice();
  }

  toSnapshot() {
    return this._projectSnapshots().wire;
  }

  get worktreeDir(): string | null { return this.worktreeLifecycle.snapshot().worktreeDir; }

  get commonGitDir(): string | null { return this.worktreeLifecycle.snapshot().commonGitDir; }

  get baseSha(): string | null { return this.worktreeLifecycle.snapshot().baseSha; }

  get mergeStatus(): string { return this.worktreeLifecycle.snapshot().mergeStatus; }

  get mergeReason(): string | null { return this.worktreeLifecycle.snapshot().mergeReason; }

  get mergeConflicts(): string[] { return this.worktreeLifecycle.snapshot().mergeConflicts; }

  get worktreeNotice(): string | null { return this.worktreeLifecycle.snapshot().worktreeNotice; }

  get isWorktree(): boolean { return this.worktreeLifecycle.snapshot().isWorktree; }

  getWorktreeCarry() { return this.worktreeLifecycle.getCarry(); }

  refreshGitContext() { return this.worktreeLifecycle.refreshGitContext(); }

  effectiveCwd(): string { return this.worktreeLifecycle.effectiveCwd(); }

  _provisionWorktree({ fresh = false }: { fresh?: boolean } = {}) { return this.worktreeLifecycle.provision({ fresh }); }

  _settleWorktreeOnExit() { return this.worktreeLifecycle.settleOnExit(); }

  discardWorktreeIfClean() { return this.worktreeLifecycle.discardIfClean(); }

  pasteMergePrompt() { return this.worktreeLifecycle.pasteMergePrompt(); }

  pasteText(text: string) { return this._output.pasteText(text); }

  pasteTextWhenReady(text: string, { timeoutMs = 120000 }: { timeoutMs?: number } = {}) {
    return this._output.pasteTextWhenReady(text, { timeoutMs });
  }

  _clearPendingPaste(): void { this._output.clearPendingPaste(); }

  hasUnmergedWork() { return this.worktreeLifecycle.hasUnmergedWork(); }

  getDiff() { return this.worktreeLifecycle.getDiff(); }

  getBranchSync() { return this.worktreeLifecycle.getBranchSync(); }

  resyncBranch() { return this.worktreeLifecycle.resyncBranch(); }

  checkWorktreeChange(signature?: Parameters<ReturnType<typeof createSessionWorktreeLifecycle>["checkWorktreeChange"]>[0]) {
    return this.worktreeLifecycle.checkWorktreeChange(signature);
  }

  mergeWorktree() { return this.worktreeLifecycle.mergeWorktree(); }

  mergeAndContinue(options: { force?: boolean } = {}) { return this.worktreeLifecycle.mergeAndContinue(options); }

  adoptWorktree(options: Parameters<ReturnType<typeof createSessionWorktreeLifecycle>["adoptWorktree"]>[0]) {
    return this.worktreeLifecycle.adoptWorktree(options);
  }

  discardWorktree() { return this.worktreeLifecycle.discardWorktree(); }

  getDetectionStats() {
    return {
      lastSignal: this._lastSignal,
      hookSeen: this._hookSeen,
      hooksInjected: this._hooks.hasInjection(),
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
      outputBufferEntries: this._output.stats().entries,
      outputBufferBytes: this._output.stats().bytes,
      outputBufferTotal: this._output.stats().total,
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
    return this._projectSnapshots().debug;
  }

  _projectSnapshots() {
    const active = this.backgroundTracking.activeAgentCount();
    const held = this.backgroundTracking.heldReady();
    return projectSessionSnapshots({
      id: this.id,
      name: this.name,
      path: this.path,
      agent: this.agentId,
      state: this.state,
      stateSince: this.stateSince,
      sleeping: this._sleeping,
      dangerouslySkipPermissions: this.dangerouslySkipPermissions,
      ephemeral: this.ephemeral,
      isWorktree: this.isWorktree,
      resumeSessionId: this._resumeSessionId,
      activeAgents: active,
      packs: this._packDelivery.delivered(),
      pendingWakeup: this.backgroundTracking.pendingWakeup(),
      pendingPromptKind: this._pendingPromptKind,
      mergeStatus: this.mergeStatus,
      mergeReason: this.mergeReason,
      worktreeNotice: this.worktreeNotice,
      effectiveBase: this.worktreeLifecycle.snapshot().effectiveBase,
      auditLog: this.auditLog,
      detection: {
        ...this.getDetectionStats(),
        agents: { ...this.backgroundTracking.agentBreakdown(), active },
        gate: held
          ? { heldForMs: Date.now() - held.ts, seq: held.seq, lastActivitySeq: this.backgroundTracking.lastActivitySeq() }
          : null,
      },
      decisions: this._observability.decisionTail(15),
    });
  }

  transition(event: string, detail?: unknown): boolean {
    const stateTransitions = TRANSITIONS[this.state];
    if (!stateTransitions || !(event in stateTransitions)) {
      return false;
    }

    // Run guard if one exists for this event
    const guard = GUARDS[event];
    if (guard && !guard(this, detail)) {
      return false;
    }

    const from = this.state;
    const to = stateTransitions[event];

    // Self-transition: record but skip hooks
    if (from === to) {
      this._pushAuditEntry({
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
    const enteredAt = Date.now();
    this.stateSince = enteredAt;
    this._pushAuditEntry({
      from,
      to,
      event,
      detail: detail || null,
      timestamp: enteredAt,
    });

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
  // `fresh` travels as an ARGUMENT rather than a field set by _prepareRestart: a field survives every
  // path that arms a fresh restart and then abandons it (forceRestart's exit handler returning on a
  // destroyed or non-restartable session, restart({fresh:true}) collapsing onto an in-flight start),
  // and a stranded one turns the operator's next plain Restart into a silent sync-and-rebase.
  start(options: { fresh?: boolean } = {}): Promise<void> {
    if (this._startPending) return this._startPending;
    this._startPending = this._startBody(options).finally(() => { this._startPending = null; });
    return this._startPending;
  }

  async _startBody({ fresh = false }: { fresh?: boolean } = {}): Promise<void> {
    if (this._destroyed) return;
    // Defensive cleanup: if a prior PTY is still alive (e.g. _handlePtyExit
    // hasn't propagated yet after a sleep-kill race), force-kill it before
    // respawning. Without this, ptyProcess assignment below would orphan the
    // previous PTY's onData/onExit subscriptions and leak the process.
    if (this.ptyProcess) {
      console.warn(`[session:${this.name}] start() called while PTY exists - killing previous PTY first`);
      const oldPid = this.ptyProcess.pid;
      // Kill NOW, wait ONCE below. The reap is parked on the same field every other reap uses instead of
      // being awaited inline, so the single bounded join covers this tree too: two independent awaits
      // doubled the worst case a start could spend waiting before it even reached the provision.
      this._killReap = this._reapTreeOnce(oldPid);
      this.ptyProcess = null;
    }
    // THE wait for a previous PTY tree, and the only one. It covers the block above plus both respawn
    // paths that cleared ptyProcess earlier: a forceRestart riding the exit event while kill()'s reap is
    // still walking the dead tree, and a plain restart from DONE following a NATURAL exit whose reap is
    // parked on _exitReap. A fresh provision REWRITES this worktree (integration sync, then a rebase),
    // so it waits them out or the rewrite lands under descendants still holding files open in there.
    const pendingReaps = this._awaitPendingReaps();
    if (pendingReaps) await pendingReaps;
    if (this._destroyed) return;
    // Provision (or reuse) this session's isolated worktree before spawn. All spawn entry points
    // funnel through start(), so each inherits isolation. A blocked provision (integration branch
    // absent) leaves the session DORMANT with a notice and does NOT run in the operator's real tree.
    if (!(await this._provisionWorktree({ fresh }))) return;
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
      this.worktreeLifecycle.startWatching();
      // Armed AFTER the watcher (re)start, which cancels any pending check timer: an adopted clean
      // survivor carries a provisional pending-review that this first check demotes to none.
      if (this.mergeStatus === "pending-review") this.worktreeLifecycle.scheduleCheck();
    }
    if (this.state === STATES.DORMANT) {
      this.transition("user_start");
    }
    this._receivedFirstOutput = false;
    this._sleeping = false;
    // A (re)started PTY begins with no live background sub-agents; drop any stale ids from a prior run.
    this._clearDetectionTracking();
    this._autoKilled = false;
    this._output.reset();
    // A restarted PTY re-bases its monotonic output offset at 0. Signal the backend so
    // it force-closes any LIVE data-WS client (whose ws-sender.sentOffset is now
    // stale-high relative to the reset total) and lets it reconnect + re-baseline.
    // Covers restart(), forceRestart(), and sleep-kill auto-restart (all funnel through
    // start()); harmless no-op on the first start() (no data clients attached yet).
    // See backend.js wireSessionEvents -> closeSessionDataClients.
    this.emit("rebaseline");
    this._resetDetectionSources({ quiet: false });

    // Hooks are wired BEFORE the env is built: a relay-based agent carries its ingress URL (bearer
    // token included) in the spawn env, which is what keeps that token off a world-listable command
    // line and makes an installed hook inert for the operator's own unsupervised runs.
    const hookInjection = this._hooks.inject();
    const settingsArgs = [...hookInjection.args];
    // An agent whose title spins through its own boot (codex) would otherwise open and close a fake
    // work cycle before the operator typed anything, so its titles stay latched quiet until the first
    // authoritative UserPromptSubmit clears the latch. Only with hooks wired, since nothing else
    // would ever un-latch it and the title tier is all a hook-less session has.
    this._titleQuiet = this._adapter.titleProfile.quietUntilFirstPrompt === true && this._hooks.hasInjection();
    this._armTitleQuietFallback();
    // The title tier reads codex's idle title by comparing it against the cwd basename, so the source
    // is told which directory this spawn actually runs in (a worktree changes it).
    this._titleSource.setContext({ cwdBasename: path.basename(this.effectiveCwd()) });
    const spawnExtraEnv = Object.keys(hookInjection.env).length > 0
      ? { ...(this._spawnEnv || {}), ...hookInjection.env }
      : this._spawnEnv;

    const env = this._buildSpawnEnv({
      additionalDirsClaudeMd: packDelivery.packs.length > 0,
      prependPathDir: this._rtkPath ? path.dirname(this._rtkPath) : null,
      extraEnv: spawnExtraEnv,
    });

    // A headless lane passes extra flags (e.g. -p, --model <m>) then the prompt as the final
    // positional; a resume id continues a prior conversation, which Claude resolves across the
    // repo's linked worktrees so the thread picks up in THIS worktree's cwd. The adapter owns the
    // flag spellings and their order (session/adapters/claude-code.ts buildArgs).
    this._suppressResumeCapture = false;
    const agentArgs = this._adapter.buildArgs({
      dangerouslySkipPermissions: this.dangerouslySkipPermissions,
      resumeSessionId: this._can("resume") ? this._resumeSessionId : null,
      extraArgs: this._extraClaudeArgs,
      antiSlopPrompt: this._antiSlopPrompt,
      initialPrompt: this._initialPrompt,
    });
    // Prefer spawning the resolved agent .exe directly (node-pty -> CreateProcess). Fall back to
    // `cmd.exe /c <agent>` only for .cmd/.bat/.ps1 shim installs or when resolution failed. The
    // resolution itself is lazy and cached per agent id (session/adapters/index.ts commandFor).
    const { file, args } = this._adapter.buildSpawnCommand({
      platform: this._platform,
      resolved: this._spawnCommand || commandFor(this._adapter),
      settingsArgs,
      packArgs: packDelivery.args,
      agentArgs,
    });

    // Reuse the last browser-pushed size so a restart spawns at the card's real
    // dimensions; fall back to 80x24 on the very first spawn (no size known yet).
    const spawnSize = this._output.spawnSize();
    try {
      this.ptyProcess = this._ptySpawn(file, args, {
        name: "xterm-256color",
        cols: spawnSize.cols,
        rows: spawnSize.rows,
        cwd: this.effectiveCwd(),
        env,
      });
    } catch (err) {
      this._hooks.cleanup();
      this._packDelivery.replaceDelivered([]);
      this.transition("spawn_fail", { error: err instanceof Error ? err.message : String(err) });
      this.emit("error", err);
      return;
    }
    this._ptyAlive = true;
    this._guardPtyInputSocket();
    this._guardUnixPtySocket();

    const spawnCwdExists = fs.existsSync(this.effectiveCwd());
    if (!this.transition("spawn_success", { spawnCwdExists })) {
      this.ptyProcess.onExit(({ exitCode, signal }) =>
        this._handlePtyExit(exitCode, signal),
      );
      this._hooks.cleanup();
      this._packDelivery.replaceDelivered([]);
      this.transition("spawn_fail", { reason: "spawn_cwd_missing" });
      this.kill();
      return;
    }

    // Emitted only once the agent is actually running with these packs on disk, and carrying whether
    // the Read hook REACHED the settings file rather than whether the adapter could in principle carry
    // it: a refused injection or a failed spawn would otherwise be recorded as a measurable delivery
    // nobody could ever have opened.
    if (packDelivery.packs.length > 0) {
      this.emit("packs-delivered", {
        packs: this._packDelivery.deliveredWithDirs(),
        agent: this.agentId,
        readDetection: this._hooks.detectsPackReads() ? "available" : "unavailable",
        ts: Date.now(),
      });
    }

    // Redact a positional initialPrompt (headless lanes) from the spawn log - it can be a multi-KB
    // context block that does not belong in the console.
    const initialPrompt = this._initialPrompt;
    const argsForLog = initialPrompt
      ? args.map((a) => (a === initialPrompt ? `<prompt:${initialPrompt.length}c>` : a)).join(" ")
      : args.join(" ");
    console.log(
      `[session ${this.id}] spawn: ${file} ${argsForLog} (cwd=${this.effectiveCwd()})`,
    );

    if (this._recorder) {
      this._recorder.writeHeader({
        agent: this.agentId,
        hooksInjected: this._hooks.hasInjection(),
        cols: spawnSize.cols,
        rows: spawnSize.rows,
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
  _guardPtyInputSocket(): void {
    try {
      this.ptyProcess?._agent?.inSocket?.on("error", (err) => {
        console.warn(`[session ${this.id}] pty input socket error (ignored): ${err.message}`);
      });
    } catch {
      // node-pty internal shape differs (version/backend): non-fatal.
    }
  }

  // node-pty's unix backend RETHROWS an unexpected pty socket error out of its own socket handler
  // (unixTerminal.js: `if (this.listeners('error').length < 2) throw err`), and there is deliberately no
  // uncaughtException handler here, so one read error on one session took the whole server down.
  // ONE listener closes it: Terminal.on and Terminal.listeners both delegate to the pty socket
  // (terminal.js, node-pty 1.1.0), so node-pty's own handler is already listener #1 and ours makes 2.
  // Ours is registered second, so it also RUNS second, after that handler has decided not to throw.
  // win32 is left untouched: its ConPTY input-socket guard above is the failure that happens there.
  _guardUnixPtySocket(): void {
    if (this._platform === "win32") return;
    try {
      this.ptyProcess?.on?.("error", (err) => this._handlePtySocketError(err));
    } catch {
      // node-pty internal shape differs (version/backend): non-fatal.
    }
  }

  // Same filtering node-pty applies before it rethrows: EAGAIN is normal startup noise on its read
  // stream, and EIO means the child closed the pty, which the exit callback already reports. Anything
  // else has broken this PTY for good: kill the tree and let the ORDINARY exit path report it, rather
  // than calling _handlePtyExit here and racing node-pty's own exit callback into a second one.
  _handlePtySocketError(err: unknown): void {
    const errorCode = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : "";
    const code = String(errorCode || "");
    if (code.includes("EAGAIN")) return;
    if (code.includes("EIO") || code.includes("errno 5")) return;
    if (!this._ptyAlive) return;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[session ${this.id}] pty socket error: ${message} - killing the session`);
    this.kill();
  }

  /*
   * Hooks wired is not hooks ARRIVING: codex silently skips an untrusted hook, so a session whose
   * callbacks never come would sit title-quiet for its whole life and report nothing at all. The
   * latch therefore has a deadline. It is generous on purpose (the boot noise it exists to swallow is
   * over within seconds, so dropping it late costs nothing), and it only ever drops the latch, never
   * re-arms it. A hook that does arrive clears the latch through the ordinary `resume` path.
   */
  _armTitleQuietFallback(): void {
    this._clearTimer("_titleQuietFallbackTimer");
    if (!this._titleQuiet) return;
    this._armTimer("_titleQuietFallbackTimer", this._titleQuietFallbackMs, () => {
      if (this._destroyed || !this._titleQuiet) return;
      if (this._hookSeen) return; // hooks are flowing; the latch is doing its real job
      console.warn(`[session:${this.name}] no hook callback within ${Math.round(this._titleQuietFallbackMs / 1000)}s - opening the title tier (detection is degraded)`);
      this._titleQuiet = false;
      this._recordDecision({ kind: "title-latch", ts: Date.now(), decision: "fallback-open", reason: "no hook callback before the deadline" });
    }, { unref: true });
  }

  // Pack delivery is additive, so resolution and rendering failures never block spawn.
  async _resolvePacks() {
    return this._packDelivery.resolve();
  }

  _buildSpawnEnv({ extraEnv = this._spawnEnv, ...options }: {
    extraEnv?: Record<string, string> | null;
    additionalDirsClaudeMd?: boolean;
    prependPathDir?: string | null;
  } = {}) {
    return this._adapter.buildEnv(process.env, extraEnv, options);
  }

  _handlePtyData(data: string): void {
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
        console.error(`[session:${this.name}] title source error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Buffer for late-joining data WS clients (session/core/output-ring.ts).
    //
    // ORDER CONTRACT: the ring push (which advances the monotonic total) MUST stay
    // BEFORE emit("data") below. ws-sender.maybeBackfill() reads getBufferSince()
    // from inside the "data" listener and relies on the just-arrived chunk already
    // being retained and counted (see ws-sender.js maybeBackfill). Reordering would
    // make a backfill miss the in-flight chunk.
    this._output.push(data);
    if (this.listenerCount("data") > 0) {
      this.emit("data", data);
    }
  }

  async _handlePtyExit(exitCode: number, signal: ExitSignal): Promise<void> {
    const pid = this.ptyProcess ? this.ptyProcess.pid : null;
    this._resetDetectionSources({ quiet: false, clearTracking: true });
    // The next spawn re-resolves its packs, so a notice owed by the dead one has no turn to ride.
    this._clearPackNotice();
    this._hooks.cleanup();
    this._ptyAlive = false;
    this.ptyProcess = null;

    // Reap orphan grandchildren. NOT awaited here: the settle/emit sequence below does not depend on it,
    // and blocking the exit emit on a reap would strand every queued once("exit") handler. It is PARKED
    // on _exitReap instead, because the next start() must not rewrite this worktree while descendants of
    // the exited tree can still write in it, and a fire-and-forget reap gave that start nothing to wait
    // on. Bounded on both platforms and never rejecting: an awaiter only needs to know the wait is over.
    // Off Windows the dead pty child's own process group is where those grandchildren still sit, holding
    // handles inside the worktree; an empty group answers ESRCH, which is the ordinary case here.
    if (pid) {
      this._exitReap = this._reapTreeOnce(pid);
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
      this._recorder.writeFooter("pty_exit", exitCode);
      this._recorder.close();
    }

    this.emit("exit", { exitCode, signal, reason });
  }

  getReplayBuffer(): string {
    return this._output.replay();
  }

  // Current monotonic output offset (== total bytes ever produced). A data-WS client
  // captures this at connect as its live baseline (startOffset).
  getOutputOffset(): number {
    return this._output.stats().total;
  }

  // Slice of output produced at or after `offset`; full offset/eviction semantics
  // documented on session/core/output-ring.ts since().
  getBufferSince(offset: number) {
    return this._output.since(offset);
  }

  write(text: string): void {
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

  resize(cols: number, rows: number): void {
    const didSizeChange = this._output.rememberSize(cols, rows);
    if (this._recorder) {
      this._recorder.writeResize(cols, rows);
    }
    if (!didSizeChange || !this.ptyProcess) return;
    // Apply immediately, even when quiescent (IDLE/COMPLETE/WAITING), so Claude
    // gets SIGWINCH and reflows to fit.
    try {
      this.ptyProcess.resize(cols, rows);
    } catch {
      // PTY exited between our check and the resize call (Windows ConPTY race).
    }
  }

  // Async Windows taskkill (process tree, forced). Returns a promise so a caller can await the reap
  // (start()'s prior-PTY kill) or fire-and-forget with a .catch (the reap / kill / force-kill paths).
  // Array args (no shell string interpolation): safer and faster than the old execSync template.
  _taskkill(pid: number | null, opts: Record<string, unknown> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this._killProc(["/PID", String(Number(pid)), "/T", "/F"], { ...opts }, (err: unknown) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  // An 'error' emit with no listener is an uncaught throw, and every kill path is best-effort.
  _emitError(err: unknown): void {
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  // The POSIX answer to taskkill /T /F. node-pty setsid()s its unix child, so the child's pgid IS its pid
  // and one signal to the NEGATIVE pid reaches the whole tree; ptyProcess.kill() is a single-pid SIGHUP
  // that leaves every background bash task, MCP server and teammate under it orphaned. A grandchild that
  // setsid'd itself out of the group escapes, which is the same parity taskkill has with a re-parented
  // process. ESRCH is the ordinary outcome (the tree is already gone), never an error worth surfacing.
  _killProcessGroup(pid: number | null, signal: NodeJS.Signals = "SIGKILL"): void {
    const target = signalablePid(pid);
    if (target === null) return;
    try {
      this._signalProc(-target, signal);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined;
      if (err && code !== "ESRCH") this._emitError(err);
    }
  }

  // What every caller means by "alive" is the TREE, and off Windows the probe therefore targets the
  // GROUP: node-pty's waitpid thread reaps the leader promptly, so a leader-only probe reports gone
  // while the background bash tasks and MCP servers under it still hold handles in the worktree. On
  // win32 there are no process groups and taskkill /T is what covers the tree, so it probes the pid.
  _isProcessAlive(pid: number | null): boolean {
    const target = signalablePid(pid);
    if (target === null) return false;
    const probeTarget = this._platform === "win32" ? target : -target;
    try {
      this._signalProc(probeTarget, 0);
      return true;
    } catch {
      // EPERM (alive but unsignalable) is deliberately read as gone: stopping the poll is the safe direction.
      return false;
    }
  }

  // Kill the group and hand back the same awaitable reap the win32 taskkill gives: signalling is instant,
  // but the tree's death is not, and restart / shutdown / the ephemeral-lane worktree discard all act on
  // what that tree still holds open. Never rejects - an awaiter only needs to know the wait is over. A
  // zombie keeps answering signal 0 until node-pty waitpid()s it, which is what the budget bounds.
  // Reap the tree behind `pid`, REUSING an in-flight reap rather than arming a second wait on it. One
  // timer field serves one wait (see _awaitProcessGone), so a second one settles the first EARLY, and the
  // shutdown coordinator and the ephemeral lanes await _killReap to know the tree is gone: they would
  // have proceeded under surviving descendants. A non-null _resolveKillReap IS "a wait is running right
  // now"; with none, this caller owns the group signal and the poll. Bounded and never rejecting on both
  // platforms, since an awaiter only needs to know the wait is over.
  _reapTreeOnce(pid: number | null): Promise<void> | null {
    if (this._platform === "win32") {
      return this._taskkill(pid, { timeout: KILL_REAP_MAX_WAIT_MS })
        .catch(() => { /* already dead/unkillable/timed out - proceed */ });
    }
    if (this._resolveKillReap) return this._killReap;
    return this._reapProcessGroup(pid);
  }

  // Join every in-flight reap of a previous PTY tree, or null when there is none to wait for. BOUNDED,
  // and that is the point: start() is single-flight, and the win32 reap is a taskkill that can wedge with
  // no timeout of its own, so an unbounded wait here would strand every later start on this session
  // forever. The cap is the POSIX reap's own budget, which is what the wait is worth; past it the tree is
  // not coming back and proceeding beats never starting. Never rejects.
  _awaitPendingReaps(): Promise<void> | null {
    const pending = [this._killReap, this._exitReap].filter((reap) => reap !== null);
    if (pending.length === 0) return null;
    // The cap timer is deliberately NOT unref'd: it is the only thing keeping the loop alive while a
    // wedged reap is waited out, and an unref'd one lets the process resolve out from under this await.
    // The race always settles, so the clearTimeout below always runs and nothing is left armed.
    let capTimer: NodeJS.Timeout | undefined;
    const capped = new Promise((resolve) => { capTimer = setTimeout(resolve, KILL_REAP_MAX_WAIT_MS); });
    return Promise.race([Promise.allSettled(pending), capped])
      .then(() => { clearTimeout(capTimer); });
  }

  _reapProcessGroup(pid: number | null, { maxWaitMs = KILL_REAP_MAX_WAIT_MS }: { maxWaitMs?: number } = {}): Promise<void> {
    this._killProcessGroup(pid);
    return this._awaitProcessGone(pid, maxWaitMs);
  }

  _awaitProcessGone(pid: number | null, maxWaitMs: number): Promise<void> {
    // One timer field serves one wait: settle any earlier one first, or arming over it would strand that
    // promise unresolved for whoever is awaiting it.
    if (this._resolveKillReap) this._resolveKillReap();
    return new Promise((resolve) => {
      const settle = (): void => {
        this._clearTimer("_killReapTimer");
        this._resolveKillReap = null;
        resolve();
      };
      this._resolveKillReap = settle;
      let waited = 0;
      // Deliberately runs past destroy(): the ephemeral lanes destroy a session and then discard its
      // worktree, and a reap that resolved early on teardown would hand them a tree still holding
      // handles in it. The budget below is what bounds the wait instead.
      const poll = (): void => {
        if (!this._isProcessAlive(pid)) {
          settle();
          return;
        }
        waited += KILL_POLL_INTERVAL_MS;
        if (waited >= maxWaitMs) {
          settle();
          return;
        }
        this._armTimer("_killReapTimer", KILL_POLL_INTERVAL_MS, poll);
      };
      // Probe FIRST, arm a timer only if something is still alive. Waiting out a poll interval before
      // the first look charged every restart 200ms of dead time for a tree that was usually already
      // gone (restart only fires from DONE/FAILED), where the win32 taskkill returns as fast as it can.
      poll();
    });
  }

  kill(): void {
    if (!this.ptyProcess) return;

    // Stop writing the instant we kill: the conin pipe peer dies with the child,
    // so any further write() would hit the dead pipe (see _guardPtyInputSocket).
    // The flip and the force-kill scheduling stay SYNCHRONOUS and in order; only the REAP is async (the
    // taskkill on Windows, the process-gone poll after the group signal off it).
    this._ptyAlive = false;
    const pid = this.ptyProcess.pid;

    if (this._platform === "win32") {
      // Retain the reap promise so the server lifecycle can await it before exit/respawn (orphan fix).
      // The .catch keeps the error-emission behavior; awaiters use Promise.allSettled so a reject is fine.
      const killReap = this._taskkill(pid);
      this._killReap = killReap;
      killReap.catch((err: unknown) => this._emitError(err));
    }
    if (this._platform !== "win32") {
      // The group SIGKILL covers the pty child itself, so node-pty's own single-pid kill() adds nothing.
      this._killReap = this._reapProcessGroup(pid);
    }

    this._forceKillAfterTimeout(pid);
  }

  _forceKillAfterTimeout(pid: number): void {
    let elapsed = 0;
    const poll = (): void => {
      if (this._destroyed) return;
      if (!this._isProcessAlive(pid)) return;
      elapsed += KILL_POLL_INTERVAL_MS;
      if (elapsed >= KILL_MAX_WAIT_MS) {
        // Terminal branch: the process outlived the poll budget. Force-kill async on Windows; off it the
        // group SIGKILL stays synchronous (already a non-blocking signal) and covers the whole tree.
        if (this._platform === "win32") {
          this._taskkill(pid).catch((err: unknown) => this._emitError(err));
          return;
        }
        this._killProcessGroup(pid);
        return;
      }
      this._armTimer("_killPollTimer", KILL_POLL_INTERVAL_MS, poll);
    };

    this._armTimer("_killPollTimer", KILL_POLL_INTERVAL_MS, poll);
  }

  dismiss(): boolean {
    if (!DISMISSIBLE_STATES.has(this.state)) return false;
    return this.transition("user_dismiss");
  }

  sleep(): void {
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

  wake(): void {
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
  _teardownPending(): boolean {
    return this._pendingRestart || this._finishing;
  }

  _scheduleSleepKill(): void {
    this._armTimer("_sleepKillTimer", SLEEP_KILL_TIMEOUT_MS, () => {
      if (!this._sleeping) return;
      const wasActive = KILLABLE_STATES.includes(this.state);
      this.killSession("natural");
      if (wasActive && RESTARTABLE_STATES.includes(this.state)) {
        this._autoKilled = true;
      }
    });
  }

  _clearSleepKill(): void {
    this._clearTimer("_sleepKillTimer");
  }

  // Every close-out reaches the SAME user_kill transition, so what ended the run travels with it: the
  // measurement lane counts only an operator abandoning live work as an abort, and inferring that from
  // the transition name scored a finish, a sleep-kill and a restart as aborts too.
  killSession(endIntent: SessionEndIntent = "operator-abort"): boolean {
    if (!KILLABLE_STATES.includes(this.state)) return false;
    this.kill();
    return this.transition("user_kill", { endIntent });
  }

  restart(options: { fresh?: boolean } = {}): boolean {
    if (this._destroyed) return false;
    // A queued teardown (finish/force-restart) is mid-flight; respawning now would race its exit
    // handler. This is the load-bearing guard: once a finish/force-restart's killSession() flips the
    // card to DONE, the dashboard's Restart button sends a plain `restart` (not `force-restart`), so
    // the mutex MUST live here too, not only in forceRestart.
    if (this._teardownPending()) return false;
    if (!RESTARTABLE_STATES.includes(this.state)) return false;
    this._prepareRestart(options);
    this.transition("user_restart");
    this.start({ fresh: options.fresh === true });
    return true;
  }

  // Close-out: return a finished, fully-settled session (PTY dead, worktree already merged/discarded)
  // to DORMANT so its card parks for reuse. Guarded by user_reset (see state-machine.ts), so it is a
  // no-op on a live or unmerged session. mergeStatus is cleared to 'none' only on a successful reset
  // (silently; the dashboard recreates the card as dormant from the state-change). Returns whether the
  // reset happened.
  resetToDormant(): boolean {
    if (this._destroyed) return false;
    const did = this.transition("user_reset");
    if (did) this.worktreeLifecycle.setMergeStatus("none", {}, { emit: false });
    return did;
  }

  // One-click close-out behind the sidebar's "Merge & finish": merge the worktree into the integration
  // branch and return the session to DORMANT. A settled session (DONE/FAILED) merges immediately. A
  // quiescent live session (COMPLETE/IDLE) is ENDED first (we must not rewrite a worktree the PTY is
  // still running in), then merged once it settles on exit. RUNNING/WAITING and the startup states are
  // refused (mid-work, or no worktree yet). Returns { ok, pending?, reason? }.
  finishAndMerge(): { ok: boolean; pending?: boolean; reason?: string } {
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
      this.killSession("close-out"); // -> DONE now; the real PTY exit settles the worktree, then the handler merges
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

  forceRestart(options: { fresh?: boolean } = {}): boolean {
    if (this._destroyed) return false;
    if (this._teardownPending()) return false;
    if (KILLABLE_STATES.includes(this.state)) {
      this._prepareRestart(options);
      const fresh = options.fresh === true;
      this._pendingRestart = true;
      this.once("exit", () => {
        this._pendingRestart = false;
        if (this._destroyed) return;
        if (!RESTARTABLE_STATES.includes(this.state)) return;
        this.transition("user_restart");
        this.start({ fresh });
      });
      this.kill();
      this.transition("user_kill", { endIntent: "natural" });
      return true;
    }
    if (!RESTARTABLE_STATES.includes(this.state)) return false;
    return this.restart(options);
  }

  updateSettings(cfg: { replayBufferKB?: number | null }): void {
    if (cfg.replayBufferKB != null)
      this._output.setMax(cfg.replayBufferKB * 1024);
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    this._clearSleepKill();

    this._clearPendingPaste();

    this._hooks.cleanup();

    this.kill();

    this._clearTimer("_killPollTimer");
    this._clearTimer("_titleQuietFallbackTimer");
    // _killReapTimer is deliberately NOT cleared here: it is driving the reap a shutdown or an ephemeral
    // lane's worktree discard is about to await, and it settles itself inside the kill budget.

    this.backgroundTracking.clearGateHeldReady();
    this._clearPackNotice();

    if (this._recorder) {
      this._recorder.close(); // Idempotent - safe if already closed by _handlePtyExit
    }
    this.worktreeLifecycle.stopWatching();
    this._titleSource.destroy();
    this._statusSource.destroy();
    this.removeAllListeners();
  }
}

// A FUNCTION, not a module-load value: resolving at import made every consumer of this file pay a PATH
// lookup. The adapter registry caches it on first call (session/adapters/index.ts).
function claudeCommand(): ResolvedCommand {
  return commandFor(DEFAULT_AGENT_ID);
}

export { Session, buildSpawnCommand, classifyClaudeKind, claudeCommand };
export type { SessionOptions, SessionPty, SessionRecorderPort };
