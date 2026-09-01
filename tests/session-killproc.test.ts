
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import type { SessionOptions } from '../session/sessions.ts';

type KillCall = { args: string[]; opts: Record<string, unknown> };
type SignalCall = Record<string, unknown>;
const FAKE_PID = 2147483646;

function fakePty(pid = FAKE_PID) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

function fakeUnixPty(pid = FAKE_PID) {
  const socket = new EventEmitter();
  socket.on('error', () => {  });
  return {
    pid,
    _socket: socket,
    onData() {}, onExit() {}, write() {}, resize() {}, kill() {},
    on: (event: string, listener: (error: Error) => void) => socket.on(event, listener),
    listeners: (event: string) => socket.listeners(event),
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makePosixSession({ signals, alive = () => false, ptySpawn, pid = FAKE_PID }: {
  signals: SignalCall[];
  alive?: () => boolean;
  ptySpawn?: SessionOptions['ptySpawn'];
  pid?: number;
}) {
  return new Session({
    id: 'posix-kill-test',
    name: 'posix-kill-test',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    platform: 'linux',
    ptySpawn: ptySpawn || (() => fakePty(pid)),
    killProc: (args, _opts, cb) => { signals.push({ taskkill: args }); cb(null, '', ''); },
    signalProc: (signalPid, signal) => {
      signals.push({ pid: signalPid, signal });
      if (alive()) return;
      const err: NodeJS.ErrnoException = new Error('ESRCH');
      err.code = 'ESRCH';
      throw err;
    },
  });
}

const groupKillsIn = (signals: SignalCall[]) => signals.filter((s) => s.pid === -FAKE_PID && s.signal === 'SIGKILL');

function cleanup(session: Session) {
  session._killPollTimer && clearTimeout(session._killPollTimer);
  session._killReapTimer && clearTimeout(session._killReapTimer);
  session.destroy();
  session._killPollTimer && clearTimeout(session._killPollTimer);
  session._killReapTimer && clearTimeout(session._killReapTimer);
}

async function asWin32(fn: () => Promise<void>) {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform') ?? { value: process.platform, configurable: true };
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try { return await fn(); }
  finally { Object.defineProperty(process, 'platform', orig); }
}

function makeSession(killCalls: KillCall[], ptySpawn?: SessionOptions['ptySpawn']) {
  return new Session({
    id: 'killproc-test',
    name: 'killproc-test',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: ptySpawn || (() => fakePty()),
    killProc: (args, opts, cb) => { killCalls.push({ args, opts }); cb(null, '', ''); },
  });
}

test('kill() invokes the injected killer with the taskkill array args', async () => {
  await asWin32(async () => {
    const killCalls: KillCall[] = [];
    const s = makeSession(killCalls);
    try {
      await s.start();
      s.kill();
      assert.equal(killCalls.length, 1, 'killer invoked once');
      assert.deepEqual(killCalls[0].args, ['/PID', String(FAKE_PID), '/T', '/F'],
        'array args, no shell string interpolation');
    } finally { s._killPollTimer && clearTimeout(s._killPollTimer); s.destroy(); }
  });
});

test('kill() flips _ptyAlive to false synchronously BEFORE invoking the killer', async () => {
  await asWin32(async () => {
    let aliveAtKill: boolean | null = null;
    const s = new Session({
      id: 'killproc-order',
      name: 'killproc-order',
      path: process.cwd(),
      spawnCommand: { path: process.execPath, kind: 'exe' },
      ptySpawn: () => fakePty(),
      killProc: (_args, _opts, cb) => { aliveAtKill = s._ptyAlive; cb(null, '', ''); },
    });
    try {
      await s.start();
      assert.equal(s._ptyAlive, true, 'live after start');
      s.kill();
      assert.equal(aliveAtKill, false, '_ptyAlive was already false when the killer was invoked');
    } finally { s._killPollTimer && clearTimeout(s._killPollTimer); s.destroy(); }
  });
});

test('killSession reaps live PTYs from INITIALIZING and STARTING', async () => {
  for (const state of [STATES.INITIALIZING, STATES.STARTING]) {
    const signals: SignalCall[] = [];
    const s = makePosixSession({ signals });
    try {
      s.state = state;
      s.ptyProcess = fakePty();
      s._ptyAlive = true;
      assert.equal(s.killSession(), true);
      assert.equal(s.state, STATES.DONE);
      assert.equal(s._ptyAlive, false);
      assert.deepEqual(signals[0], { pid: -FAKE_PID, signal: 'SIGKILL' });
      await s._killReap;
    } finally {
      cleanup(s);
    }
  }
});

test('_handlePtyExit reap is fire-and-forget: the exit emit is not delayed by the killer', async () => {
  await asWin32(async () => {
    const killCalls: KillCall[] = [];
    let resolveKill: () => void = () => {};
    const s = new Session({
      id: 'killproc-reap',
      name: 'killproc-reap',
      path: process.cwd(),
      spawnCommand: { path: process.execPath, kind: 'exe' },
      ptySpawn: () => fakePty(),
      killProc: (args, opts, cb) => { killCalls.push({ args, opts }); resolveKill = () => cb(null, '', ''); },
    });
    try {
      await s.start();
      s.state = STATES.RUNNING;
      let exited = false;
      s.on('exit', () => { exited = true; });
      await s._handlePtyExit(0, null);
      assert.equal(exited, true, 'exit emitted without waiting on the held reap');
      assert.equal(killCalls.length, 1, 'the orphan reap was issued');
      resolveKill();
    } finally { s._killPollTimer && clearTimeout(s._killPollTimer); s.destroy(); }
  });
});

test('_forceKillAfterTimeout fires the killer once when the process outlives the budget', async () => {
  await asWin32(async () => {
    const killCalls: KillCall[] = [];
    const livePid = process.pid;
    const s = new Session({
      id: 'killproc-force',
      name: 'killproc-force',
      path: process.cwd(),
      spawnCommand: { path: process.execPath, kind: 'exe' },
      ptySpawn: () => fakePty(livePid),
      killProc: (args, opts, cb) => { killCalls.push({ args, opts }); cb(null, '', ''); },
    });
    try {
      await s.start();
      s.kill();
      const immediate = killCalls.length;
      await new Promise((r) => setTimeout(r, 3500));
      assert.equal(killCalls.length, immediate + 1, 'force-kill fired exactly once after the budget');
      assert.deepEqual(killCalls.at(-1)?.args, ['/PID', String(livePid), '/T', '/F']);
    } finally { s._killPollTimer && clearTimeout(s._killPollTimer); s.destroy(); }
  });
});

test('kill() exposes an awaitable _killReap that settles when the win32 killer completes', async () => {
  await asWin32(async () => {
    const killCalls: KillCall[] = [];
    const s = makeSession(killCalls);
    try {
      await s.start();
      s.kill();
      assert.ok(s._killReap && typeof s._killReap.then === 'function', '_killReap is a promise');
      await s._killReap;
    } finally { s._killPollTimer && clearTimeout(s._killPollTimer); s.destroy(); }
  });
});


test('kill() off Windows signals the whole process group, not just the pty child', async () => {
  const signals: SignalCall[] = [];
  const ptyKills: unknown[] = [];
  const s = makePosixSession({
    signals,
    ptySpawn: () => Object.assign(fakePty(), { kill: () => ptyKills.push('sighup') }),
  });
  try {
    await s.start();
    s.kill();
    assert.deepEqual(signals[0], { pid: -FAKE_PID, signal: 'SIGKILL' }, 'the negative pid IS the group');
    assert.equal(ptyKills.length, 0, "node-pty's single-pid kill adds nothing over the group signal");
    await s._killReap;
  } finally { cleanup(s); }
});

test('_killReap off Windows stays pending until the group is actually gone', async () => {
  const signals: SignalCall[] = [];
  let living = true;
  const s = makePosixSession({ signals, alive: () => living });
  try {
    await s.start();
    s.kill();
    let settled = false;
    void s._killReap?.then(() => { settled = true; });
    await delay(500);
    assert.equal(settled, false, 'the group still answers signal 0, so the reap is not done');
    living = false;
    await s._killReap;
    assert.equal(settled, true, 'and it resolves once the probe reports ESRCH');
  } finally { cleanup(s); }
});

test('a reap of an already-dead group resolves without waiting out a poll interval', async () => {
  const signals: SignalCall[] = [];
  const s = makePosixSession({ signals });
  try {
    await s.start();
    s.kill();
    let settled = false;
    void s._killReap?.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, true, 'the respawn must not wait on a timer for a tree that is already gone');
    assert.equal(s._killReapTimer, null, 'and no poll timer was armed at all');
  } finally { cleanup(s); }
});

test('the liveness probe off Windows targets the process GROUP, not the leader pid', async () => {
  const signals: SignalCall[] = [];
  let living = true;
  const s = makePosixSession({ signals, alive: () => living });
  try {
    await s.start();
    s.kill();
    const probes = signals.filter((x) => x.signal === 0);
    assert.ok(probes.length > 0, 'the reap probed at least once');
    assert.deepEqual([...new Set(probes.map((x) => x.pid))], [-FAKE_PID], 'every probe is the negative pid');
    living = false;
    await s._killReap;
  } finally { cleanup(s); }
});

test('the liveness probe on win32 targets the pid, since a negative one is not signallable there', async () => {
  const signals: SignalCall[] = [];
  const s = new Session({
    id: 'win32-probe',
    name: 'win32-probe',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    platform: 'win32',
    ptySpawn: () => fakePty(),
    killProc: (_args, _opts, cb) => cb(null, '', ''),
    signalProc: (pid, signal) => { signals.push({ pid, signal }); },
  });
  try {
    await s.start();
    assert.equal(s._isProcessAlive(FAKE_PID), true);
    assert.deepEqual(signals, [{ pid: FAKE_PID, signal: 0 }]);
  } finally { cleanup(s); }
});

test('a pid below 2 is never signalled, in either direction', async () => {
  for (const pid of [0, 1, undefined, Number.NaN]) {
    const signals: SignalCall[] = [];
    const s = makePosixSession({ signals, ptySpawn: () => ({ ...fakePty(), pid: pid as number }) });
    try {
      await s.start();
      s.kill();
      await s._killReap;
      assert.deepEqual(signals, [], `pid ${String(pid)} must reach no signal at all`);
    } finally { cleanup(s); }
  }
});

test('a group that never dies costs the kill budget, then a force-kill, and never a rejection', async () => {
  const signals: SignalCall[] = [];
  const s = makePosixSession({ signals, alive: () => true });
  try {
    await s.start();
    const startedAt = Date.now();
    s.kill();
    await s._killReap;
    const reapMs = Date.now() - startedAt;
    assert.ok(reapMs < 3000, `the reap must settle inside the shutdown cap, took ${reapMs}ms`);
    assert.equal(groupKillsIn(signals).length, 1, 'so far only the kill() signal itself');
    await delay(3400 - reapMs);
    assert.equal(groupKillsIn(signals).length, 2, 'the force-kill escalation followed');
    assert.equal(signals.filter((x) => x.taskkill).length, 0, 'taskkill is a Windows tool');
  } finally { cleanup(s); }
});

test('_handlePtyExit reaps the dead child\'s group off Windows, and ESRCH is not an error', async () => {
  const signals: SignalCall[] = [];
  const s = makePosixSession({ signals });
  const errors: unknown[] = [];
  try {
    await s.start();
    s.on('error', (err) => errors.push(err));
    s.state = STATES.RUNNING;
    let exited = false;
    s.on('exit', () => { exited = true; });
    await s._handlePtyExit(0, null);
    assert.equal(exited, true);
    assert.deepEqual(groupKillsIn(signals), [{ pid: -FAKE_PID, signal: 'SIGKILL' }], 'orphan grandchildren reaped');
    assert.deepEqual(errors, [], 'an empty group is the ordinary case, not a failure');
  } finally { cleanup(s); }
});

test('start() with a live PTY kills the old group before spawning the new one', async () => {
  const signals: SignalCall[] = [];
  const pids = [4101, 4102];
  let spawned = 0;
  const s = makePosixSession({ signals, ptySpawn: () => fakePty(pids[spawned++]) });
  try {
    await s.start();
    await s.start();
    assert.ok(
      signals.some((x) => x.pid === -pids[0] && x.signal === 'SIGKILL'),
      'the previous tree is signalled, not left running beside the fresh spawn',
    );
    assert.equal(s.ptyProcess?.pid, pids[1]);
  } finally { cleanup(s); }
});

test('the win32 kill path is untouched: taskkill only, never a group signal', async () => {
  const signals: SignalCall[] = [];
  const s = new Session({
    id: 'win32-untouched',
    name: 'win32-untouched',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    platform: 'win32',
    ptySpawn: () => fakePty(),
    killProc: (args, _opts, cb) => { signals.push({ taskkill: args }); cb(null, '', ''); },
    signalProc: (pid, signal) => { signals.push({ pid, signal }); },
  });
  try {
    await s.start();
    s.kill();
    await s._killReap;
    assert.deepEqual(signals, [{ taskkill: ['/PID', String(FAKE_PID), '/T', '/F'] }]);
  } finally { cleanup(s); }
});


test('a POSIX spawn adds exactly ONE error listener, which is what stops the rethrow', async () => {
  const signals: SignalCall[] = [];
  const pty = fakeUnixPty();
  const before = pty.listeners('error').length;
  const s = makePosixSession({ signals, ptySpawn: () => pty });
  try {
    await s.start();
    assert.equal(before, 1, "node-pty's own handler is already listener #1");
    assert.equal(pty.listeners('error').length, 2, 'below two it rethrows; above two is a double fire');
  } finally { cleanup(s); }
});

test('one fatal socket error runs the handler exactly once', async () => {
  const signals: SignalCall[] = [];
  const pty = fakeUnixPty();
  const s = makePosixSession({ signals, ptySpawn: () => pty });
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (line: string) => { warnings.push(line); };
  try {
    await s.start();
    pty._socket.emit('error', Object.assign(new Error('read EBADF'), { code: 'EBADF' }));
    assert.equal(warnings.filter((line) => line.includes('pty socket error')).length, 1);
    await s._killReap;
  } finally { console.warn = realWarn; cleanup(s); }
});

test('a fatal pty socket error kills the session instead of the server', async () => {
  const signals: SignalCall[] = [];
  const pty = fakeUnixPty();
  const s = makePosixSession({ signals, ptySpawn: () => pty });
  try {
    await s.start();
    pty._socket.emit('error', Object.assign(new Error('read EBADF'), { code: 'EBADF' }));
    assert.deepEqual(groupKillsIn(signals), [{ pid: -FAKE_PID, signal: 'SIGKILL' }]);
    assert.equal(s._ptyAlive, false, 'the session stops writing to a pty that is gone');
    await s._killReap;
  } finally { cleanup(s); }
});

test('EAGAIN and EIO on the pty socket are node-pty noise, not a session failure', async () => {
  const signals: SignalCall[] = [];
  const pty = fakeUnixPty();
  const s = makePosixSession({ signals, ptySpawn: () => pty });
  try {
    await s.start();
    pty._socket.emit('error', Object.assign(new Error('read EAGAIN'), { code: 'EAGAIN' }));
    pty._socket.emit('error', Object.assign(new Error('read EIO'), { code: 'EIO' }));
    assert.deepEqual(signals, [], 'the startup noise and the child closing the pty both stay quiet');
    assert.equal(s._ptyAlive, true);
  } finally { cleanup(s); }
});

test('the win32 spawn attaches no pty error listeners (its ConPTY guard is the input socket)', async () => {
  const pty = fakeUnixPty();
  const s = new Session({
    id: 'win32-pty-guard',
    name: 'win32-pty-guard',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    platform: 'win32',
    ptySpawn: () => pty,
    killProc: (_args, _opts, cb) => cb(null, '', ''),
  });
  try {
    await s.start();
    assert.equal(pty.listeners('error').length, 1, "only node-pty's own handler, nothing added by us");
  } finally { cleanup(s); }
});
