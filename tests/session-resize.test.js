'use strict';

// Regression: Session.resize() must apply to the PTY immediately, including the
// quiescent states (WAITING / IDLE / COMPLETE). A now-removed deferral used to
// stash the resize in _pendingResize and only flush it on the next RUNNING
// transition — so minimizing a sibling card resized the browser xterm but did
// NOT SIGWINCH Claude, which then reflowed only "after a message input"
// (the WAITING -> RUNNING transition that flushed the deferral).
//
// A fake PTY records resize() calls; ptySpawn is injected so no real process
// launches. The .exe spawn form is irrelevant here (resize is post-spawn), so
// these run cross-platform.

const test = require('node:test');
const assert = require('node:assert/strict');

const { Session } = require('../session/sessions');
const { STATES } = require('../shared/states');

function fakePty(resizes) {
  return {
    // Non-existent pid keeps destroy()'s taskkill a harmless no-op.
    pid: 2147483646,
    onData() {},
    onExit() {},
    write() {},
    resize(cols, rows) { resizes.push({ cols, rows }); },
    kill() {},
  };
}

async function startedSession(resizes) {
  const s = new Session({
    id: 'resize-test',
    name: 'resize-test',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(resizes),
  });
  await s.start(); // start() is async (worktree provision await); awaiting assigns this.ptyProcess
  return s;
}

// The three states that used to defer the resize, plus RUNNING as the control.
for (const state of [STATES.WAITING, STATES.IDLE, STATES.COMPLETE, STATES.RUNNING]) {
  test(`resize() reaches the PTY immediately while ${state}`, async () => {
    const resizes = [];
    const s = await startedSession(resizes);
    try {
      s.state = state;
      resizes.length = 0; // isolate from any resize during start()
      s.resize(120, 40);
      assert.deepEqual(resizes, [{ cols: 120, rows: 40 }],
        `expected immediate pty.resize(120, 40) while ${state}, got ${JSON.stringify(resizes)}`);
    } finally {
      s.destroy();
    }
  });
}

// Regression: a restarted PTY must respawn at the last browser-pushed size, not
// the 80x24 default. Otherwise Claude initializes its TUI at 80x24 and renders
// cramped, since the lone post-reconnect resize races startup and is never
// retried once the browser-side fit cache matches.
test('restart respawns the PTY at the last resized dimensions', async () => {
  const spawnOpts = [];
  const s = new Session({
    id: 'respawn-size-test',
    name: 'respawn-size-test',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (_file, _args, opts) => {
      spawnOpts.push({ cols: opts.cols, rows: opts.rows });
      return fakePty([]);
    },
    // Restart funnels through start()'s prior-PTY kill, now an AWAITED async taskkill; the fake resolves
    // immediately so the awaited reap does not spawn a real taskkill and the respawn lands on the next tick.
    killProc: (_args, _opts, cb) => cb(null, '', ''),
  });
  try {
    await s.start(); // first spawn: no size known yet -> 80x24 default
    assert.deepEqual(spawnOpts.at(-1), { cols: 80, rows: 24 },
      'first spawn should use the 80x24 default');

    s.resize(120, 40);

    // restart() only fires from DONE/FAILED. It calls the async start() fire-and-forget, and start()
    // awaits the prior-PTY reap then provision before spawning, so yield twice for the respawn to land.
    s.state = STATES.DONE;
    s.restart();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(spawnOpts.at(-1), { cols: 120, rows: 40 },
      'restart should respawn at the last resized size, not 80x24');
  } finally {
    s.destroy();
  }
});
