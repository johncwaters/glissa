import test from 'node:test';
import assert from 'node:assert/strict';

const importCore = () => import('../public/session-card/pack-stale-core.ts');

test('a delivered pack whose current version moved is stale', async () => {
  const { hasStalePack, stalePackNames } = await importCore();
  const delivered = [{ name: 'house-rules', version: 'v1' }, { name: 'crew-rules', version: 'v9' }];
  const latest = { 'house-rules': 'v2', 'crew-rules': 'v9' };

  assert.deepEqual(stalePackNames(delivered, latest), ['house-rules']);
  assert.equal(hasStalePack(delivered, latest), true);
});

test('matching versions are never stale', async () => {
  const { hasStalePack } = await importCore();
  assert.equal(hasStalePack([{ name: 'crew-rules', version: 'v9' }], { 'crew-rules': 'v9' }), false);
});

test('a pack the dashboard has no current version for is never judged', async () => {
  const { stalePackNames } = await importCore();

  assert.deepEqual(stalePackNames([{ name: 'crew-rules', version: 'v9' }], {}), []);
  assert.deepEqual(stalePackNames([{ name: 'crew-rules', version: 'v9' }], { 'crew-rules': null }), []);
});

test('a session that delivered no packs is never stale', async () => {
  const { hasStalePack } = await importCore();
  assert.equal(hasStalePack([], { 'crew-rules': 'v2' }), false);
  assert.equal(hasStalePack(undefined, { 'crew-rules': 'v2' }), false);
  assert.equal(hasStalePack([{ name: 'crew-rules', version: 'v1' }], null), false);
});

test('a Map of latest versions works as well as a plain object', async () => {
  const { stalePackNames } = await importCore();
  const latest = new Map([['crew-rules', 'v2']]);
  assert.deepEqual(stalePackNames([{ name: 'crew-rules', version: 'v1' }], latest), ['crew-rules']);
  assert.deepEqual(stalePackNames([{ name: 'crew-rules', version: 'v2' }], latest), []);
});

test('malformed pack entries are skipped rather than throwing', async () => {
  const { stalePackNames } = await importCore();
  const delivered = [null, {}, { name: 42, version: 'v1' }, { name: 'crew-rules', version: 'v1' }];
  assert.deepEqual(stalePackNames(delivered, { 'crew-rules': 'v2' }), ['crew-rules']);
});
