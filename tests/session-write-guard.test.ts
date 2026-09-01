// Regression: Session.write() must not push input into a pty that has been
// killed or has exited. node-pty (1.1.0) attaches an 'error' handler to the
// conout socket only, never to the conin socket it writes to. A write that
// lands after the child's console pipe has died (e.g. our taskkill on restart,
// before node-pty's exit callback fires) surfaces asynchronously as
// `write EAGAIN` on that unguarded socket and crashes the whole server. The
// _ptyAlive guard in write() closes the common window.
//
// A fake PTY records write() calls; ptySpawn is injected so no real process
// launches. The .exe spawn form is irrelevant here, so these run cross-platform.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
function makeSession(writes: string[]) {
  return new Session({
    id: 'write-guard-test',
    name: 'write-guard-test',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    // Non-existent pid keeps kill()/destroy()'s taskkill a harmless no-op.
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
    await s.start(); // start() is async; awaiting spawns -> _ptyAlive = true
    s.write('before');
    assert.deepEqual(writes, ['before'], 'a live pty should receive writes');

    s.kill(); // flips _ptyAlive false; conin peer is now dead
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
    s.write('never'); // DORMANT, no pty yet
    assert.deepEqual(writes, [], 'write before spawn must not throw or reach a pty');
  } finally {
    s.destroy();
  }
});
