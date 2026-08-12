'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// radar-hold-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/radar-hold-core.mjs');

// Fake clock: timers fire only when the test advances it, so a whole interleaving runs synchronously
// and no test waits out a real 4 second hold.
function fakeClock() {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, delayMs) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, at: nowMs + delayMs });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      nowMs += ms;
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= nowMs)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        if (!timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    armed() {
      return timers.size;
    },
  };
}

async function makeHold(holdMs = 4000) {
  const { createRenderHold } = await importCore();
  const clock = fakeClock();
  const renders = [];
  const hold = createRenderHold({
    render: () => renders.push(renders.length + 1),
    holdMs,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { hold, clock, renders };
}

test('an idle board repaints straight through', async () => {
  const { hold, renders } = await makeHold();
  hold.request();
  hold.request();
  assert.equal(renders.length, 2);
});

test('the archive ordering: broadcast lands BEFORE the reply, and the row repaints one window later', async () => {
  const { hold, clock, renders } = await makeHold();
  // The operator clicks Archive.
  hold.begin('archive:iss-1@100');
  // The server rebroadcasts the new board BEFORE it replies to the request that caused it.
  hold.request();
  assert.equal(renders.length, 0, 'held: repainting now would wipe the in-flight row');
  // The reply lands and the outcome line is written.
  hold.settle('archive:iss-1@100');
  assert.equal(renders.length, 0, 'the outcome line is still being read');

  clock.advance(3999);
  assert.equal(renders.length, 0);
  clock.advance(1);
  assert.equal(renders.length, 1, 'the held board repaints once the outcome has been readable');
  assert.deepEqual(hold._state(), { pending: 0, held: false, armed: false });
});

test('the reverse ordering: reply first, broadcast inside the window, still exactly one repaint', async () => {
  const { hold, clock, renders } = await makeHold();
  hold.begin('archive:iss-1@100');
  hold.settle('archive:iss-1@100');
  clock.advance(1000);
  hold.request();
  assert.equal(renders.length, 0, 'held so the outcome line survives');
  clock.advance(3000);
  assert.equal(renders.length, 1);
});

test('a broadcast arriving after the window has closed repaints immediately', async () => {
  const { hold, clock, renders } = await makeHold();
  hold.begin('t');
  hold.settle('t');
  clock.advance(4000);
  assert.equal(renders.length, 0, 'nothing was held, so nothing repainted');
  hold.request();
  assert.equal(renders.length, 1);
});

test('a held repaint survives a second action started inside the window', async () => {
  const { hold, clock, renders } = await makeHold();
  hold.begin('a');
  hold.request();
  hold.settle('a');
  clock.advance(3900);
  hold.begin('b');
  // The window opened by `a` expires while `b` is still in flight. The repaint must not be handed to
  // a settle that has already run: this is the interleaving that stranded the board indefinitely.
  clock.advance(100);
  assert.equal(renders.length, 0, 'still held, b is in flight');
  assert.equal(hold._state().armed, true, 'and the hold kept its own timer');

  hold.settle('b');
  clock.advance(4000);
  assert.equal(renders.length, 1);
});

test('a held repaint is never owed to a settle that never comes', async () => {
  const { hold, clock, renders } = await makeHold();
  // An action that never settles (a reply the client never routes) must not park the board forever.
  hold.begin('never');
  hold.request();
  for (let i = 0; i < 20; i += 1) clock.advance(4000);
  assert.equal(renders.length, 0, 'still correctly held while the action is genuinely in flight');
  assert.equal(hold._state().armed, true, 'but a live timer is always pending, never a dead flag');
  hold.settle('never');
  clock.advance(4000);
  assert.equal(renders.length, 1, 'and it repaints the moment the action is accounted for');
});

test('a settle restarts the window so a fresh outcome line gets the full beat', async () => {
  const { hold, clock, renders } = await makeHold();
  hold.begin('a');
  hold.request();
  clock.advance(3900);
  hold.settle('a');
  clock.advance(3999);
  assert.equal(renders.length, 0, 'the window restarted when the outcome line appeared');
  clock.advance(1);
  assert.equal(renders.length, 1);
});

test('several broadcasts held together collapse into one repaint', async () => {
  const { hold, clock, renders } = await makeHold();
  hold.begin('a');
  hold.request();
  hold.request();
  hold.request();
  hold.settle('a');
  clock.advance(4000);
  assert.equal(renders.length, 1);
});

test('a repeated token is one control firing twice, not two outstanding actions', async () => {
  const { hold, clock, renders } = await makeHold();
  hold.begin('a');
  hold.begin('a');
  hold.request();
  hold.settle('a');
  clock.advance(4000);
  assert.equal(renders.length, 1);
});
