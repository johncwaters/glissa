'use strict';

// The budget evaluate-persist-broadcast cycle through createUsageWiring with every side effect injected.
// The 50/75/100 ladder itself is the committed core's own test; what matters here is that a threshold fires
// ONCE per period, survives a restart, re-arms on rollover, and that a broken or missing state file cannot
// take the lane down.
//
// The state file always lives in a temp dir: nothing here may write to the operator's real ~/.glissa.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createUsageWiring, resolveUsageConfig, budgetAlertText, DEFAULT_USAGE_CONFIG } = require('../server/usage-wiring.ts');

const TODAY = '2026-08-19';
const MONTH = '2026-08';

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'glissa-usage-budget-'));
}

/*
 * A fake scanner: this file is about the budget decision and its persistence, so the transcript walk is out
 * of the picture entirely. `spend` is mutable so a test can move the numbers between passes.
 */
function harness({ root, usage = {}, telegram = null, telegramNotifications = false, connections = 1, spend = { todayUsd: 0, monthUsd: 0 } } = {}) {
  const sent = [];
  const telegrams = [];
  const state = { spend };
  const scanner = {
    runPass: async () => ({ newEntries: 1, partial: false }),
    sessionTotals: () => new Map(),
    buildReport: () => ({ ts: 0, totals: {}, daily: [], models: [], sessions: [], blocks: [], activeBlock: null, tokenLimit: null, byLane: [{ lane: 'pr-review', costUSD: 4.2, tokens: 1000, sessions: 2 }], budget: { rows: [{ scope: 'daily', spentUsd: 12.4, budgetUsd: 16, pct: 77.5, tone: 'warn' }] }, pricing: { missing: [] }, scan: { dirs: [], files: 0, entries: 0, lastScanMs: 0, partial: false } }),
    stats: () => ({ resolutionError: null }),
    budgetSpend: () => ({ todayKey: TODAY, monthKey: MONTH, ...state.spend }),
  };
  const config = { usage, telegramNotifications, telegram };
  const wiring = createUsageWiring({
    config,
    sessions: new Map(),
    broadcast: (msg) => sent.push(msg),
    controlClientCount: () => connections,
    createScanner: () => scanner,
    loadPricingFn: async () => ({ table: {}, source: 'snapshot', fetchedAt: null }),
    nowFn: () => 1_800_000_000_000,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: { warn: () => {} },
    budgetStatePath: path.join(root, '.glissa', 'usage-budget-state.json'),
    sendTelegram: async (args) => { telegrams.push(args); },
    // This file is about budgets; an rtk reading here would exec a real binary on whatever machine runs
    // the suite (tests/usage-savings-wiring.test.js owns that path).
    rtkPathFn: () => null,
  });
  return {
    wiring,
    sent,
    telegrams,
    state,
    alerts: () => sent.filter((msg) => msg.type === 'usage-budget-alert'),
    statePath: path.join(root, '.glissa', 'usage-budget-state.json'),
  };
}

async function readState(statePath) {
  return JSON.parse(await fs.readFile(statePath, 'utf8'));
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

test('no budget configured is fully inert: no state file, no alerts', async () => {
  const root = await makeTempRoot();
  const h = harness({ root, spend: { todayUsd: 500, monthUsd: 5000 } });
  await h.wiring.start();
  assert.equal(h.alerts().length, 0);
  assert.equal(await exists(h.statePath), false);
  // And the default config carries no ceiling at all.
  assert.deepEqual(resolveUsageConfig(undefined).budget, { dailyUsd: null, monthlyUsd: null });
  assert.deepEqual(DEFAULT_USAGE_CONFIG.budget, { dailyUsd: null, monthlyUsd: null });
});

test('crossing a threshold broadcasts once and persists the fired mark', async () => {
  const root = await makeTempRoot();
  const h = harness({ root, usage: { budget: { dailyUsd: 16 } }, spend: { todayUsd: 12.4, monthUsd: 12.4 } });
  await h.wiring.start();
  const alerts = h.alerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].scope, 'daily');
  assert.equal(alerts[0].threshold, 75);
  assert.equal(alerts[0].spentUsd, 12.4);
  assert.equal(alerts[0].budgetUsd, 16);
  assert.equal(alerts[0].periodKey, TODAY);
  assert.ok(alerts[0].ts > 0);
  // The text travels ON the message, so the browser notification and the Telegram ping are one string.
  assert.equal(alerts[0].text, 'Usage budget: daily spend $12.40 reached 75% of $16.00');
  const stored = await readState(h.statePath);
  assert.deepEqual(stored.fired.daily[TODAY], [50, 75]);
});

