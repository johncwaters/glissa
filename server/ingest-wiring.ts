
import {
  DEFAULT_DIGEST_BUDGET_CHARS, buildContextDigest, createIngestStore, enabledSourceNames, latestSeq,
  publishEvent, resolveIngestConfig, ringStats, snapshotEvents,
} from './core/ingest-core.ts';
import type { IngestConfig, IngestEvent } from './core/ingest-core.ts';
import { deriveSessionRoots, isActiveSessionState } from './core/ingest-fs-core.ts';
import { createAgentLogIngest } from './ingest-agent-logs.ts';
import type { AgentLogConsumer, AgentLogIngestOptions } from './ingest-agent-logs.ts';
import { createEditorIngest } from './ingest-editor.ts';
import { createFsIngest } from './ingest-fs.ts';
import type { FsIngestOptions } from './ingest-fs.ts';
import { createGitIngest } from './ingest-git.ts';
import { createShellHistoryIngest } from './ingest-shell-history.ts';
import type { ShellHistoryOptions } from './ingest-shell-history.ts';
import { createTerminalIngest } from './ingest-terminal.ts';
import type { SessionTap, TappableSession } from './ingest-terminal.ts';
import { createLaneLog } from './lane-log.ts';
import type { LaneLogger } from './lane-log.ts';

const BATCH_INTERVAL_MS = 1000;
const MAX_EVENTS_PER_FRAME = 50;
const SNAPSHOT_EVENT_LIMIT = 100;

interface IngestLaneOptions {
  config?: IngestConfig | null;
  broadcast?: ((message: Record<string, unknown>) => void) | null;
  logger?: LaneLogger | null;
  laneMap?: (() => Map<string, string>) | null;
  agentLogConsumers?: AgentLogConsumer[];
  agentLogOptions?: AgentLogIngestOptions | null;
  fsOptions?: FsIngestOptions | null;
  shellHistoryOptions?: ShellHistoryOptions | null;
  configPath?: string | null;
  repoRoots?: (() => string[]) | null;
  editorRoots?: (() => string[]) | string[];
  onActivity?: (() => void) | null;
  nowFn?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  batchIntervalMs?: number;
  maxEventsPerFrame?: number;
  snapshotEventLimit?: number;
  debug?: boolean | (() => boolean);
}

