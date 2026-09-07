import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUDGET_THRESHOLDS,
  budgetStanding,
  evaluateBudget,
  markFired,
  mergeFiredState,
  normalizeBudgetConfig,
} from '../server/core/usage-budget-core.ts';
import type { BudgetAlert, BudgetFiredState } from '../server/core/usage-budget-core.ts';

function stampAlerts(firedState: BudgetFiredState, alerts: BudgetAlert[]): BudgetFiredState {
  for (const alert of alerts) {
    for (const threshold of alert.thresholds) markFired(firedState, alert.scope, alert.periodKey, threshold);
  }
  return firedState;
}

test('normalizeBudgetConfig keeps finite positive numbers only', () => {
  assert.deepEqual(normalizeBudgetConfig({ dailyUsd: 10, monthlyUsd: 0 }), { dailyUsd: 10, monthlyUsd: null });
  assert.deepEqual(normalizeBudgetConfig({ dailyUsd: Number.POSITIVE_INFINITY, monthlyUsd: -1 }), { dailyUsd: null, monthlyUsd: null });
  assert.deepEqual(normalizeBudgetConfig(null), { dailyUsd: null, monthlyUsd: null });
  assert.deepEqual(BUDGET_THRESHOLDS, [50, 75, 100]);
});

test('evaluateBudget fires when spending crosses a ladder threshold', () => {
  const evaluated = evaluateBudget({
    budget: { dailyUsd: 10 },
    todayUsd: 5,
    todayKey: '2026-08-19',
  });
  assert.deepEqual(evaluated.alerts, [
    { scope: 'daily', threshold: 50, thresholds: [50], spentUsd: 5, budgetUsd: 10, periodKey: '2026-08-19' },
  ]);
  assert.deepEqual(evaluated.firedState, { daily: {}, monthly: {} }, 'the returned state is pruned, never stamped');
});

test('evaluateBudget fires only the highest new threshold', () => {
  const evaluated = evaluateBudget({
    budget: { dailyUsd: 10 },
    todayUsd: 12,
    todayKey: '2026-08-19',
  });
  assert.deepEqual(evaluated.alerts.map((alert) => alert.threshold), [100]);
  assert.deepEqual(evaluated.alerts.map((alert) => alert.thresholds), [[50, 75, 100]]);
});

test('evaluateBudget fires once per period and threshold', () => {
  const first = evaluateBudget({ budget: { dailyUsd: 10 }, todayUsd: 5, todayKey: '2026-08-19' });
  const stamped = stampAlerts(first.firedState, first.alerts);
  const second = evaluateBudget({ budget: { dailyUsd: 10 }, todayUsd: 6, todayKey: '2026-08-19' }, stamped);
  assert.deepEqual(second.alerts, []);
});

test('evaluateBudget period rollover re-arms alerts', () => {
  const first = evaluateBudget({ budget: { dailyUsd: 10 }, todayUsd: 5, todayKey: '2026-08-19' });
  const stamped = stampAlerts(first.firedState, first.alerts);
  const second = evaluateBudget({ budget: { dailyUsd: 10 }, todayUsd: 5, todayKey: '2026-08-20' }, stamped);
  assert.deepEqual(second.alerts.map((alert) => alert.periodKey), ['2026-08-20']);
});

test('evaluateBudget prunes old period state', () => {
  const firedState = {
    daily: { '2026-08-18': [50], '2026-08-19': [50] },
    monthly: { '2026-07': [50], '2026-08': [75] },
  };
  const evaluated = evaluateBudget({
    budget: { dailyUsd: 10, monthlyUsd: 100 },
    todayUsd: 4,
    monthUsd: 40,
    todayKey: '2026-08-19',
    monthKey: '2026-08',
  }, firedState);
  assert.deepEqual(evaluated.firedState, { daily: { '2026-08-19': [50] }, monthly: { '2026-08': [75] } });
});

test('evaluateBudget ignores null budgets', () => {
  const evaluated = evaluateBudget({
    budget: { dailyUsd: null, monthlyUsd: null },
    todayUsd: 100,
    monthUsd: 100,
    todayKey: '2026-08-19',
    monthKey: '2026-08',
  });
  assert.deepEqual(evaluated.alerts, []);
  assert.deepEqual(evaluated.firedState, { daily: {}, monthly: {} });
});

test('markFired stamps only the alerts handed to it, leaving the rest armed', () => {
  const evaluated = evaluateBudget({
    budget: { dailyUsd: 10, monthlyUsd: 100 },
    todayUsd: 12,
    monthUsd: 80,
    todayKey: '2026-08-19',
    monthKey: '2026-08',
  }, { daily: { '2026-08-19': [50] }, monthly: {} });
  assert.deepEqual(evaluated.alerts.map((alert) => alert.thresholds), [[75, 100], [50, 75]]);

  const daily = evaluated.alerts.filter((alert) => alert.scope === 'daily');
  assert.deepEqual(stampAlerts(evaluated.firedState, daily), {
    daily: { '2026-08-19': [50, 75, 100] },
    monthly: {},
  });
});

test('budgetStanding reports tones', () => {
  assert.deepEqual(budgetStanding({ budget: { dailyUsd: 10, monthlyUsd: 100 }, todayUsd: 4, monthUsd: 50 }), [
    { scope: 'daily', spentUsd: 4, budgetUsd: 10, pct: 40, tone: 'ok' },
    { scope: 'monthly', spentUsd: 50, budgetUsd: 100, pct: 50, tone: 'warn' },
  ]);
  assert.deepEqual(budgetStanding({ budget: { dailyUsd: 10 }, todayUsd: 9, monthUsd: 0 }), [
    { scope: 'daily', spentUsd: 9, budgetUsd: 10, pct: 90, tone: 'crit' },
  ]);
  assert.deepEqual(budgetStanding({ budget: {}, todayUsd: 9, monthUsd: 90 }), []);
});

test('mergeFiredState unions both sides per scope and period key', () => {
  const merged = mergeFiredState(
    { daily: { '2026-08-19': [75], '2026-08-20': [50] }, monthly: { '2026-08': [100] } },
    { daily: { '2026-08-19': [50] }, monthly: { '2026-08': [50], '2026-09': [75] } },
  );
  assert.deepEqual(merged, {
    daily: { '2026-08-19': [50, 75], '2026-08-20': [50] },
    monthly: { '2026-08': [50, 100], '2026-09': [75] },
  });
});

test('mergeFiredState drops threshold values off the ladder', () => {
  const merged = mergeFiredState(
    { daily: { '2026-08-19': [75, 42] } },
    { daily: { '2026-08-19': ['50', 60] }, monthly: { '2026-08': [7] } },
  );
  assert.deepEqual(merged, { daily: { '2026-08-19': [75] }, monthly: {} });
});

test('mergeFiredState treats a missing or malformed side as empty', () => {
  assert.deepEqual(mergeFiredState({}, {}), { daily: {}, monthly: {} });
  assert.deepEqual(mergeFiredState(null, undefined), { daily: {}, monthly: {} });
  assert.deepEqual(
    mergeFiredState({ daily: { '2026-08-19': [50] } }, { daily: 'not a map', monthly: 7 }),
    { daily: { '2026-08-19': [50] }, monthly: {} },
  );
});