test('a repeat pass at the same spend does not re-alert', async () => {
  const root = await makeTempRoot();
  const h = harness({ root, usage: { budget: { dailyUsd: 16 } }, spend: { todayUsd: 12.4, monthUsd: 12.4 } });
  await h.wiring.start();
  assert.equal(h.alerts().length, 1);
  // force:true always drives a pass (rate-limited to a plain one, which is still a completed pass).
  await h.wiring.requestReport({ force: true });
  await h.wiring.requestReport({ force: true });
  assert.equal(h.alerts().length, 1, 'still one');
});

test('a higher threshold later in the same period fires once more, the lower one never again', async () => {
  const root = await makeTempRoot();
  const h = harness({ root, usage: { budget: { dailyUsd: 16 } }, spend: { todayUsd: 12.4, monthUsd: 12.4 } });
  await h.wiring.start();
  assert.deepEqual(h.alerts().map((alert) => alert.threshold), [75]);
  h.state.spend = { todayUsd: 17, monthUsd: 17 };
  await h.wiring.requestReport({ force: true });
  assert.deepEqual(h.alerts().map((alert) => alert.threshold), [75, 100]);
  // Spend falling back must not re-arm anything inside the same period.
  h.state.spend = { todayUsd: 9, monthUsd: 9 };
  await h.wiring.requestReport({ force: true });
  assert.deepEqual(h.alerts().map((alert) => alert.threshold), [75, 100]);
});

// A restart must not re-alert what was already delivered: that is the whole reason the state is on disk.
test('the fired state survives a restart', async () => {
  const root = await makeTempRoot();
  const first = harness({ root, usage: { budget: { dailyUsd: 16 } }, spend: { todayUsd: 12.4, monthUsd: 12.4 } });
  await first.wiring.start();
  assert.equal(first.alerts().length, 1);

  const second = harness({ root, usage: { budget: { dailyUsd: 16 } }, spend: { todayUsd: 12.4, monthUsd: 12.4 } });
  await second.wiring.start();
  assert.equal(second.alerts().length, 0, 'a fresh process reads the marks off disk');
});

test('a new period re-arms the ladder and drops the old marks', async () => {
  const root = await makeTempRoot();
  await fs.mkdir(path.join(root, '.glissa'), { recursive: true });
  // Yesterday reached 100%; today must start clean.
  await fs.writeFile(path.join(root, '.glissa', 'usage-budget-state.json'), JSON.stringify({
    version: 1,
    fired: { daily: { '2026-08-18': [50, 75, 100] }, monthly: { '2026-07': [50] } },
  }));
  const h = harness({ root, usage: { budget: { dailyUsd: 16, monthlyUsd: 400 } }, spend: { todayUsd: 12.4, monthUsd: 210 } });
  await h.wiring.start();
  assert.deepEqual(h.alerts().map((alert) => `${alert.scope}:${alert.threshold}`), ['daily:75', 'monthly:50']);
  const stored = await readState(h.statePath);
  assert.equal(stored.fired.daily['2026-08-18'], undefined, 'last period pruned');
  assert.equal(stored.fired.monthly['2026-07'], undefined);
  assert.deepEqual(stored.fired.daily[TODAY], [50, 75]);
});

