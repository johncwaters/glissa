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
