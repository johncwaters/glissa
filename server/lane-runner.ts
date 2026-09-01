import { DEFAULT_BASE_MS, DEFAULT_MAX_MS, nextBackoffMs, shouldSkipTick } from './core/lane-backoff.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TickOutcome {
  failed?: boolean;
  retryAfterMs?: number;
}

interface TickLoopOptions {
  tag: string;
  intervalMs: number;
  tick: () => Promise<TickOutcome | undefined | null>;
  writeState?: () => Promise<void> | void;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  now?: () => number;
  random?: () => number;
  log?: Pick<Console, 'warn'>;
}

interface TickLoop {
  start(prelude?: (() => Promise<void> | void) | null): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
  persist(): Promise<void>;
  track<T>(promise: Promise<T>): Promise<T>;
  isStopped(): boolean;
  backoffUntil(): number;
}

function createTickLoop({
  tag,
  intervalMs,
  tick: tickBody,
  writeState = async () => {},
  setIntervalFn = (fn: () => void, ms: number) => setInterval(fn, ms),
  clearIntervalFn = clearInterval,
  backoffBaseMs = Math.max(intervalMs, DEFAULT_BASE_MS),
  backoffMaxMs = DEFAULT_MAX_MS,
  now = Date.now,
  random = Math.random,
  log = console,
}: TickLoopOptions): TickLoop {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let tickRunning = false;
  let persistChain: Promise<void> = Promise.resolve();

  let backoffUntil = 0;
  let failureStreak = 0;

  const running = new Set<Promise<unknown>>();

  function persist(): Promise<void> {
    persistChain = persistChain.then(() => writeState()).catch((e: unknown) => {
      log.warn(`[${tag}] state write failed: ${errorMessage(e)}`);
    });
    return persistChain;
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    running.add(promise);
    promise.finally(() => running.delete(promise));
    return promise;
  }

  async function tick(): Promise<void> {
    if (tickRunning || stopped) return;
    if (shouldSkipTick({ now: now(), backoffUntil })) return;
    tickRunning = true;
    try {
      const outcome = await tickBody();
      if (!outcome || outcome.failed !== true) {
        failureStreak = 0;
        backoffUntil = 0;
        return;
      }
      failureStreak += 1;
      const waitMs = nextBackoffMs({
        attempt: failureStreak,
        baseMs: backoffBaseMs,
        maxMs: backoffMaxMs,
        retryAfterMs: outcome.retryAfterMs ?? null,
        random,
      });
      backoffUntil = now() + waitMs;
      log.warn(`[${tag}] poll failed (${failureStreak} in a row) - backing off ${Math.round(waitMs / 1000)}s`);
    } finally {
      tickRunning = false;
    }
  }

  async function start(prelude: (() => Promise<void> | void) | null = null): Promise<void> {
    stopped = false;
    if (prelude) await prelude();
    await tick();
    timer = setIntervalFn(() => { void tick(); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function stop(): Promise<void> {
    stopped = true;
    backoffUntil = 0;
    failureStreak = 0;
    if (timer) clearIntervalFn(timer);
    timer = null;
    await Promise.allSettled([...running]);
    await persistChain;
  }

  return { start, stop, tick, persist, track, isStopped: () => stopped, backoffUntil: () => backoffUntil };
}

interface LaneRunnerGate {
  start: boolean;
  reason?: string | null;
}

type LaneStatusRecord = Record<string, unknown>;

interface RestartablePoller {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

interface LaneRunnerOptions<Poller extends RestartablePoller> {
  tag: string;
  gate: () => LaneRunnerGate;
  cfgKey: () => string;
  emptyStatus: () => LaneStatusRecord;
  createPoller: (callbacks: { onTickComplete: (summary: LaneStatusRecord) => void }) => Poller;
  broadcast?: (status: LaneStatusRecord) => void;
  beforeStop?: () => void;
}

interface LaneRunner<Poller extends RestartablePoller> {
  startPoller(): void;
  restartIfConfigChanged(): void;
  stopPoller(): Promise<void>;
  patchStatus(patch: LaneStatusRecord): void;
  getStatus(): LaneStatusRecord;
  getPoller(): Poller | null;
  isStopped(): boolean;
}

function createLaneRunner<Poller extends RestartablePoller>({
  tag, gate, cfgKey, emptyStatus, createPoller, broadcast = () => {}, beforeStop = () => {},
}: LaneRunnerOptions<Poller>): LaneRunner<Poller> {
  let lastStatus: LaneStatusRecord | null = null;
  let poller: Poller | null = null;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;
  let lastKey: string | null = null;

  function onTickComplete(summary: LaneStatusRecord): void {
    lastStatus = { ...summary, configured: true };
    if (lastStatus) broadcast(lastStatus);
  }

  function startPoller(): void {
    lastKey = cfgKey();
    chain = chain.then(async () => {
      if (stopped) return;
      if (poller) {
        const old = poller;
        poller = null;
        await old.stop();
      }
      const verdict = gate();
      if (!verdict.start) {
        lastStatus = null;
        broadcast(emptyStatus());
        if (verdict.reason) console.warn(`[${tag}] not starting: ${verdict.reason}`);
        return;
      }
      if (!lastStatus) broadcast(emptyStatus());
      const createdPoller = createPoller({ onTickComplete });
      poller = createdPoller;
      await createdPoller.start().catch((e: unknown) => console.warn(`[${tag}] start failed: ${errorMessage(e)}`));
    }).catch((e: unknown) => console.warn(`[${tag}] restart failed: ${errorMessage(e)}`));
  }

  function restartIfConfigChanged(): void {
    if (cfgKey() !== lastKey) startPoller();
  }

  function stopPoller(): Promise<void> {
    stopped = true;
    beforeStop();
    const draining = poller ? poller.stop() : Promise.resolve();
    return Promise.allSettled([draining, chain]).then(() => {});
  }

  function patchStatus(patch: LaneStatusRecord): void {
    lastStatus = { ...(lastStatus || emptyStatus()), ...patch };
    if (lastStatus) broadcast(lastStatus);
  }

  return {
    startPoller,
    restartIfConfigChanged,
    stopPoller,
    patchStatus,
    getStatus: () => lastStatus || emptyStatus(),
    getPoller: () => poller,
    isStopped: () => stopped,
  };
}

export { createLaneRunner, createTickLoop };
export type { LaneRunner, LaneRunnerGate, LaneRunnerOptions, LaneStatusRecord, RestartablePoller, TickLoop, TickLoopOptions, TickOutcome };
