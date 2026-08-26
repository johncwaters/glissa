'use strict';

const {
  nextBackoffMs, shouldSkipTick, DEFAULT_BASE_MS, DEFAULT_MAX_MS,
} = require('./core/lane-backoff');

/*
 * The two scaffolds the polling lanes (pr-review, posthog) share.
 *
 * createTickLoop owns a poller's timer, its re-entrancy guard, its serialized state-write chain and
 * its in-flight drain. createLaneRunner owns the wiring side: the restartable poller instance, the
 * cached last status and the config-key gate. Neither knows what a tick does or what the lane polls.
 */

/**
 * @param {{ tag: string, intervalMs: number,
 *   tick: () => Promise<{ failed?: boolean, retryAfterMs?: number } | void>,
 *   writeState?: () => Promise<void> | void, setIntervalFn?: typeof setInterval,
 *   clearIntervalFn?: typeof clearInterval, backoffBaseMs?: number, backoffMaxMs?: number,
 *   now?: () => number, random?: () => number, log?: Pick<Console, 'warn'> }} deps `tick` is the lane's tick body; `writeState` persists whatever the lane calls
 *   its state. Both are injected, so the loop stays IO-free like the pollers it serves.
 *
 * A tick body may report a failed poll by returning `{ failed: true, retryAfterMs? }`, which opens a
 * full-jitter backoff window (server/core/lane-backoff.js) that later ticks are SKIPPED inside. The
 * interval timer itself is untouched, so the lane's cadence, its re-entrancy guard and its
 * drain-on-stop all behave as before; an outage costs skipped ticks rather than a rescheduled chain.
 * A body that returns nothing (every lane before this) never backs off.
 */
function createTickLoop({
  tag,
  intervalMs,
  tick: tickBody,
  writeState = async () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  backoffBaseMs = Math.max(intervalMs, DEFAULT_BASE_MS),
  backoffMaxMs = DEFAULT_MAX_MS,
  now = Date.now,
  random = Math.random,
  log = console,
}) {
  let timer = null;
  let stopped = false;
  let tickRunning = false;
  let persistChain = Promise.resolve();
  // Open backoff window (a timestamp) and how many consecutive failures produced it.
  let backoffUntil = 0;
  let failureStreak = 0;
  // In-flight lane jobs, tracked so stop() can drain them before a caller reuses the dependencies
  // (result-file paths, worktrees, the state file) for a fresh poller instance.
  const running = new Set();

  function persist() {
    persistChain = persistChain.then(() => writeState()).catch((e) => {
      log.warn(`[${tag}] state write failed: ${e.message}`);
    });
    return persistChain;
  }

  function track(promise) {
    running.add(promise);
    promise.finally(() => running.delete(promise));
    return promise;
  }

  async function tick() {
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
        retryAfterMs: outcome.retryAfterMs,
        random,
      });
      backoffUntil = now() + waitMs;
      log.warn(`[${tag}] poll failed (${failureStreak} in a row) - backing off ${Math.round(waitMs / 1000)}s`);
    } finally {
      tickRunning = false;
    }
  }

  async function start(prelude = null) {
    stopped = false;
    if (prelude) await prelude();
    await tick();
    timer = setIntervalFn(() => { void tick(); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // Async so a caller that restarts the lane can await it: the old instance's in-flight jobs (up to
  // their own timeout) and pending state writes must drain BEFORE a new instance reuses the same
  // result-file paths, worktrees and state file, or a duplicate job races the old one.
  async function stop() {
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

/**
 * The restartable half of a lane's wiring: start the poller at boot, restart it when the lane's own
 * config key actually changed, stop it on shutdown.
 *
 * Restarts are serialized through one promise chain so a stop-drain-start never overlaps a prior one,
 * and a settings save landing mid-drain just queues another restart on the chain, which coalesces
 * naturally. startPoller stays synchronous from its callers' perspective (it only appends to the chain).
 */
/**
 * @param {{ tag: string, gate: () => { start: boolean, reason?: string }, cfgKey: () => string,
 *   emptyStatus: () => Record<string, unknown>,
 *   createPoller: (callbacks: { onTickComplete: (summary: Record<string, unknown>) => void }) => { start: () => Promise<void>, stop: () => Promise<void> },
 *   broadcast?: (status: Record<string, unknown>) => void, beforeStop?: () => void }} options
 */
function createLaneRunner({
  tag, gate, cfgKey, emptyStatus, createPoller, broadcast = () => {}, beforeStop = () => {},
}) {
  // The last tick summary, replayed to a control client that connects between ticks.
  let lastStatus = null;
  let poller = null;
  let chain = Promise.resolve();
  let stopped = false;
  let lastKey = null;

  function onTickComplete(summary) {
    lastStatus = { ...summary, configured: true };
    broadcast(lastStatus);
  }

  function startPoller() {
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
      poller = createPoller({ onTickComplete });
      await poller.start().catch((e) => console.warn(`[${tag}] start failed: ${e.message}`));
    }).catch((e) => console.warn(`[${tag}] restart failed: ${e.message}`));
  }

  // The poller closure captures the lane's config at creation time, so a restart is how a config change
  // takes effect. Only restart when the lane's own key changed: an unrelated settings save (cursorBlink,
  // etc.) must never interrupt a job that may be in flight.
  function restartIfConfigChanged() {
    if (cfgKey() !== lastKey) startPoller();
  }

  // Blocks a restart still queued on the chain (a settings save that raced shutdown) from starting a
  // fresh poller after teardown began. Returns the drain so the shutdown coordinator can AWAIT it
  // under its bound: a poller stopped but not awaited can still be discarding a worktree or writing
  // its state file while a restart brings a fresh backend up against the same paths. The restart chain
  // is awaited alongside the poller, so a queued restart has settled (into a no-op, since `stopped` is
  // already latched) before the caller believes the lane is down.
  function stopPoller() {
    stopped = true;
    beforeStop();
    const draining = poller ? poller.stop() : Promise.resolve();
    return Promise.allSettled([draining, chain]).then(() => {});
  }

  // For a lane edit that changes nothing a poll would discover: patch the cached status in place and
  // rebroadcast, rather than forcing a tick that would re-query and could re-spawn work.
  function patchStatus(patch) {
    lastStatus = { ...(lastStatus || emptyStatus()), ...patch };
    broadcast(lastStatus);
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

module.exports = { createLaneRunner, createTickLoop };
