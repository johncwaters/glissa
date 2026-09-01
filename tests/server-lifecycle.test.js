'use strict';

// server-lifecycle.js owns restart/shutdown. These tests lock in the three regressions behind the
// "menu restart -> unkillable popping cmd loop" bug, all via injected side effects (no real spawn/exit):
//   1. the production respawn is spawned with windowsHide:true + detached:true (no popping console window);
//   2. a double restart/shutdown spawns the replacement AT MOST ONCE (re-entry guard);
//   3. the PTY reaps are AWAITED before the respawn/exit (no orphaned cmd/claude/conhost);
// plus the dev (onRestart) path and the awaitReaps cap.

const test = require('node:test');
const assert = require('node:assert/strict');

const { awaitReaps, createLifecycle } = require('../server/server-lifecycle.ts');
const { decideRestartStrategy, SUPERVISED_RESTART_EXIT_CODE } = require('../server/core/restart-strategy.ts');

// Every test injects env explicitly: the restart hand-off branches on it, and the suite itself may run
// under a supervisor whose INVOCATION_ID would otherwise leak into these assertions.
const UNSUPERVISED = {};
const SYSTEMD = { INVOCATION_ID: 'a1b2c3d4e5f64718a9bc0d1e2f3a4b5c' };

// httpServer fake: close(cb) releases the listener and runs the spawn-and-exit / exit callback now.
function fakeHttpServer() {
  return { closes: 0, close(cb) { this.closes++; if (cb) cb(); } };
}

function deferredResolve() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

// One macrotask, long enough for every already-settled microtask chain to run.
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeSpawn() {
  const calls = [];
  const fn = (file, args, opts) => { calls.push({ file, args, opts }); return { unref() {} }; };
  fn.calls = calls;
  return fn;
}

test('production restart respawns detached + windowsHide and then exits', async () => {
  const spawn = fakeSpawn();
  const exits = [];
  const lc = createLifecycle({
    shutdown: () => [],
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: UNSUPERVISED,
    spawn,
    exit: (code) => exits.push(code),
    getArgv: () => ['node.exe', 'server.js'],
    cwd: () => 'C:/work',
  });
  await lc.requestRestart();
  assert.equal(spawn.calls.length, 1, 'replacement spawned exactly once');
  const { file, args, opts } = spawn.calls[0];
  assert.equal(file, 'node.exe');
  assert.deepEqual(args, ['server.js']);
  assert.equal(opts.detached, true, 'detached so it outlives this process');
  assert.equal(opts.windowsHide, true, 'windowsHide so it does NOT pop its own console window');
  assert.equal(opts.stdio, 'ignore');
  assert.equal(opts.cwd, 'C:/work');
  assert.deepEqual(exits, [0], 'exited after respawn');
});

test('double requestRestart spawns the replacement at most once (re-entry guard)', async () => {
  const spawn = fakeSpawn();
  let shutdowns = 0;
  const lc = createLifecycle({
    shutdown: () => { shutdowns++; return []; },
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: UNSUPERVISED,
    spawn,
    exit: () => {},
    getArgv: () => ['node.exe', 'server.js'],
  });
  await Promise.all([lc.requestRestart(), lc.requestRestart()]);
  await lc.requestRestart();
  assert.equal(shutdowns, 1, 'shutdown ran once');
  assert.equal(spawn.calls.length, 1, 'one replacement only, no ping-pong');
});

test('restart and shutdown share one guard: shutdown after restart is a no-op', async () => {
  const spawn = fakeSpawn();
  const exits = [];
  const http = fakeHttpServer();
  const lc = createLifecycle({
    shutdown: () => [],
    httpServer: http,
    onRestart: null,
    env: UNSUPERVISED,
    spawn,
    exit: (code) => exits.push(code),
    getArgv: () => ['node.exe', 'server.js'],
  });
  await lc.requestRestart();
  await lc.requestShutdown();
  assert.equal(spawn.calls.length, 1, 'no second lifecycle action ran');
  assert.deepEqual(exits, [0], 'only the restart exit fired');
});

