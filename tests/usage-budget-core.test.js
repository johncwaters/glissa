'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUDGET_THRESHOLDS,
  budgetStanding,
  evaluateBudget,
  normalizeBudgetConfig,
} = require('../server/core/usage-budget-core');

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
    { scope: 'daily', threshold: 50, spentUsd: 5, budgetUsd: 10, periodKey: '2026-08-19' },
  ]);
});

test('evaluateBudget fires only the highest new threshold', () => {
  const evaluated = evaluateBudget({
    budget: { dailyUsd: 10 },
    todayUsd: 12,
    todayKey: '2026-08-19',
  });
  assert.deepEqual(evaluated.alerts.map((alert) => alert.threshold), [100]);
});

test('evaluateBudget fires once per period and threshold', () => {
  const first = evaluateBudget({ budget: { dailyUsd: 10 }, todayUsd: 5, todayKey: '2026-08-19' });
  const second = evaluateBudget({ budget: { dailyUsd: 10 }, todayUsd: 6, todayKey: '2026-08-19' }, first.firedState);
  assert.deepEqual(second.alerts, []);
});

test('evaluateBudget period rollover re-arms alerts', () => {
  const first = evaluateBudget({ budget: { dailyUsd: 10 }, todayUsd: 5, todayKey: '2026-08-19' });
  const second = evaluateBudget({ budget: { dailyUsd: 10 }, todayUsd: 5, todayKey: '2026-08-20' }, first.firedState);
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
