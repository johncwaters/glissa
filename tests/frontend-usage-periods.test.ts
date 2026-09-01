// Week/month rollups, the calendar heatmap and the anomaly wording. All three are computed CLIENT-side from
// the merged daily rows the report already ships, so these are the only tests that pin them: the wire
// carries no weekly, monthly or heatmap array to check against.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { HeatmapCell, UsageModelRow, UsageWireRow } from '../public/usage-view-core.ts';

const importCore = () => import('../public/usage-view-core.ts');

interface DayOptions {
  tokens?: number;
  costUSD?: number;
  models?: UsageModelRow[] | null;
  source?: string;
}

function day(dayKey: string, { tokens = 100, costUSD = 1, models = null, source = undefined }: DayOptions = {}): UsageWireRow {
  const row: UsageWireRow = {
    day: dayKey,
    tokens,
    costUSD,
    input: tokens,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    models: models || [{ key: 'claude-opus-5', model: 'claude-opus-5', vendor: 'claude', tokens, costUSD, input: tokens, output: 0, cacheCreate: 0, cacheRead: 0 }],
  };
  if (source) row.source = source;
  return row;
}

// A rolled-up row is a wire record, so the fields a test reads off one are narrowed here rather than
// re-narrowed at every assertion.
function modelsOf(row: UsageWireRow | undefined): UsageModelRow[] {
  const models = row?.models;
  return Array.isArray(models) ? models : [];
}

function cellFor(cells: Map<string, HeatmapCell>, dayKey: string): HeatmapCell {
  const cell = cells.get(dayKey);
  assert.ok(cell, `the heatmap frame carries ${dayKey}`);
  return cell;
}

// ── Week and month keys ──

test('weekStartKey: weeks start Monday, including across a month boundary', async () => {
  const { weekStartKey } = await importCore();
  // 2026-08-19 is a Wednesday; its week begins Monday 2026-08-17.
  assert.equal(weekStartKey('2026-08-19'), '2026-08-17');
  assert.equal(weekStartKey('2026-08-17'), '2026-08-17', 'a Monday is its own week start');
  assert.equal(weekStartKey('2026-08-23'), '2026-08-17', 'Sunday still belongs to the Monday before it');
  // A week that spans the turn of the month stays ONE bucket rather than splitting at the boundary.
  assert.equal(weekStartKey('2026-09-01'), '2026-08-31');
  assert.equal(weekStartKey('2026-08-31'), '2026-08-31');
  // And across a year boundary.
  assert.equal(weekStartKey('2027-01-01'), '2026-12-28');
  assert.equal(weekStartKey('not-a-day'), '');
});

test('monthKey: calendar months, including December', async () => {
  const { monthKey } = await importCore();
  assert.equal(monthKey('2026-08-19'), '2026-08');
  assert.equal(monthKey('2026-12-31'), '2026-12');
  assert.equal(monthKey('2026-01-01'), '2026-01');
  assert.equal(monthKey('nope'), '');
});

