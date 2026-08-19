'use strict';

const { numberOrNull, safeNumber } = require('./usage-number-core');

const BUDGET_THRESHOLDS = Object.freeze([50, 75, 100]);

function normalizeBudgetConfig(raw) {
  if (!raw) return { dailyUsd: null, monthlyUsd: null };
  return {
    dailyUsd: positiveNumberOrNull(raw.dailyUsd),
    monthlyUsd: positiveNumberOrNull(raw.monthlyUsd),
  };
}

function evaluateBudget({ budget, todayUsd, monthUsd, todayKey, monthKey } = {}, firedState = {}) {
  const normalizedBudget = normalizeBudgetConfig(budget);
  const nextFiredState = prunedFiredState(firedState, { todayKey, monthKey });
  const alerts = [];
  const dailyAlert = evaluateScope({
    scope: 'daily',
    spentUsd: todayUsd,
    budgetUsd: normalizedBudget.dailyUsd,
    periodKey: todayKey,
    firedState: nextFiredState,
  });
  if (dailyAlert) alerts.push(dailyAlert);
  const monthlyAlert = evaluateScope({
    scope: 'monthly',
    spentUsd: monthUsd,
    budgetUsd: normalizedBudget.monthlyUsd,
    periodKey: monthKey,
    firedState: nextFiredState,
  });
  if (monthlyAlert) alerts.push(monthlyAlert);
  return { alerts, firedState: nextFiredState };
}

function budgetStanding({ budget, todayUsd, monthUsd } = {}) {
  const normalizedBudget = normalizeBudgetConfig(budget);
  const rows = [];
  const daily = standingRow('daily', todayUsd, normalizedBudget.dailyUsd);
  if (daily) rows.push(daily);
  const monthly = standingRow('monthly', monthUsd, normalizedBudget.monthlyUsd);
  if (monthly) rows.push(monthly);
  return rows;
}

function evaluateScope({ scope, spentUsd, budgetUsd, periodKey, firedState }) {
  if (!budgetUsd) return null;
  if (typeof periodKey !== 'string' || periodKey.length === 0) return null;
  const pct = (safeNumber(spentUsd) / budgetUsd) * 100;
  const crossedThresholds = BUDGET_THRESHOLDS.filter((threshold) => pct >= threshold && !hasFired(firedState, scope, periodKey, threshold));
  if (crossedThresholds.length === 0) return null;
  const threshold = crossedThresholds[crossedThresholds.length - 1];
  markFired(firedState, scope, periodKey, threshold);
  return {
    scope,
    threshold,
    spentUsd: safeNumber(spentUsd),
    budgetUsd,
    periodKey,
  };
}

function prunedFiredState(firedState, { todayKey, monthKey }) {
  const source = firedState && typeof firedState === 'object' ? firedState : {};
  return {
    daily: filteredScopeState(source.daily, todayKey),
    monthly: filteredScopeState(source.monthly, monthKey),
  };
}

function filteredScopeState(scopeState, periodKey) {
  if (!scopeState || typeof scopeState !== 'object') return {};
  if (typeof periodKey !== 'string' || periodKey.length === 0) return {};
  const thresholds = Array.isArray(scopeState[periodKey]) ? scopeState[periodKey].filter((threshold) => BUDGET_THRESHOLDS.includes(threshold)) : [];
  if (thresholds.length === 0) return {};
  return { [periodKey]: Array.from(new Set(thresholds)).sort((a, b) => a - b) };
}

function hasFired(firedState, scope, periodKey, threshold) {
  return Array.isArray(firedState[scope]?.[periodKey]) && firedState[scope][periodKey].includes(threshold);
}

function markFired(firedState, scope, periodKey, threshold) {
  const existing = Array.isArray(firedState[scope]?.[periodKey]) ? firedState[scope][periodKey] : [];
  firedState[scope][periodKey] = Array.from(new Set([...existing, threshold])).sort((a, b) => a - b);
}

function standingRow(scope, spentUsd, budgetUsd) {
  if (!budgetUsd) return null;
  const safeSpentUsd = safeNumber(spentUsd);
  const pct = (safeSpentUsd / budgetUsd) * 100;
  return {
    scope,
    spentUsd: safeSpentUsd,
    budgetUsd,
    pct,
    tone: toneForPct(pct),
  };
}

function toneForPct(pct) {
  if (pct >= 90) return 'crit';
  if (pct >= 50) return 'warn';
  return 'ok';
}

function positiveNumberOrNull(value) {
  const number = numberOrNull(value);
  if (number === null || number <= 0) return null;
  return number;
}

module.exports = {
  BUDGET_THRESHOLDS,
  budgetStanding,
  evaluateBudget,
  normalizeBudgetConfig,
};
