'use strict';

// Item 2: the taskkill sites in sessions.js are async execFile via an injected killer seam (killProc),
// mirroring the spawnCommand/ptySpawn injection. These tests assert the kill is invoked with the array
// args (['/PID', pid, '/T', '/F']) without spawning a real process, that kill() flips _ptyAlive BEFORE
// invoking the killer (the synchronous ordering the write-guard relies on), that the _handlePtyExit reap
// is fire-and-forget (does not delay the exit emit), and that the force-kill timeout branch fires once.
// Windows-only paths are exercised by forcing process.platform to 'win32' so the assertions run anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { Session } = require('../session/sessions');
const { STATES } = require('../shared/states.ts');

const FAKE_PID = 2147483646;

function fakePty(pid = FAKE_PID) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

/*
 * Models node-pty 1.1.0's real shape, which the guard depends on: Terminal.on and Terminal.listeners do
 * NOT use the terminal's own emitter, they delegate to the pty SOCKET (terminal.js), and the unix
 * backend registers its own 'error' handler on that socket at construction. So node-pty's handler is
 * always listener #1, and the `listeners('error').length < 2` rethrow test it applies to itself is
 * satisfied by exactly one listener of ours. A fake with two independent emitters hid all of that.
 */
function fakeUnixPty(pid = FAKE_PID) {
  const socket = new EventEmitter();
  socket.on('error', () => { /* node-pty's own handler, the one that would rethrow */ });
  return {
    pid,
    _socket: socket,
    onData() {}, onExit() {}, write() {}, resize() {}, kill() {},
    on: (event, listener) => socket.on(event, listener),
    listeners: (event) => socket.listeners(event),
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * A session pinned to a POSIX platform with both process seams faked, so a test asserts the SIGNALS
 * rather than delivering them: nothing here ever reaches a real process group. `alive` decides what the
 * liveness probe (and a group kill) sees; the default is "already gone", which answers ESRCH the way a
 * dead group does.
 */
function makePosixSession({ signals, alive = () => false, ptySpawn, pid = FAKE_PID }) {
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
      const err = new Error('ESRCH');
      err.code = 'ESRCH';
      throw err;
    },
  });
}

const groupKillsIn = (signals) => signals.filter((s) => s.pid === -FAKE_PID && s.signal === 'SIGKILL');

function cleanup(session) {
  session._killPollTimer && clearTimeout(session._killPollTimer);
  session._killReapTimer && clearTimeout(session._killReapTimer);
  session.destroy();
  session._killPollTimer && clearTimeout(session._killPollTimer);
  session._killReapTimer && clearTimeout(session._killReapTimer);
}

// Run `fn` with process.platform pinned to 'win32', then restore it. The kill sites branch on platform;
// pinning win32 makes the taskkill path run on any host CI.
async function asWin32(fn) {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try { return await fn(); }
  finally { Object.defineProperty(process, 'platform', orig); }
}

function makeSession(killCalls, ptySpawn) {
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
    const killCalls = [];
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
    let aliveAtKill = null;
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
    const signals = [];
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
    const killCalls = [];
    let resolveKill;
    const s = new Session({
      id: 'killproc-reap',
      name: 'killproc-reap',
      path: process.cwd(),
      spawnCommand: { path: process.execPath, kind: 'exe' },
      ptySpawn: () => fakePty(),
      // Hold the killer's callback open: a fire-and-forget reap must NOT block the exit emit on it.
      killProc: (args, _opts, cb) => { killCalls.push(args); resolveKill = () => cb(null, '', ''); },
    });
    try {
      await s.start();
      s.state = STATES.RUNNING;
      let exited = false;
      s.on('exit', () => { exited = true; });
      await s._handlePtyExit(0, null); // the reap killer is still pending (callback held)
      assert.equal(exited, true, 'exit emitted without waiting on the held reap');
      assert.equal(killCalls.length, 1, 'the orphan reap was issued');
      resolveKill(); // drain the held callback so no dangling handle remains
    } finally { s._killPollTimer && clearTimeout(s._killPollTimer); s.destroy(); }
  });
});