test('weeklyRows: a week spanning two months is one bucket carrying both months of days', async () => {
  const { weeklyRows } = await importCore();
  // Mon 2026-08-31 through Wed 2026-09-02.
  const rows = weeklyRows([
    day('2026-08-31', { tokens: 100, costUSD: 1 }),
    day('2026-09-01', { tokens: 200, costUSD: 2 }),
    day('2026-09-02', { tokens: 300, costUSD: 3 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].day, '2026-08-31');
  assert.equal(rows[0].tokens, 600);
  assert.equal(rows[0].costUSD, 6);
  assert.equal(rows[0].days, 3, 'the day count travels with the bucket');
});

test('monthlyRows: days split at the month boundary even inside one week', async () => {
  const { monthlyRows } = await importCore();
  const rows = monthlyRows([
    day('2026-08-31', { tokens: 100, costUSD: 1 }),
    day('2026-09-01', { tokens: 200, costUSD: 2 }),
  ]).sort((a, b) => String(a.day).localeCompare(String(b.day)));
  assert.deepEqual(rows.map((row) => row.day), ['2026-08', '2026-09']);
  assert.equal(rows[0].tokens, 100);
  assert.equal(rows[1].tokens, 200);
});

test('period rollups merge the per-model breakdown, keeping the same row shape', async () => {
  const { weeklyRows } = await importCore();
  const opus = (tokens: number, cost: number): UsageModelRow => ({ key: 'claude-opus-5', model: 'claude-opus-5', vendor: 'claude', tokens, costUSD: cost, input: tokens, output: 0, cacheCreate: 0, cacheRead: 0 });
  const codex = (tokens: number, cost: number): UsageModelRow => ({ key: 'gpt-5.5', model: 'gpt-5.5', vendor: 'codex', tokens, costUSD: cost, input: tokens, output: 0, cacheCreate: 0, cacheRead: 0 });
  const rows = weeklyRows([
    day('2026-08-17', { tokens: 300, costUSD: 3, models: [opus(200, 2), codex(100, 1)] }),
    day('2026-08-18', { tokens: 100, costUSD: 1, models: [opus(100, 1)] }),
  ]);
  assert.equal(rows.length, 1);
  // Biggest model first, same as a daily row's breakdown.
  assert.deepEqual(modelsOf(rows[0]).map((model) => [model.model, model.tokens]), [['claude-opus-5', 300], ['gpt-5.5', 100]]);
  assert.equal(modelsOf(rows[0])[1].vendor, 'codex', 'the vendor survives the rollup');
});

// A period is only "remembered" when every day in it is: one live day makes the total a live claim.
test('period source: history only when every day in the bucket is history', async () => {
  const { weeklyRows, historyNote } = await importCore();
  const allHistory = weeklyRows([
    day('2026-08-17', { source: 'history' }),
    day('2026-08-18', { source: 'history' }),
  ]);
  assert.equal(allHistory[0].source, 'history');
  const mixed = weeklyRows([
    day('2026-08-17', { source: 'history' }),
    day('2026-08-18'),
  ]);
  assert.equal(mixed[0].source, 'live');
  assert.equal(historyNote([day('2026-08-17', { source: 'history' })]), 'older days from local history');
  assert.equal(historyNote([day('2026-08-17')]), '');
  assert.equal(historyNote(null), '');
});

// A period row mirrors a daily row's shape, vendors included, so a consumer cannot have to branch on which
// view it was handed.
test('period rows carry the union of the vendors under them', async () => {
  const { weeklyRows, monthlyRows } = await importCore();
  const opus = { key: 'claude-opus-5', model: 'claude-opus-5', vendor: 'claude', tokens: 100, costUSD: 1, input: 100, output: 0, cacheCreate: 0, cacheRead: 0 };
  const codex = { key: 'gpt-5.5', model: 'gpt-5.5', vendor: 'codex', tokens: 50, costUSD: 1, input: 50, output: 0, cacheCreate: 0, cacheRead: 0 };
  const rows = weeklyRows([
    { ...day('2026-08-17', { models: [opus] }), vendors: ['claude'] },
    { ...day('2026-08-18', { models: [codex] }), vendors: ['codex'] },
  ]);
  assert.deepEqual(rows[0].vendors, ['claude', 'codex']);
  assert.deepEqual(monthlyRows([{ ...day('2026-08-17', { models: [opus] }), vendors: ['claude'] }])[0].vendors, ['claude']);
  // A history row is rebuilt from stored day-by-model rollups, so its vendors come off the model rows.
  const historyOnly = weeklyRows([day('2026-08-17', { models: [codex], source: 'history' })]);
  assert.deepEqual(historyOnly[0].vendors, ['codex']);
  // Same key as a daily row, so the shape matches even when nothing is known.
  assert.deepEqual(weeklyRows([{ day: '2026-08-17', tokens: 1, costUSD: 1, models: [] }])[0].vendors, []);
});

test('periodRows and periodLabel: one switch, three views, one label rule', async () => {
  const { periodRows, periodLabel, periodHint, PERIOD_VIEWS, DEFAULT_PERIOD_VIEW } = await importCore();
  const daily = [day('2026-08-17'), day('2026-08-18')];
  assert.equal(periodRows(daily, 'day').length, 2);
  assert.equal(periodRows(daily, 'week').length, 1);
  assert.equal(periodRows(daily, 'month').length, 1);
  // An unknown view falls back to days rather than rendering nothing.
  assert.equal(periodRows(daily, 'decade').length, 2);
  assert.equal(periodRows(null, 'day').length, 0);
  assert.equal(periodLabel('2026-08-17', 'day'), 'Aug 17');
  assert.equal(periodLabel('2026-08-17', 'week'), 'week of Aug 17');
  assert.equal(periodLabel('2026-08', 'month'), 'Aug 2026');
  assert.equal(periodLabel('bad', 'month'), 'bad');
  assert.equal(periodHint('week'), 'weeks start Monday');
  assert.equal(periodHint('month'), 'calendar months');
  assert.deepEqual(PERIOD_VIEWS.map((view) => view.value), ['day', 'week', 'month']);
  assert.equal(DEFAULT_PERIOD_VIEW, 'day');
  // Every view is selectable by the switch, or a label would have no button.
  assert.ok(PERIOD_VIEWS.every((view) => typeof view.label === 'string' && view.label.length > 0));
});

// ── Heatmap ──

test('heatmapCells: 16 week columns of Monday-to-Sunday rows, anchored on this week', async () => {
  const { heatmapCells, HEATMAP_WEEKS, HEATMAP_DAY_LABELS } = await importCore();
  const today = new Date(2026, 7, 19, 12); // Wednesday
  const { cells, weeks } = heatmapCells([day('2026-08-18')], { today });
  assert.equal(weeks, HEATMAP_WEEKS);
  assert.equal(cells.length, HEATMAP_WEEKS * 7);
  assert.equal(HEATMAP_DAY_LABELS.length, 7);
  assert.equal(HEATMAP_DAY_LABELS[0], 'Mon');
  // The last column is the current week, and its Monday is this week's Monday.
  const lastColumn = cells.filter((cell) => cell.week === HEATMAP_WEEKS - 1);
  assert.equal(lastColumn.length, 7);
  assert.equal(lastColumn[0].day, '2026-08-17');
  assert.equal(lastColumn[0].weekday, 0);
  assert.equal(lastColumn[6].day, '2026-08-23');
});

// An observed zero and an unobserved day are different claims: colouring them alike would invent quiet
// days that were never seen.
test('heatmapCells: an empty day in range is distinct from a no-data day', async () => {
  const { heatmapCells } = await importCore();
  const today = new Date(2026, 7, 19, 12);
  const { cells } = heatmapCells([
    day('2026-08-10', { tokens: 500 }),
    day('2026-08-18', { tokens: 100 }),
  ], { today });
  const byDay = new Map(cells.map((cell) => [cell.day, cell]));
  // Between the two observed days: in range, no usage. A real zero.
  assert.equal(cellFor(byDay, '2026-08-12').noData, false);
  assert.equal(cellFor(byDay, '2026-08-12').tokens, 0);
  assert.equal(cellFor(byDay, '2026-08-12').tone, 0);
  // Before the series began, and after today: absences.
  assert.equal(cellFor(byDay, '2026-08-09').noData, true);
  assert.equal(cellFor(byDay, '2026-08-20').noData, true);
  assert.equal(cellFor(byDay, '2026-08-18').noData, false);
});

test('heatmapTone: four filled steps scaled to the window peak, zero for nothing', async () => {
  const { heatmapTone } = await importCore();
  assert.equal(heatmapTone(0, 1000), 0);
  assert.equal(heatmapTone(100, 0), 0, 'no peak means no tone');
  assert.equal(heatmapTone(10, 1000), 1, 'a small nonzero day is still visible');
  assert.equal(heatmapTone(300, 1000), 2);
  assert.equal(heatmapTone(600, 1000), 3);
  assert.equal(heatmapTone(1000, 1000), 4);
  assert.equal(heatmapTone(2000, 1000), 4, 'never above the top step');
});

test('heatmapCells: scaled to the window peak, and marks remembered days', async () => {
  const { heatmapCells } = await importCore();
  const today = new Date(2026, 7, 19, 12);
  const { cells, max } = heatmapCells([
    day('2026-08-18', { tokens: 1000 }),
    day('2026-08-17', { tokens: 100, source: 'history' }),
  ], { today });
  assert.equal(max, 1000);
  const byDay = new Map(cells.map((cell) => [cell.day, cell]));
  assert.equal(cellFor(byDay, '2026-08-18').tone, 4);
  assert.equal(cellFor(byDay, '2026-08-17').tone, 1);
  assert.equal(cellFor(byDay, '2026-08-17').source, 'history');
  assert.deepEqual(heatmapCells([], { today }).cells.length, 16 * 7, 'an empty series still renders the frame');
});

test('heatmapCellTitle: the day, its tokens and its cost, or why there is nothing', async () => {
  const { heatmapCellTitle } = await importCore();
  assert.equal(heatmapCellTitle({ day: '2026-08-03', tokens: 1200000, costUSD: 14.2 }), 'Aug 3: 1.2M tokens, $14.20');
  assert.equal(heatmapCellTitle({ day: '2026-08-03', tokens: 0, costUSD: 0 }), 'Aug 3: no usage');
  assert.equal(heatmapCellTitle({ day: '2026-08-03', noData: true }), 'Aug 3: no data');
});

// ── Anomaly ──

test('anomalyLine: the wording names the comparison, not just "unusual"', async () => {
  const { anomalyLine, anomalyTone, hasAnomaly, NO_ANOMALY_LINE } = await importCore();
  const daily = { kind: 'daily', todayUsd: 31, todayTokens: 5000, baselineUsd: 10, ratio: 3.1, baselineDays: 30 };
  assert.equal(
    anomalyLine({ daily, burn: null }),
    'Today is 3.1x the 30 day average: $31.00 against $10.00.',
  );
  // A burn spike only speaks when there is no daily one: two alarms about the same afternoon is noise.
  const burn = { kind: 'burn', current: 500000, baseline: 200000, ratio: 2.5 };
  assert.equal(
    anomalyLine({ daily: null, burn }),
    'This block is burning 2.5x the usual rate: 500k tokens per minute against 200k.',
  );
  assert.match(anomalyLine({ daily, burn }), /^Today is 3\.1x/, 'the daily comparison leads');
  assert.equal(anomalyLine(null), '');
  assert.equal(anomalyLine({ daily: null, burn: null }), '');
  assert.equal(anomalyTone({ daily }), 'warn');
  assert.equal(anomalyTone({ daily: null, burn: null }), 'ok');
  assert.equal(anomalyTone(null), 'ok');
  assert.equal(hasAnomaly({ burn }), true);
  assert.equal(hasAnomaly({ daily: null, burn: null }), false);
  assert.equal(hasAnomaly(null), false);
  assert.ok(NO_ANOMALY_LINE.length > 0, 'the quiet case still says something');
});

test('an anomaly raises the tab attention dot on its own', async () => {
  const { hasUsageAttention } = await importCore();
  const calm = { tokenLimit: null, anomaly: { daily: null, burn: null } };
  assert.equal(hasUsageAttention(calm), false);
  const flagged = { tokenLimit: null, anomaly: { daily: { ratio: 3, todayUsd: 30, baselineUsd: 10 }, burn: null } };
  assert.equal(hasUsageAttention(flagged), true, 'nothing else would surface it');
  // And it does not mask the limit checks it sits beside.
  assert.equal(hasUsageAttention({ tokenLimit: { max: 10, pct: 0.9 }, anomaly: null }), true);
});

test('no forbidden characters reach the DOM from the new builders', async () => {
  const core = await importCore();
  const forbidden = [String.fromCharCode(0x2014), String.fromCharCode(0x2013), String.fromCharCode(0x2026)];
  const produced = [core.NO_ANOMALY_LINE, ...core.HEATMAP_DAY_LABELS, ...core.PERIOD_VIEWS.map((view) => view.label)];
  for (const view of ['day', 'week', 'month', 'other']) {
    produced.push(core.periodHint(view), core.periodLabel('2026-08-17', view), core.periodLabel('2026-08', view));
  }
  produced.push(core.historyNote([day('2026-08-17', { source: 'history' })]));
  produced.push(core.heatmapCellTitle({ day: '2026-08-03', tokens: 1200000, costUSD: 14.2 }));
  produced.push(core.heatmapCellTitle({ day: '2026-08-03', noData: true }));
  produced.push(core.anomalyLine({ daily: { ratio: 3.1, todayUsd: 31, baselineUsd: 10, baselineDays: 30 } }));
  produced.push(core.anomalyLine({ burn: { ratio: 2.5, current: 500000, baseline: 200000 } }));
  for (const value of produced) {
    assert.equal(typeof value, 'string');
    for (const glyph of forbidden) assert.equal(value.includes(glyph), false, `forbidden character in ${JSON.stringify(value)}`);
  }
});

// ── Spend budgets ──
// The rows and their tones come from server/core/usage-budget-core.ts; these only format them and decide
// when the tab dot is owed, so an unset budget must render nothing rather than a zero ceiling.

test('budgetRows: only rows with a real ceiling, nothing at all without a budget', async () => {
  const { budgetRows } = await importCore();
  const report = { budget: { rows: [
    { scope: 'daily', spentUsd: 12.4, budgetUsd: 16, pct: 77.5, tone: 'warn' },
    { scope: 'monthly', spentUsd: 210, budgetUsd: null, pct: 0, tone: 'ok' },
  ] } };
  assert.deepEqual(budgetRows(report).map((row) => row.scope), ['daily']);
  assert.deepEqual(budgetRows({ budget: null }), []);
  assert.deepEqual(budgetRows({}), []);
  assert.deepEqual(budgetRows(null), []);
  assert.deepEqual(budgetRows({ budget: { rows: 'nope' } }), []);
});

test('budget row formatting: a position, not a bare percentage', async () => {
  const { budgetRowText, budgetRowPct, budgetScopeLabel, budgetRowMeterLabel } = await importCore();
  const row = { scope: 'daily', spentUsd: 12.4, budgetUsd: 16, pct: 77.5, tone: 'warn' };
  assert.equal(budgetRowText(row), '$12.40 of $16.00');
  assert.equal(budgetRowPct(row), 77.5);
  assert.equal(budgetScopeLabel('daily'), 'today');
  assert.equal(budgetScopeLabel('monthly'), 'this month');
  assert.equal(budgetRowMeterLabel(row), 'today spend against budget');
  // Missing numbers read as zero rather than breaking the meter geometry.
  assert.equal(budgetRowPct({}), 0);
  assert.equal(budgetRowText({}), '$0.00 of $0.00');
});

test('a budget at or past 90 percent raises the tab dot on its own', async () => {
  const { hasUsageAttention, BUDGET_ATTENTION_PCT } = await importCore();
  assert.equal(BUDGET_ATTENTION_PCT, 90);
  const at = (pct: number) => ({ tokenLimit: null, anomaly: null, budget: { rows: [{ scope: 'daily', spentUsd: 1, budgetUsd: 2, pct, tone: 'crit' }] } });
  assert.equal(hasUsageAttention(at(89.9)), false);
  assert.equal(hasUsageAttention(at(90)), true);
  assert.equal(hasUsageAttention(at(150)), true);
  assert.equal(hasUsageAttention({ budget: null }), false);
  // It composes with the other two arbiters rather than replacing either.
  assert.equal(hasUsageAttention(at(95)), true);
  assert.equal(hasUsageAttention(at(10)), false);
  assert.equal(hasUsageAttention({ tokenLimit: { max: 10, pct: 0.95 }, budget: null }), true);
});

// ── Glissa lanes ──
// The section exists only because Glissa spawned the sessions; the join is exact, so `other` means "not
// spawned by Glissa" rather than "unrecognized". It stays hidden until that distinction has content.

test('laneRows and laneLabel: known lanes get names, unknown ids pass through', async () => {
  const { laneRows, laneLabel } = await importCore();
  const report = { byLane: [
    { lane: 'pr-review', tokens: 100, costUSD: 4.2, sessions: 2 },
    { lane: 'other', tokens: 10, costUSD: 0.5, sessions: 1 },
  ] };
  assert.deepEqual(laneRows(report).map((row) => row.lane), ['pr-review', 'other']);
  assert.deepEqual(laneRows({ byLane: null }), []);
  assert.deepEqual(laneRows({}), []);
  assert.deepEqual(laneRows(null), []);
  assert.equal(laneLabel('pr-review'), 'PR review');
  assert.equal(laneLabel('pack-distill'), 'Pack distiller');
  assert.equal(laneLabel('posthog'), 'PostHog');
  assert.equal(laneLabel('interactive'), 'Interactive');
  assert.equal(laneLabel('other'), 'Other');
  // A lane added server-side before this map knows about it still renders under its own id.
  assert.equal(laneLabel('some-new-lane'), 'some-new-lane');
  assert.equal(laneLabel(''), 'Other');
});

test('the lanes section stays hidden until a real automation lane has spend', async () => {
  const { hasLaneAttribution } = await importCore();
  // A fresh install: only the operator's own sessions, so the section would just restate the totals.
  assert.equal(hasLaneAttribution({ byLane: [{ lane: 'interactive', tokens: 1, costUSD: 1, sessions: 1 }] }), false);
  assert.equal(hasLaneAttribution({ byLane: [
    { lane: 'interactive', tokens: 1, costUSD: 1, sessions: 1 },
    { lane: 'other', tokens: 1, costUSD: 1, sessions: 1 },
  ] }), false);
  // One automation lane is enough to make the split worth showing.
  assert.equal(hasLaneAttribution({ byLane: [
    { lane: 'interactive', tokens: 1, costUSD: 1, sessions: 1 },
    { lane: 'pr-review', tokens: 1, costUSD: 1, sessions: 1 },
  ] }), true);
  assert.equal(hasLaneAttribution({ byLane: [] }), false);
  assert.equal(hasLaneAttribution(null), false);
});

test('laneSessionsText and the scope hint say what is and is not counted', async () => {
  const { laneSessionsText, LANE_SCOPE_HINT } = await importCore();
  assert.equal(laneSessionsText(1), '1 session');
  assert.equal(laneSessionsText(4), '4 sessions');
  assert.equal(laneSessionsText(1234), '1,234 sessions');
  assert.equal(laneSessionsText(0), '');
  assert.equal(laneSessionsText(null), '');
  // The hint has to name the boundary, since a terminal session's spend appears here as `other`.
  assert.match(LANE_SCOPE_HINT, /spawned by Glissa/);
  assert.match(LANE_SCOPE_HINT, /other/);
  for (const glyph of [String.fromCharCode(0x2014), String.fromCharCode(0x2013), String.fromCharCode(0x2026)]) {
    assert.equal(LANE_SCOPE_HINT.includes(glyph), false);
  }
});
