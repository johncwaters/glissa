'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  costForEntry,
  lookupModelPrice,
  normalizePricingTable,
} = require('../server/core/usage-pricing-core');
const pricingSnapshot = require('../server/data/claude-pricing.json');

test('normalizePricingTable accepts snapshot-shaped and raw LiteLLM-shaped objects', () => {
  const table = normalizePricingTable({ models: { a: { input_cost_per_token: 1 } } });
  assert.equal(table.get('a').input_cost_per_token, 1);
  assert.equal(normalizePricingTable({ b: { output_cost_per_token: 2 } }).get('b').output_cost_per_token, 2);
});

test('lookupModelPrice uses exact, aliases, then fuzzy matching with longest key winning', () => {
  const table = normalizePricingTable({
    'claude-sonnet-4': { input_cost_per_token: 1 },
    'claude-sonnet-4-20250514': { input_cost_per_token: 2 },
    'claude-sonnet-4-fast': { input_cost_per_token: 99 },
    'claude.opus@4': { input_cost_per_token: 3 },
  });
  assert.equal(lookupModelPrice(table, 'claude-sonnet-4').key, 'claude-sonnet-4');
  assert.equal(lookupModelPrice(table, 'alias', { aliases: { alias: 'claude.opus@4' } }).key, 'claude.opus@4');
  assert.equal(lookupModelPrice(table, 'provider/claude-sonnet-4-20250514-v1').key, 'claude-sonnet-4-20250514');
  assert.equal(lookupModelPrice(table, 'claude-opus-4').key, 'claude.opus@4');
  assert.equal(lookupModelPrice(table, 'provider/claude-sonnet-4-fast-v1').key, 'claude-sonnet-4');
  assert.equal(lookupModelPrice(table, 'unknown'), null);
});

test('lookupModelPrice resolves claude 3.5 sonnet from the snapshot', () => {
  const table = normalizePricingTable(pricingSnapshot);
  const resolved = lookupModelPrice(table, 'claude-3-5-sonnet-20241022');
  assert.equal(resolved.key, 'claude-3-5-sonnet-20241022');
  assert.equal(resolved.price.input_cost_per_token, 0.000003);
});

test('costForEntry implements display, auto, calculate and unknown model behavior', () => {
  const price = { input_cost_per_token: 1, output_cost_per_token: 2 };
  const entry = { input: 1, output: 1, cacheCreation5m: 0, cacheCreation1h: 0, cacheRead: 0, costUSD: 42 };
  assert.deepEqual(costForEntry(entry, price, { costMode: 'display' }), { costUSD: 42, priced: true });
  assert.deepEqual(costForEntry({ ...entry, costUSD: null }, price, { costMode: 'display' }), { costUSD: 0, priced: false });
  assert.deepEqual(costForEntry(entry, price, { costMode: 'auto' }), { costUSD: 42, priced: true });
  assert.deepEqual(costForEntry(entry, price, { costMode: 'calculate' }), { costUSD: 3, priced: true });
  assert.deepEqual(costForEntry(entry, null, { costMode: 'calculate' }), { costUSD: 0, priced: false });
});

test('costForEntry derives cache defaults and charges 1h cache at 2x input', () => {
  const price = { input_cost_per_token: 1, output_cost_per_token: 10 };
  const entry = {
    input: 2,
    output: 3,
    cacheCreation5m: 4,
    cacheCreation1h: 5,
    cacheRead: 6,
    speed: 'fast',
  };
  assert.equal(costForEntry(entry, price, { costMode: 'calculate' }).costUSD, 47.6);
});

test('costForEntry honors explicit zero 5m cache creation on 1h-only entries', () => {
  const price = { input_cost_per_token: 1, output_cost_per_token: 10 };
  const entry = { input: 0, output: 0, cacheCreation5m: 0, cacheCreation1h: 1000, cacheRead: 0 };
  assert.equal(costForEntry(entry, price, { costMode: 'calculate' }).costUSD, 2000);
});

test('costForEntry uses data-driven fast multiplier without compounding exact fast rates', () => {
  const table = normalizePricingTable({
    'claude-a': { input_cost_per_token: 1, output_cost_per_token: 0, fast_multiplier: 2 },
    'claude-a-fast': { input_cost_per_token: 3, output_cost_per_token: 0, fast_multiplier: 2 },
  });
  const baseResolved = lookupModelPrice(table, 'provider/claude-a-fast-v1');
  const exactFastResolved = lookupModelPrice(table, 'claude-a-fast');
  assert.equal(costForEntry({ input: 10, output: 0, model: 'claude-a-fast' }, baseResolved.price, { costMode: 'calculate' }).costUSD, 20);
  assert.equal(costForEntry({ input: 10, output: 0, model: 'claude-a-fast' }, exactFastResolved.price, { costMode: 'calculate' }).costUSD, 30);
});

test('costForEntry switches all buckets for explicit long-context threshold', () => {
  const price = {
    input_cost_per_token: 1,
    output_cost_per_token: 2,
    cache_creation_input_token_cost: 3,
    cache_read_input_token_cost: 4,
    input_cost_per_token_above_200k_tokens: 10,
    output_cost_per_token_above_200k_tokens: 20,
    cache_creation_input_token_cost_above_200k_tokens: 30,
    cache_read_input_token_cost_above_200k_tokens: 40,
    long_context_threshold: 100,
  };
  const entry = { input: 50, output: 1, cacheCreation5m: 25, cacheCreation1h: 26, cacheRead: 1 };
  assert.equal(costForEntry(entry, price, { costMode: 'calculate' }).costUSD, 1830);
});

test('costForEntry keeps all buckets at base rates under explicit long-context threshold', () => {
  const price = {
    input_cost_per_token: 1,
    output_cost_per_token: 2,
    cache_creation_input_token_cost: 3,
    cache_read_input_token_cost: 4,
    input_cost_per_token_above_200k_tokens: 10,
    output_cost_per_token_above_200k_tokens: 20,
    cache_creation_input_token_cost_above_200k_tokens: 30,
    cache_read_input_token_cost_above_200k_tokens: 40,
    long_context_threshold: 300000,
  };
  const entry = { input: 200001, output: 1, cacheCreation5m: 1, cacheCreation1h: 1, cacheRead: 1 };
  assert.equal(costForEntry(entry, price, { costMode: 'calculate' }).costUSD, 200012);
});

test('costForEntry applies marginal 200k tiering when no threshold is present', () => {
  const price = {
    input_cost_per_token: 1,
    output_cost_per_token: 2,
    cache_creation_input_token_cost: 3,
    cache_read_input_token_cost: 4,
    input_cost_per_token_above_200k_tokens: 10,
    output_cost_per_token_above_200k_tokens: 20,
    cache_creation_input_token_cost_above_200k_tokens: 30,
    cache_read_input_token_cost_above_200k_tokens: 40,
  };
  const entry = { input: 200001, output: 200001, cacheCreation5m: 200001, cacheCreation1h: 200001, cacheRead: 200001 };
  assert.equal(costForEntry(entry, price, { costMode: 'calculate' }).costUSD, 2400000 + 120);
});
