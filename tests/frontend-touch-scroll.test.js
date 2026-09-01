'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// touch-scroll-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/session-card/touch-scroll-core.ts');

test('isScrollGesture: travel under the threshold is a tap, not a scroll', async () => {
  const { isScrollGesture, TOUCH_SCROLL_THRESHOLD_PX } = await importCore();
  assert.equal(isScrollGesture(0, 0), false);
  assert.equal(isScrollGesture(0, TOUCH_SCROLL_THRESHOLD_PX - 1), false);
  assert.equal(isScrollGesture(0, -(TOUCH_SCROLL_THRESHOLD_PX - 1)), false);
});

test('isScrollGesture: a vertical drag past the threshold claims the gesture, either direction', async () => {
  const { isScrollGesture } = await importCore();
  assert.equal(isScrollGesture(0, 40), true);
  assert.equal(isScrollGesture(0, -40), true);
  assert.equal(isScrollGesture(6, 40), true);
});

test('isScrollGesture: a sideways swipe is left to the browser', async () => {
  const { isScrollGesture } = await importCore();
  assert.equal(isScrollGesture(60, 12), false);
  assert.equal(isScrollGesture(-60, -12), false);
});

test('scrollLinesForDrag: a downward drag scrolls back through history', async () => {
  const { scrollLinesForDrag } = await importCore();
  const { scrollLines, remainderPx } = scrollLinesForDrag(40, 20);
  assert.equal(scrollLines, -2, 'finger down reveals earlier output');
  assert.equal(remainderPx, 0);
});

test('scrollLinesForDrag: an upward drag scrolls forward toward the live tail', async () => {
  const { scrollLinesForDrag } = await importCore();
  assert.deepEqual(scrollLinesForDrag(-60, 20), { scrollLines: 3, remainderPx: 0 });
});

test('scrollLinesForDrag: sub-row travel moves nothing but is banked as remainder', async () => {
  const { scrollLinesForDrag } = await importCore();
  const first = scrollLinesForDrag(9, 20);
  assert.equal(first.scrollLines, 0);
  assert.equal(first.remainderPx, 9);
  // The next move event adds to the carry and crosses the row boundary.
  const second = scrollLinesForDrag(first.remainderPx + 12, 20);
  assert.equal(second.scrollLines, -1);
  assert.equal(second.remainderPx, 1);
});

test('scrollLinesForDrag: the local scrollback path is uncapped, a hard flick lands whole', async () => {
  const { scrollLinesForDrag } = await importCore();
  assert.deepEqual(scrollLinesForDrag(20 * 40, 20), { scrollLines: -40, remainderPx: 0 });
});

test('scrollLinesForDrag: the wheel path caps its burst, and the withheld travel survives as remainder', async () => {
  const { scrollLinesForDrag, MAX_WHEEL_ROWS_PER_STEP } = await importCore();
  const pendingPx = 20 * (MAX_WHEEL_ROWS_PER_STEP + 5);
  const { scrollLines, remainderPx } = scrollLinesForDrag(pendingPx, 20, MAX_WHEEL_ROWS_PER_STEP);
  assert.equal(scrollLines, -MAX_WHEEL_ROWS_PER_STEP);
  assert.equal(remainderPx, 20 * 5, 'the rows the cap withheld are not lost');
});

test('scrollLinesForDrag: an unmeasurable cell height scrolls nothing and banks the travel', async () => {
  const { scrollLinesForDrag } = await importCore();
  assert.deepEqual(scrollLinesForDrag(120, 0), { scrollLines: 0, remainderPx: 120 });
  assert.deepEqual(scrollLinesForDrag(120, Number.NaN), { scrollLines: 0, remainderPx: 120 });
});

test('shouldSendWheelReport: the alternate buffer always reports, it has no scrollback to move', async () => {
  const { shouldSendWheelReport } = await importCore();
  assert.equal(shouldSendWheelReport('alternate', 'none'), true);
  assert.equal(shouldSendWheelReport('alternate', 'any'), true);
});

