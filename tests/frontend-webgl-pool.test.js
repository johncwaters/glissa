'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// webgl-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/session-card/webgl-core.mjs');

test('pickEvictionVictims: returns nothing while under the cap', async () => {
  const { pickEvictionVictims } = await importCore();
  assert.deepEqual(pickEvictionVictims(['a', 'b'], 12, 'a'), []);
});

test('pickEvictionVictims: at the cap evicts the oldest key that is not exceptKey', async () => {
  const { pickEvictionVictims } = await importCore();
  // size 2 >= cap 2; exceptKey 'c' is absent, so the oldest ('a') is evicted, then size 1 < 2 stops.
  assert.deepEqual(pickEvictionVictims(['a', 'b'], 2, 'c'), ['a']);
});

test('pickEvictionVictims: never evicts exceptKey, evicts the rest in order', async () => {
  const { pickEvictionVictims } = await importCore();
  const victims = pickEvictionVictims(['a', 'b', 'c'], 2, 'a');
  assert.deepEqual(victims, ['b', 'c']);
  assert.ok(!victims.includes('a'));
});

test('pickEvictionVictims: stops when only exceptKey remains at/over the cap', async () => {
  const { pickEvictionVictims } = await importCore();
  assert.deepEqual(pickEvictionVictims(['a'], 1, 'a'), []);
});
