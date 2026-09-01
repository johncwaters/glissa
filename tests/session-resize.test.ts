
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import { waitFor } from './helpers/wait-for.ts';
interface ResizeCall {
  cols: number;
  rows: number;
}

function fakePty(resizes: ResizeCall[]) {
  return {
    pid: 2147483646,
    onData() {},
    onExit() {},
    write() {},
    resize(cols: number, rows: number) { resizes.push({ cols, rows }); },
    kill() {},
  };
}


async function startedSession(resizes: ResizeCall[]) {
  const s = new Session({
    id: 'resize-test',
    name: 'resize-test',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(resizes),
  });
  await s.start();
  return s;
}

for (const state of [STATES.WAITING, STATES.IDLE, STATES.COMPLETE, STATES.RUNNING]) {
  test(`resize() reaches the PTY immediately while ${state}`, async () => {
    const resizes: ResizeCall[] = [];
    const s = await startedSession(resizes);
    try {
      s.state = state;
      resizes.length = 0;
      s.resize(120, 40);
      assert.deepEqual(resizes, [{ cols: 120, rows: 40 }],
        `expected immediate pty.resize(120, 40) while ${state}, got ${JSON.stringify(resizes)}`);
    } finally {
      s.destroy();
    }
  });
}

test('resize() leaves the PTY alone when the dimensions are unchanged', async () => {
  const resizes: ResizeCall[] = [];
  const s = await startedSession(resizes);
  try {
    s.resize(120, 40);
    resizes.length = 0;

    s.resize(120, 40);

    assert.deepEqual(resizes, []);
  } finally {
    s.destroy();
  }
});

test('restart respawns the PTY at the last resized dimensions', async () => {
  const spawnOpts: ResizeCall[] = [];
  const s = new Session({
    id: 'respawn-size-test',
    name: 'respawn-size-test',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (_file, _args, opts) => {
      spawnOpts.push({ cols: opts.cols ?? 0, rows: opts.rows ?? 0 });
      return fakePty([]);
    },
    killProc: (_args, _opts, cb) => cb(null, '', ''),
  });
  try {
    await s.start();
    assert.deepEqual(spawnOpts.at(-1), { cols: 80, rows: 24 },
      'first spawn should use the 80x24 default');

    s.resize(120, 40);

    s.state = STATES.DONE;
    s.restart();
    await waitFor(() => spawnOpts.length === 2);
    assert.deepEqual(spawnOpts.at(-1), { cols: 120, rows: 40 },
      'restart should respawn at the last resized size, not 80x24');
  } finally {
    s.destroy();
  }
});
