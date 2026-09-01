'use strict';

// The savings field's trip through createUsageWiring: the rtk exec is a seam, so nothing here needs rtk
// installed. What matters is that a failing or absent rtk costs the rtk half and nothing else, that the
// process is not spawned once per report pull, and that the cache half is computed from the same model
// rows and price table the cost estimate uses.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUsageWiring, resolveUsageConfig, DEFAULT_USAGE_CONFIG, RTK_SAVINGS_TTL_MS } = require('../server/usage-wiring.ts');
const { normalizePricingTable } = require('../server/core/usage-pricing-core.ts');

const RTK_JSON = JSON.stringify({
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
    { date: '2026-08-21', commands: 191, input_tokens: 279800, output_tokens: 38040, saved_tokens: 241780, savings_pct: 86.41, total_time_ms: 19120, avg_time_ms: 100 },
  ],
});

const MODEL_ROWS = [
  { model: 'claude-sonnet-4-5', vendor: 'claude', cacheRead: 1_000_000, tokens: 1_200_000, costUSD: 3 },
  { model: 'gpt-5.5', vendor: 'codex', cacheRead: 4_000_000, tokens: 4_000_000, costUSD: 1 },
];

const PRICING = normalizePricingTable({
  'claude-sonnet-4-5': {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000003,
  },
});

function harness({
  usage = {},
  models = MODEL_ROWS,
  rtkPath = 'C:/fake/rtk.exe',
  execResult = { stdout: RTK_JSON, stderr: '' },
} = {}) {
  const execCalls = [];
  const rtkPathCalls = [];
  const clock = { now: 1_800_000_000_000 };
  const scanner = {
    runPass: async () => ({ newEntries: 1, partial: false }),
    sessionTotals: () => new Map(),
    stats: () => ({ resolutionError: null }),
    budgetSpend: () => ({ todayKey: '2026-08-21', monthKey: '2026-08', todayUsd: 0, monthUsd: 0 }),
    buildReport: () => ({
      ts: clock.now,
      tz: 'UTC',
      totals: { tokens: 0, costUSD: 0 },
      daily: [],
      models,
      sessions: [],
      blocks: [],
      activeBlock: null,
      anomaly: null,
      byLane: [{ lane: 'pr-review', costUSD: 4.2, tokens: 1000, sessions: 2 }],
      budget: { rows: [{ scope: 'daily', spentUsd: 12.4, budgetUsd: 16, pct: 77.5, tone: 'warn' }] },
      tokenLimit: null,
      pricing: { missing: [] },
      scan: { dirs: [], files: 0, entries: 0, lastScanMs: 0, partial: false },
    }),
  };
  const wiring = createUsageWiring({
    config: { usage },
    sessions: new Map(),
    broadcast: () => {},
    controlClientCount: () => 1,
    createScanner: () => scanner,
    loadPricingFn: async () => ({ table: PRICING, source: 'snapshot', fetchedAt: null }),
    nowFn: () => clock.now,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: { warn: () => {} },
    rtkPathFn: () => {
      rtkPathCalls.push(1);
      return rtkPath;
    },
    execFileAsync: async (file, args, options) => {
      execCalls.push({ file, args, options });
      if (execResult instanceof Error) throw execResult;
      return execResult;
    },
  });
  return { wiring, execCalls, rtkPathCalls, clock };
}

test('a report carries both savings halves, with rtk parsed off its own JSON', async () => {
  const h = harness();
  const report = await h.wiring.requestReport({});
  assert.deepEqual(report.savings.rtk, {
    available: true,
    commands: 250,
    inputTokens: 921837,
    outputTokens: 52209,
    savedTokens: 869660,
    savingsPct: 94.34,
    daily: [{ date: '2026-08-21', commands: 191, savedTokens: 241780, savingsPct: 86.41 }],
  });
  // Only the Claude row: 1M x (0.000003 - 0.0000003).
  assert.equal(Math.round(report.savings.cache.savedUSD * 100) / 100, 2.7);
  assert.equal(report.savings.cache.cacheReadTokens, 1_000_000);
  assert.deepEqual(report.savings.cache.unpricedModels, []);
});

test('the rtk call is the documented one, on the resolved binary', async () => {
  const h = harness();
  await h.wiring.requestReport({});
  assert.equal(h.execCalls.length, 1);
  assert.equal(h.execCalls[0].file, 'C:/fake/rtk.exe');
  assert.deepEqual(h.execCalls[0].args, ['gain', '--daily', '--format', 'json']);
  assert.equal(h.execCalls[0].options.encoding, 'utf8');
  assert.ok(h.execCalls[0].options.timeout > 0, 'a hung rtk cannot hold a report open');
  assert.ok(h.execCalls[0].options.maxBuffer > 0);
});

