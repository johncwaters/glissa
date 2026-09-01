import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';

interface ArgvCall {
  file: string;
  args: string[];
}

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
  const calls: ArgvCall[] = [];
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
  const calls: ArgvCall[] = [];
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
