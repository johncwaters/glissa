'use strict';

// Item 2: the taskkill sites in sessions.js are async execFile via an injected killer seam (killProc),
// mirroring the spawnCommand/ptySpawn injection. These tests assert the kill is invoked with the array
// args (['/PID', pid, '/T', '/F']) without spawning a real process, that kill() flips _ptyAlive BEFORE
// invoking the killer (the synchronous ordering the write-guard relies on), that the _handlePtyExit reap
// is fire-and-forget (does not delay the exit emit), and that the force-kill timeout branch fires once.
// Windows-only paths are exercised by forcing process.platform to 'win32' so the assertions run anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');

const { Session } = require('../sessions');
const { STATES } = require('../shared/states');

const FAKE_PID = 2147483646;

function fakePty(pid = FAKE_PID) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
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
