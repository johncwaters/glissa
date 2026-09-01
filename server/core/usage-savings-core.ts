/*
 * Pure savings arithmetic for the Usage lane: what the token-saving systems around Glissa are worth.
 *
 * Two independent halves, deliberately not blended into one number. rtk reports its OWN machine-wide
 * compression stats (every rtk-hooked Bash call on this host, not only Glissa sessions), so this module
 * only normalizes what its CLI prints. Prompt-cache savings are computed here from the report's model
 * rows against the same price table the cost estimate uses.
 */

import { isPlainObject, safeNumber, stringOrNull } from './usage-number-core.ts';
import { lookupModelPrice, ratesForPrice } from './usage-pricing-core.ts';
import { vendorOf } from './usage-aggregate-core.ts';

export interface RtkDailyRow {
  date: string;
  commands: number;
  savedTokens: number;
  savingsPct: number;
}

export interface RtkGain {
  commands: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  savingsPct: number;
  daily: RtkDailyRow[];
}

interface ModelUsageRow {
  model?: string | null;
  vendor?: string;
  cacheRead?: unknown;
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/*
 * `rtk gain --daily --format json` -> the wire shape, or null when the payload is unusable. A missing
 * `daily` is ordinary (a fresh install has no history), so it degrades to an empty series rather than
 * rejecting the whole reading.
 */
function normalizeRtkGain(parsed: unknown): RtkGain | null {
  if (!isPlainObject(parsed)) return null;
  const payload = parsed as Record<string, unknown>;
  if (!isPlainObject(payload.summary)) return null;
  const summary = payload.summary as Record<string, unknown>;
  return {
    commands: safeNumber(summary.total_commands),
    inputTokens: safeNumber(summary.total_input),
    outputTokens: safeNumber(summary.total_output),
    savedTokens: safeNumber(summary.total_saved),
    savingsPct: safeNumber(summary.avg_savings_pct),
    daily: normalizeRtkDaily(payload.daily),
  };
}

// A row with no usable date cannot be placed on any timeline, so it is dropped rather than bucketed
// under an invented key.
function normalizeRtkDaily(daily: unknown): RtkDailyRow[] {
  if (!Array.isArray(daily)) return [];
  const rows: RtkDailyRow[] = [];
  for (const rawRow of daily) {
    if (!isPlainObject(rawRow)) continue;
    const row = rawRow as Record<string, unknown>;
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

/*
 * What the prompt cache saved against paying full input list price for the same tokens. A FLAT-rate
 * estimate: the above-200k tier is deliberately ignored, because the report's model rows carry no
 * per-request context size to tier them by, and pretending otherwise would be precision Glissa does not
 * have. A model with no price contributes its TOKENS but no dollars, and is named so the figure reads as
 * a floor rather than a total.
 */
function computeCacheSavings(
  modelRows: ModelUsageRow[] | null | undefined,
  pricingTable: unknown,
): { savedUSD: number; cacheReadTokens: number; unpricedModels: string[] } | null {
  const rows = Array.isArray(modelRows) ? modelRows : [];
  let savedUSD = 0;
  let cacheReadTokens = 0;
  const unpricedModels: string[] = [];
  for (const row of rows) {
    if (vendorOf(row) !== 'claude') continue;
    const cacheRead = safeNumber(row?.cacheRead);
    if (cacheRead <= 0) continue;
    cacheReadTokens += cacheRead;
    const resolved = lookupModelPrice(pricingTable, row?.model, {});
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

export { computeCacheSavings, normalizeRtkGain };
