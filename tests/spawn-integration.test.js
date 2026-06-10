'use strict';

// Integration test: Session.start() wires buildSpawnCommand's {file, args} into the
// PTY spawner correctly. A fake spawner is injected so we assert the real start()
// path deterministically WITHOUT launching node/claude (which would keep the PTY
// alive and hang the test runner). The .exe-direct decision is Windows-specific, so
// these are gated to win32; the cross-platform builder logic is covered by
// tests/spawn-command.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { Session } = require('../sessions');
const { STATES } = require('../shared/states');

// Stub PTY handle. A non-existent pid keeps Session.kill()'s taskkill a harmless no-op.
function fakePty(pid = 2147483646) {
  return {
    pid,
    onData() {},
    onExit() {},
    write() {},
    resize() {},
    kill() {},
  };
}

test('start() spawns the injected exe directly (no cmd.exe layer)', { skip: process.platform !== 'win32' }, () => {
  const calls = [];
  const s = new Session({
    id: 'spawn-int',
    name: 'spawn-int',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
  });
  try {
    s.start();
    assert.equal(calls.length, 1, 'pty spawner called exactly once');
    assert.equal(calls[0].file, process.execPath, 'spawned the injected exe path');
    assert.notEqual(calls[0].file, 'cmd.exe');
    assert.ok(!calls[0].args.includes('/c'), 'no cmd /c token in args');
    assert.equal(s.state, STATES.STARTING, `expected STARTING after spawn, got ${s.state}`);
  } finally {
    s.destroy();
  }
});

test('start() injects ANTHROPIC_BASE_URL from getProxyBaseUrl into the PTY env', { skip: process.platform !== 'win32' }, () => {
  const calls = [];
  const s = new Session({
    id: 'spawn-proxy',
    name: 'spawn-proxy',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    getProxyBaseUrl: () => 'http://127.0.0.1:8787',
    ptySpawn: (file, args, opts) => { calls.push({ file, args, opts }); return fakePty(); },
  });
  try {
    s.start();
    assert.equal(calls.length, 1, 'pty spawner called exactly once');
    assert.equal(calls[0].opts.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787');
  } finally {
    s.destroy();
  }
});

test('start() survives a throwing getProxyBaseUrl (spawns without the proxy var)', { skip: process.platform !== 'win32' }, () => {
  // The spawn env starts from process.env; park any user-level ANTHROPIC_BASE_URL so the
  // absence assertion below tests OUR injection, not the host machine's environment.
  const inherited = process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;
  const calls = [];
  const s = new Session({
    id: 'spawn-proxy-throw',
    name: 'spawn-proxy-throw',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    getProxyBaseUrl: () => { throw new Error('boom'); },
    ptySpawn: (file, args, opts) => { calls.push({ file, args, opts }); return fakePty(); },
  });
  try {
    s.start();
    assert.equal(calls.length, 1, 'spawn still happens');
    assert.ok(!('ANTHROPIC_BASE_URL' in calls[0].opts.env), 'no proxy var on getter failure');
    assert.equal(s.state, STATES.STARTING);
  } finally {
    s.destroy();
    if (inherited !== undefined) process.env.ANTHROPIC_BASE_URL = inherited;
  }
});

test('start() routes a .cmd shim command through cmd.exe /c claude', { skip: process.platform !== 'win32' }, () => {
  const calls = [];
  const s = new Session({
    id: 'spawn-shim',
    name: 'spawn-shim',
    path: process.cwd(),
    spawnCommand: { path: 'C:\\nope\\claude.cmd', kind: 'shim' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
  });
  try {
    s.start();
    assert.equal(calls.length, 1, 'pty spawner called exactly once');
    assert.equal(calls[0].file, 'cmd.exe', 'shim install routes through cmd.exe');
    assert.deepEqual(calls[0].args.slice(0, 2), ['/c', 'claude']);
  } finally {
    s.destroy();
  }
});