test('_forceKillAfterTimeout fires the killer once when the process outlives the budget', async () => {
  await asWin32(async () => {
    const killCalls = [];
    // A pid that is ALWAYS alive (process.kill(pid,0) succeeds): this process's own pid. The poll then
    // runs to the budget and fires the force-kill killer exactly once.
    const livePid = process.pid;
    const s = new Session({
      id: 'killproc-force',
      name: 'killproc-force',
      path: process.cwd(),
      spawnCommand: { path: process.execPath, kind: 'exe' },
      ptySpawn: () => fakePty(livePid),
      killProc: (args, _opts, cb) => { killCalls.push(args); cb(null, '', ''); },
    });
    try {
      await s.start();
      s.kill(); // fires the immediate kill (1 call) + schedules the force-kill poll
      const immediate = killCalls.length; // the kill()'s own taskkill
      // Wait past KILL_MAX_WAIT_MS (3s) for the poll to reach the terminal force-kill branch.
      await new Promise((r) => setTimeout(r, 3500));
      assert.equal(killCalls.length, immediate + 1, 'force-kill fired exactly once after the budget');
      assert.deepEqual(killCalls.at(-1), ['/PID', String(livePid), '/T', '/F']);
    } finally { s._killPollTimer && clearTimeout(s._killPollTimer); s.destroy(); }
  });
});

// The server lifecycle (restart/shutdown) awaits each session's reap before exit/respawn so the PTY
// tree is not orphaned. kill() exposes that reap as an awaitable _killReap.
test('kill() exposes an awaitable _killReap that settles when the win32 killer completes', async () => {
  await asWin32(async () => {
    const killCalls = [];
    const s = makeSession(killCalls); // injected killProc calls cb(null) -> the reap resolves
    try {
      await s.start();
      s.kill();
      assert.ok(s._killReap && typeof s._killReap.then === 'function', '_killReap is a promise');
      await s._killReap;
    } finally { s._killPollTimer && clearTimeout(s._killPollTimer); s.destroy(); }
  });
});

// --- POSIX: the process GROUP is the unit of a kill, and the reap is a real wait ---
//
// node-pty setsid()s its unix child, so the child's pgid is its pid and one signal to the negative pid
// reaches the whole tree. Its own ptyProcess.kill() is a single-pid SIGHUP, which orphans every
// background bash task, MCP server and teammate under the session.

