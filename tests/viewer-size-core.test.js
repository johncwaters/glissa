'use strict';

// Pure arbitration of the ONE PTY size several data-WS viewers disagree about. The wiring that feeds
// this (record on resize, hand back on unview/close) is exercised end to end in
// tests/backend-data-ws-resize.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isApplicableViewerSize, pickSizeAfterDeparture } = require('../server/core/viewer-size-core');

function viewers(entries) {
  return new Map(entries);
}

test('isApplicableViewerSize accepts the documented range and nothing else', () => {
  assert.equal(isApplicableViewerSize(80, 24), true);
  assert.equal(isApplicableViewerSize(1, 1), true);
  assert.equal(isApplicableViewerSize(500, 200), true);
  assert.equal(isApplicableViewerSize(0, 24), false);
  assert.equal(isApplicableViewerSize(80, 0), false);
  assert.equal(isApplicableViewerSize(501, 24), false);
  assert.equal(isApplicableViewerSize(80, 201), false);
  assert.equal(isApplicableViewerSize(80.5, 24), false);
  assert.equal(isApplicableViewerSize(Number.NaN, 24), false);
  assert.equal(isApplicableViewerSize('80', '24'), false);
});

test('the departing viewer hands the PTY to the most recent survivor', () => {
  const size = pickSizeAfterDeparture(viewers([
    ['desktop', { cols: 200, rows: 50, resizeSeq: 1 }],
    ['tab2', { cols: 180, rows: 48, resizeSeq: 2 }],
    ['phone', { cols: 40, rows: 30, resizeSeq: 3 }],
  ]), 'phone');
  assert.deepEqual(size, { cols: 180, rows: 48 });
});

test('the departing viewer is skipped even when the caller already dropped its record', () => {
  const size = pickSizeAfterDeparture(viewers([
    ['desktop', { cols: 200, rows: 50, resizeSeq: 1 }],
    ['phone', null],
  ]), 'phone');
  assert.deepEqual(size, { cols: 200, rows: 50 });
});

test('a departing viewer with no survivor leaves the PTY alone', () => {
  assert.equal(pickSizeAfterDeparture(viewers([['phone', { cols: 40, rows: 30, resizeSeq: 1 }]]), 'phone'), null);
  assert.equal(pickSizeAfterDeparture(viewers([]), 'phone'), null);
});

test('connections that never declared a size are not survivors', () => {
  // A board-only phone and a card that was never visible hold an open socket but have claimed nothing.
  assert.equal(pickSizeAfterDeparture(viewers([
    ['boardOnly', null],
    ['hiddenCard', null],
    ['phone', { cols: 40, rows: 30, resizeSeq: 1 }],
  ]), 'phone'), null);
});

test('an out-of-range record is never re-applied', () => {
  const size = pickSizeAfterDeparture(viewers([
    ['sane', { cols: 200, rows: 50, resizeSeq: 1 }],
    ['bogus', { cols: 9999, rows: 24, resizeSeq: 9 }],
    ['phone', { cols: 40, rows: 30, resizeSeq: 10 }],
  ]), 'phone');
  assert.deepEqual(size, { cols: 200, rows: 50 });
});

test('recency ties are impossible because the sequence is monotonic, not a clock', () => {
  // Two viewers resizing in the same millisecond is ordinary; ordering by a clock would hand the PTY
  // to whichever entry happened to iterate first.
  const size = pickSizeAfterDeparture(viewers([
    ['first', { cols: 200, rows: 50, resizeSeq: 7 }],
    ['second', { cols: 100, rows: 40, resizeSeq: 8 }],
    ['phone', { cols: 40, rows: 30, resizeSeq: 9 }],
  ]), 'phone');
  assert.deepEqual(size, { cols: 100, rows: 40 });
});

test('no departing key means every recorded viewer competes', () => {
  const size = pickSizeAfterDeparture(viewers([
    ['desktop', { cols: 200, rows: 50, resizeSeq: 1 }],
    ['phone', { cols: 40, rows: 30, resizeSeq: 2 }],
  ]));
  assert.deepEqual(size, { cols: 40, rows: 30 });
});
