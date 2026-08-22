'use strict';

// The two halves of the Savings section, both pure: normalizing what the rtk CLI prints, and pricing the
// prompt-cache reads the report already counted. The rtk sample below is verbatim from a live
// `rtk gain --daily --format json` (rtk 0.45.0), so a change in that output breaks this rather than
// silently reporting zeros on the dashboard.

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeCacheSavings, normalizeRtkGain } = require('../server/core/usage-savings-core');
const { normalizePricingTable, ratesForPrice } = require('../server/core/usage-pricing-core');

const RTK_SAMPLE = {
  summary: {
    total_commands: 250,
    total_input: 921837,
    total_output: 52209,
    total_saved: 869660,
    avg_savings_pct: 94.34,
    total_time_ms: 23512,
    avg_time_ms: 94,
  },
  daily: [
    {
      date: '2026-08-21',
      commands: 191,
      input_tokens: 279800,
      output_tokens: 38040,
      saved_tokens: 241780,
      savings_pct: 86.41,
      total_time_ms: 19120,
      avg_time_ms: 100,
    },
  ],
};

// A tiny table rather than the bundled snapshot: the arithmetic under test is the rate spread, and a real
// table would tie this test to whatever LiteLLM last published.
function pricingTable() {
  return normalizePricingTable({
    'claude-sonnet-4-5': {
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cache_read_input_token_cost: 0.0000003,
    },
    'cheap-cache-model': {
      input_cost_per_token: 0.000002,
      // No cache_read entry at all: ratesForPrice defaults it to a tenth of input.
    },
  });
}

test('normalizeRtkGain: the live shape maps onto the wire contract', () => {
  const gain = normalizeRtkGain(RTK_SAMPLE);
  assert.deepEqual(gain, {
    commands: 250,
    inputTokens: 921837,
    outputTokens: 52209,
    savedTokens: 869660,
    savingsPct: 94.34,
    daily: [{ date: '2026-08-21', commands: 191, savedTokens: 241780, savingsPct: 86.41 }],
  });
});

test('normalizeRtkGain: zero stats are a real reading, not an absent one', () => {
  const gain = normalizeRtkGain({
    summary: { total_commands: 0, total_input: 0, total_output: 0, total_saved: 0, avg_savings_pct: 0 },
    daily: [],
  });
  assert.equal(gain.commands, 0);
  assert.equal(gain.savedTokens, 0);
  assert.deepEqual(gain.daily, []);
});

test('normalizeRtkGain: an absent or unusable daily series degrades to empty', () => {
  for (const daily of [undefined, null, 'nope', 42, {}]) {
    const gain = normalizeRtkGain({ summary: RTK_SAMPLE.summary, daily });
    assert.deepEqual(gain.daily, [], `daily=${JSON.stringify(daily)}`);
    assert.equal(gain.savedTokens, 869660, 'the summary still counts');
  }
});

test('normalizeRtkGain: a row with no usable date is dropped, the rest survive', () => {
  const gain = normalizeRtkGain({
    summary: RTK_SAMPLE.summary,
    daily: [
      { date: 'yesterday', saved_tokens: 10 },
      { date: '', saved_tokens: 10 },
      { date: 42, saved_tokens: 10 },
      { saved_tokens: 10 },
      null,
      { date: '2026-08-20', commands: 5, saved_tokens: 700, savings_pct: 90 },
    ],
  });
  assert.deepEqual(gain.daily, [{ date: '2026-08-20', commands: 5, savedTokens: 700, savingsPct: 90 }]);
});

test('normalizeRtkGain: every number is coerced, a garbage one reads as zero', () => {
  const gain = normalizeRtkGain({
    summary: { total_commands: '250', total_input: null, total_output: Number.NaN, total_saved: Number.POSITIVE_INFINITY, avg_savings_pct: 94.34 },
    daily: [{ date: '2026-08-21', commands: 'lots', saved_tokens: undefined, savings_pct: 86.41 }],
  });
  assert.equal(gain.commands, 0);
  assert.equal(gain.inputTokens, 0);
  assert.equal(gain.outputTokens, 0);
  assert.equal(gain.savedTokens, 0);
  assert.equal(gain.savingsPct, 94.34);
  assert.deepEqual(gain.daily, [{ date: '2026-08-21', commands: 0, savedTokens: 0, savingsPct: 86.41 }]);
});

test('normalizeRtkGain: a payload with no usable summary is null, never a zeroed reading', () => {
  for (const parsed of [null, undefined, 'nope', 42, [], {}, { summary: null }, { summary: 'x' }, { summary: [] }]) {
    assert.equal(normalizeRtkGain(parsed), null, JSON.stringify(parsed));
  }
});