test('kill() off Windows signals the whole process group, not just the pty child', async () => {
  const signals = [];
  const ptyKills = [];
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

// Every contract built on _killReap (restart before respawn, the shutdown coordinator, the ephemeral
// lanes' worktree discard) was vacuous off Windows while this was Promise.resolve().
test('_killReap off Windows stays pending until the group is actually gone', async () => {
  const signals = [];
  let living = true;
  const s = makePosixSession({ signals, alive: () => living });
  try {
    await s.start();
    s.kill();
    let settled = false;
    void s._killReap.then(() => { settled = true; });
    await delay(500);
    assert.equal(settled, false, 'the group still answers signal 0, so the reap is not done');
    living = false;
    await s._killReap;
    assert.equal(settled, true, 'and it resolves once the probe reports ESRCH');
  } finally { cleanup(s); }
});

// Regression (found on the ubuntu CI leg): the reap used to wait out a poll interval BEFORE its first
// look, so a restart of a DONE session, whose tree is always already gone, paid 200ms of dead time and
// the respawn landed later than the win32 path's. Two restart fixtures assert on the respawn after a
// couple of turns and went red on Linux only.
test('a reap of an already-dead group resolves without waiting out a poll interval', async () => {
  const signals = [];
  const s = makePosixSession({ signals });
  try {
    await s.start();
    s.kill();
    let settled = false;
    void s._killReap.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, true, 'the respawn must not wait on a timer for a tree that is already gone');
    assert.equal(s._killReapTimer, null, 'and no poll timer was armed at all');
  } finally { cleanup(s); }
});

// The reap's contract is the TREE, and node-pty's waitpid thread reaps the leader promptly, so a
// probe of the LEADER pid reports gone while background bash tasks and MCP servers under it still
// hold handles in the worktree the ephemeral lanes are about to discard. The probe is the group too.
test('the liveness probe off Windows targets the process GROUP, not the leader pid', async () => {
  const signals = [];
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

// Windows has no process groups: taskkill /T is what covers the tree there, so the probe stays the pid.
test('the liveness probe on win32 targets the pid, since a negative one is not signallable there', async () => {
  const signals = [];
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

// Negated, pid 0 is our OWN process group and pid 1 is every process this user can signal, so a pty
// object with a missing or absurd pid must reach neither.
test('a pid below 2 is never signalled, in either direction', async () => {
  for (const pid of [0, 1, undefined, Number.NaN]) {
    const signals = [];
    // Spread, not fakePty(pid): its default parameter would turn an undefined pid back into a real one.
    const s = makePosixSession({ signals, ptySpawn: () => ({ ...fakePty(), pid }) });
    try {
      await s.start();
      s.kill();
      await s._killReap;
      assert.deepEqual(signals, [], `pid ${String(pid)} must reach no signal at all`);
    } finally { cleanup(s); }
  }
});

// A zombie keeps answering signal 0 until node-pty waitpid()s it, so the wait must be bounded: an
// awaiter blocked forever would hang a shutdown.
test('a group that never dies costs the kill budget, then a force-kill, and never a rejection', async () => {
  const signals = [];
  const s = makePosixSession({ signals, alive: () => true });
  try {
    await s.start();
    const startedAt = Date.now();
    s.kill();
    await s._killReap; // resolves on its own budget, does not reject
    const reapMs = Date.now() - startedAt;
    // The reap budget is deliberately SHORTER than the shutdown coordinator's cap (server-lifecycle.js
    // awaitTeardown, 3000ms), or a reap could overrun the bound it exists to settle inside.
    assert.ok(reapMs < 3000, `the reap must settle inside the shutdown cap, took ${reapMs}ms`);
    assert.equal(groupKillsIn(signals).length, 1, 'so far only the kill() signal itself');
    await delay(3400 - reapMs); // past the force-kill's own, longer budget
    assert.equal(groupKillsIn(signals).length, 2, 'the force-kill escalation followed');
    assert.equal(signals.filter((x) => x.taskkill).length, 0, 'taskkill is a Windows tool');
  } finally { cleanup(s); }
});

test('_handlePtyExit reaps the dead child\'s group off Windows, and ESRCH is not an error', async () => {
  const signals = [];
  const s = makePosixSession({ signals });
  const errors = [];
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
  const signals = [];
  const pids = [4101, 4102];
  let spawned = 0;
  const s = makePosixSession({ signals, ptySpawn: () => fakePty(pids[spawned++]) });
  try {
    await s.start();
    await s.start(); // the guard sees a live PTY and must reap it first
    assert.ok(
      signals.some((x) => x.pid === -pids[0] && x.signal === 'SIGKILL'),
      'the previous tree is signalled, not left running beside the fresh spawn',
    );
    assert.equal(s.ptyProcess.pid, pids[1]);
  } finally { cleanup(s); }
});

// Windows keeps taskkill and nothing else: no signal seam call may reach a process group there.
test('the win32 kill path is untouched: taskkill only, never a group signal', async () => {
  const signals = [];
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

// --- the unix pty socket guard ---
//
// node-pty's unix backend rethrows an unexpected pty socket error out of its own handler unless the
// terminal carries at least TWO 'error' listeners (unixTerminal.js: `listeners('error').length < 2`),
// and it never emits that event itself. With no uncaughtException handler here, one read error on one
// session took the whole server down.

test('a POSIX spawn adds exactly ONE error listener, which is what stops the rethrow', async () => {
  const signals = [];
  const pty = fakeUnixPty();
  const before = pty.listeners('error').length;
  const s = makePosixSession({ signals, ptySpawn: () => pty });
  try {
    await s.start();
    assert.equal(before, 1, "node-pty's own handler is already listener #1");
    assert.equal(pty.listeners('error').length, 2, 'below two it rethrows; above two is a double fire');
  } finally { cleanup(s); }
});

// Registering on both the terminal and its socket looked like belt and braces, but they are the SAME
// emitter, so the handler ran twice for one error.
test('one fatal socket error runs the handler exactly once', async () => {
  const signals = [];
  const pty = fakeUnixPty();
  const s = makePosixSession({ signals, ptySpawn: () => pty });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (line) => warnings.push(line);
  try {
    await s.start();
    pty._socket.emit('error', Object.assign(new Error('read EBADF'), { code: 'EBADF' }));
    assert.equal(warnings.filter((line) => line.includes('pty socket error')).length, 1);
    await s._killReap;
  } finally { console.warn = realWarn; cleanup(s); }
});

test('a fatal pty socket error kills the session instead of the server', async () => {
  const signals = [];
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
  const signals = [];
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
