'use strict';

// The abort-vs-reap race the 2026-08 review recorded alongside the shutdown coordinator: a lane's hard
// timeout resolved the job promise the instant it fired, so the caller's finally discarded the job's
// worktree while the session it had just killed was still dying. On Windows a surviving
// claude/cmd/conhost holding a handle in that directory makes the discard fail, leaking the checkout
// and the branch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { awaitSessionExit, drainPending, raceWithAbort } = require('../server/ephemeral-session');

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

// A Session stand-in whose destroy() parks an in-flight reap on _killReap, exactly as sessions.js
// does on win32.
function fakeSession({ reap = null } = {}) {
  const sess = new EventEmitter();
  sess.destroyed = false;
  sess.start = () => new Promise(() => {});
  sess.destroy = () => { sess.destroyed = true; if (reap) sess._killReap = reap; };
  return sess;
}

// Timers the test drives, so "the bound expired" is a decision rather than a wall-clock race.
function manualTimers() {
  const pending = [];
  return {
    setTimeoutFn: (fn) => { const entry = { fn, cleared: false }; pending.push(entry); return entry; },
    clearTimeoutFn: (entry) => { if (entry) entry.cleared = true; },
    fireAll: () => { for (const entry of pending) { if (!entry.cleared) entry.fn(); } },
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('an abort waits for the killed PTY tree to be reaped before it resolves', async () => {
  const reap = deferred();
  const sess = fakeSession({ reap: reap.promise });
  const controller = new AbortController();
  let settled = false;
  const waiting = awaitSessionExit(sess, { signal: controller.signal }).then(() => { settled = true; });

  controller.abort();
  await tick();
  assert.equal(sess.destroyed, true, 'the abort kills the session at once');
  assert.equal(settled, false, 'but does not report done while the tree is still being reaped');

  reap.resolve();
  await waiting;
  assert.equal(settled, true);
});

test('a reap that never settles costs the bound, not the lane slot', async () => {
  const sess = fakeSession({ reap: new Promise(() => {}) });
  const controller = new AbortController();
  const waiting = awaitSessionExit(sess, { signal: controller.signal, reapCapMs: 20 });
  controller.abort();
  await waiting;
  assert.ok(true, 'resolved via the cap rather than the hung reap');
});

test('a session with no reap to wait for resolves immediately, as before', async () => {
  const sess = fakeSession();
  const controller = new AbortController();
  controller.abort();
  await awaitSessionExit(sess, { signal: controller.signal });
  assert.equal(sess.destroyed, true);
});

test('a timeout still frees the slot at once, and the cleanup waits for the dying session', async () => {
  const timers = manualTimers();
  const startSettled = deferred();
  const cleanup = [];
  let pending = null;

  const verdict = await new Promise((resolve) => {
    raceWithAbort({
      timeoutMs: 5,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onTimeout: () => ({ verdict: 'ERROR', summary: 'timed out' }),
      onEmpty: () => ({ verdict: 'ERROR', summary: 'no verdict' }),
      start: () => startSettled.promise,
      onPending: (promise) => { pending = promise; },
    }).then(resolve);
    timers.fireAll();
  });
  assert.equal(verdict.summary, 'timed out', 'the concurrency slot frees the moment the deadline hits');

  // What the caller does in its finally: drain first, discard second.
  const draining = drainPending(pending, { capMs: 5000 }).then(() => cleanup.push('discard worktree'));
  await tick();
  assert.deepEqual(cleanup, [], 'the worktree is not discarded under a session that is still dying');

  startSettled.resolve();
  await draining;
  assert.deepEqual(cleanup, ['discard worktree']);
});

test('drainPending gives up on its own bound rather than blocking cleanup forever', async () => {
  await drainPending(new Promise(() => {}), { capMs: 20 });
  assert.ok(true, 'a session that resists kill costs a delay, not a leaked worktree');
});

test('drainPending with nothing pending is a no-op', async () => {
  await drainPending(null);
  assert.ok(true);
});

test('a job that finishes normally hands back a start that is already settled', async () => {
  const timers = manualTimers();
  const result = await raceWithAbort({
    timeoutMs: 5,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onTimeout: () => ({ verdict: 'ERROR', summary: 'timed out' }),
    onEmpty: () => ({ verdict: 'ERROR', summary: 'no verdict' }),
    start: async () => ({ verdict: 'CLEAN', summary: 'ok' }),
  });
  assert.deepEqual(result, { verdict: 'CLEAN', summary: 'ok' });
});
