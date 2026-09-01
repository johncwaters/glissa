import {
  buildScorecards,
  classifyPrompt,
  classifyReadPath,
  dispositionFor,
  recordFromAccumulator,
} from './core/mill-metrics-core.ts';
import type {
  MillMetricAccumulatorShape,
  MillPackScorecard,
  MillMetricEndIntent,
  MillMetricPackAccumulator,
  MillMetricsConfig,
} from './core/mill-metrics-core.ts';
import {
  MAX_PACK_FILES_PER_SESSION,
  MAX_PACK_REL_PATH_CHARS,
} from '../shared/contracts/mill-metrics.ts';
import type {
  MillMetricDisposition,
  MillMetricPromptClass,
  MillMetricReadDetection,
  MillMetricSession,
} from '../shared/contracts/mill-metrics.ts';
import { numberOrNull } from './core/usage-number-core.ts';
import type { MillMetricsStoreInstance } from './mill-metrics-store.ts';

type DeliveredPack = {
  name: string;
  version: string;
  dir: string;
  tokenEstimate?: number | null;
};

type Accumulator = MillMetricAccumulatorShape & {
  tokens: TokenLedger;
};

type MillMetricsRecordSink = {
  appendEvent: (event: unknown) => void;
  closeSession: (record: MillMetricSession) => void;
  records: () => MillMetricSession[];
};

type TokenTotals = { tokens: number | null; costUSD: number | null };

type UsageSample = TokenTotals & { identity: string | null };

type TokenLedger = {
  identity: string | null;
  conversationExistedAtDelivery: boolean | null;
  baseline: TokenTotals | null;
  latest: TokenTotals | null;
  banked: TokenTotals;
};

type MillMetricsWiringOptions = {
  store: MillMetricsRecordSink;
  nowFn?: () => number;
  tokensForSession?: (sessionId: string) => (TokenTotals & { identity?: string | null }) | null;
  logger?: Pick<Console, 'warn'> | null;
  caseInsensitive?: boolean;
};

