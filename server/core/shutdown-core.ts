export interface BoundedWaitOutcome {
  timedOut: boolean;
  settled: PromiseSettledResult<unknown>[];
}

export interface StopperEntry {
  name: string;
  promise: Promise<unknown>;
}

export interface StopperCollector {
  add: (name: string, run: () => unknown) => Promise<unknown>;
  entries: () => StopperEntry[];
}

function awaitBounded(
  promises: Array<Promise<unknown> | null | undefined> | null | undefined,
  {
    capMs = 3000,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }: {
    capMs?: number;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: never) => void;
  } = {},
): Promise<BoundedWaitOutcome> {
  const list = Array.isArray(promises) ? promises.filter((p) => p != null) : [];
  if (list.length === 0) return Promise.resolve({ timedOut: false, settled: [] });
  let timer: unknown = null;
  const TIMED_OUT = Symbol('timed-out');
  const cap = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeoutFn(() => resolve(TIMED_OUT), capMs);
  });
  return Promise.race([Promise.allSettled(list), cap]).then((outcome) => {
    if (timer) clearTimeoutFn(timer as never);
    if (outcome === TIMED_OUT) return { timedOut: true, settled: [] };
    return { timedOut: false, settled: outcome };
  });
}

function createStopperCollector(): StopperCollector {
  const entries: StopperEntry[] = [];
  const names = new Set<string>();
  return {
    add(name: string, run: () => unknown): Promise<unknown> {
      if (names.has(name)) throw new Error(`duplicate shutdown stopper: ${name}`);
      names.add(name);
      let promise: Promise<unknown>;
      try {
        promise = Promise.resolve(run());
      } catch (error) {
        promise = Promise.reject(error);
      }

      promise.catch(() => {});
      entries.push({ name, promise });
      return promise;
    },
    entries: () => entries.slice(),
  };
}

function normalizeShutdownResult(result: unknown): { reaps: unknown[]; stoppers: unknown[] } {
  if (Array.isArray(result)) return { reaps: result, stoppers: [] };
  if (!result || typeof result !== 'object') return { reaps: [], stoppers: [] };
  const fields = result as { reaps?: unknown; stoppers?: unknown };
  return {
    reaps: Array.isArray(fields.reaps) ? fields.reaps : [],
    stoppers: Array.isArray(fields.stoppers) ? fields.stoppers : [],
  };
}

function stopFailureText(reason: unknown): string {
  if (reason && typeof reason === 'object' && 'message' in reason && reason.message) return String(reason.message);
  return String(reason);
}

function summarizeStopOutcomes(
  entries: Array<{ name: string }>,
  { timedOut, settled }: BoundedWaitOutcome,
): { timedOut: boolean; failed: Array<{ name: string; reason: unknown }> } {
  const failed: Array<{ name: string; reason: unknown }> = [];
  settled.forEach((outcome, index) => {
    if (outcome.status !== 'rejected') return;
    const name = entries[index] ? entries[index].name : `stopper-${index}`;
    failed.push({ name, reason: outcome.reason });
  });
  return { timedOut: timedOut === true, failed };
}

export { awaitBounded, createStopperCollector, normalizeShutdownResult, stopFailureText, summarizeStopOutcomes };
