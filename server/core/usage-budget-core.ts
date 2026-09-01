import { numberOrNull, safeNumber } from './usage-number-core.ts';

const BUDGET_THRESHOLDS = Object.freeze([50, 75, 100]);

export interface BudgetConfig {
  dailyUsd: number | null;
  monthlyUsd: number | null;
}

export type BudgetScope = 'daily' | 'monthly';

export type BudgetFiredState = Record<BudgetScope, Record<string, number[]>>;

export interface BudgetAlert {
  scope: BudgetScope;
  threshold: number;
  spentUsd: number;
  budgetUsd: number;
  periodKey: string;
}

export interface BudgetStandingRow {
  scope: BudgetScope;
  spentUsd: number;
  budgetUsd: number;
  pct: number;
  tone: 'ok' | 'warn' | 'crit';
}

function normalizeBudgetConfig(raw: { dailyUsd?: unknown; monthlyUsd?: unknown } | null | undefined): BudgetConfig {
  if (!raw) return { dailyUsd: null, monthlyUsd: null };
  return {
    dailyUsd: positiveNumberOrNull(raw.dailyUsd),
    monthlyUsd: positiveNumberOrNull(raw.monthlyUsd),
  };
}

function evaluateBudget(
  { budget, todayUsd, monthUsd, todayKey, monthKey }: {
    budget?: { dailyUsd?: unknown; monthlyUsd?: unknown } | null;
    todayUsd?: unknown;
    monthUsd?: unknown;
    todayKey?: unknown;
    monthKey?: unknown;
  } = {},
  firedState: unknown = {},
): { alerts: BudgetAlert[]; firedState: BudgetFiredState } {
  const normalizedBudget = normalizeBudgetConfig(budget);
  const nextFiredState = prunedFiredState(firedState, { todayKey, monthKey });
  const alerts: BudgetAlert[] = [];
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

function budgetStanding({ budget, todayUsd, monthUsd }: {
  budget?: { dailyUsd?: unknown; monthlyUsd?: unknown } | null;
  todayUsd?: unknown;
  monthUsd?: unknown;
} = {}): BudgetStandingRow[] {
  const normalizedBudget = normalizeBudgetConfig(budget);
  const rows: BudgetStandingRow[] = [];
  const daily = standingRow('daily', todayUsd, normalizedBudget.dailyUsd);
  if (daily) rows.push(daily);
  const monthly = standingRow('monthly', monthUsd, normalizedBudget.monthlyUsd);
  if (monthly) rows.push(monthly);
  return rows;
}

function evaluateScope({ scope, spentUsd, budgetUsd, periodKey, firedState }: {
  scope: BudgetScope;
  spentUsd: unknown;
  budgetUsd: number | null;
  periodKey: unknown;
  firedState: BudgetFiredState;
}): BudgetAlert | null {
  if (!budgetUsd) return null;
  if (typeof periodKey !== 'string' || periodKey.length === 0) return null;
  const pct = pctOfBudget(spentUsd, budgetUsd);
  const crossedThresholds = BUDGET_THRESHOLDS.filter((threshold) => pct >= threshold && !hasFired(firedState, scope, periodKey, threshold));
  if (crossedThresholds.length === 0) return null;
  const threshold = crossedThresholds[crossedThresholds.length - 1];
  // Mark every newly crossed threshold so a later spend correction cannot re-fire a lower one.
  for (const crossed of crossedThresholds) markFired(firedState, scope, periodKey, crossed);
  return {
    scope,
    threshold,
    spentUsd: safeNumber(spentUsd),
    budgetUsd,
    periodKey,
  };
}

function prunedFiredState(
  firedState: unknown,
  { todayKey, monthKey }: { todayKey?: unknown; monthKey?: unknown },
): BudgetFiredState {
  const source: Record<string, unknown> = firedState && typeof firedState === 'object'
    ? (firedState as Record<string, unknown>)
    : {};
  return {
    daily: filteredScopeState(source.daily, todayKey),
    monthly: filteredScopeState(source.monthly, monthKey),
  };
}

function filteredScopeState(scopeState: unknown, periodKey: unknown): Record<string, number[]> {
  if (!scopeState || typeof scopeState !== 'object') return {};
  if (typeof periodKey !== 'string' || periodKey.length === 0) return {};
  const stored = (scopeState as Record<string, unknown>)[periodKey];
  const thresholds: number[] = Array.isArray(stored)
    ? stored.filter((threshold): threshold is number => BUDGET_THRESHOLDS.includes(threshold))
    : [];
  if (thresholds.length === 0) return {};
  return { [periodKey]: Array.from(new Set(thresholds)).sort((a, b) => a - b) };
}

function hasFired(firedState: BudgetFiredState, scope: BudgetScope, periodKey: string, threshold: number): boolean {
  const fired = firedState[scope]?.[periodKey];
  return Array.isArray(fired) && fired.includes(threshold);
}

function markFired(firedState: BudgetFiredState, scope: BudgetScope, periodKey: string, threshold: number): void {
  const stored = firedState[scope]?.[periodKey];
  const existing = Array.isArray(stored) ? stored : [];
  firedState[scope][periodKey] = Array.from(new Set([...existing, threshold])).sort((a, b) => a - b);
}

function standingRow(scope: BudgetScope, spentUsd: unknown, budgetUsd: number | null): BudgetStandingRow | null {
  if (!budgetUsd) return null;
  const pct = pctOfBudget(spentUsd, budgetUsd);
  return {
    scope,
    spentUsd: safeNumber(spentUsd),
    budgetUsd,
    pct,
    tone: toneForPct(pct),
  };
}

function pctOfBudget(spentUsd: unknown, budgetUsd: number): number {
  return (safeNumber(spentUsd) / budgetUsd) * 100;
}

function toneForPct(pct: number): 'ok' | 'warn' | 'crit' {
  if (pct >= 90) return 'crit';
  if (pct >= 50) return 'warn';
  return 'ok';
}

function positiveNumberOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  if (number === null || number <= 0) return null;
  return number;
}

export { BUDGET_THRESHOLDS, budgetStanding, evaluateBudget, normalizeBudgetConfig };
