'use strict';

const { safeNumber } = require('./usage-number-core');

function dailyBaseline(dailyRows, { excludeDay } = /** @type {any} */ ({})) {
  const usableRows = (dailyRows || []).filter((row) => isUsableDailyRow(row, excludeDay));
  if (usableRows.length < 7) return null;
  const totalUsd = usableRows.reduce((sum, row) => sum + safeNumber(row.costUSD), 0);
  const totalTokens = usableRows.reduce((sum, row) => sum + safeNumber(row.tokens), 0);
  return {
    meanUsd: totalUsd / usableRows.length,
    meanTokens: totalTokens / usableRows.length,
    days: usableRows.length,
  };
}

function detectDailyAnomaly({ todayUsd, todayTokens, baseline, minUsd = 5, factor = 1.8 } = /** @type {any} */ ({})) {
  if (!baseline) return null;
  const safeTodayUsd = safeNumber(todayUsd);
  const baselineUsd = safeNumber(baseline.meanUsd);
  if (safeTodayUsd < minUsd) return null;
  if (baselineUsd <= 0) return null;
  if (safeTodayUsd < baselineUsd * factor) return null;
  return {
    kind: 'daily',
    todayUsd: safeTodayUsd,
    todayTokens: safeNumber(todayTokens),
    baselineUsd,
    ratio: safeTodayUsd / baselineUsd,
  };
}

function detectBurnAnomaly({ currentTokensPerMinute, completedBlocks, minTokensPerMinute = 200000, factor = 2.5 } = /** @type {any} */ ({})) {
  const baselineRates = (completedBlocks || []).map(tokensPerMinute).filter((rate) => rate !== null);
  if (baselineRates.length < 3) return null;
  const current = safeNumber(currentTokensPerMinute);
  const baseline = baselineRates.reduce((sum, rate) => sum + rate, 0) / baselineRates.length;
  if (current < minTokensPerMinute) return null;
  if (baseline <= 0) return null;
  if (current < baseline * factor) return null;
  return {
    kind: 'burn',
    current,
    baseline,
    ratio: current / baseline,
  };
}

function isUsableDailyRow(row, excludeDay) {
  if (!row || row.day === excludeDay) return false;
  if (typeof row.day !== 'string' || row.day.length === 0) return false;
  return Number.isFinite(safeNumber(row.costUSD)) && Number.isFinite(safeNumber(row.tokens));
}

function tokensPerMinute(block) {
  if (!block || block.isGap || safeNumber(block.entries) <= 0) return null;
  const durationMs = safeNumber(block.endTs) - safeNumber(block.startTs);
  if (durationMs <= 0) return null;
  return safeNumber(block.tokens) / (durationMs / 60000);
}

module.exports = {
  dailyBaseline,
  detectBurnAnomaly,
  detectDailyAnomaly,
};
