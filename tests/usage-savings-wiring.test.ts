// The savings field's trip through createUsageWiring: the rtk exec is a seam, so nothing here needs rtk
// installed. What matters is that a failing or absent rtk costs the rtk half and nothing else, that the
// process is not spawned once per report pull, and that the cache half is computed from the same model
// rows and price table the cost estimate uses.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createUsageWiring, resolveUsageConfig, DEFAULT_USAGE_CONFIG, RTK_SAVINGS_TTL_MS,
} from '../server/usage-wiring.ts';
import { normalizePricingTable } from '../server/core/usage-pricing-core.ts';

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

interface ModelRow {
  key: string;
  model: string;
  vendor: string;
  entries: number;
  tokens: number;
  costUSD: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

function modelRow(model: string, vendor: string, cacheRead: number, tokens = 0, costUSD = 0): ModelRow {
  return { key: `${vendor}:${model}`, model, vendor, entries: 1, tokens, costUSD, input: 0, output: 0, cacheCreate: 0, cacheRead };
}

const MODEL_ROWS: ModelRow[] = [
  modelRow('claude-sonnet-4-5', 'claude', 1_000_000, 1_200_000, 3),
  modelRow('gpt-5.5', 'codex', 4_000_000, 4_000_000, 1),
];

const PRICING = normalizePricingTable({
  'claude-sonnet-4-5': {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000003,
  },
});

interface ExecCall {
  file: string;
  args: unknown;
  options: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// The wire report is a Record by design (usage-wiring answers the control plane), so the fields this
// suite asserts on are narrowed here once rather than at each assertion.
function blockAt(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  if (!isRecord(value)) throw new Error(`the report carries no ${key} block`);
  return value;
}

function numberAt(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number') throw new Error(`${key} is not a number`);
  return value;
}

function savingsOf(report: Record<string, unknown>): {
  rtk: Record<string, unknown>;
  cache: Record<string, unknown> | null;
} {
  const savings = blockAt(report, 'savings');
  const cache = savings.cache;
  if (cache !== null && !isRecord(cache)) throw new Error('the cache half is neither a block nor null');
  return { rtk: blockAt(savings, 'rtk'), cache };
}

interface HarnessOptions {
  usage?: Record<string, unknown>;
  models?: ModelRow[];
  rtkPath?: string | null;
  execResult?: Error | { stdout: string; stderr: string };
}

function harness({
  usage = {},
  models = MODEL_ROWS,
  rtkPath = 'C:/fake/rtk.exe',
  execResult = { stdout: RTK_JSON, stderr: '' },
}: HarnessOptions = {}) {
  const execCalls: ExecCall[] = [];
  let rtkPathCalls = 0;
  const clock = { now: 1_800_000_000_000 };
  const scanner = {
    runPass: async () => ({ files: 1, entries: 1, newEntries: 1, partial: false, durationMs: 0 }),
    sessionTotals: () => new Map(),
    stats: () => ({ dirs: [], files: 0, entries: 0, lastScanMs: 0, resolutionError: null }),
    budgetSpend: () => ({ todayKey: '2026-08-21', monthKey: '2026-08', todayUsd: 0, monthUsd: 0 }),
    buildReport: () => ({
      ts: clock.now,
      tz: 'UTC',
      blockHours: 5,
      totals: { tokens: 0, costUSD: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, byVendor: {} },
      daily: [],
      models,
      sessions: [],
      blocks: [],
      activeBlock: null,
      anomaly: { daily: null, burn: null },
      byLane: [{ lane: 'pr-review', costUSD: 4.2, tokens: 1000, sessions: 2 }],
      budget: {
        dailyUsd: 16,
        monthlyUsd: null,
        rows: [{ scope: 'daily' as const, spentUsd: 12.4, budgetUsd: 16, pct: 77.5, tone: 'warn' as const }],
      },
      tokenLimit: null,
      pricing: { missing: [] },
      scan: { dirs: [], files: 0, entries: 0, lastScanMs: 0, partial: false, resolutionError: null },
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
    setIntervalFn: () => {
      const handle = setTimeout(() => {}, 0);
      handle.unref();
      return handle;
    },
    clearIntervalFn: (handle) => clearTimeout(handle),
    logger: { warn: () => {}, log: () => {} },
    rtkPathFn: () => {
      rtkPathCalls += 1;
      return rtkPath;
    },
    execFileAsync: async (file, args, options) => {
      execCalls.push({ file, args, options: isRecord(options) ? options : {} });
      if (execResult instanceof Error) throw execResult;
      return execResult;
    },
  });
  return { wiring, execCalls, clock, rtkPathCallCount: () => rtkPathCalls };
}

test('a report carries both savings halves, with rtk parsed off its own JSON', async () => {
  const lane = harness();
  const report = await lane.wiring.requestReport({});
  assert.deepEqual(savingsOf(report).rtk, {
    available: true,
    commands: 250,
    inputTokens: 921837,
    outputTokens: 52209,
    savedTokens: 869660,
    savingsPct: 94.34,
    daily: [{ date: '2026-08-21', commands: 191, savedTokens: 241780, savingsPct: 86.41 }],
  });
  // Only the Claude row: 1M x (0.000003 - 0.0000003).
  const cache = savingsOf(report).cache;
  assert.ok(cache, 'the cache half was computed');
  assert.equal(Math.round(numberAt(cache, 'savedUSD') * 100) / 100, 2.7);
  assert.equal(numberAt(cache, 'cacheReadTokens'), 1_000_000);
  assert.deepEqual(cache.unpricedModels, []);
});

test('the rtk call is the documented one, on the resolved binary', async () => {
  const lane = harness();
  await lane.wiring.requestReport({});
  assert.equal(lane.execCalls.length, 1);
  const call = lane.execCalls[0];
  assert.equal(call.file, 'C:/fake/rtk.exe');
  assert.deepEqual(call.args, ['gain', '--daily', '--format', 'json']);
  assert.equal(call.options.encoding, 'utf8');
  assert.ok(numberAt(call.options, 'timeout') > 0, 'a hung rtk cannot hold a report open');
  assert.ok(numberAt(call.options, 'maxBuffer') > 0);
});

test('an rtk that fails costs the rtk half and nothing else', async () => {
  const failures: HarnessOptions['execResult'][] = [
    new Error('ENOENT'),
    { stdout: 'not json', stderr: '' },
    { stdout: '{"nope":1}', stderr: '' },
  ];
  for (const execResult of failures) {
    const lane = harness({ execResult });
    const report = await lane.wiring.requestReport({});
    const savings = savingsOf(report);
    assert.deepEqual(savings.rtk, { available: false }, String(execResult));
    assert.ok(savings.cache, 'the cache half is present');
    assert.equal(numberAt(savings.cache, 'cacheReadTokens'), 1_000_000, 'the cache half is unaffected');
    assert.equal(report.error, null, 'the report itself still lands');
    assert.equal(report.type, 'usage-report');
  }
});

test('no rtk binary reports unavailable and never spawns anything', async () => {
  const lane = harness({ rtkPath: null });
  const report = await lane.wiring.requestReport({});
  assert.deepEqual(savingsOf(report).rtk, { available: false });
  assert.equal(lane.execCalls.length, 0);
});

test('usage.rtkSavings false is fully inert: no path probe, no exec', async () => {
  const lane = harness({ usage: { rtkSavings: false } });
  const report = await lane.wiring.requestReport({});
  assert.deepEqual(savingsOf(report).rtk, { available: false });
  assert.equal(lane.execCalls.length, 0);
  assert.equal(lane.rtkPathCallCount(), 0, 'the binary is not even looked for');
});

// A report is pulled on every turn end while the tab is open, so an uncached reading would spawn a process
// per turn for numbers that move by a few hundred tokens.
test('a successful reading is cached for its TTL, then re-read', async () => {
  const lane = harness();
  await lane.wiring.requestReport({});
  await lane.wiring.requestReport({});
  assert.equal(lane.execCalls.length, 1, 'two pulls inside the window, one exec');

  lane.clock.now += RTK_SAVINGS_TTL_MS - 1;
  await lane.wiring.requestReport({});
  assert.equal(lane.execCalls.length, 1, 'still inside the window');

  lane.clock.now += 2;
  const report = await lane.wiring.requestReport({});
  assert.equal(lane.execCalls.length, 2, 'past the window, re-read');
  assert.equal(savingsOf(report).rtk.savedTokens, 869660);
});

// A failure is deliberately not cached: an rtk installed or repaired mid-session should show up on the
// next pull rather than after a restart.
test('a failed reading is not cached', async () => {
  const lane = harness({ execResult: new Error('EPERM') });
  await lane.wiring.requestReport({});
  await lane.wiring.requestReport({});
  assert.equal(lane.execCalls.length, 2);
});

test('a report with no Claude cache reads carries a null cache half, not a zero one', async () => {
  const lane = harness({ models: [modelRow('gpt-5.5', 'codex', 4_000_000)] });
  const report = await lane.wiring.requestReport({});
  const savings = savingsOf(report);
  assert.equal(savings.cache, null);
  assert.equal(savings.rtk.available, true, 'the rtk half is independent');
});

test('savings is always present on a successful report, worst case doubly absent', async () => {
  const lane = harness({ rtkPath: null, models: [] });
  const report = await lane.wiring.requestReport({});
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
  const lane = harness();
  const report = await lane.wiring.requestReport({});
  assert.deepEqual(report.byLane, [{ lane: 'pr-review', costUSD: 4.2, tokens: 1000, sessions: 2 }]);
  assert.deepEqual(blockAt(report, 'budget').rows, [{ scope: 'daily', spentUsd: 12.4, budgetUsd: 16, pct: 77.5, tone: 'warn' }]);
});
