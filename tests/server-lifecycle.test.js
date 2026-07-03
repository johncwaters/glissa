'use strict';

// server-lifecycle.js owns restart/shutdown. These tests lock in the three regressions behind the
// "menu restart -> unkillable popping cmd loop" bug, all via injected side effects (no real spawn/exit):
//   1. the production respawn is spawned with windowsHide:true + detached:true (no popping console window);
//   2. a double restart/shutdown spawns the replacement AT MOST ONCE (re-entry guard);
//   3. the PTY reaps are AWAITED before the respawn/exit (no orphaned cmd/claude/conhost);
// plus the dev (onRestart) path and the awaitReaps cap.

const test = require('node:test');
const assert = require('node:assert/strict');

const { awaitReaps, createLifecycle } = require('../server/server-lifecycle');

// httpServer fake: close(cb) releases the listener and runs the spawn-and-exit / exit callback now.
function fakeHttpServer() {
  return { closes: 0, close(cb) { this.closes++; if (cb) cb(); } };
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
    spawn: fakeSpawn(),
    exit: (code) => exits.push(code),
  });
  await lc.requestShutdown();
  assert.equal(http.closes, 1, 'listener closed');
  assert.deepEqual(exits, [0], 'exited exactly once');
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
