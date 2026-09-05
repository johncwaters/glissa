import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitReaps, createLifecycle } from '../server/server-lifecycle.ts';
import type { LifecycleOptions } from '../server/server-lifecycle.ts';
import { decideRestartStrategy, SUPERVISED_RESTART_EXIT_CODE } from '../server/core/restart-strategy.ts';

type SpawnFn = LifecycleOptions['spawn'];

interface SpawnCall {
  file: string;
  args: unknown;
  opts: Record<string, unknown>;
}

const UNSUPERVISED = {};
const SYSTEMD = { INVOCATION_ID: 'a1b2c3d4e5f64718a9bc0d1e2f3a4b5c' };

function fakeHttpServer() {
  return {
    closes: 0,
    close(callback: () => void) {
      this.closes += 1;
      if (callback) callback();
    },
  };
}

function deferredResolve(): { promise: Promise<void>; resolve: () => void } {
  let settle: () => void = () => {};
  const promise = new Promise<void>((resolve) => { settle = resolve; });
  return { promise, resolve: () => settle() };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fakeSpawn(): { fn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const fn: SpawnFn = (file, args, options) => {
    calls.push({ file, args, opts: isRecord(options) ? options : {} });
    return { unref: () => undefined };
  };
  return { fn, calls };
}

test('production restart respawns detached + windowsHide and then exits', async () => {
  const spawn = fakeSpawn();
  const exits: (number | undefined)[] = [];
  const lc = createLifecycle({
    shutdown: () => [],
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: UNSUPERVISED,
    spawn: spawn.fn,
    exit: (code) => exits.push(code),
    getArgv: () => ['node.exe', 'server/main.ts'],
    cwd: () => 'C:/work',
  });
  await lc.requestRestart();
  assert.equal(spawn.calls.length, 1, 'replacement spawned exactly once');
  const call = spawn.calls[0];
  assert.ok(call, 'a replacement was spawned');
  const { file, args, opts } = call;
  assert.equal(file, 'node.exe');
  assert.deepEqual(args, ['server/main.ts']);
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
    spawn: spawn.fn,
    exit: () => {},
    getArgv: () => ['node.exe', 'server/main.ts'],
  });
  await Promise.all([lc.requestRestart(), lc.requestRestart()]);
  await lc.requestRestart();
  assert.equal(shutdowns, 1, 'shutdown ran once');
  assert.equal(spawn.calls.length, 1, 'one replacement only, no ping-pong');
});

test('restart and shutdown share one guard: shutdown after restart is a no-op', async () => {
  const spawn = fakeSpawn();
  const exits: (number | undefined)[] = [];
  const http = fakeHttpServer();
  const lc = createLifecycle({
    shutdown: () => [],
    httpServer: http,
    onRestart: null,
    env: UNSUPERVISED,
    spawn: spawn.fn,
    exit: (code) => exits.push(code),
    getArgv: () => ['node.exe', 'server/main.ts'],
  });
  await lc.requestRestart();
  await lc.requestShutdown();
  assert.equal(spawn.calls.length, 1, 'no second lifecycle action ran');
  assert.deepEqual(exits, [0], 'only the restart exit fired');
});

test('reaps are awaited BEFORE the respawn (no orphaned PTY tree)', async () => {
  const spawn = fakeSpawn();
  let reapSettled = false;
  const reap = new Promise<void>((resolve) => setTimeout(() => {
    reapSettled = true;
    resolve();
  }, 15));
  let settledWhenSpawned: boolean | null = null;
  const wrappedSpawn: SpawnFn = (file, args, options) => {
    settledWhenSpawned = reapSettled;
    return spawn.fn(file, args, options);
  };
  const lc = createLifecycle({
    shutdown: () => [reap],
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: UNSUPERVISED,
    spawn: wrappedSpawn,
    exit: () => {},
    getArgv: () => ['node.exe', 'server/main.ts'],
  });
  await lc.requestRestart();
  assert.equal(settledWhenSpawned, true, 'the kill reap resolved before the replacement spawned');
});

