'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// geometry-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/session-card/geometry-core.mjs');

// Helper: a {card, rect} entry; rect center is (left+width/2, top+height/2).
const R = (card, left, top, width = 10, height = 10) => ({ card, rect: { left, top, width, height } });

test('closestCardByCenter: empty rects -> {card:null, before:true}', async () => {
  const { closestCardByCenter } = await importCore();
  assert.deepEqual(closestCardByCenter(0, 0, [], 'src', 'zone'), { card: null, before: true });
});

test('closestCardByCenter: picks the nearest center and skips source + dropZone', async () => {
  const { closestCardByCenter } = await importCore();
  const rects = [R('src', 0, 0), R('a', 100, 0), R('b', 200, 0), R('zone', 5, 0)];
  // Pointer at b's center (205, 5). 'src' and 'zone' are skipped.
  const r = closestCardByCenter(205, 5, rects, 'src', 'zone');
  assert.equal(r.card, 'b');
});

test('closestCardByCenter: before=true when source index > target index (leftward)', async () => {
  const { closestCardByCenter } = await importCore();
  const rects = [R('a', 0, 0), R('b', 100, 0), R('src', 200, 0)];
  const r = closestCardByCenter(5, 5, rects, 'src', 'zone'); // nearest = 'a' at index 0
  assert.equal(r.card, 'a');
  assert.equal(r.before, true);
});

test('closestCardByCenter: before=false when source index < target index (rightward)', async () => {
  const { closestCardByCenter } = await importCore();
  const rects = [R('src', 0, 0), R('a', 100, 0), R('b', 200, 0)];
  const r = closestCardByCenter(205, 5, rects, 'src', 'zone'); // nearest = 'b' at index 2
  assert.equal(r.card, 'b');
  assert.equal(r.before, false);
});
