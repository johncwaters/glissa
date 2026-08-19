'use strict';

// The rule behind the card's "pack stale" chip: which delivered context packs the mill has rebuilt
// since the session was spawned, and (just as important) when it must stay quiet.

const test = require('node:test');
const assert = require('node:assert/strict');

// pack-stale-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/session-card/pack-stale-core.mjs');

test('a delivered pack whose current version moved is stale', async () => {
  const { hasStalePack, stalePackNames } = await importCore();
  const delivered = [{ name: 'company-context', version: 'v1' }, { name: 'glissa', version: 'v9' }];
  const latest = { 'company-context': 'v2', glissa: 'v9' };

  assert.deepEqual(stalePackNames(delivered, latest), ['company-context']);
  assert.equal(hasStalePack(delivered, latest), true);
});

test('matching versions are never stale', async () => {
  const { hasStalePack } = await importCore();
  assert.equal(hasStalePack([{ name: 'glissa', version: 'v9' }], { glissa: 'v9' }), false);
});

test('a pack the dashboard has no current version for is never judged', async () => {
  const { stalePackNames } = await importCore();
  // Auto-rebuild off, or a pack built before this dashboard connected: guessing "stale" here would
  // nag about every session forever.
  assert.deepEqual(stalePackNames([{ name: 'glissa', version: 'v9' }], {}), []);
  assert.deepEqual(stalePackNames([{ name: 'glissa', version: 'v9' }], { glissa: null }), []);
});

test('a session that delivered no packs is never stale', async () => {
  const { hasStalePack } = await importCore();
  assert.equal(hasStalePack([], { glissa: 'v2' }), false);
  assert.equal(hasStalePack(undefined, { glissa: 'v2' }), false);
  assert.equal(hasStalePack([{ name: 'glissa', version: 'v1' }], null), false);
});

test('a Map of latest versions works as well as a plain object', async () => {
  const { stalePackNames } = await importCore();
  const latest = new Map([['glissa', 'v2']]);
  assert.deepEqual(stalePackNames([{ name: 'glissa', version: 'v1' }], latest), ['glissa']);
  assert.deepEqual(stalePackNames([{ name: 'glissa', version: 'v2' }], latest), []);
});

test('malformed pack entries are skipped rather than throwing', async () => {
  const { stalePackNames } = await importCore();
  const delivered = [null, {}, { name: 42, version: 'v1' }, { name: 'glissa', version: 'v1' }];
  assert.deepEqual(stalePackNames(delivered, { glissa: 'v2' }), ['glissa']);
});