test('both scopes are independent', async () => {
  const root = await makeTempRoot();
  const h = harness({ root, usage: { budget: { dailyUsd: 100, monthlyUsd: 100 } }, spend: { todayUsd: 10, monthUsd: 80 } });
  await h.wiring.start();
  // Daily is at 10% (nothing), monthly at 80% (50 and 75 crossed, reported as the highest).
  assert.deepEqual(h.alerts().map((alert) => `${alert.scope}:${alert.threshold}`), ['monthly:75']);
});

test('a corrupt state file starts empty, warns, and still alerts', async () => {
  const root = await makeTempRoot();
  await fs.mkdir(path.join(root, '.glissa'), { recursive: true });
  await fs.writeFile(path.join(root, '.glissa', 'usage-budget-state.json'), '{ not json');
  const h = harness({ root, usage: { budget: { dailyUsd: 16 } }, spend: { todayUsd: 12.4, monthUsd: 12.4 } });
  await h.wiring.start();
  // Starting empty can only ever RE-fire an alert, never suppress a real one, so the alert still lands and
  // the file is rebuilt from this evaluation.
  assert.equal(h.alerts().length, 1);
  assert.deepEqual((await readState(h.statePath)).fired.daily[TODAY], [50, 75]);
});

test('an unwritable state path degrades to a warning, not a failed pass', async () => {
  const root = await makeTempRoot();
  const sent = [];
  const wiring = createUsageWiring({
    config: { usage: { budget: { dailyUsd: 16 } } },
    sessions: new Map(),
    broadcast: (msg) => sent.push(msg),
    controlClientCount: () => 1,
    createScanner: () => ({
      runPass: async () => ({ newEntries: 1, partial: false }),
      sessionTotals: () => new Map(),
      stats: () => ({ resolutionError: null }),
      budgetSpend: () => ({ todayKey: TODAY, monthKey: MONTH, todayUsd: 12.4, monthUsd: 12.4 }),
    }),
    loadPricingFn: async () => ({ table: {}, source: 'snapshot', fetchedAt: null }),
    nowFn: () => 1,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: { warn: () => {} },
    budgetStatePath: path.join(root, '.glissa', 'usage-budget-state.json'),
    fsPromises: { ...require('node:fs/promises'), writeFile: async () => { throw new Error('EACCES simulated'); } },
  });
  await wiring.start();
  // The alert still went out; only the durability of the mark was lost.
  assert.equal(sent.filter((msg) => msg.type === 'usage-budget-alert').length, 1);
  assert.equal(await exists(path.join(root, '.glissa', 'usage-budget-state.json')), false);
});

// A partial pass has seen an arbitrary slice of the tree; firing off an undercount would burn the threshold
// for the rest of the period.
test('a partial pass never evaluates budgets', async () => {
  const root = await makeTempRoot();
  const sent = [];
  const wiring = createUsageWiring({
    config: { usage: { budget: { dailyUsd: 16 } } },
    sessions: new Map(),
    broadcast: (msg) => sent.push(msg),
    controlClientCount: () => 1,
    createScanner: () => ({
      runPass: async () => ({ newEntries: 1, partial: true }),
      sessionTotals: () => new Map(),
      stats: () => ({ resolutionError: null }),
      budgetSpend: () => ({ todayKey: TODAY, monthKey: MONTH, todayUsd: 12.4, monthUsd: 12.4 }),
    }),
    loadPricingFn: async () => ({ table: {}, source: 'snapshot', fetchedAt: null }),
    nowFn: () => 1,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: { warn: () => {} },
    budgetStatePath: path.join(root, '.glissa', 'usage-budget-state.json'),
  });
  await wiring.start();
  assert.equal(sent.filter((msg) => msg.type === 'usage-budget-alert').length, 0);
  assert.equal(await exists(path.join(root, '.glissa', 'usage-budget-state.json')), false);
});

// ── Telegram: the session channel's zero-connections rule, reused rather than reimplemented ──