test('shouldSendWheelReport: mouse tracking on the primary buffer reports instead of scrolling back', async () => {
  const { shouldSendWheelReport } = await importCore();
  for (const mode of ['x10', 'vt200', 'drag', 'any']) {
    assert.equal(shouldSendWheelReport('normal', mode), true, `${mode} tracking must reach the app`);
  }
});

test('shouldSendWheelReport: an untracked primary buffer scrolls local scrollback', async () => {
  const { shouldSendWheelReport } = await importCore();
  assert.equal(shouldSendWheelReport('normal', 'none'), false);
  // An xterm that never exposed the modes surface reads as untracked rather than throwing.
  assert.equal(shouldSendWheelReport('normal', undefined), false);
});

test('cellHeightFromElement: row height comes from the measured box, or 0 when there is none', async () => {
  const { cellHeightFromElement } = await importCore();
  assert.equal(cellHeightFromElement(480, 24), 20);
  assert.equal(cellHeightFromElement(0, 24), 0, 'a hidden card has no measurable box');
  assert.equal(cellHeightFromElement(480, 0), 0);
});

test('pushVelocitySample: the window is bounded and never mutates the array it was handed', async () => {
  const { pushVelocitySample, VELOCITY_SAMPLE_LIMIT } = await importCore();
  let samples = [];
  for (let index = 0; index < VELOCITY_SAMPLE_LIMIT + 3; index++) {
    const previous = samples;
    samples = pushVelocitySample(samples, index * 10, index * 16);
    assert.notEqual(samples, previous, 'a new array, so a stale gesture cannot share the window');
  }
  assert.equal(samples.length, VELOCITY_SAMPLE_LIMIT);
  assert.equal(samples[samples.length - 1].positionPx, (VELOCITY_SAMPLE_LIMIT + 2) * 10);
  assert.equal(samples[0].timestampMs, 3 * 16, 'the oldest samples are dropped, newest kept');
});

test('releaseVelocity: a flick reports signed px/ms across the window', async () => {
  const { releaseVelocity } = await importCore();
  const down = releaseVelocity([
    { positionPx: 0, timestampMs: 0 },
    { positionPx: 100, timestampMs: 50 },
  ]);
  assert.equal(down, 2);
  const up = releaseVelocity([
    { positionPx: 100, timestampMs: 1000 },
    { positionPx: 0, timestampMs: 1050 },
  ]);
  assert.equal(up, -2);
});

test('releaseVelocity: a slow release, a still finger and a degenerate window all coast nothing', async () => {
  const { releaseVelocity, MIN_FLICK_VELOCITY_PX_PER_MS } = await importCore();
  assert.equal(releaseVelocity([]), 0);
  assert.equal(releaseVelocity([{ positionPx: 0, timestampMs: 0 }]), 0, 'one sample has no span');
  assert.equal(releaseVelocity([
    { positionPx: 0, timestampMs: 5 },
    { positionPx: 40, timestampMs: 5 },
  ]), 0, 'a zero-length window would divide by zero');
  // A finger that flicked and then held still: the lift sample stretches the window until the
  // averaged velocity falls under the flick floor.
  const heldStill = releaseVelocity([
    { positionPx: 0, timestampMs: 0 },
    { positionPx: 60, timestampMs: 30 },
    { positionPx: 60, timestampMs: 900 },
  ]);
  assert.ok(Math.abs(heldStill) < MIN_FLICK_VELOCITY_PX_PER_MS, 'a deliberate stop does not coast');
  assert.equal(heldStill, 0);
});

test('releaseVelocity: a jumped sample is clamped instead of launching a runaway coast', async () => {
  const { releaseVelocity, MAX_FLICK_VELOCITY_PX_PER_MS } = await importCore();
  assert.equal(releaseVelocity([
    { positionPx: 0, timestampMs: 0 },
    { positionPx: 9000, timestampMs: 16 },
  ]), MAX_FLICK_VELOCITY_PX_PER_MS);
});

