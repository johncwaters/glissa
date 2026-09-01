import test from 'node:test';
import assert from 'node:assert/strict';

import { createRenderHold } from '../public/radar-hold-core.ts';

function fakeClock() {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  return {
    setTimer(fn: () => void, delayMs: number): number {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, at: nowMs + delayMs });
      return id;
    },
    clearTimer(id: number): void {
      timers.delete(id);
    },
    advance(ms: number): void {
      nowMs += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= nowMs)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        if (!timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

function makeHold(holdMs = 4000) {
  const clock = fakeClock();
  const renders: number[] = [];
  const hold = createRenderHold({
    render: () => renders.push(renders.length + 1),
    holdMs,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { hold, clock, renders };
}

test('an idle board repaints straight through', () => {
  const { hold, renders } = makeHold();
  hold.request();
  hold.request();
  assert.equal(renders.length, 2);
});

test('the archive ordering: broadcast lands BEFORE the reply, and the row repaints one window later', () => {
  const { hold, clock, renders } = makeHold();

  hold.begin('archive:iss-1@100');

  hold.request();
  assert.equal(renders.length, 0, 'held: repainting now would wipe the in-flight row');

  hold.settle('archive:iss-1@100');
  assert.equal(renders.length, 0, 'the outcome line is still being read');

  clock.advance(3999);
  assert.equal(renders.length, 0);
  clock.advance(1);
  assert.equal(renders.length, 1, 'the held board repaints once the outcome has been readable');
  assert.deepEqual(hold._state(), { pending: 0, held: false, armed: false });
});

test('the reverse ordering: reply first, broadcast inside the window, still exactly one repaint', () => {
  const { hold, clock, renders } = makeHold();
  hold.begin('archive:iss-1@100');
  hold.settle('archive:iss-1@100');
  clock.advance(1000);
  hold.request();
  assert.equal(renders.length, 0, 'held so the outcome line survives');
  clock.advance(3000);
  assert.equal(renders.length, 1);
});

test('a broadcast arriving after the window has closed repaints immediately', () => {
  const { hold, clock, renders } = makeHold();
  hold.begin('t');
  hold.settle('t');
  clock.advance(4000);
  assert.equal(renders.length, 0, 'nothing was held, so nothing repainted');
  hold.request();
  assert.equal(renders.length, 1);
});

test('a held repaint survives a second action started inside the window', () => {
  const { hold, clock, renders } = makeHold();
  hold.begin('a');
  hold.request();
  hold.settle('a');
  clock.advance(3900);
  hold.begin('b');

  clock.advance(100);
  assert.equal(renders.length, 0, 'still held, b is in flight');
  assert.equal(hold._state().armed, true, 'and the hold kept its own timer');

  hold.settle('b');
  clock.advance(4000);
  assert.equal(renders.length, 1);
});

test('a held repaint is never owed to a settle that never comes', () => {
  const { hold, clock, renders } = makeHold();

  hold.begin('never');
  hold.request();
  for (let round = 0; round < 20; round += 1) clock.advance(4000);
  assert.equal(renders.length, 0, 'still correctly held while the action is genuinely in flight');
  assert.equal(hold._state().armed, true, 'but a live timer is always pending, never a dead flag');
  hold.settle('never');
  clock.advance(4000);
  assert.equal(renders.length, 1, 'and it repaints the moment the action is accounted for');
});

test('a settle restarts the window so a fresh outcome line gets the full beat', () => {
  const { hold, clock, renders } = makeHold();
  hold.begin('a');
  hold.request();
  clock.advance(3900);
  hold.settle('a');
  clock.advance(3999);
  assert.equal(renders.length, 0, 'the window restarted when the outcome line appeared');
  clock.advance(1);
  assert.equal(renders.length, 1);
});

test('several broadcasts held together collapse into one repaint', () => {
  const { hold, clock, renders } = makeHold();
  hold.begin('a');
  hold.request();
  hold.request();
  hold.request();
  hold.settle('a');
  clock.advance(4000);
  assert.equal(renders.length, 1);
});

test('a repeated token is one control firing twice, not two outstanding actions', () => {
  const { hold, clock, renders } = makeHold();
  hold.begin('a');
  hold.begin('a');
  hold.request();
  hold.settle('a');
  clock.advance(4000);
  assert.equal(renders.length, 1);
});