interface RootedSession {
  id?: string;
  state?: string;
  path?: unknown;
  worktreeDir?: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createIngestLane({
  config = null,
  broadcast = null,
  logger = console,
  laneMap = null,
  agentLogConsumers = [],
  agentLogOptions = null,
  fsOptions = null,
  shellHistoryOptions = null,
  configPath = null,
  repoRoots = null,
  editorRoots = () => [],
  onActivity = null,
  nowFn = Date.now,
  setIntervalFn = (fn: () => void, ms: number) => setInterval(fn, ms),
  clearIntervalFn = clearInterval,
  setTimeoutFn = (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeoutFn = clearTimeout,
  batchIntervalMs = BATCH_INTERVAL_MS,
  maxEventsPerFrame = MAX_EVENTS_PER_FRAME,
  snapshotEventLimit = SNAPSHOT_EVENT_LIMIT,
  debug = false,
}: IngestLaneOptions = {}) {
  const resolved = config?.sources ? config : resolveIngestConfig(config);
  const store = createIngestStore(resolved);
  const sources = enabledSourceNames(resolved);
  let pendingEvents: IngestEvent[] = [];
  let stopped = false;

  const { debugNote, note, warn } = createLaneLog({ prefix: '[ingest]', logger, debugFlag: debug });

  function emit(message: Record<string, unknown>): void {
    if (typeof broadcast !== 'function') return;
    try {
      broadcast(message);
    } catch (error) {
      warn(`broadcast failed: ${errorMessage(error)}`);
    }
  }

  function pokeActivity(): void {
    if (typeof onActivity !== 'function') return;
    debugNote(() => 'activity poke');
    try {
      onActivity();
    } catch (error) {
      warn(`activity callback failed: ${errorMessage(error)}`);
    }
  }

  function flushBatch(): Record<string, unknown> | null {
    if (pendingEvents.length === 0) return null;
    const batched = pendingEvents;
    pendingEvents = [];
    const newestFirst = [...batched].sort((left, right) => right.seq - left.seq);
    const events = newestFirst.slice(0, maxEventsPerFrame);
    const message = {
      type: 'ingest-activity',
      events,
      overflow: Math.max(0, newestFirst.length - events.length),
      ts: nowFn(),
    };
    emit(message);
    debugNote(() => `batch flushed: ${events.length} events (seq ${events[events.length - 1].seq}-${events[0].seq}), ${message.overflow} overflowed`);
    pokeActivity();
    return message;
  }

  let batchTimer: NodeJS.Timeout | null = setIntervalFn(flushBatch, batchIntervalMs);
  if (batchTimer && typeof batchTimer.unref === 'function') batchTimer.unref();

  function publish(raw: unknown): IngestEvent | null {
    if (stopped) return null;
    const event = publishEvent(store, raw, nowFn());
    if (!event) return null;
    pendingEvents.push(event);
    return event;
  }

  function snapshotMessage(): Record<string, unknown> {
    return {
      type: 'ingest-snapshot',
      events: snapshotEvents(store, { limit: snapshotEventLimit }),
      sources,
      ts: nowFn(),
    };
  }

  function buildDigest({ scopes = null, budgetChars = DEFAULT_DIGEST_BUDGET_CHARS, now = null }: {
    scopes?: string[] | null;
    budgetChars?: number;
    now?: number | null;
  } = {}) {
    return buildContextDigest(store, { scopes, budgetChars, now: now == null ? nowFn() : now });
  }

  const adapters: { name: string; start?: () => unknown; stop: () => unknown }[] = [];
  const terminalEnabled = resolved.enabled === true && resolved.sources.terminal.enabled === true;
  const terminal = terminalEnabled
    ? createTerminalIngest({
      publish,
      sourceConfig: resolved.sources.terminal,
      logger,
      nowFn,
      setTimeoutFn,
      clearTimeoutFn,
    })
    : null;
  if (terminal) adapters.push(terminal);

  const agentLogsEnabled = resolved.enabled === true && resolved.sources.agentLogs.enabled === true;
  const agentLogs = agentLogsEnabled
    ? createAgentLogIngest({
      publish,
      sourceConfig: resolved.sources.agentLogs,
      laneMap,
      consumers: agentLogConsumers,
      logger,
      nowFn,
      setIntervalFn,
      clearIntervalFn,
      setTimeoutFn,
      clearTimeoutFn,
      ...(agentLogOptions || {}),
    })
    : null;
  if (agentLogs) adapters.push(agentLogs);

  const gitEnabled = resolved.enabled === true && resolved.sources.git.enabled === true;
  const git = gitEnabled
    ? createGitIngest({
      publish,
      sourceConfig: resolved.sources.git,
      reposProvider: repoRoots,
      logger,
      nowFn,
      setIntervalFn,
      clearIntervalFn,
      setTimeoutFn,
      clearTimeoutFn,
    })
    : null;
  if (git) adapters.push(git);

  const fsEnabled = resolved.enabled === true && resolved.sources.fs.enabled === true;
  const fsSource = fsEnabled
    ? createFsIngest({
      publish,
      sourceConfig: resolved.sources.fs,
      configPath,
      logger,
      nowFn,
      setTimeoutFn,
      clearTimeoutFn,
      ...(fsOptions || {}),
    })
    : null;
  if (fsSource) adapters.push(fsSource);

  const shellHistoryEnabled = resolved.enabled === true && resolved.sources.shellHistory.enabled === true;
  const shellHistory = shellHistoryEnabled
    ? createShellHistoryIngest({
      publish,
      sourceConfig: resolved.sources.shellHistory,
      logger,
      nowFn,
      setIntervalFn,
      clearIntervalFn,
      setTimeoutFn,
      clearTimeoutFn,
      ...(shellHistoryOptions || {}),
    })
    : null;
  if (shellHistory) adapters.push(shellHistory);

  const editorEnabled = resolved.enabled === true && resolved.sources.editor.enabled === true;
  const editorSource = editorEnabled
    ? createEditorIngest({
      publish,
      roots: editorRoots,
      logger,
      nowFn,
      debug,
    })
    : null;
  if (editorSource) adapters.push(editorSource);

  note(`lane started: ${sources.length > 0 ? sources.join(', ') : 'no sources enabled'}`);

  for (const adapter of adapters) {
    if (typeof adapter.start !== 'function') continue;
    try {
      void adapter.start();
      note(`starting the ${adapter.name} source`);
    } catch (error) {
      warn(`starting the ${adapter.name} source failed: ${errorMessage(error)}`);
    }
  }

  function noteRepos(): Promise<void> {
    if (stopped || !git) return Promise.resolve();
    return git.reconcile();
  }

  function noteSessionRoots(sess: RootedSession | null | undefined): boolean {
    if (stopped || !fsSource || !sess?.id) return false;
    if (!isActiveSessionState(sess.state)) return fsSource.releaseHolder(sess.id);
    return fsSource.addRoots(sess.id, deriveSessionRoots(sess));
  }

  function releaseSessionRoots(sess: RootedSession | null | undefined): boolean {
    if (!fsSource || !sess?.id) return false;
    return fsSource.releaseHolder(sess.id);
  }

  function attachSessionTap(sess: TappableSession | null | undefined): SessionTap | null {
    if (stopped || !terminal) return null;
    return terminal.attachSessionTap(sess);
  }

  function detachSessionTap(sess: TappableSession | null | undefined): boolean {
    if (!terminal) return false;
    return terminal.detachSessionTap(sess);
  }

  function hasSessionTap(sess: TappableSession | null | undefined): boolean {
    if (!terminal) return false;
    return terminal.hasSessionTap(sess);
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (batchTimer) clearIntervalFn(batchTimer);
    batchTimer = null;
    pendingEvents = [];
    for (const adapter of adapters) {
      try {
        adapter.stop();
        note(`the ${adapter.name} source stopped`);
      } catch (error) {
        warn(`stopping the ${adapter.name} source failed: ${errorMessage(error)}`);
      }
    }
    note('lane stopped');
  }

  function noteEditorEvent(notification: { method?: string; uri?: string } | null | undefined): unknown {
    if (!editorSource) return null;
    return editorSource.note(notification);
  }

  return {
    publish,
    snapshotMessage,
    buildDigest,
    noteEditorEvent,
    attachSessionTap,
    detachSessionTap,
    hasSessionTap,
    noteRepos,
    noteSessionRoots,
    releaseSessionRoots,
    flushBatch,
    stop,
    sources,
    ringStats: () => ringStats(store),
    latestSeq: () => latestSeq(store),
    recentEvents: (limit = snapshotEventLimit) => snapshotEvents(store, { limit }),
    get agentLogs() { return agentLogs; },
    get agentLogsEnabled() { return agentLogsEnabled; },
    get git() { return git; },
    get gitEnabled() { return gitEnabled; },
    get fs() { return fsSource; },
    get fsEnabled() { return fsEnabled; },
    get shellHistory() { return shellHistory; },
    get shellHistoryEnabled() { return shellHistoryEnabled; },
    get terminalEnabled() { return terminalEnabled; },
    get editorEnabled() { return editorEnabled; },
    get tapCount() { return terminal ? terminal.tapCount : 0; },
    get pendingEventCount() { return pendingEvents.length; },
    get isStopped() { return stopped; },
  };
}

export {
  BATCH_INTERVAL_MS,
  MAX_EVENTS_PER_FRAME,
  SNAPSHOT_EVENT_LIMIT,
  createIngestLane,
};
export type { IngestLaneOptions };