test('dev (onRestart) path restarts in-process: no detached spawn, no exit', async () => {
  const spawn = fakeSpawn();
  let onRestartCalls = 0;
  const exits: (number | undefined)[] = [];
  const lc = createLifecycle({
    shutdown: () => [],
    httpServer: fakeHttpServer(),
    onRestart: () => { onRestartCalls++; },
    spawn: spawn.fn,
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
    spawn: fakeSpawn().fn,
    exit: () => {},
  });
  await assert.rejects(() => lc.requestRestart(), /vite boom/, 'the thrown onRestart propagates');
  await lc.requestRestart();
  assert.equal(calls, 2, 'guard reset after the throw allowed a second in-process restart');
});

test('requestShutdown closes the server and exits once', async () => {
  const http = fakeHttpServer();
  const exits: (number | undefined)[] = [];
  const lc = createLifecycle({
    shutdown: () => [],
    httpServer: http,
    onRestart: null,
    env: UNSUPERVISED,
    spawn: fakeSpawn().fn,
    exit: (code) => exits.push(code),
  });
  await lc.requestShutdown();
  assert.equal(http.closes, 1, 'listener closed');
  assert.deepEqual(exits, [0], 'exited exactly once');
});

test('decideRestartStrategy: INVOCATION_ID present means the supervisor restarts us', () => {
  assert.equal(decideRestartStrategy({ INVOCATION_ID: 'abc123' }), 'exit-for-supervisor');
  assert.equal(decideRestartStrategy({}), 'respawn');
  assert.equal(decideRestartStrategy({ INVOCATION_ID: '' }), 'respawn', 'empty is not a real invocation');
  assert.equal(decideRestartStrategy(undefined), 'respawn', 'no env at all falls back to the respawn');
  assert.notEqual(SUPERVISED_RESTART_EXIT_CODE, 0, 'a zero exit would not trigger Restart=on-failure');
});

test('supervised restart exits non-zero WITHOUT respawning (systemd starts the replacement)', async () => {
  const spawn = fakeSpawn();
  const exits: (number | undefined)[] = [];
  const http = fakeHttpServer();
  const lc = createLifecycle({
    shutdown: () => [],
    httpServer: http,
    onRestart: null,
    env: SYSTEMD,
    spawn: spawn.fn,
    exit: (code) => exits.push(code),
    getArgv: () => ['node', 'server/main.ts'],
    log: () => {},
  });
  await lc.requestRestart();
  assert.equal(spawn.calls.length, 0, 'no detached child to die with the cgroup');
  assert.equal(http.closes, 1, 'listener released before exiting');
  assert.deepEqual(exits, [SUPERVISED_RESTART_EXIT_CODE], 'non-zero so Restart=on-failure fires');
});

test('beforeHandOff runs once when the close callback fires first', async () => {
  let handOffCalls = 0;
  const lifecycle = createLifecycle({
    shutdown: () => [],
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: SYSTEMD,
    spawn: fakeSpawn().fn,
    exit: () => {},
    log: () => {},
    closeTimeoutMs: 20,
    beforeHandOff: async () => { handOffCalls += 1; },
  });
  await lifecycle.requestRestart();
  assert.equal(handOffCalls, 1);
});

test('beforeHandOff runs once when the close fallback fires first', async () => {
  let handOffCalls = 0;
  const lifecycle = createLifecycle({
    shutdown: () => [],
    httpServer: { close() {} },
    onRestart: null,
    env: SYSTEMD,
    spawn: fakeSpawn().fn,
    exit: () => {},
    log: () => {},
    closeTimeoutMs: 1,
    beforeHandOff: async () => { handOffCalls += 1; },
  });
  await lifecycle.requestRestart();
  assert.equal(handOffCalls, 1);
});

