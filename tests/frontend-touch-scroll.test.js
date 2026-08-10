'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// touch-scroll-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/session-card/touch-scroll-core.mjs');

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

test('scrollLinesForDrag: a flick is capped, and the uncapped travel survives as remainder', async () => {
  const { scrollLinesForDrag, MAX_ROWS_PER_STEP } = await importCore();
  const { scrollLines, remainderPx } = scrollLinesForDrag(20 * (MAX_ROWS_PER_STEP + 5), 20);
  assert.equal(scrollLines, -MAX_ROWS_PER_STEP);
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
