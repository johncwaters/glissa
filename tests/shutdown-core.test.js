'use strict';

// The shutdown coordinator's decisions. The failure it exists to prevent: a restart bringing a fresh
// backend up while the old one's lanes are still discarding a worktree or writing the same state file,
// because shutdown fired every lane stop as `void lane.stop()` and nothing awaited them.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  awaitBounded, createStopperCollector, normalizeShutdownResult, summarizeStopOutcomes,
} = require('../server/core/shutdown-core');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// A timer seam that fires only when the test says so, so "the bound expired" is a decision the test
// makes rather than a wall-clock race.
function manualTimers() {
  const pending = [];
  return {
    setTimeoutFn: (fn) => { const entry = { fn, cleared: false }; pending.push(entry); return entry; },
    clearTimeoutFn: (entry) => { if (entry) entry.cleared = true; },
    fire: () => { for (const entry of pending) { if (!entry.cleared) entry.fn(); } },
    pending,
  };
}

test('awaitBounded settles when every promise settles, and reports no timeout', async () => {
  const timers = manualTimers();
  const outcome = await awaitBounded([Promise.resolve(1), Promise.reject(new Error('x'))], timers);
  assert.equal(outcome.timedOut, false);
  assert.deepEqual(outcome.settled.map((s) => s.status), ['fulfilled', 'rejected']);
  assert.equal(timers.pending[0].cleared, true, 'the cap timer is cleared the moment the race settles');
});

test('awaitBounded with nothing to wait for schedules no timer at all', async () => {
  const timers = manualTimers();
  const outcome = await awaitBounded([], timers);
  assert.deepEqual(outcome, { timedOut: false, settled: [] });
  assert.equal(timers.pending.length, 0);
});

test('a stalled promise costs the bound, not the exit', async () => {
  const timers = manualTimers();
  const stalled = deferred();
  const pending = awaitBounded([stalled.promise], timers);
  timers.fire();
  const outcome = await pending;
  assert.equal(outcome.timedOut, true, 'one wedged lane may not hang the process');
});

test('the collector invokes each stopper immediately and keeps its promise', () => {
  const order = [];
  const stoppers = createStopperCollector();
  stoppers.add('usage', () => { order.push('usage'); return Promise.resolve(); });
  stoppers.add('packs', () => { order.push('packs'); });
  assert.deepEqual(order, ['usage', 'packs'], 'timers are cleared on the spot, not when the coordinator gets round to it');
  assert.deepEqual(stoppers.entries().map((e) => e.name), ['usage', 'packs']);
});

test('a stopper that throws synchronously becomes a rejected entry, not an aborted teardown', async () => {
  const stoppers = createStopperCollector();
  stoppers.add('broken', () => { throw new Error('nope'); });
  stoppers.add('fine', () => Promise.resolve());
  const settled = await Promise.allSettled(stoppers.entries().map((e) => e.promise));
  assert.deepEqual(settled.map((s) => s.status), ['rejected', 'fulfilled']);
});

test('a duplicate stopper name is a wiring bug and says so at once', () => {
  const stoppers = createStopperCollector();
  stoppers.add('usage', () => {});
  assert.throws(() => stoppers.add('usage', () => {}), /duplicate shutdown stopper: usage/);
});

test('normalizeShutdownResult accepts the historical array shape', () => {
  const reap = Promise.resolve();
  assert.deepEqual(normalizeShutdownResult([reap]), { reaps: [reap], stoppers: [] });
  assert.deepEqual(normalizeShutdownResult(undefined), { reaps: [], stoppers: [] });
  assert.deepEqual(normalizeShutdownResult({ reaps: [reap], stoppers: [] }), { reaps: [reap], stoppers: [] });
  assert.deepEqual(normalizeShutdownResult({ nonsense: 1 }), { reaps: [], stoppers: [] });
});

test('summarizeStopOutcomes names the lanes that failed', () => {
  const entries = [{ name: 'usage' }, { name: 'packs' }];
  const summary = summarizeStopOutcomes(entries, {
    timedOut: false,
    settled: [{ status: 'rejected', reason: new Error('disk full') }, { status: 'fulfilled', value: undefined }],
  });
  assert.equal(summary.timedOut, false);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].name, 'usage');
  assert.equal(summary.failed[0].reason.message, 'disk full');
});