test('beginInertia: no flick and no measurable row height both mean no coast', async () => {
  const { beginInertia } = await importCore();
  assert.equal(beginInertia({ velocityPxPerMs: 0, startedAtMs: 0, cellHeightPx: 20 }), null);
  assert.equal(beginInertia({ velocityPxPerMs: 2, startedAtMs: 0, cellHeightPx: 0 }), null);
  const state = beginInertia({ velocityPxPerMs: 2, startedAtMs: 100, cellHeightPx: 20, pendingPx: 7 });
  assert.deepEqual(state, { velocityPxPerMs: 2, lastMs: 100, cellHeightPx: 20, pendingPx: 7 });
});

test('stepInertia: a coast decays to a stop and travels the analytic distance', async () => {
  const { beginInertia, stepInertia, SCROLL_FRICTION_PX_PER_MS2 } = await importCore();
  const releaseVelocityPxPerMs = 2;
  const cellHeightPx = 20;
  let state = beginInertia({ velocityPxPerMs: releaseVelocityPxPerMs, startedAtMs: 0, cellHeightPx });
  let totalRows = 0;
  let nowMs = 0;
  let frames = 0;
  while (state && frames < 1000) {
    nowMs += 16;
    const stepped = stepInertia(state, nowMs);
    totalRows += stepped.scrollLines;
    state = stepped.state;
    frames++;
  }
  assert.equal(state, null, 'friction ends the coast');
  assert.ok(nowMs <= releaseVelocityPxPerMs / SCROLL_FRICTION_PX_PER_MS2 + 16, 'stops on schedule');
  // Continuous travel is v^2 / (2 * friction); the frame-stepped sum lands within a row of it.
  const expectedRows =
    (releaseVelocityPxPerMs ** 2) / (2 * SCROLL_FRICTION_PX_PER_MS2) / cellHeightPx;
  assert.ok(Math.abs(Math.abs(totalRows) - expectedRows) < 2, `travelled ${totalRows} rows`);
  assert.ok(totalRows < 0, 'a downward flick keeps revealing earlier output');
});

test('stepInertia: a long frame gap decays straight past zero and ends the coast', async () => {
  const { beginInertia, stepInertia } = await importCore();
  const state = beginInertia({ velocityPxPerMs: 2, startedAtMs: 0, cellHeightPx: 20 });
  const stepped = stepInertia(state, 5000);
  assert.equal(stepped.state, null, 'a backgrounded tab resumes stopped, not with a huge jump');
  assert.equal(stepped.scrollLines, 0);
});

test('stepInertia: a cancelled coast and a zero-length frame are both no-ops', async () => {
  const { beginInertia, stepInertia } = await importCore();
  assert.deepEqual(stepInertia(null, 100), { scrollLines: 0, state: null });
  const state = beginInertia({ velocityPxPerMs: 2, startedAtMs: 100, cellHeightPx: 20 });
  const sameInstant = stepInertia(state, 100);
  assert.equal(sameInstant.scrollLines, 0);
  assert.equal(sameInstant.state, state, 'the coast is untouched until time actually moves');
});

test('stepInertia: sub-row travel is carried, not dropped, between frames', async () => {
  const { stepInertia } = await importCore();
  // 0.5 px/ms over an 8ms frame is a few px, well under one 20px row.
  const first = stepInertia({ velocityPxPerMs: 0.5, lastMs: 0, cellHeightPx: 20, pendingPx: 0 }, 8);
  assert.equal(first.scrollLines, 0);
  assert.ok(first.state.pendingPx > 0, 'the fraction of a row is banked');
  const second = stepInertia(first.state, 16);
  assert.equal(second.scrollLines, 0);
  assert.ok(second.state.pendingPx > first.state.pendingPx, 'the carry accumulates toward a row');
  let state = second.state;
  let nowMs = 16;
  let deliveredRows = 0;
  while (state && deliveredRows === 0) {
    nowMs += 8;
    const stepped = stepInertia(state, nowMs);
    deliveredRows = stepped.scrollLines;
    state = stepped.state;
  }
  assert.equal(deliveredRows, -1, 'the banked fractions eventually deliver a whole row');
});
