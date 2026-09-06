import fs from "node:fs";
import path from "node:path";
import pty from "node-pty";
import { EventEmitter } from "node:events";
import { execFile } from "../server/child-process-safe.ts";
import { STATES, KILLABLE_STATES, RESTARTABLE_STATES } from "../shared/states.ts";
import type { SessionState } from "../shared/states.ts";
import { createOscTitleSource } from "../detection/osc-title-source.ts";
import { createStatusSource } from "../detection/status-source.ts";
import type { MetaStatusSignal, ResolvedStatusSignal } from "../detection/status-source.ts";
import type { HookSignal } from "../detection/hook-source.ts";
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

const KILL_REAP_MAX_WAIT_MS = 2400;
const SLEEP_KILL_TIMEOUT_MS = 15 * 60 * 1000;

function signalablePid(pid: unknown): number | null {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < 2) return null;
  return parsed;
}

const DISMISSIBLE_STATES: Set<SessionState> = new Set([STATES.WAITING, STATES.COMPLETE]);

type SessionEndIntent = "operator-abort" | "close-out" | "natural";

interface SessionMillMetricsPort {
  onHookEvent: (sessionId: string, event: string, payload: Record<string, unknown>) => void;
}

type TimerField = "_killPollTimer" | "_killReapTimer" | "_sleepKillTimer" | "_titleQuietFallbackTimer";

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
  observeToolCalls?: boolean;
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

    hookRouter = null,
    getHookPort = null,
    hooksBaseDir = undefined,
    titleStabilizationMs = 1500,
    statusConflictMs = undefined,
    statusDedupMs = undefined,

    detectBackgroundAgents = true,
    agentTtlMs = agentTracker.DEFAULT_AGENT_TTL_MS,

    shellTaskTtlMs = agentTracker.DEFAULT_SHELL_TASK_TTL_MS,

    teammateTaskTtlMs = agentTracker.DEFAULT_TEAMMATE_TASK_TTL_MS,

    gateReleaseSettleMs = DEFAULT_GATE_RELEASE_SETTLE_MS,

    detectScheduledWakeups = true,

    observeToolCalls = false,

    agent = DEFAULT_AGENT_ID,

    adapter = null,

    bypassHookTrust = false,

    titleQuietFallbackMs = 30000,

    spawnCommand = null,

    initialPrompt = null,
    extraClaudeArgs = [],
    ephemeral = false,

    resumeSessionId = null,

    antiSlopPrompt = false,

    settingsPermissions = null,

    spawnEnv = null,

    enableProjectMcp = false,
    rtkPath = null,

    packs = [],

    packsBuiltRoot = null,

    packVariantSlug = null,
    millMetricsPort = null,

    planLimits = false,

    getUserHooks = null,

    ptySpawn = null,

    killProc = null,

    signalProc = null,

    platform = process.platform,

    gitWorkspace = null,
    integrationBranch = null,

    autoRebase = true,
    syncOnStart = true,

    liveWorktreeReview = true,

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

    this._resolveKillReap = null;

    this._killReap = null;

    this._exitReap = null;
    this._sleeping = false;
    this._sleepKillTimer = null;
    this._autoKilled = false;
    this._destroyed = false;
    this._pendingRestart = false;

    this._finishing = false;

    this._ptyAlive = false;
    this._recorder = null;
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

    const resolvedAdapter = adapter || resolveAdapter(agent, { label: `session:${name}` });
    if (!resolvedAdapter) throw new TypeError("default agent adapter is unavailable");
    this._adapter = resolvedAdapter;
    this.agentId = this._adapter.id;
    this._observability = createSessionObservability({
      agentId: this.agentId,
      getRecorder: () => this._recorder,
    });

    this.usageVendor = this._adapter.usageVendor || "claude";
    this.bypassHookTrust = bypassHookTrust === true;
    this._titleQuietFallbackMs = titleQuietFallbackMs;
    this._titleQuietFallbackTimer = null;

    this._hookSeen = false;
    this._lastSignal = null;

    this._pendingPromptKind = null;

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
      configuredPacks: typeof packs === "function" ? (packs as () => unknown) : () => packs,
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
      observeToolCalls: observeToolCalls === true,
      enableProjectMcp: !!enableProjectMcp,
      rtkPath: this._rtkPath,
      planLimits: this._planLimits,
      getUserHooks,
      bypassHookTrust: this.bypassHookTrust,
      effectiveCwd: () => this.effectiveCwd(),
      ingestSignal: (raw) => this.ingestHookSignal(raw),
      observeHook: (event, payload) => {
        millMetricsPort?.onHookEvent(this.id, event, payload);
        this.emit("hook-event", { event, payload });
      },
      recordDecision: (entry) => this._recordDecision(entry),
    });
    this._ptySpawn = ptySpawn || ((file, args, opts) => pty.spawn(file, args, opts));

    this._killProc = killProc || ((args, opts, cb) => execFile("taskkill", args, opts, cb));
    this._signalProc = signalProc || ((pid, signal) => process.kill(pid, signal));
    this._platform = platform;

    this._startPending = null;
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
      if (this._titleQuiet) return;
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

  _can(capability: keyof AgentCapabilities): boolean {
    return this._adapter.capabilities?.[capability] === true;
  }

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

  ingestHookSignal(raw: HookSignal): void {
    if (this._destroyed) return;
    this._hookSeen = true;
    if (this._recorder && raw && raw.event) {
      this._recorder.writeHook(raw.event, raw.payload);
    }

    if (raw && (raw.signal === "subagent-start" || raw.signal === "subagent-stop")) {
      this.backgroundTracking.trackSubagent(raw);
      return;
    }

    if (raw && (raw.signal === "task-created" || raw.signal === "task-completed" || raw.signal === "teammate-idle")) {
      this.backgroundTracking.trackTaskLifecycle(raw);
      return;
    }

    if (raw && (raw.signal === "wakeup-scheduled" || raw.signal === "cron-created" || raw.signal === "cron-deleted")) {
      this.backgroundTracking.trackWakeup(raw);
      return;
    }

    if (raw?.payload) {
      const sessionIdOf = typeof this._adapter.sessionIdOf === "function"
        ? this._adapter.sessionIdOf
        : (payload: HookPayload) => payload?.session_id;
      this._captureClaudeSessionId(sessionIdOf(raw.payload), raw.payload.source);
    }

    if (raw && raw.signal === "awaiting-input") this._setPendingPromptKind(raw.promptKind || null);
    if (raw && raw.signal === "session-start") this._onSessionStartHook(raw);
    if (raw && raw.signal === "resume") {
      this._titleQuiet = false;
      this._setPendingPromptKind(null);

      this.backgroundTracking.clearGateHeldReady();
      this.backgroundTracking.resetTurnEvidence();
      this.backgroundTracking.clearBgDeclared();

      this.emit("user-prompt", { state: this.state, stateSince: this.stateSince, ts: Date.now() });
    }

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

  _onSessionStartHook(raw: HookSignal): void {
    const payload = raw.payload || {};
    const src = String(payload.source || "").toLowerCase();
    if (src !== "clear" && src !== "compact") return;
    this._resetDetectionSources({ quiet: true });
    this.backgroundTracking.clearGateHeldReady();
    this.backgroundTracking.resetTurnEvidence();
    this._setPendingPromptKind(null);
  }

  _captureClaudeSessionId(id: unknown, source: unknown): void {
    if (this._suppressResumeCapture) return;
    if (typeof id !== "string" || !RESUME_ID_RE.test(id)) return;
    if (id === this._resumeSessionId) return;
    this.setResumeConversation(id);

    this.emit("claude-session-id", { id, source: source || null, vendor: this.usageVendor, sessionId: id });
  }

  _setPendingPromptKind(kind: string | null): void {
    const next = kind || null;
    if (next === this._pendingPromptKind) return;
    this._pendingPromptKind = next;
    this.emit("prompt-kind-change", { pendingPromptKind: next });
  }

  _pushAuditEntry(entry: Record<string, unknown>): void {
    this._observability.pushAuditEntry(entry);
  }

  _recordDecision(entry: DecisionEntry): void {
    this._observability.recordDecision(entry);
  }

  recordNotifyDecision(entry: DecisionEntry): void {
    this._recordDecision(entry);
  }

  _resetDetectionSources({ quiet, clearTracking = false }: { quiet?: boolean; clearTracking?: boolean } = {}): void {
    this._titleSource.reset();
    this._statusSource.reset();
    if (quiet !== undefined) this._titleQuiet = quiet;

    if (clearTracking) this._clearDetectionTracking();
  }

  _clearDetectionTracking(): void {
    this.backgroundTracking.clearGateHeldReady();
    this.backgroundTracking.clearAgents();
    this.backgroundTracking.clearWakeups();
    this._setPendingPromptKind(null);
  }

  _onStatus(s: ResolvedStatusSignal): void {
    if (this._destroyed) return;
    this._lastSignal = { signal: s.signal, source: s.source, confidence: s.confidence, ts: s.ts };

    const signalSeq = this.backgroundTracking.noteStatus(s.signal);

    if (s.signal === "working") this._setPendingPromptKind(null);

    const active = this.backgroundTracking.activeAgentCount();
    const eventWithoutGate = mapSignalToEvent(s.signal, this.state, s.confidence, 0);
    const orphanStopGate = s.signal === "ready" && s.source === "hook"
      && this.backgroundTracking.hasOrphanStopEvidence() && !!eventWithoutGate;
    const event = orphanStopGate
      ? null
      : mapSignalToEvent(s.signal, this.state, s.confidence, active);

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

    if (s.signal === "ready") this.worktreeLifecycle.scheduleCheck();
  }

  _onMeta(m: MetaStatusSignal): void {

    this._lastSignal = { signal: m.signal, source: m.source, ts: m.ts, meta: true };
  }

  get pid(): number | null {
    return this.ptyProcess ? this.ptyProcess.pid : null;
  }

  get hookSeen(): boolean {
    return this._hookSeen;
  }

  get sleeping(): boolean {
    return this._sleeping;
  }

  get hasLivePty(): boolean {
    return !this._destroyed && !!this.ptyProcess && !!this._ptyAlive;
  }

  get pendingRestart(): boolean {
    return this._pendingRestart;
  }

  setResumeConversation(id: string | null): void {
    this._resumeSessionId = id || null;
  }

  get resumeSessionId(): string | null {
    return this._resumeSessionId;
  }

  _prepareRestart(options: { fresh?: boolean } = {}): void {
    if (options.fresh !== true) return;

    this._suppressResumeCapture = true;
    this.setResumeConversation(null);
    this.emit("resume-cleared", { id: this.id });
  }

  get packNames(): string[] {
    return this._packDelivery.names();
  }

  notePackUpdate(name: string, version: string): boolean {
    return this._packDelivery.noteUpdate(name, version);
  }

  takePackNoticeContext(): string | null {
    return this._packDelivery.takeNotice();
  }

  get packNoticeHookEvent(): string | null {
    if (!this._can("packNotice")) return null;
    return this._adapter.packNoticeHookEvent || "UserPromptSubmit";
  }

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

    const guard = GUARDS[event];
    if (guard && !guard(this, detail)) {
      return false;
    }

    const from = this.state;
    const to = stateTransitions[event];

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

    const exitHook = EXIT_HOOKS[from];
    if (exitHook) {
      exitHook(this);
    }

    if (from === STATES.WAITING) this._setPendingPromptKind(null);

    this.state = to;

    const entryHook = ENTRY_HOOKS[to];
    if (entryHook) {
      entryHook(this);
    }

    if (to === STATES.IDLE || to === STATES.COMPLETE) {
      this._titleSource.resyncWorkingLatch();
    }

    const enteredAt = Date.now();
    this.stateSince = enteredAt;
    this._pushAuditEntry({
      from,
      to,
      event,
      detail: detail || null,
      timestamp: enteredAt,
    });

    if (this._recorder) {
      this._recorder.writeState(from, to, event, detail);
    }

    this.emit("state-change", { from, to, event, detail: detail || null });

    return true;
  }

  start(options: { fresh?: boolean } = {}): Promise<void> {
    if (this._startPending) return this._startPending;
    this._startPending = this._startBody(options).finally(() => { this._startPending = null; });
    return this._startPending;
  }

  async _startBody({ fresh = false }: { fresh?: boolean } = {}): Promise<void> {
    if (this._destroyed) return;

    if (this.ptyProcess) {
      console.warn(`[session:${this.name}] start() called while PTY exists - killing previous PTY first`);
      const oldPid = this.ptyProcess.pid;

      this._killReap = this._reapTreeOnce(oldPid);
      this.ptyProcess = null;
    }

    const pendingReaps = this._awaitPendingReaps();
    if (pendingReaps) await pendingReaps;
    if (this._destroyed) return;

    if (!(await this._provisionWorktree({ fresh }))) return;

    if (this._destroyed) return;

    const packDelivery = await this._resolvePacks();
    if (this._destroyed) return;

    if (this.worktreeDir) {
      this.worktreeLifecycle.startWatching();

      if (this.mergeStatus === "pending-review") this.worktreeLifecycle.scheduleCheck();
    }
    if (this.state === STATES.DORMANT) {
      this.transition("user_start");
    }
    this._receivedFirstOutput = false;
    this._sleeping = false;

    this._clearDetectionTracking();
    this._autoKilled = false;
    this._output.reset();

    this.emit("rebaseline");
    this._resetDetectionSources({ quiet: false });

    const hookInjection = this._hooks.inject();
    const settingsArgs = [...hookInjection.args];

    this._titleQuiet = this._adapter.titleProfile.quietUntilFirstPrompt === true && this._hooks.hasInjection();
    this._armTitleQuietFallback();

    this._titleSource.setContext({ cwdBasename: path.basename(this.effectiveCwd()) });
    const spawnExtraEnv = Object.keys(hookInjection.env).length > 0
      ? { ...(this._spawnEnv || {}), ...hookInjection.env }
      : this._spawnEnv;

    const env = this._buildSpawnEnv({
      additionalDirsClaudeMd: packDelivery.packs.length > 0,
      prependPathDir: this._rtkPath ? path.dirname(this._rtkPath) : null,
      extraEnv: spawnExtraEnv,
    });

    this._suppressResumeCapture = false;
    const agentArgs = this._adapter.buildArgs({
      dangerouslySkipPermissions: this.dangerouslySkipPermissions,
      resumeSessionId: this._can("resume") ? this._resumeSessionId : null,
      extraArgs: this._extraClaudeArgs,
      antiSlopPrompt: this._antiSlopPrompt,
      initialPrompt: this._initialPrompt,
    });

    const { file, args } = this._adapter.buildSpawnCommand({
      platform: this._platform,
      resolved: this._spawnCommand || commandFor(this._adapter),
      settingsArgs,
      packArgs: packDelivery.args,
      agentArgs,
    });

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

    if (packDelivery.packs.length > 0) {
      this.emit("packs-delivered", {
        packs: this._packDelivery.deliveredWithDirs(),
        agent: this.agentId,
        readDetection: this._hooks.detectsPackReads() ? "available" : "unavailable",
        ts: Date.now(),
      });
    }

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

  _guardPtyInputSocket(): void {
    try {
      this.ptyProcess?._agent?.inSocket?.on("error", (err) => {
        console.warn(`[session ${this.id}] pty input socket error (ignored): ${err.message}`);
      });
    } catch {

    }
  }

  _guardUnixPtySocket(): void {
    if (this._platform === "win32") return;
    try {
      this.ptyProcess?.on?.("error", (err) => this._handlePtySocketError(err));
    } catch {

    }
  }

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

  _armTitleQuietFallback(): void {
    this._clearTimer("_titleQuietFallbackTimer");
    if (!this._titleQuiet) return;
    this._armTimer("_titleQuietFallbackTimer", this._titleQuietFallbackMs, () => {
      if (this._destroyed || !this._titleQuiet) return;
      if (this._hookSeen) return;
      console.warn(`[session:${this.name}] no hook callback within ${Math.round(this._titleQuietFallbackMs / 1000)}s - opening the title tier (detection is degraded)`);
      this._titleQuiet = false;
      this._recordDecision({ kind: "title-latch", ts: Date.now(), decision: "fallback-open", reason: "no hook callback before the deadline" });
    }, { unref: true });
  }

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

    if (this.state === STATES.STARTING && !this._receivedFirstOutput) {
      this._receivedFirstOutput = true;
      this.transition("first_output");
    }

    if (!this._sleeping) {
      try {
        this._titleSource.feed(data);
      } catch (err) {
        console.error(`[session:${this.name}] title source error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this._output.push(data);
    if (this.listenerCount("data") > 0) {
      this.emit("data", data);
    }
  }

  async _handlePtyExit(exitCode: number, signal: ExitSignal): Promise<void> {
    const pid = this.ptyProcess ? this.ptyProcess.pid : null;
    this._resetDetectionSources({ quiet: false, clearTracking: true });

    this._clearPackNotice();
    this._hooks.cleanup();
    this._ptyAlive = false;
    this.ptyProcess = null;

    if (pid) {
      this._exitReap = this._reapTreeOnce(pid);
    }

    const { event, detail } = decideExitTransition(this.state, exitCode, signal, this._receivedFirstOutput);
    const reason = detail.reason || null;
    this.transition(event, detail);

    try { await this._settleWorktreeOnExit(); }
    catch {}

    if (this._recorder) {
      this._recorder.writeFooter("pty_exit", exitCode);
      this._recorder.close();
    }

    this.emit("exit", { exitCode, signal, reason });
  }

  getReplayBuffer(): string {
    return this._output.replay();
  }

  getOutputOffset(): number {
    return this._output.stats().total;
  }

  getBufferSince(offset: number) {
    return this._output.since(offset);
  }

  write(text: string): void {
    if (this._recorder) {
      this._recorder.writeInput(text);
    }

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

    try {
      this.ptyProcess.resize(cols, rows);
    } catch {

    }
  }

  _taskkill(pid: number | null, opts: Record<string, unknown> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this._killProc(["/PID", String(Number(pid)), "/T", "/F"], { ...opts }, (err: unknown) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  _emitError(err: unknown): void {
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

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

  _isProcessAlive(pid: number | null): boolean {
    const target = signalablePid(pid);
    if (target === null) return false;
    const probeTarget = this._platform === "win32" ? target : -target;
    try {
      this._signalProc(probeTarget, 0);
      return true;
    } catch {

      return false;
    }
  }

  _reapTreeOnce(pid: number | null): Promise<void> | null {
    if (this._platform === "win32") {
      return this._taskkill(pid, { timeout: KILL_REAP_MAX_WAIT_MS })
        .catch(() => {});
    }
    if (this._resolveKillReap) return this._killReap;
    return this._reapProcessGroup(pid);
  }

  _awaitPendingReaps(): Promise<void> | null {
    const pending = [this._killReap, this._exitReap].filter((reap) => reap !== null);
    if (pending.length === 0) return null;

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

    if (this._resolveKillReap) this._resolveKillReap();
    return new Promise((resolve) => {
      const settle = (): void => {
        this._clearTimer("_killReapTimer");
        this._resolveKillReap = null;
        resolve();
      };
      this._resolveKillReap = settle;
      let waited = 0;

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

      poll();
    });
  }

  kill(): void {
    if (!this.ptyProcess) return;

    this._ptyAlive = false;
    const pid = this.ptyProcess.pid;

    if (this._platform === "win32") {

      const killReap = this._taskkill(pid);
      this._killReap = killReap;
      killReap.catch((err: unknown) => this._emitError(err));
    }
    if (this._platform !== "win32") {

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

    if (this._autoKilled
        && !this._teardownPending()
        && RESTARTABLE_STATES.includes(this.state)) {
      this.restart();
    }
  }

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

  killSession(endIntent: SessionEndIntent = "operator-abort"): boolean {
    if (!KILLABLE_STATES.includes(this.state)) return false;
    this.kill();
    return this.transition("user_kill", { endIntent });
  }

  restart(options: { fresh?: boolean } = {}): boolean {
    if (this._destroyed) return false;

    if (this._teardownPending()) return false;
    if (!RESTARTABLE_STATES.includes(this.state)) return false;
    this._prepareRestart(options);
    this.transition("user_restart");
    this.start({ fresh: options.fresh === true });
    return true;
  }

  resetToDormant(): boolean {
    if (this._destroyed) return false;
    const did = this.transition("user_reset");
    if (did) this.worktreeLifecycle.setMergeStatus("none", {}, { emit: false });
    return did;
  }

  finishAndMerge(): { ok: boolean; pending?: boolean; reason?: string } {
    if (this._destroyed || this._teardownPending()) {
      return { ok: false, reason: this._teardownPending() ? "in-progress" : "destroyed" };
    }
    if (RESTARTABLE_STATES.includes(this.state)) {

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
      this.killSession("close-out");
      return { ok: true, pending: true };
    }
    return { ok: false, reason: "not-finishable" };
  }

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

    this.backgroundTracking.clearGateHeldReady();
    this._clearPackNotice();

    if (this._recorder) {
      this._recorder.close();
    }
    this.worktreeLifecycle.stopWatching();
    this._titleSource.destroy();
    this._statusSource.destroy();
    this.removeAllListeners();
  }
}

function claudeCommand(): ResolvedCommand {
  return commandFor(DEFAULT_AGENT_ID);
}

export { Session, claudeCommand };
export type { SessionOptions, SessionPty, SessionRecorderPort };