test('reaps are awaited BEFORE the respawn (no orphaned PTY tree)', async () => {
  const spawn = fakeSpawn();
  let reapSettled = false;
  const reap = new Promise((resolve) => setTimeout(() => { reapSettled = true; resolve(); }, 15));
  let settledWhenSpawned = null;
  const wrappedSpawn = (file, args, opts) => { settledWhenSpawned = reapSettled; return spawn(file, args, opts); };
  const lc = createLifecycle({
    shutdown: () => [reap],
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: UNSUPERVISED,
    spawn: wrappedSpawn,
    exit: () => {},
    getArgv: () => ['node.exe', 'server.js'],
  });
  await lc.requestRestart();
  assert.equal(settledWhenSpawned, true, 'the kill reap resolved before the replacement spawned');
});

test('dev (onRestart) path restarts in-process: no detached spawn, no exit', async () => {
  const spawn = fakeSpawn();
  let onRestartCalls = 0;
  const exits = [];
  const lc = createLifecycle({
    shutdown: () => [],
    httpServer: fakeHttpServer(),
    onRestart: () => { onRestartCalls++; },
    spawn,
    exit: (code) => exits.push(code),
  });
  await lc.requestRestart();
  assert.equal(onRestartCalls, 1, 'in-process restart invoked');
  assert.equal(spawn.calls.length, 0, 'no detached respawn in dev');
  assert.deepEqual(exits, [], 'dev restart does not exit the process');
});

test('dev restart releases the guard when onRestart throws, so a later restart proceeds', async () => {
  let calls = 0;
  const onRestart = () => { calls++; if (calls === 1) throw new Error('vite boom'); };
  const lc = createLifecycle({
    shutdown: () => [],
    httpServer: fakeHttpServer(),
    onRestart,
    spawn: fakeSpawn(),
    exit: () => {},
  });
  await assert.rejects(() => lc.requestRestart(), /vite boom/, 'the thrown onRestart propagates');
  await lc.requestRestart(); // guard was released by the throw, so this in-process restart runs again
  assert.equal(calls, 2, 'guard reset after the throw allowed a second in-process restart');
});

test('requestShutdown closes the server and exits once', async () => {
  const http = fakeHttpServer();
  const exits = [];
  const lc = createLifecycle({
    shutdown: () => [],
    httpServer: http,
    onRestart: null,
    env: UNSUPERVISED,
    spawn: fakeSpawn(),
    exit: (code) => exits.push(code),
  });
  await lc.requestShutdown();
  assert.equal(http.closes, 1, 'listener closed');
  assert.deepEqual(exits, [0], 'exited exactly once');
});

// Under systemd the self-respawn bricked the service: the clean exit 0 did not trigger
// Restart=on-failure and the detached child died with the cgroup, leaving nothing listening.
test('decideRestartStrategy: INVOCATION_ID present means the supervisor restarts us', () => {
  assert.equal(decideRestartStrategy({ INVOCATION_ID: 'abc123' }), 'exit-for-supervisor');
  assert.equal(decideRestartStrategy({}), 'respawn');
  assert.equal(decideRestartStrategy({ INVOCATION_ID: '' }), 'respawn', 'empty is not a real invocation');
  assert.equal(decideRestartStrategy(undefined), 'respawn', 'no env at all falls back to the respawn');
  assert.notEqual(SUPERVISED_RESTART_EXIT_CODE, 0, 'a zero exit would not trigger Restart=on-failure');
});

test('supervised restart exits non-zero WITHOUT respawning (systemd starts the replacement)', async () => {
  const spawn = fakeSpawn();
  const exits = [];
  const http = fakeHttpServer();
  const lc = createLifecycle({
    shutdown: () => [],
    httpServer: http,
    onRestart: null,
    env: SYSTEMD,
    spawn,
    exit: (code) => exits.push(code),
    getArgv: () => ['node', 'server.js'],
    log: () => {},
  });
  await lc.requestRestart();
  assert.equal(spawn.calls.length, 0, 'no detached child to die with the cgroup');
  assert.equal(http.closes, 1, 'listener released before exiting');
  assert.deepEqual(exits, [SUPERVISED_RESTART_EXIT_CODE], 'non-zero so Restart=on-failure fires');
});

test('supervised SHUTDOWN still exits 0 so the unit stays down', async () => {
  const exits = [];
  const lc = createLifecycle({
    shutdown: () => [],
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: SYSTEMD,
    spawn: fakeSpawn(),
    exit: (code) => exits.push(code),
  });
  await lc.requestShutdown();
  assert.deepEqual(exits, [0], 'Shut Down must not look like a failure to the supervisor');
});

