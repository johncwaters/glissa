'use strict';

/*
 * The shutdown coordinator's decisions, with no IO of their own (timers are injected), so the ordering
 * and the bounds are unit-testable without tearing a real server down.
 *
 * WHY it exists: the lanes all expose an async stop() that drains in-flight work (a PR review still
 * discarding a worktree, a usage pass still writing its warehouse), but shutdown fired them as
 * `void lane.stop()` and server-lifecycle awaited only the PTY reaps. A restart could therefore bring
 * a fresh backend up while the old one was still writing the same state file. Two independent review
 * passes named that the biggest systemic risk in the codebase: lifecycle finality, not the state
 * machine.
 *
 * Every wait here is BOUNDED. A stalled lane must cost a bounded delay at exit, never a hang: the
 * process is going away either way, and a shutdown that never completes is worse than a lane that
 * never drained.
 */

/**
 * Settle every promise, or give up after capMs, whichever comes first. Always resolves.
 *
 * The cap timer is deliberately NOT unref'd: when a wait hangs, this timer is the only thing that can
 * settle the returned promise, so an unref'd one would let the loop drain and leave the awaiting caller
 * hanging instead of proceeding. It is cleared the moment the race settles, so it pins the loop only
 * while something is genuinely outstanding, bounded by capMs.
 */
function awaitBounded(promises, { capMs = 3000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const list = Array.isArray(promises) ? promises.filter((p) => p != null) : [];
  if (list.length === 0) return Promise.resolve({ timedOut: false, settled: [] });
  let timer = null;
  const TIMED_OUT = Symbol('timed-out');
  const cap = new Promise((resolve) => {
    timer = setTimeoutFn(() => resolve(TIMED_OUT), capMs);
  });
  return Promise.race([Promise.allSettled(list), cap]).then((outcome) => {
    clearTimeoutFn(timer);
    if (outcome === TIMED_OUT) return { timedOut: true, settled: [] };
    return { timedOut: false, settled: outcome };
  });
}

/**
 * The named async stoppers a shutdown has to await.
 *
 * `add` INVOKES the stop function immediately and keeps the promise it returned. Invoking now (rather
 * than handing the coordinator a thunk to call later) is load-bearing: every lane's stop() clears its
 * timers and watchers synchronously, and a caller that tears the backend down without a coordinator
 * (the Vite dev plugin, every backend test) must still get that. What the coordinator adds is the
 * AWAIT, not the call.
 *
 * A synchronous throw from a stop function becomes a rejected entry rather than escaping: one broken
 * lane may not abort the teardown of the rest.
 */
function createStopperCollector() {
  const entries = [];
  const names = new Set();
  return {
    add(name, run) {
      if (names.has(name)) throw new Error(`duplicate shutdown stopper: ${name}`);
      names.add(name);
      let promise;
      try {
        promise = Promise.resolve(run());
      } catch (error) {
        promise = Promise.reject(error);
      }
      // Nothing may reach the process as an unhandled rejection just because the coordinator's bound
      // expired before this entry settled.
      promise.catch(() => {});
      entries.push({ name, promise });
      return promise;
    },
    entries: () => entries.slice(),
  };
}

/**
 * What shutdown() handed back. An ARRAY is the historical shape (PTY reaps only) and still works, so a
 * caller or test that predates the coordinator needs no change.
 */
function normalizeShutdownResult(result) {
  if (Array.isArray(result)) return { reaps: result, stoppers: [] };
  if (!result || typeof result !== 'object') return { reaps: [], stoppers: [] };
  return {
    reaps: Array.isArray(result.reaps) ? result.reaps : [],
    stoppers: Array.isArray(result.stoppers) ? result.stoppers : [],
  };
}

/** Which named stoppers failed, for one honest log line instead of a silent swallow. */
function summarizeStopOutcomes(entries, { timedOut, settled }) {
  const failed = [];
  settled.forEach((outcome, index) => {
    if (outcome.status !== 'rejected') return;
    const name = entries[index] ? entries[index].name : `stopper-${index}`;
    failed.push({ name, reason: outcome.reason });
  });
  return { timedOut: timedOut === true, failed };
}

module.exports = { awaitBounded, createStopperCollector, normalizeShutdownResult, summarizeStopOutcomes };
