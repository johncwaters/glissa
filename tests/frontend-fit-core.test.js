'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// fit-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/session-card/fit-core.ts');

const NEVER_FITTED = { lastFittedCols: 0, lastFittedRows: 0, lastSentCols: 0, lastSentRows: 0 };

test('decideFitAction: an unmeasured fit publishes nothing', async () => {
  const { decideFitAction } = await importCore();
  const out = decideFitAction({ measured: false, cols: 80, rows: 24, ...NEVER_FITTED });
  assert.deepEqual(out, { repaint: false, send: false });
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
  });
  assert.deepEqual(out, { repaint: false, send: false });
});

test('decideFitAction: the first visible fit publishes geometry', async () => {
  const { decideFitAction } = await importCore();
  const out = decideFitAction({ measured: true, cols: 150, rows: 44, ...NEVER_FITTED });
  assert.deepEqual(out, { repaint: true, send: true });
});

test('decideFitAction: reveal at an unchanged grid requests a browser repaint and geometry publish', async () => {
  const { decideFitAction } = await importCore();
  const out = decideFitAction({
    measured: true,
    cols: 150,
    rows: 44,
    lastFittedCols: 150,
    lastFittedRows: 44,
    lastSentCols: 150,
    lastSentRows: 44,
    repaintRequested: true,
  });
  assert.deepEqual(out, { repaint: true, send: true });
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
  });
  assert.deepEqual(out, { repaint: false, send: false });
});

test('decideFitAction: a change on either axis alone is a changed grid', async () => {
  const { decideFitAction } = await importCore();
  const base = {
    measured: true,
    lastFittedCols: 150,
    lastFittedRows: 44,
    lastSentCols: 150,
    lastSentRows: 44,
  };
  assert.deepEqual(
    decideFitAction({ ...base, cols: 149, rows: 44 }),
    { repaint: true, send: true },
  );
  assert.deepEqual(
    decideFitAction({ ...base, cols: 150, rows: 43 }),
    { repaint: true, send: true },
  );
});

test('decideFitAction: a viewer reclaim publishes geometry when only the sent grid differs', async () => {
  const { decideFitAction } = await importCore();
  const out = decideFitAction({
    measured: true,
    cols: 150,
    rows: 44,
    lastFittedCols: 150,
    lastFittedRows: 44,
    lastSentCols: 0,
    lastSentRows: 0,
  });
  assert.deepEqual(out, { repaint: false, send: true });
});
