'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// fit-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/session-card/fit-core.mjs');

const NEVER_FITTED = { lastFittedCols: 0, lastFittedRows: 0, lastSentCols: 0, lastSentRows: 0 };
const NO_DATA_SOCKET = { hasDataSocket: false, isDataSocketOpen: false };
const OPEN_DATA_SOCKET = { hasDataSocket: true, isDataSocketOpen: true };

test('decideFitAction: an unmeasured fit publishes nothing', async () => {
  const { decideFitAction } = await importCore();
  const out = decideFitAction({ measured: false, cols: 80, rows: 24, ...NEVER_FITTED, ...NO_DATA_SOCKET });
  assert.deepEqual(out, { repaint: false, connect: false, send: false, redraw: false });
});

test('decideFitAction: an unmeasured fit publishes nothing even at a size already sent', async () => {
  const { decideFitAction } = await importCore();
  const out = decideFitAction({
    measured: false,
    cols: 80,
    rows: 24,
    lastFittedCols: 150,
    lastFittedRows: 44,
    lastSentCols: 150,
    lastSentRows: 44,
    ...NO_DATA_SOCKET,
  });
  assert.deepEqual(out, { repaint: false, connect: false, send: false, redraw: false });
});

test('decideFitAction: open ordering waits for fit, connects, then sends size after socket open', async () => {
  const { decideFitAction } = await importCore();
  const hidden = decideFitAction({ measured: false, cols: 80, rows: 24, ...NEVER_FITTED, ...NO_DATA_SOCKET });
  const fitted = decideFitAction({ measured: true, cols: 150, rows: 44, ...NEVER_FITTED, ...NO_DATA_SOCKET });
  const opened = decideFitAction({
    measured: true,
    cols: 150,
    rows: 44,
    lastFittedCols: 150,
    lastFittedRows: 44,
    lastSentCols: 0,
    lastSentRows: 0,
    ...OPEN_DATA_SOCKET,
  });
  assert.deepEqual(hidden, { repaint: false, connect: false, send: false, redraw: false });
  assert.deepEqual(fitted, { repaint: true, connect: true, send: false, redraw: false });
  assert.deepEqual(opened, { repaint: false, connect: false, send: true, redraw: false });
});

test('decideFitAction: a re-borrow at the fitted size sends once without a redraw', async () => {
  const { decideFitAction } = await importCore();
  const out = decideFitAction({
    measured: true,
    cols: 150,
    rows: 44,
    lastFittedCols: 150,
    lastFittedRows: 44,
    lastSentCols: 0,
    lastSentRows: 0,
    repaintRequested: true,
    ...OPEN_DATA_SOCKET,
  });
  assert.deepEqual(out, { repaint: true, connect: false, send: true, redraw: false });
});

test('decideFitAction: a fit that changes nothing at all is silent', async () => {
  const { decideFitAction } = await importCore();
  const out = decideFitAction({
    measured: true,
    cols: 150,
    rows: 44,
    lastFittedCols: 150,
    lastFittedRows: 44,
    lastSentCols: 150,
    lastSentRows: 44,
    ...OPEN_DATA_SOCKET,
  });
  assert.deepEqual(out, { repaint: false, connect: false, send: false, redraw: false });
});

test('decideFitAction: a change on either axis alone is a changed grid', async () => {
  const { decideFitAction } = await importCore();
  const base = {
    measured: true,
    lastFittedCols: 150,
    lastFittedRows: 44,
    lastSentCols: 150,
    lastSentRows: 44,
    ...OPEN_DATA_SOCKET,
  };
  assert.deepEqual(
    decideFitAction({ ...base, cols: 149, rows: 44 }),
    { repaint: true, connect: false, send: true, redraw: true },
  );
  assert.deepEqual(
    decideFitAction({ ...base, cols: 150, rows: 43 }),
    { repaint: true, connect: false, send: true, redraw: true },
  );
});