test('awaitReaps resolves when a reap never settles (bounded cap)', async () => {
  const never = new Promise(() => {});
  // capMs small so the test is fast; assert it resolves despite the never-settling reap.
  await awaitReaps([never], { capMs: 20 });
  assert.ok(true, 'awaitReaps resolved via the cap, not the hung reap');
});

test('awaitReaps with no pending reaps resolves immediately', async () => {
  await awaitReaps([]);
  await awaitReaps(undefined);
  assert.ok(true);
});

// The shutdown coordinator (2026-08 review, section 6). Two independent review passes named the
// unawaited lane stops as the biggest systemic risk in the codebase: a restart could bring a fresh
// backend up while the old one was still discarding a worktree or writing the same state file.
test('the lifecycle awaits every named lane stopper before releasing the listener', async () => {
  const order = [];
  const laneStopped = deferredResolve();
  const lc = createLifecycle({
    shutdown: () => ({
      reaps: [],
      stoppers: [{ name: 'pr-review', promise: laneStopped.promise.then(() => order.push('lane drained')) }],
    }),
    httpServer: { closes: 0, close(cb) { order.push('listener closed'); if (cb) cb(); } },
    onRestart: null,
    env: UNSUPERVISED,
    spawn: fakeSpawn(),
    exit: () => order.push('exit'),
  });
  const shuttingDown = lc.requestShutdown();
  await tick();
  assert.deepEqual(order, [], 'nothing proceeds while the lane is still draining');
  laneStopped.resolve();
  await shuttingDown;
  assert.deepEqual(order, ['lane drained', 'listener closed', 'exit']);
});

test('a wedged lane costs the bound and one warning, never the exit', async () => {
  const warnings = [];
  const exits = [];
  const lc = createLifecycle({
    shutdown: () => ({ reaps: [], stoppers: [{ name: 'usage', promise: new Promise(() => {}) }] }),
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: UNSUPERVISED,
    spawn: fakeSpawn(),
    exit: (code) => exits.push(code),
    log: (line) => warnings.push(line),
    capMs: 20,
  });
  await lc.requestShutdown();
  assert.deepEqual(exits, [0], 'the process still exits');
  assert.equal(warnings.some((line) => line.includes('lane shutdown exceeded')), true);
});

test('a lane whose stop rejects is named rather than swallowed', async () => {
  const warnings = [];
  const lc = createLifecycle({
    shutdown: () => ({ reaps: [], stoppers: [{ name: 'pack-service', promise: Promise.reject(new Error('rename failed')) }] }),
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: UNSUPERVISED,
    spawn: fakeSpawn(),
    exit: () => {},
    log: (line) => warnings.push(line),
  });
  await lc.requestShutdown();
  assert.equal(
    warnings.some((line) => line.includes('pack-service failed to stop cleanly: rename failed')),
    true
  );
});

test('a restart awaits the lane drains too, not only the PTY reaps', async () => {
  const order = [];
  const laneStopped = deferredResolve();
  const spawn = fakeSpawn();
  const lc = createLifecycle({
    shutdown: () => ({
      reaps: [Promise.resolve().then(() => order.push('reaped'))],
      stoppers: [{ name: 'posthog', promise: laneStopped.promise.then(() => order.push('lane drained')) }],
    }),
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: UNSUPERVISED,
    spawn,
    exit: () => order.push('exit'),
    getArgv: () => ['node', 'server.js'],
  });
  const restarting = lc.requestRestart();
  await tick();
  assert.equal(spawn.calls.length, 0, 'no replacement while the old lane still owns the worktree');
  laneStopped.resolve();
  await restarting;
  assert.deepEqual(order, ['reaped', 'lane drained', 'exit']);
  assert.equal(spawn.calls.length, 1);
});

// The historical shape (a bare array of PTY reaps) still works, so a caller or test that predates the
// coordinator needs no change.
test('a shutdown that returns a plain reap array is still awaited', async () => {
  const order = [];
  const reap = deferredResolve();
  const lc = createLifecycle({
    shutdown: () => [reap.promise.then(() => order.push('reaped'))],
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: UNSUPERVISED,
    spawn: fakeSpawn(),
    exit: () => order.push('exit'),
  });
  const shuttingDown = lc.requestShutdown();
  await tick();
  assert.deepEqual(order, []);
  reap.resolve();
  await shuttingDown;
  assert.deepEqual(order, ['reaped', 'exit']);
});