test('an rtk that fails costs the rtk half and nothing else', async () => {
  for (const execResult of [new Error('ENOENT'), { stdout: 'not json', stderr: '' }, { stdout: '{"nope":1}', stderr: '' }]) {
    const h = harness({ execResult });
    const report = await h.wiring.requestReport({});
    assert.deepEqual(report.savings.rtk, { available: false }, String(execResult));
    assert.equal(report.savings.cache.cacheReadTokens, 1_000_000, 'the cache half is unaffected');
    assert.equal(report.error, null, 'the report itself still lands');
    assert.equal(report.type, 'usage-report');
  }
});

test('no rtk binary reports unavailable and never spawns anything', async () => {
  const h = harness({ rtkPath: null });
  const report = await h.wiring.requestReport({});
  assert.deepEqual(report.savings.rtk, { available: false });
  assert.equal(h.execCalls.length, 0);
});

test('usage.rtkSavings false is fully inert: no path probe, no exec', async () => {
  const h = harness({ usage: { rtkSavings: false } });
  const report = await h.wiring.requestReport({});
  assert.deepEqual(report.savings.rtk, { available: false });
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.rtkPathCalls.length, 0, 'the binary is not even looked for');
});

// A report is pulled on every turn end while the tab is open, so an uncached reading would spawn a process
// per turn for numbers that move by a few hundred tokens.
test('a successful reading is cached for its TTL, then re-read', async () => {
  const h = harness();
  await h.wiring.requestReport({});
  await h.wiring.requestReport({});
  assert.equal(h.execCalls.length, 1, 'two pulls inside the window, one exec');

  h.clock.now += RTK_SAVINGS_TTL_MS - 1;
  await h.wiring.requestReport({});
  assert.equal(h.execCalls.length, 1, 'still inside the window');

  h.clock.now += 2;
  const report = await h.wiring.requestReport({});
  assert.equal(h.execCalls.length, 2, 'past the window, re-read');
  assert.equal(report.savings.rtk.savedTokens, 869660);
});

// A failure is deliberately not cached: an rtk installed or repaired mid-session should show up on the
// next pull rather than after a restart.
test('a failed reading is not cached', async () => {
  const h = harness({ execResult: new Error('EPERM') });
  await h.wiring.requestReport({});
  await h.wiring.requestReport({});
  assert.equal(h.execCalls.length, 2);
});

test('a report with no Claude cache reads carries a null cache half, not a zero one', async () => {
  const h = harness({ models: [{ model: 'gpt-5.5', vendor: 'codex', cacheRead: 4_000_000 }] });
  const report = await h.wiring.requestReport({});
  assert.equal(report.savings.cache, null);
  assert.equal(report.savings.rtk.available, true, 'the rtk half is independent');
});

test('savings is always present on a successful report, worst case doubly absent', async () => {
  const h = harness({ rtkPath: null, models: [] });
  const report = await h.wiring.requestReport({});
  assert.deepEqual(report.savings, { rtk: { available: false }, cache: null });
});

test('rtkSavings defaults on and round trips through resolveUsageConfig', () => {
  assert.equal(DEFAULT_USAGE_CONFIG.rtkSavings, true);
  assert.equal(resolveUsageConfig(undefined).rtkSavings, true);
  assert.equal(resolveUsageConfig({ rtkSavings: false }).rtkSavings, false);
  // Defensive like every other key: a hand-edited garbage value falls back to the default rather than
  // silently switching the reading off.
  assert.equal(resolveUsageConfig({ rtkSavings: 'no' }).rtkSavings, true);
});

// Change 1 regression: both fields exist on the scanner report and are read by the frontend, but the
// wiring re-projects the report field by field, so an omission here is invisible until the section never
// renders.
test('byLane and budget survive the report projection onto the wire', async () => {
  const h = harness();
  const report = await h.wiring.requestReport({});
  assert.deepEqual(report.byLane, [{ lane: 'pr-review', costUSD: 4.2, tokens: 1000, sessions: 2 }]);
  assert.deepEqual(report.budget.rows, [{ scope: 'daily', spentUsd: 12.4, budgetUsd: 16, pct: 77.5, tone: 'warn' }]);
});
