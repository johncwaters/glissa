// The abort-vs-reap race the 2026-08 review recorded alongside the shutdown coordinator: a lane's hard
// timeout resolved the job promise the instant it fired, so the caller's finally discarded the job's
// worktree while the session it had just killed was still dying. On Windows a surviving
// claude/cmd/conhost holding a handle in that directory makes the discard fail, leaking the checkout
// and the branch.

import test from 'node:test';
import assert from 'node:assert/strict';

import { awaitSessionExit, drainPending, raceWithAbort } from '../server/ephemeral-session.ts';
import type { Session } from '../session/sessions.ts';
import { plainSession } from './helpers/fake-session.ts';
import { manualTimers } from './helpers/manual-timers.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, resolve: (value) => settle(value) };
}

interface LaneVerdict {
  verdict: string;
  summary: string;
}

// A real Session that never spawns, whose destroy() parks an in-flight reap on _killReap exactly as
// sessions.ts does on win32.
function abortableSession(reap: Promise<void> | null = null): Session {
  const session = plainSession('ephemeral-abort');
  session.start = () => new Promise<void>(() => {});
  session.destroy = () => {
    session._destroyed = true;
    if (reap) session._killReap = reap;
  };
  return session;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('an abort waits for the killed PTY tree to be reaped before it resolves', async () => {
  const reap = deferred<void>();
  const session = abortableSession(reap.promise);
  const controller = new AbortController();
  let hasSettled = false;
  const waiting = awaitSessionExit(session, { signal: controller.signal }).then(() => { hasSettled = true; });

  controller.abort();
  await tick();
  assert.equal(session._destroyed, true, 'the abort kills the session at once');
  assert.equal(hasSettled, false, 'but does not report done while the tree is still being reaped');

  reap.resolve();
  await waiting;
  assert.equal(hasSettled, true);
});

test('a reap that never settles costs the bound, not the lane slot', async () => {
  const session = abortableSession(new Promise(() => {}));
  const controller = new AbortController();
  const waiting = awaitSessionExit(session, { signal: controller.signal, reapCapMs: 20 });
  controller.abort();
  await waiting;
  assert.ok(true, 'resolved via the cap rather than the hung reap');
});

test('a session with no reap to wait for resolves immediately, as before', async () => {
  const session = abortableSession();
  const controller = new AbortController();
  controller.abort();
  await awaitSessionExit(session, { signal: controller.signal });
  assert.equal(session._destroyed, true);
});

test('a timeout still frees the slot at once, and the cleanup waits for the dying session', async () => {
  const timers = manualTimers();
  const startSettled = deferred<LaneVerdict>();
  const cleanup: string[] = [];
  const pendingStarts: Promise<unknown>[] = [];

  const verdict = await new Promise<LaneVerdict>((resolve) => {
    void raceWithAbort<LaneVerdict>({
      timeoutMs: 5,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onTimeout: () => ({ verdict: 'ERROR', summary: 'timed out' }),
      onEmpty: () => ({ verdict: 'ERROR', summary: 'no verdict' }),
      start: () => startSettled.promise,
      onPending: (promise) => { pendingStarts.push(promise); },
    }).then(resolve);
    timers.fireAll();
  });
  assert.equal(verdict.summary, 'timed out', 'the concurrency slot frees the moment the deadline hits');

  // What the caller does in its finally: drain first, discard second.
  const draining = drainPending(pendingStarts[0], { capMs: 5000 }).then(() => cleanup.push('discard worktree'));
  await tick();
  assert.deepEqual(cleanup, [], 'the worktree is not discarded under a session that is still dying');

  startSettled.resolve({ verdict: 'ERROR', summary: 'killed' });
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
  const result = await raceWithAbort<LaneVerdict>({
    timeoutMs: 5,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onTimeout: () => ({ verdict: 'ERROR', summary: 'timed out' }),
    onEmpty: () => ({ verdict: 'ERROR', summary: 'no verdict' }),
    start: async () => ({ verdict: 'CLEAN', summary: 'ok' }),
  });
  assert.deepEqual(result, { verdict: 'CLEAN', summary: 'ok' });
});