test('restart handoff waits for beforeHandOff to settle', async () => {
  const handOffReady = deferredResolve();
  const exits: (number | undefined)[] = [];
  const lifecycle = createLifecycle({
    shutdown: () => [],
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: SYSTEMD,
    spawn: fakeSpawn().fn,
    exit: (code) => exits.push(code),
    log: () => {},
    beforeHandOff: () => handOffReady.promise,
  });
  const restarting = lifecycle.requestRestart();
  await tick();
  assert.deepEqual(exits, []);
  handOffReady.resolve();
  await restarting;
  assert.deepEqual(exits, [SUPERVISED_RESTART_EXIT_CODE]);
});

test('a rejecting beforeHandOff is logged and restart still hands off', async () => {
  const exits: (number | undefined)[] = [];
  const logs: string[] = [];
  const lifecycle = createLifecycle({
    shutdown: () => [],
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: SYSTEMD,
    spawn: fakeSpawn().fn,
    exit: (code) => exits.push(code),
    log: (message) => logs.push(message),
    beforeHandOff: async () => { throw new Error('swap failed'); },
  });
  await lifecycle.requestRestart();
  assert.deepEqual(exits, [SUPERVISED_RESTART_EXIT_CODE]);
  assert.equal(logs.some((message) => message.includes('before handoff failed: swap failed')), true);
});

test('the in-process restart path runs beforeHandOff before restarting', async () => {
  const order: string[] = [];
  const lifecycle = createLifecycle({
    shutdown: () => [],
    httpServer: fakeHttpServer(),
    onRestart: () => { order.push('restart'); },
    env: UNSUPERVISED,
    spawn: fakeSpawn().fn,
    exit: () => {},
    log: () => {},
    beforeHandOff: async () => { order.push('handoff'); },
  });
  await lifecycle.requestRestart();
  assert.deepEqual(order, ['handoff', 'restart']);
});

test('a beforeHandOff that never settles is bounded and the restart still hands off', async () => {
  const exits: (number | undefined)[] = [];
  const logs: string[] = [];
  const lifecycle = createLifecycle({
    shutdown: () => [],
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: SYSTEMD,
    spawn: fakeSpawn().fn,
    exit: (code) => exits.push(code),
    log: (message) => logs.push(message),
    beforeHandOff: () => new Promise<void>(() => {}),
    beforeHandOffCapMs: 5,
  });
  await lifecycle.requestRestart();
  assert.deepEqual(exits, [SUPERVISED_RESTART_EXIT_CODE]);
  assert.equal(logs.some((message) => message.includes('before handoff exceeded 5ms')), true);
});

test('the default five minute cap is the last resort a handoff bounded by its own timeouts never reaches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const exits: (number | undefined)[] = [];
  const logs: string[] = [];
  const handOffReady = deferredResolve();
  const lifecycle = createLifecycle({
    shutdown: () => [],
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: SYSTEMD,
    spawn: fakeSpawn().fn,
    exit: (code) => exits.push(code),
    log: (message) => logs.push(message),
    beforeHandOff: () => handOffReady.promise,
  });
  const restarted = lifecycle.requestRestart();
  t.mock.timers.tick(299_999);
  assert.deepEqual(exits, [], 'the cap has not fired yet');
  handOffReady.resolve();
  await restarted;
  assert.deepEqual(exits, [SUPERVISED_RESTART_EXIT_CODE]);
  assert.equal(logs.some((message) => message.includes('before handoff exceeded')), false);
});

test('requestShutdown never calls beforeHandOff', async () => {
  let handOffCalls = 0;
  const lifecycle = createLifecycle({
    shutdown: () => [],
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: SYSTEMD,
    spawn: fakeSpawn().fn,
    exit: () => {},
    beforeHandOff: async () => { handOffCalls += 1; },
  });
  await lifecycle.requestShutdown();
  assert.equal(handOffCalls, 0);
});

