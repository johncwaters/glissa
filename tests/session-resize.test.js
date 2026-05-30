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

const { Session } = require('../sessions');
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

function startedSession(resizes) {
  const s = new Session({
    id: 'resize-test',
    name: 'resize-test',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(resizes),
  });
  s.start(); // assigns this.ptyProcess synchronously
  return s;
}

// The three states that used to defer the resize, plus RUNNING as the control.
for (const state of [STATES.WAITING, STATES.IDLE, STATES.COMPLETE, STATES.RUNNING]) {
  test(`resize() reaches the PTY immediately while ${state}`, () => {
    const resizes = [];
    const s = startedSession(resizes);
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