// ── Cache savings ──

test('computeCacheSavings: priced rows pay the input-to-cache-read spread', () => {
  const savings = computeCacheSavings(
    [
      { model: 'claude-sonnet-4-5', vendor: 'claude', cacheRead: 1_000_000 },
      { model: 'cheap-cache-model', vendor: 'claude', cacheRead: 500_000 },
    ],
    pricingTable(),
  );
  // 1M x (0.000003 - 0.0000003) = 2.70, plus 500k x (0.000002 - 0.0000002) = 0.90.
  assert.equal(Math.round(savings.savedUSD * 100) / 100, 3.6);
  assert.equal(savings.cacheReadTokens, 1_500_000);
  assert.deepEqual(savings.unpricedModels, []);
});

test('computeCacheSavings: an unpriced model contributes tokens but no dollars, and is named', () => {
  const savings = computeCacheSavings(
    [
      { model: 'claude-sonnet-4-5', vendor: 'claude', cacheRead: 1_000_000 },
      { model: 'zzz-unknown-model', vendor: 'claude', cacheRead: 400_000 },
      { model: 'zzz-unknown-model', vendor: 'claude', cacheRead: 100_000 },
    ],
    pricingTable(),
  );
  assert.equal(Math.round(savings.savedUSD * 100) / 100, 2.7, 'only the priced row pays');
  assert.equal(savings.cacheReadTokens, 1_500_000, 'its tokens still count');
  assert.deepEqual(savings.unpricedModels, ['zzz-unknown-model'], 'listed once');
});

test('computeCacheSavings: other vendors are ignored entirely', () => {
  const savings = computeCacheSavings(
    [
      { model: 'gpt-5.5', vendor: 'codex', cacheRead: 9_000_000 },
      { model: 'grok-4.5', vendor: 'grok', cacheRead: 9_000_000 },
      { model: 'claude-sonnet-4-5', vendor: 'claude', cacheRead: 1_000_000 },
    ],
    pricingTable(),
  );
  assert.equal(savings.cacheReadTokens, 1_000_000);
  assert.equal(Math.round(savings.savedUSD * 100) / 100, 2.7);
});

test('computeCacheSavings: a row with no vendor is Claude, matching the aggregate rule', () => {
  const savings = computeCacheSavings([{ model: 'claude-sonnet-4-5', cacheRead: 1_000_000 }], pricingTable());
  assert.equal(savings.cacheReadTokens, 1_000_000);
});

test('computeCacheSavings: nothing read from cache is null, not a zero saving', () => {
  const table = pricingTable();
  assert.equal(computeCacheSavings([], table), null);
  assert.equal(computeCacheSavings(null, table), null);
  assert.equal(computeCacheSavings([{ model: 'claude-sonnet-4-5', vendor: 'claude', cacheRead: 0 }], table), null);
  assert.equal(computeCacheSavings([{ model: 'gpt-5.5', vendor: 'codex', cacheRead: 5000 }], table), null);
});

// A cache read costing MORE than fresh input is not a saving; reporting it as a negative one would let a
// mispriced model eat a real saving from another row.
test('computeCacheSavings: an inverted rate spread clamps to zero rather than going negative', () => {
  const table = normalizePricingTable({
    'inverted-model': { input_cost_per_token: 0.0000001, cache_read_input_token_cost: 0.000009 },
    'claude-sonnet-4-5': { input_cost_per_token: 0.000003, cache_read_input_token_cost: 0.0000003 },
  });
  const savings = computeCacheSavings(
    [
      { model: 'inverted-model', vendor: 'claude', cacheRead: 1_000_000 },
      { model: 'claude-sonnet-4-5', vendor: 'claude', cacheRead: 1_000_000 },
    ],
    table,
  );
  assert.equal(Math.round(savings.savedUSD * 100) / 100, 2.7);
  assert.equal(savings.cacheReadTokens, 2_000_000);
});

// ratesForPrice is the shared rate reader; the savings core needs it exported rather than reimplementing
// the cache-read default and drifting from what the cost estimate charges.
test('ratesForPrice is exported and still defaults cache read to a tenth of input', () => {
  assert.equal(typeof ratesForPrice, 'function');
  const rates = ratesForPrice({ input_cost_per_token: 0.000002 });
  assert.equal(rates.input, 0.000002);
  assert.equal(rates.cacheRead, 0.0000002);
  const explicit = ratesForPrice({ input_cost_per_token: 0.000003, cache_read_input_token_cost: 0.0000003 });
  assert.equal(explicit.cacheRead, 0.0000003);
});