test('supervised SHUTDOWN still exits 0 so the unit stays down', async () => {
  const exits: (number | undefined)[] = [];
  const lc = createLifecycle({
    shutdown: () => [],
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: SYSTEMD,
    spawn: fakeSpawn().fn,
    exit: (code) => exits.push(code),
  });
  await lc.requestShutdown();
  assert.deepEqual(exits, [0], 'Shut Down must not look like a failure to the supervisor');
});

test('awaitReaps resolves when a reap never settles (bounded cap)', async () => {
  const never = new Promise(() => {});

  await awaitReaps([never], { capMs: 20 });
  assert.ok(true, 'awaitReaps resolved via the cap, not the hung reap');
});

test('awaitReaps with no pending reaps resolves immediately', async () => {
  await awaitReaps([]);
  await awaitReaps(undefined);
  assert.ok(true);
});

test('the lifecycle awaits every named lane stopper before releasing the listener', async () => {
  const order: string[] = [];
  const laneStopped = deferredResolve();
  const lc = createLifecycle({
    shutdown: () => ({
      reaps: [],
      stoppers: [{ name: 'pr-review', promise: laneStopped.promise.then(() => order.push('lane drained')) }],
    }),
    httpServer: { close(callback: () => void) { order.push('listener closed'); if (callback) callback(); } },
    onRestart: null,
    env: UNSUPERVISED,
    spawn: fakeSpawn().fn,
    exit: () => { order.push('exit'); },
  });
  const shuttingDown = lc.requestShutdown();
  await tick();
  assert.deepEqual(order, [], 'nothing proceeds while the lane is still draining');
  laneStopped.resolve();
  await shuttingDown;
  assert.deepEqual(order, ['lane drained', 'listener closed', 'exit']);
});

test('a wedged lane costs the bound and one warning, never the exit', async () => {
  const warnings: string[] = [];
  const exits: (number | undefined)[] = [];
  const lc = createLifecycle({
    shutdown: () => ({ reaps: [], stoppers: [{ name: 'usage', promise: new Promise(() => {}) }] }),
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: UNSUPERVISED,
    spawn: fakeSpawn().fn,
    exit: (code) => exits.push(code),
    log: (line) => warnings.push(line),
    capMs: 20,
  });
  await lc.requestShutdown();
  assert.deepEqual(exits, [0], 'the process still exits');
  assert.equal(warnings.some((line) => line.includes('lane shutdown exceeded')), true);
});

test('a lane whose stop rejects is named rather than swallowed', async () => {
  const warnings: string[] = [];
  const lc = createLifecycle({
    shutdown: () => ({ reaps: [], stoppers: [{ name: 'pack-service', promise: Promise.reject(new Error('rename failed')) }] }),
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: UNSUPERVISED,
    spawn: fakeSpawn().fn,
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
  const order: string[] = [];
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
    spawn: spawn.fn,
    exit: () => { order.push('exit'); },
    getArgv: () => ['node', 'server/main.ts'],
  });
  const restarting = lc.requestRestart();
  await tick();
  assert.equal(spawn.calls.length, 0, 'no replacement while the old lane still owns the worktree');
  laneStopped.resolve();
  await restarting;
  assert.deepEqual(order, ['reaped', 'lane drained', 'exit']);
  assert.equal(spawn.calls.length, 1);
});

test('a shutdown that returns a plain reap array is still awaited', async () => {
  const order: string[] = [];
  const reap = deferredResolve();
  const lc = createLifecycle({
    shutdown: () => [reap.promise.then(() => order.push('reaped'))],
    httpServer: fakeHttpServer(),
    onRestart: null,
    env: UNSUPERVISED,
    spawn: fakeSpawn().fn,
    exit: () => { order.push('exit'); },
  });
  const shuttingDown = lc.requestShutdown();
  await tick();
  assert.deepEqual(order, []);
  reap.resolve();
  await shuttingDown;
  assert.deepEqual(order, ['reaped', 'exit']);
});
