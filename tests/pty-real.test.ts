// Every other PTY test injects a hand-written fake through the ptySpawn seam, so nothing proved the
// fakes still describe node-pty. These spawn the real module: the socket-delegation contract that
// _guardUnixPtySocket depends on (unixTerminal.js rethrows an 'error' when listeners('error').length
// is under 2, which once took the whole server down), plus a live child driven through Session.

import test from 'node:test';
import assert from 'node:assert/strict';
import pty from 'node-pty';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
// node-pty's unix backend delegates on()/listeners() to the pty socket; the guard under test needs both.
type UnixPty = pty.IPty & {
  on(event: string, listener: (error: Error) => void): unknown;
  listeners(event: string): unknown[];
  _socket: { listeners(event: string): unknown[] };
};

const isWindows = process.platform === 'win32';
const shell = isWindows ? 'cmd.exe' : '/bin/sh';
const shellArgs = (script: string) => (isWindows ? ['/c', script] : ['-c', script]);

function spawnReal(script: string) {
  return pty.spawn(shell, shellArgs(script), {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  });
}

const nextTickDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await nextTickDelay(20);
  }
  return false;
}

function makeRealSession({ script, id = 'pty-real' }: { script: string; id?: string }) {
  const spawned: UnixPty[] = [];
  const session = new Session({
    id,
    name: id,
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (_file, _args, options) => {
      const terminal = pty.spawn(shell, shellArgs(script), options) as UnixPty;
      spawned.push(terminal);
      return terminal;
    },
  });
  return { session, spawned };
}

test('a real node-pty terminal exposes the surface every fake in this suite models', () => {
  const terminal = spawnReal('exit 0');
  try {
    for (const member of ['pid', 'onData', 'onExit', 'write', 'resize', 'kill']) {
      assert.ok(member in terminal, `node-pty terminal is missing ${member}`);
    }
    assert.equal(typeof terminal.pid, 'number');
  } finally {
    terminal.kill();
  }
});

test('node-pty delegates on/listeners to its own socket, not to a second emitter', { skip: isWindows }, () => {
  const terminal = spawnReal('sleep 30') as UnixPty;
  try {
    assert.equal(terminal.listeners('error').length, 1,
      "node-pty's own handler must be listener #1, which is what the < 2 rethrow test counts");
    terminal.on('error', () => {});
    assert.equal(terminal.listeners('error').length, 2);
    assert.equal(terminal._socket.listeners('error').length, 2,
      'on() must reach the pty socket, or the guard registers on an emitter node-pty never consults');
  } finally {
    terminal.kill();
  }
});

test('Session guards a real unix pty socket past the rethrow threshold', { skip: isWindows }, async () => {
  const { session, spawned } = makeRealSession({ script: 'sleep 30', id: 'pty-real-guard' });
  try {
    await session.start();
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].listeners('error').length, 2,
      'node-pty rethrows out of its own handler while it is the only listener');
  } finally {
    session.kill();
    session.destroy();
  }
});

test('Session carries real pty output and a real exit code through its events', async () => {
  const { session } = makeRealSession({ script: 'echo glissa-pty-marker; exit 7', id: 'pty-real-exit' });
  let output = '';
  const exits: Record<string, unknown>[] = [];
  session.on('data', (chunk) => { output += chunk; });
  session.on('exit', (detail) => exits.push(detail));
  try {
    await session.start();
    assert.ok(await waitFor(() => exits.length > 0), 'real pty never reported exit');
    assert.match(output, /glissa-pty-marker/);
    assert.equal(exits[0].exitCode, 7);
    assert.equal(session.state, STATES.FAILED);
  } finally {
    session.destroy();
  }
});

test('write() reaches a real pty child', async () => {
  const script = isWindows ? 'set /p LINE= && echo got-%LINE%' : 'read line; echo got-$line';
  const { session } = makeRealSession({ script, id: 'pty-real-write' });
  let output = '';
  session.on('data', (chunk) => { output += chunk; });
  try {
    await session.start();
    await waitFor(() => output.length > 0, 2000);
    session.write('ping\r');
    assert.ok(await waitFor(() => /got-ping/.test(output)), `child never echoed the write: ${JSON.stringify(output)}`);
  } finally {
    session.kill();
    session.destroy();
  }
});

test('kill() takes down a real pty process group, not just the direct child', { skip: isWindows }, async () => {
  const { session, spawned } = makeRealSession({ script: 'sleep 30 & sleep 30', id: 'pty-real-kill' });
  const exits: Record<string, unknown>[] = [];
  session.on('exit', (detail) => exits.push(detail));
  try {
    await session.start();
    const groupPid = spawned[0].pid;
    session.kill();
    assert.ok(await waitFor(() => exits.length > 0), 'killed pty never reported exit');
    assert.ok(await waitFor(() => {
      try {
        process.kill(-groupPid, 0);
        return false;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }), 'process group survived kill()');
  } finally {
    session._killPollTimer && clearTimeout(session._killPollTimer);
    session._killReapTimer && clearTimeout(session._killReapTimer);
    session.destroy();
  }
});