test('telegram fires only with the channel on, credentials present, and nobody watching', async () => {
  const credentials = { botToken: 'bot', chatId: 'chat' };
  const cases = [
    { label: 'nobody watching', connections: 0, telegramNotifications: true, telegram: credentials, expect: 1 },
    { label: 'a dashboard is open', connections: 1, telegramNotifications: true, telegram: credentials, expect: 0 },
    { label: 'channel off', connections: 0, telegramNotifications: false, telegram: credentials, expect: 0 },
    { label: 'no credentials', connections: 0, telegramNotifications: true, telegram: null, expect: 0 },
  ];
  for (const testCase of cases) {
    const root = await makeTempRoot();
    const h = harness({
      root,
      usage: { budget: { dailyUsd: 16 } },
      spend: { todayUsd: 12.4, monthUsd: 12.4 },
      connections: testCase.connections,
      telegramNotifications: testCase.telegramNotifications,
      telegram: testCase.telegram,
    });
    await h.wiring.start();
    assert.equal(h.telegrams.length, testCase.expect, testCase.label);
    // The broadcast is unconditional either way: the dashboard is the primary channel.
    assert.equal(h.alerts().length, 1, `${testCase.label}: broadcast regardless`);
    if (testCase.expect === 0) continue;
    assert.equal(h.telegrams[0].text, 'Usage budget: daily spend $12.40 reached 75% of $16.00');
    assert.equal(h.telegrams[0].botToken, 'bot');
    assert.equal(h.telegrams[0].chatId, 'chat');
  }
});

test('budgetAlertText: the one wording, plain and dash free', () => {
  assert.equal(
    budgetAlertText({ scope: 'daily', threshold: 75, spentUsd: 12.4, budgetUsd: 16 }),
    'Usage budget: daily spend $12.40 reached 75% of $16.00',
  );
  assert.equal(
    budgetAlertText({ scope: 'monthly', threshold: 100, spentUsd: 210.5, budgetUsd: 200 }),
    'Usage budget: monthly spend $210.50 reached 100% of $200.00',
  );
  for (const glyph of [String.fromCharCode(0x2014), String.fromCharCode(0x2013), String.fromCharCode(0x2026)]) {
    assert.equal(budgetAlertText({ scope: 'daily', threshold: 50, spentUsd: 1, budgetUsd: 2 }).includes(glyph), false);
  }
});

/*
 * requestReport re-projects the scanner's report field by field, so a field the scanner produces and the
 * dashboard reads can go missing without anything failing: the budget meters and the Glissa lanes section
 * simply never render. Both were dropped that way.
 */
test('byLane and budget reach the wire on a pulled report', async () => {
  const root = await makeTempRoot();
  const h = harness({ root });
  const report = await h.wiring.requestReport({ requestId: 'r1' });
  assert.equal(report.type, 'usage-report');
  assert.deepEqual(report.byLane, [{ lane: 'pr-review', costUSD: 4.2, tokens: 1000, sessions: 2 }]);
  assert.deepEqual(report.budget, { rows: [{ scope: 'daily', spentUsd: 12.4, budgetUsd: 16, pct: 77.5, tone: 'warn' }] });
  // And on the cached copy a reconnecting client is replayed.
  assert.deepEqual(h.wiring.getCachedReport().byLane, report.byLane);
  assert.deepEqual(h.wiring.getCachedReport().budget, report.budget);
});

// An alert is a moment, not a state: replaying it on reconnect would re-alert a crossing that already
// happened, possibly days later.
test('usage-budget-alert is not retained by the control replay log', () => {
  const { createReplayLog } = require('../server/control-replay-core.ts');
  const log = createReplayLog();
  log.stamp({ type: 'usage-budget-alert', scope: 'daily', threshold: 75 }, 1000);
  log.stamp({ type: 'notify', session: 's', category: 'complete' }, 1000);
  const replayed = log.entriesSince(0, 1000).entries.map((msg) => msg.type);
  assert.deepEqual(replayed, ['notify'], 'a moment is not replayed; a state is');
});
