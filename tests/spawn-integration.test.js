'use strict';

// Integration test: Session.start() wires buildSpawnCommand's {file, args} into the
// PTY spawner correctly. A fake spawner is injected so we assert the real start()
// path deterministically WITHOUT launching node/claude (which would keep the PTY
// alive and hang the test runner). The .exe-direct decision is Windows-specific, so
// these are gated to win32; the cross-platform builder logic is covered by
// tests/spawn-command.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { Session } = require('../session/sessions');
const { STATES } = require('../shared/states.ts');

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

test('start() spawns the injected exe directly (no cmd.exe layer)', { skip: process.platform !== 'win32' }, async () => {
  const calls = [];
  const s = new Session({
    id: 'spawn-int',
    name: 'spawn-int',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
  });
  try {
    await s.start();
    assert.equal(calls.length, 1, 'pty spawner called exactly once');
    assert.equal(calls[0].file, process.execPath, 'spawned the injected exe path');
    assert.notEqual(calls[0].file, 'cmd.exe');
    assert.ok(!calls[0].args.includes('/c'), 'no cmd /c token in args');
    assert.equal(s.state, STATES.STARTING, `expected STARTING after spawn, got ${s.state}`);
  } finally {
    s.destroy();
  }
});

test('start() routes a .cmd shim command through cmd.exe /c claude', { skip: process.platform !== 'win32' }, async () => {
  const calls = [];
  const s = new Session({
    id: 'spawn-shim',
    name: 'spawn-shim',
    path: process.cwd(),
    spawnCommand: { path: 'C:\\nope\\claude.cmd', kind: 'shim' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
  });
  try {
    await s.start();
    assert.equal(calls.length, 1, 'pty spawner called exactly once');
    assert.equal(calls[0].file, 'cmd.exe', 'shim install routes through cmd.exe');
    assert.deepEqual(calls[0].args.slice(0, 2), ['/c', 'claude']);
  } finally {
    s.destroy();
  }
});