function createMillMetricsWiring({
  store,
  nowFn = Date.now,
  tokensForSession = () => null,
  logger = null,
  caseInsensitive = process.platform === 'win32',
}: MillMetricsWiringOptions) {
  const accumulators = new Map<string, Accumulator>();

  function warn(message: string): void {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`[mill-metrics] ${message}`);
  }

  function usageForSession(sessionId: string): UsageSample {
    try {
      const totals = tokensForSession(sessionId);
      return {
        tokens: numberOrNull(totals?.tokens),
        costUSD: numberOrNull(totals?.costUSD),
        identity: typeof totals?.identity === 'string' && totals.identity ? totals.identity : null,
      };
    } catch (error) {
      warn(`usage lookup failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return { tokens: null, costUSD: null, identity: null };
    }
  }

  function emptyLedger(): TokenLedger {
    return {
      identity: null,
      conversationExistedAtDelivery: null,
      baseline: null,
      latest: null,
      banked: { tokens: null, costUSD: null },
    };
  }

  function addFigures(left: number | null, right: number | null): number | null {
    if (left === null) return right;
    if (right === null) return left;
    return left + right;
  }

  function sinceBaseline(current: number | null, baseline: number | null): number | null {
    if (current === null) return null;
    if (baseline === null) return current;
    return Math.max(0, current - baseline);
  }

  function ledgerTotals(ledger: TokenLedger): TokenTotals {
    if (!ledger.baseline || !ledger.latest) return { ...ledger.banked };
    return {
      tokens: addFigures(ledger.banked.tokens, sinceBaseline(ledger.latest.tokens, ledger.baseline.tokens)),
      costUSD: addFigures(ledger.banked.costUSD, sinceBaseline(ledger.latest.costUSD, ledger.baseline.costUSD)),
    };
  }

  function movedBack(current: number | null, previous: number | null): boolean {
    return current !== null && previous !== null && current < previous;
  }

  function bankRewoundFields(ledger: TokenLedger, current: TokenTotals): void {
    const { baseline, latest } = ledger;
    if (!baseline || !latest) return;
    const tokensRewound = movedBack(current.tokens, latest.tokens);
    const costRewound = movedBack(current.costUSD, latest.costUSD);
    if (!tokensRewound && !costRewound) return;
    const earned = ledgerTotals(ledger);
    ledger.banked = {
      tokens: tokensRewound ? earned.tokens : ledger.banked.tokens,
      costUSD: costRewound ? earned.costUSD : ledger.banked.costUSD,
    };
    ledger.baseline = {
      tokens: tokensRewound ? current.tokens : baseline.tokens,
      costUSD: costRewound ? current.costUSD : baseline.costUSD,
    };
  }

  function observeTokens(accumulator: Accumulator): TokenTotals {
    const ledger = accumulator.tokens;
    const sample = usageForSession(accumulator.sessionId);
    if (ledger.conversationExistedAtDelivery === null) {
      ledger.conversationExistedAtDelivery = sample.identity !== null
        || sample.tokens !== null
        || sample.costUSD !== null;
    }
    if (sample.tokens === null && sample.costUSD === null) {
      if (ledger.identity === null) ledger.identity = sample.identity;
      return ledgerTotals(ledger);
    }
    const current: TokenTotals = { tokens: sample.tokens, costUSD: sample.costUSD };
    if (!ledger.baseline) {
      const bornThisRun = ledger.conversationExistedAtDelivery === false && sample.identity !== null;
      if (sample.identity !== null) ledger.identity = sample.identity;
      ledger.baseline = bornThisRun ? { tokens: 0, costUSD: 0 } : current;
      ledger.latest = current;
      return ledgerTotals(ledger);
    }

    if (ledger.identity !== null && sample.identity !== null && sample.identity !== ledger.identity) {
      ledger.banked = ledgerTotals(ledger);
      ledger.identity = sample.identity;
      ledger.baseline = { tokens: 0, costUSD: 0 };
      ledger.latest = current;
      return ledgerTotals(ledger);
    }
    if (ledger.identity === null) ledger.identity = sample.identity;
    bankRewoundFields(ledger, current);
    ledger.latest = current;
    return ledgerTotals(ledger);
  }

  function onPacksDelivered(sessionId: string, payload: {
    packs?: DeliveredPack[];
    agent?: string;
    readDetection?: MillMetricReadDetection;
    ts?: number;
  }): void {
    if (typeof sessionId !== 'string' || !sessionId) return;
    if (!Array.isArray(payload?.packs) || payload.packs.length === 0) return;
    const agent = typeof payload.agent === 'string' && payload.agent ? payload.agent : null;
    if (!agent) return;
    const readDetection = payload.readDetection === 'available' ? 'available' : 'unavailable';
    const startedAt = numberOrNull(payload.ts) ?? nowFn();
    const packs = new Map<string, MillMetricPackAccumulator>();
    for (const pack of payload.packs) {
      if (typeof pack?.name !== 'string' || !pack.name) continue;
      if (typeof pack.dir !== 'string' || !pack.dir) continue;
      packs.set(pack.name, {
        version: typeof pack.version === 'string' ? pack.version : '',
        tokenEstimate: numberOrNull(pack.tokenEstimate),
        dir: pack.dir,
        files: new Set<string>(),
        filesDropped: 0,
      });
    }
    if (packs.size === 0) return;
    const accumulator: Accumulator = {
      sessionId,
      startedAt,
      agent,
      readDetection,
      packs,
      prompts: { interruption: 0, answer: 0, followup: 0, ambiguous: 0 },
      tokens: emptyLedger(),
    };
    accumulators.set(sessionId, accumulator);
    observeTokens(accumulator);
    for (const [packName, pack] of packs) {
      store.appendEvent({
        v: 1,
        kind: 'pack-delivered',
        ts: startedAt,
        sessionId,
        pack: packName,
        version: pack.version,
        tokenEstimate: pack.tokenEstimate,
        agent,
        readDetection,
      });
    }
  }

  function onPromptSubmitted(sessionId: string, payload: {
    state?: string;
    stateSince?: number;
    ts?: number;
  }): void {
    const accumulator = accumulators.get(sessionId);
    if (!accumulator) return;
    const state = typeof payload?.state === 'string' ? payload.state : '';
    const ts = numberOrNull(payload?.ts) ?? nowFn();
    const promptClass: MillMetricPromptClass = classifyPrompt({
      state,
      stateSince: numberOrNull(payload?.stateSince) ?? ts,
      ts,
    });
    accumulator.prompts[promptClass] += 1;
    store.appendEvent({
      v: 1,
      kind: 'prompt',
      ts,
      sessionId,
      promptClass,
      state,
    });
  }

  function onHookEvent(sessionId: string, event: unknown, payload: unknown): void {
    if (typeof event !== 'string' || event.toLowerCase() !== 'posttooluse') return;
    if (!payload || typeof payload !== 'object') return;
    const hookPayload = payload as { tool_name?: unknown; tool_input?: { file_path?: unknown } };
    if (hookPayload.tool_name !== 'Read') return;
    const accumulator = accumulators.get(sessionId);
    if (!accumulator) return;
    const deliveredPacks = Array.from(accumulator.packs, ([name, pack]) => ({ name, dir: pack.dir }));
    const read = classifyReadPath(hookPayload.tool_input?.file_path, deliveredPacks, { caseInsensitive });
    if (!read) return;
    const pack = accumulator.packs.get(read.pack);
    if (!pack || pack.files.has(read.relPath)) return;

    if (read.relPath.length > MAX_PACK_REL_PATH_CHARS || pack.files.size >= MAX_PACK_FILES_PER_SESSION) {
      pack.filesDropped += 1;
      return;
    }
    pack.files.add(read.relPath);
    store.appendEvent({
      v: 1,
      kind: 'pack-read',
      ts: nowFn(),
      sessionId,
      pack: read.pack,
      relPath: read.relPath,
    });
  }

  function closeAccumulator(sessionId: string, {
    disposition,
    finalState,
    transition,
  }: {
    disposition: MillMetricDisposition | null;
    finalState: string;
    transition: string;
  }): void {
    const accumulator = accumulators.get(sessionId);
    accumulators.delete(sessionId);
    if (!accumulator) return;
    const endedAt = nowFn();
    const totals = observeTokens(accumulator);
    const record = recordFromAccumulator(accumulator, {
      endedAt,
      disposition,
      finalState,
      tokens: totals.tokens,
      costUSD: totals.costUSD,
      resumeSessionId: accumulator.tokens.identity,
    });
    if (record) store.closeSession(record);
    store.appendEvent({
      v: 1,
      kind: 'session-end',
      ts: endedAt,
      sessionId,
      disposition,
      finalState,
      transition,
    });
  }

  function onSessionEnd(sessionId: string, {
    transitionEvent,
    intent,
    finalState,
  }: {
    transitionEvent?: string;
    intent?: MillMetricEndIntent;
    finalState?: string;
  }): void {
    closeAccumulator(sessionId, {
      disposition: dispositionFor(intent),
      finalState: typeof finalState === 'string' ? finalState : '',
      transition: typeof transitionEvent === 'string' ? transitionEvent : '',
    });
  }

  function onSessionTeardown(sessionId: string): void {
    closeAccumulator(sessionId, { disposition: null, finalState: '', transition: 'teardown' });
  }

  function scorecards(): Record<string, MillPackScorecard> {
    const liveRecords: MillMetricSession[] = [];
    for (const accumulator of accumulators.values()) {
      const totals = observeTokens(accumulator);
      const record = recordFromAccumulator(accumulator, {
        tokens: totals.tokens,
        costUSD: totals.costUSD,
        resumeSessionId: accumulator.tokens.identity,
      });
      if (record) liveRecords.push(record);
    }
    return buildScorecards(store.records(), liveRecords);
  }

  const port: MillMetricsPort = {
    onHookEvent,
    onPacksDelivered,
    onPromptSubmitted,
    onSessionEnd,
    onSessionTeardown,
  };

  return { port, scorecards };
}

type MillMetricsLaneOptions = Omit<MillMetricsWiringOptions, 'store'> & {
  resolveConfig: () => MillMetricsConfig;
  createStore: (options: { retainDays: number }) => MillMetricsStoreInstance;
};

const MAX_BUFFERED_SWAP_WRITES = 500;

type BufferedWrite = {
  isClose: boolean;
  apply: (target: MillMetricsStoreInstance) => void;
};

function createMillMetricsLane({ resolveConfig, createStore, ...wiringOptions }: MillMetricsLaneOptions) {
  let config = resolveConfig();
  let store: MillMetricsStoreInstance | null = null;
  let openedRetainDays: number | null = null;
  let restart: Promise<void> = Promise.resolve();
  let pendingRestarts = 0;
  let bufferedWrites: BufferedWrite[] = [];

  function warnLane(message: string): void {
    const logger = wiringOptions.logger;
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`[mill-metrics] ${message}`);
  }

  function openStore(): MillMetricsStoreInstance {
    const opened = createStore({ retainDays: config.retainDays });
    void opened.load();
    store = opened;
    openedRetainDays = config.retainDays;
    return opened;
  }

  function storeMatchesConfig(): boolean {
    return store !== null && openedRetainDays === config.retainDays;
  }

  openStore();

  function bufferWrite(isClose: boolean, apply: (target: MillMetricsStoreInstance) => void): void {
    if (pendingRestarts === 0) return;
    if (bufferedWrites.length >= MAX_BUFFERED_SWAP_WRITES) {
      const oldestEvent = bufferedWrites.findIndex((buffered) => !buffered.isClose);
      if (!isClose || oldestEvent === -1) {
        warnLane(`store swap buffer is full, dropping a ${isClose ? 'close' : 'write'}`);
        return;
      }
      warnLane('store swap buffer is full, dropping an event to keep a close');
      bufferedWrites.splice(oldestEvent, 1);
    }
    bufferedWrites.push({ isClose, apply });
  }

  function flushBufferedWrites(target: MillMetricsStoreInstance): void {
    const pending = bufferedWrites;
    bufferedWrites = [];
    for (const buffered of pending) buffered.apply(target);
  }

  const sink: MillMetricsRecordSink = {
    appendEvent: (event) => {
      if (store) {
        store.appendEvent(event);
        return;
      }
      bufferWrite(false, (target) => target.appendEvent(event));
    },
    closeSession: (record) => {
      if (store) {
        store.closeSession(record);
        return;
      }
      bufferWrite(true, (target) => target.closeSession(record));
    },
    records: () => (store ? store.records() : []),
  };

  const { port, scorecards } = createMillMetricsWiring({
    ...wiringOptions,
    store: sink,
  });

  async function drainStore(target: MillMetricsStoreInstance): Promise<void> {
    try {
      await target.whenIdle();
    } catch (error) {
      warnLane(`store drain failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function handOverQueuedRecords(outgoing: MillMetricsStoreInstance, incoming: MillMetricsStoreInstance): void {
    const stranded = outgoing.takeQueuedRecords();
    if (stranded.length === 0) return;
    incoming.adoptQueuedRecords(stranded);
  }

  async function reopenStore(): Promise<void> {
    if (storeMatchesConfig()) return;
    const outgoing = store;
    store = null;
    openedRetainDays = null;
    if (outgoing) await drainStore(outgoing);
    const incoming = openStore();
    if (outgoing) handOverQueuedRecords(outgoing, incoming);
    flushBufferedWrites(incoming);
  }

  function restartIfConfigChanged(): Promise<void> {
    const next = resolveConfig();
    if (next.retainDays === config.retainDays) return restart;
    config = next;
    pendingRestarts += 1;
    restart = restart
      .then(reopenStore)
      .catch((error: unknown) => {
        warnLane(`store restart failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        pendingRestarts -= 1;
      });
    return restart;
  }

  async function whenIdle(): Promise<void> {
    let chain = restart;
    await chain;
    while (chain !== restart) {
      chain = restart;
      await chain;
    }
    if (store) await store.whenIdle();
  }

  return { port, scorecards, restartIfConfigChanged, whenIdle, currentStore: () => store };
}

export type MillMetricsPort = {
  onHookEvent: (sessionId: string, event: unknown, payload: unknown) => void;
  onPacksDelivered: (sessionId: string, payload: {
    packs?: { name: string; version: string; dir: string; tokenEstimate?: number | null }[];
    agent?: string;
    readDetection?: MillMetricReadDetection;
    ts?: number;
  }) => void;
  onPromptSubmitted: (sessionId: string, payload: { state?: string; stateSince?: number; ts?: number }) => void;
  onSessionEnd: (sessionId: string, payload: {
    transitionEvent?: string;
    intent?: MillMetricEndIntent;
    finalState?: string;
  }) => void;
  onSessionTeardown: (sessionId: string) => void;
};

export { createMillMetricsLane, createMillMetricsWiring };
export type { MillMetricsRecordSink };
