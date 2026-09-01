import test from 'node:test';
import assert from 'node:assert/strict';

const importCore = () => import('../public/session-card/webgl-core.ts');

test('pickEvictionVictims: returns nothing while under the cap', async () => {
  const { pickEvictionVictims } = await importCore();
  assert.deepEqual(pickEvictionVictims(['a', 'b'], 12, ['a']), []);
});

test('pickEvictionVictims: at the cap evicts the oldest key that is not protected', async () => {
  const { pickEvictionVictims } = await importCore();

  assert.deepEqual(pickEvictionVictims(['a', 'b'], 2, ['c']), ['a']);
});

test('pickEvictionVictims: never evicts protected keys, evicts the rest in order', async () => {
  const { pickEvictionVictims } = await importCore();
  const victims = pickEvictionVictims(['a', 'b', 'c'], 2, ['a']);
  assert.deepEqual(victims, ['b', 'c']);
  assert.ok(!victims.includes('a'));
});

test('pickEvictionVictims: borrowed card is spared and the next LRU card is evicted', async () => {
  const { pickEvictionVictims } = await importCore();
  const victims = pickEvictionVictims(['borrowed', 'next', 'claiming'], 3, ['claiming', 'borrowed']);
  assert.deepEqual(victims, ['next']);
});

test('pickEvictionVictims: stops when only protected keys remain at/over the cap', async () => {
  const { pickEvictionVictims } = await importCore();
  assert.deepEqual(pickEvictionVictims(['a'], 1, ['a']), []);
});
