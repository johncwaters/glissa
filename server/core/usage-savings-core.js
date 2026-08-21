'use strict';

/*
 * Pure savings arithmetic for the Usage lane: what the token-saving systems around Glissa are worth.
 *
 * Two independent halves, deliberately not blended into one number. rtk reports its OWN machine-wide
 * compression stats (every rtk-hooked Bash call on this host, not only Glissa sessions), so this module
 * only normalizes what its CLI prints. Prompt-cache savings are computed here from the report's model
 * rows against the same price table the cost estimate uses.
 */

const { safeNumber, stringOrNull } = require('./usage-number-core');
const { lookupModelPrice, ratesForPrice } = require('./usage-pricing-core');

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/*
 * `rtk gain --daily --format json` -> the wire shape, or null when the payload is unusable. A missing
 * `daily` is ordinary (a fresh install has no history), so it degrades to an empty series rather than
 * rejecting the whole reading.
 */
function normalizeRtkGain(parsed) {
  if (!isPlainObject(parsed)) return null;
  const summary = parsed.summary;
  if (!isPlainObject(summary)) return null;
  return {
    commands: safeNumber(summary.total_commands),
    inputTokens: safeNumber(summary.total_input),
    outputTokens: safeNumber(summary.total_output),
    savedTokens: safeNumber(summary.total_saved),
    savingsPct: safeNumber(summary.avg_savings_pct),
    daily: normalizeRtkDaily(parsed.daily),
  };
}

// A row with no usable date cannot be placed on any timeline, so it is dropped rather than bucketed
// under an invented key.
function normalizeRtkDaily(daily) {
  if (!Array.isArray(daily)) return [];
  const rows = [];
  for (const row of daily) {
    if (!isPlainObject(row)) continue;
    const date = stringOrNull(row.date);
    if (date === null || !DAY_KEY_RE.test(date)) continue;
    rows.push({
      date,
      commands: safeNumber(row.commands),
      savedTokens: safeNumber(row.saved_tokens),
      savingsPct: safeNumber(row.savings_pct),
    });
  }
  return rows;
}

// Matches server/core/usage-aggregate-core.js vendorOf: an absent vendor is Claude, so a row from an
// older report still counts.
function isClaudeRow(row) {
  const vendor = typeof row?.vendor === 'string' ? row.vendor.trim() : '';
  return vendor === '' || vendor === 'claude';
}

/*
 * What the prompt cache saved against paying full input list price for the same tokens. A FLAT-rate
 * estimate: the above-200k tier is deliberately ignored, because the report's model rows carry no
 * per-request context size to tier them by, and pretending otherwise would be precision Glissa does not
 * have. A model with no price contributes its TOKENS but no dollars, and is named so the figure reads as
 * a floor rather than a total.
 */
function computeCacheSavings(modelRows, pricingTable, lookupDeps = {}) {
  const rows = Array.isArray(modelRows) ? modelRows : [];
  let savedUSD = 0;
  let cacheReadTokens = 0;
  const unpricedModels = [];
  for (const row of rows) {
    if (!isClaudeRow(row)) continue;
    const cacheRead = safeNumber(row?.cacheRead);
    if (cacheRead <= 0) continue;
    cacheReadTokens += cacheRead;
    const resolved = lookupModelPrice(pricingTable, row?.model, lookupDeps);
    if (!resolved) {
      const name = stringOrNull(row?.model);
      if (name !== null && !unpricedModels.includes(name)) unpricedModels.push(name);
      continue;
    }
    const rates = ratesForPrice(resolved.price);
    savedUSD += Math.max(0, cacheRead * (rates.input - rates.cacheRead));
  }
  if (cacheReadTokens <= 0) return null;
  return { savedUSD, cacheReadTokens, unpricedModels };
}

module.exports = {
  computeCacheSavings,
  normalizeRtkGain,
};
