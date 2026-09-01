
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
function makeSession(writes: string[]) {
  return new Session({
    id: 'write-guard-test',
    name: 'write-guard-test',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => ({
      pid: 2147483646,
      onData() {},
      onExit() {},
      write(d: string) { writes.push(d); },
      resize() {},
      kill() {},
    }),
  });
}

test('write() reaches a live pty, then stops after kill()', async () => {
  const writes: string[] = [];
  const s = makeSession(writes);
  try {
    await s.start();
    s.write('before');
    assert.deepEqual(writes, ['before'], 'a live pty should receive writes');

    s.kill();
    s.write('after');
    assert.deepEqual(writes, ['before'],
      'a killed pty must not receive further writes (would EAGAIN on a dead pipe)');
  } finally {
    s.destroy();
  }
});

test('write() is a no-op before the pty is ever spawned', () => {
  const writes: string[] = [];
  const s = makeSession(writes);
  try {
    s.write('never');
    assert.deepEqual(writes, [], 'write before spawn must not throw or reach a pty');
  } finally {
    s.destroy();
  }
});
