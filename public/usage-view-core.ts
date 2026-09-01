// ── Usage view: pure formatting, ordering and thresholds ──────
// Every string the Usage panel renders is built here, so the panel is DOM only and the wording is
// testable without a browser. No literal em dash, en dash or ellipsis is produced anywhere: a missing
// value reads as the ASCII placeholder below, ranges read "Aug 12 to Aug 19", and a projection reads
// "->" (tests/frontend-usage-view.test.js pins that).

import { attentionSignature } from './attention-ack-core.ts';

export interface UsageModelRow {
  key?: string;
  model?: string | null;
  vendor?: string;
  tokens?: number;
  costUSD?: number;
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
}

export type UsageWireRow = Record<string, unknown>;

export interface UsageTokenLimit {
  max?: unknown;
  pct?: unknown;
}

export interface UsageProjection {
  projectedTokens?: unknown;
  projectedCostUSD?: unknown;
  remainingMinutes?: unknown;
}

export interface UsageBurn {
  tokensPerMinute?: unknown;
  tokensPerMinuteExCache?: unknown;
  costPerHour?: unknown;
}

export interface UsageBlock {
  startTs?: unknown;
  endTs?: unknown;
  tokens?: unknown;
  costUSD?: unknown;
  isActive?: unknown;
  isGap?: unknown;
  burn?: UsageBurn;
  projection?: UsageProjection;
}

export interface UsageLaneRow {
  lane?: unknown;
  sessions?: unknown;
  tokens?: unknown;
  costUSD?: unknown;
}

export interface UsageBudgetRow {
  scope?: unknown;
  budgetUsd?: unknown;
  spentUsd?: unknown;
  pct?: unknown;
  tone?: unknown;
}

export interface UsageAnomaly {
  daily?: { baselineDays?: unknown; ratio?: unknown; todayUsd?: unknown; baselineUsd?: unknown } | null;
  burn?: { ratio?: unknown; current?: unknown; baseline?: unknown } | null;
}

export interface RtkSavings {
  available?: unknown;
  commands?: unknown;
  savedTokens?: unknown;
  savingsPct?: unknown;
}

export interface CacheSavings {
  cacheReadTokens?: unknown;
  savedUSD?: unknown;
  unpricedModels?: unknown;
}

export interface UsageSavings {
  rtk?: RtkSavings | null;
  cache?: CacheSavings | null;
}

export interface UsageVendorTotals {
  tokens?: unknown;
  costUSD?: unknown;
}

export interface UsageTotals {
  costUSD?: unknown;
  tokens?: unknown;
  input?: unknown;
  output?: unknown;
  cacheCreate?: unknown;
  cacheRead?: unknown;
  byVendor?: Record<string, UsageVendorTotals | null | undefined>;
}

export interface UsageScan {
  dirs?: unknown;
  files?: unknown;
  entries?: unknown;
  lastScanMs?: unknown;
  partial?: unknown;
}

export interface UsageReport {
  ts?: unknown;
  tz?: unknown;
  error?: unknown;
  warning?: unknown;
  byLane?: unknown;
  budget?: { rows?: unknown } | null;
  tokenLimit?: UsageTokenLimit | null;
  activeBlock?: UsageBlock | null;
  anomaly?: UsageAnomaly | null;
  daily?: unknown;
  blocks?: unknown;
  models?: unknown;
  sessions?: unknown;
  blockHours?: unknown;
  totals?: UsageTotals;
  savings?: UsageSavings;
  scan?: UsageScan;
  pricing?: { missing?: unknown; fetchedAt?: unknown; source?: unknown } | null;
}

export interface UsageSessionUsage {
  tokens?: unknown;
  costUSD?: unknown;
  officialCostUSD?: unknown;
}

export interface HeatmapCell {
  day: string;
  week: number;
  weekday: number;
  tokens: number;
  costUSD: number;
  source: string | null;
  noData: boolean;
  tone: number;
}

export const NO_VALUE = '-';

export const USAGE_CAVEAT_SHORT = 'Estimated list prices, not a bill.';

export const USAGE_DISABLED_HINT = 'Enable in Settings.';

// ccusage's own warning threshold, applied to both the block so far and where it is projected to land.
export const TOKEN_LIMIT_WARN_PCT = 80;
export const SESSION_ROW_LIMIT = 10;

// What a range control may ask for. `days` of null means "whatever the lane retains", which is the
// server's own default when the field is omitted.
export const RANGE_OPTIONS: readonly { value: string; label: string; days: number | null }[] = Object.freeze([
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
  { value: 'all', label: 'All retained', days: null },
]);
export const DEFAULT_RANGE_VALUE = 'all';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TEXT_SORT_KEYS = new Set(['day', 'model', 'label']);
// A name sorts A to Z on first click; everything measured, dates included, leads with the biggest or the
// newest, which is what the tables already default to.
const ASC_BY_DEFAULT_KEYS = new Set(['model', 'label']);

function groupThousands(digits: string) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function trimTrailingZeros(fixed: string) {
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

export function formatCount(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NO_VALUE;
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  return `${sign}${groupThousands(String(Math.abs(rounded)))}`;
}

// Sub-cent totals are real on a per-model row, so they keep four decimals instead of rounding to a
// misleading $0.00, and anything below the last representable digit says so rather than printing a
// nonzero cost as $0.0000.
export function formatUsd(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NO_VALUE;
  const abs = Math.abs(value);
  if (abs === 0) return '$0.00';
  const sign = value < 0 ? '-' : '';
  if (abs < 0.0001) return value < 0 ? 'above -$0.0001' : '<$0.0001';
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  const [whole, cents] = abs.toFixed(2).split('.');
  return `${sign}$${groupThousands(whole)}.${cents}`;
}

export function formatTokens(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NO_VALUE;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs < 1000) {
    const rounded = Math.round(abs);
    return `${rounded === 0 ? '' : sign}${rounded}`;
  }
  // 999950 already rounds to 1.0M at this precision, so it crosses here rather than reading "1000k".
  if (abs < 999950) return `${sign}${trimTrailingZeros((abs / 1000).toFixed(1))}k`;
  // Same reasoning one tier up: cache-read totals over a long retention window do reach billions.
  if (abs < 999995000) return `${sign}${trimTrailingZeros((abs / 1e6).toFixed(2))}M`;
  return `${sign}${trimTrailingZeros((abs / 1e9).toFixed(2))}B`;
}

export function formatPercent(pct: unknown) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return NO_VALUE;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${trimTrailingZeros(pct.toFixed(1))}%`;
}

// Share is measured against cost when there is any, because that is the question ("what is expensive"),
// and falls back to tokens on a report whose costs are all zero (display cost mode, or no price table).
export function shareBasis(totals: UsageTotals | null | undefined) {
  const cost = Number(totals?.costUSD);
  if (Number.isFinite(cost) && cost > 0) return 'costUSD';
  return 'tokens';
}

export function shareLabel(basis: string) {
  if (basis === 'costUSD') return 'share of cost';
  return 'share of tokens';
}

export function percentOfTotal(value: unknown, total: unknown) {
  const part = Number(value);
  const whole = Number(total);
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

export function dayLabel(day: unknown) {
  const parts = DAY_KEY_RE.exec(String(day ?? ''));
  if (!parts) return String(day ?? '') || NO_VALUE;
  const month = MONTH_NAMES[Number(parts[2]) - 1];
  if (!month) return String(day);
  return `${month} ${Number(parts[3])}`;
}

// "Aug 12 to Aug 19", the no-dash form of a date range.
export function dayRangeLabel(days: unknown) {
  const keys = dayKeysOf(days);
  if (keys.length === 0) return '';
  if (keys.length === 1) return dayLabel(keys[0]);
  return `${dayLabel(keys[0])} to ${dayLabel(keys[keys.length - 1])}`;
}

function dayKeysOf(days: unknown) {
  const entries: unknown[] = Array.isArray(days) ? days : [];
  return entries
    .map((entry) => (typeof entry === 'string' ? entry : (entry as { day?: unknown } | null | undefined)?.day))
    .map((key) => String(key ?? ''))
    .filter((key) => DAY_KEY_RE.test(key))
    .sort();
}

// The report's own calendar day, in the SERVER's timezone. The daily buckets are keyed there
// (server/core/usage-aggregate-core.ts runs on the server clock), so asking the browser what day it is
// reads the wrong bucket for any viewer in another zone, which remote mode makes routine.
export function reportDayKey(report: UsageReport | null | undefined) {
  const ts = Number(report?.ts);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  return dayKeyInZone(ts, typeof report?.tz === 'string' && report.tz ? report.tz : null);
}

function dayKeyInZone(ts: number, tz: string | null) {
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
  if (tz) options.timeZone = tz;
  const formatted = safeZoneFormat(ts, options);
  if (DAY_KEY_RE.test(formatted)) return formatted;
  return safeZoneFormat(ts, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

// An unknown zone name throws rather than falling back, so a report from a host Glissa cannot resolve
// degrades to this machine's day instead of losing the tile.
function safeZoneFormat(ts: number, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat('en-CA', options).format(new Date(ts));
  } catch {
    return '';
  }
}

export function formatMinutes(minutes: unknown) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return NO_VALUE;
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

export function blockLabel(startTs: unknown) {
  const ts = Number(startTs);
  if (!Number.isFinite(ts) || ts <= 0) return NO_VALUE;
  const date = new Date(ts);
  const month = MONTH_NAMES[date.getMonth()];
  if (!month) return NO_VALUE;
  const hours = String(date.getHours()).padStart(2, '0');
  const mins = String(date.getMinutes()).padStart(2, '0');
  return `${month} ${date.getDate()} ${hours}:${mins}`;
}

// Burn rate as tiles rather than a sentence: these are the two numbers an operator compares against a
// threshold, so they get the same weight as the block's own totals.
export function burnTiles(burn: UsageBurn | null | undefined) {
  if (!burn || typeof burn !== 'object') return [];
  const tiles: { label: string; value: string; sub: string }[] = [];
  if (Number.isFinite(burn.tokensPerMinute)) {
    const sub = Number.isFinite(burn.tokensPerMinuteExCache)
      ? `${formatTokens(burn.tokensPerMinuteExCache)} excluding cache`
      : '';
    tiles.push({ label: 'tokens per min', value: formatTokens(burn.tokensPerMinute), sub });
  }
  if (Number.isFinite(burn.costPerHour)) {
    tiles.push({ label: 'cost per hour', value: formatUsd(burn.costPerHour), sub: '' });
  }
  return tiles;
}

export function projectionLine(projection: UsageProjection | null | undefined) {
  if (!projection || typeof projection !== 'object') return '';
  const totals: string[] = [];
  if (Number.isFinite(projection.projectedTokens)) totals.push(`${formatTokens(projection.projectedTokens)} tokens`);
  if (Number.isFinite(projection.projectedCostUSD)) totals.push(formatUsd(projection.projectedCostUSD));
  const remaining = Number.isFinite(projection.remainingMinutes)
    ? `${formatMinutes(projection.remainingMinutes)} left in this block`
    : '';
  if (totals.length === 0) return remaining;
  const head = `-> ${totals.join(', ')} by block end`;
  if (!remaining) return head;
  return `${head}, ${remaining}`;
}

// Geometry for the block progress bar: how far through its own window the active block is.
export function blockProgress(block: UsageBlock | null | undefined, now = Date.now()) {
  const start = Number(block?.startTs);
  const end = Number(block?.endTs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const totalMinutes = (end - start) / 60000;
  const elapsedMinutes = Math.min(Math.max((now - start) / 60000, 0), totalMinutes);
  const remainingMinutes = Math.max(totalMinutes - elapsedMinutes, 0);
  return {
    totalMinutes,
    elapsedMinutes,
    remainingMinutes,
    pct: Math.round((elapsedMinutes / totalMinutes) * 100),
  };
}

export function tokenLimitTone(pct: unknown) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'ok';
  if (pct >= 100) return 'crit';
  if (pct >= TOKEN_LIMIT_WARN_PCT) return 'warn';
  return 'ok';
}

// The wire carries tokenLimit.pct as a RATIO of the largest completed block (see
// server/core/usage-blocks-core.ts), so the percent every threshold and meter here works in is derived
// rather than assumed.
// Absent has to stay distinct from zero here: Number(null) is 0, and a missing reference reported as
// "0% of the limit" would read as a calm block rather than an unknown one.
function finiteNumber(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function limitMax(tokenLimit: UsageTokenLimit | null | undefined) {
  const max = finiteNumber(tokenLimit?.max);
  if (max === null || max <= 0) return null;
  return max;
}

export function limitPct(tokenLimit: UsageTokenLimit | null | undefined) {
  const max = limitMax(tokenLimit);
  const ratio = finiteNumber(tokenLimit?.pct);
  if (max === null || ratio === null) return null;
  return ratio * 100;
}

export function projectedLimitPct(projection: UsageProjection | null | undefined, tokenLimit: UsageTokenLimit | null | undefined) {
  const max = limitMax(tokenLimit);
  const projected = finiteNumber(projection?.projectedTokens);
  if (max === null || projected === null) return null;
  return (projected / max) * 100;
}

export function tokenLimitLine(tokenLimit: UsageTokenLimit | null | undefined) {
  const pct = limitPct(tokenLimit);
  if (pct === null) return '';
  return `${Math.round(pct)}% of ${formatTokens(tokenLimit?.max)} tokens, the largest completed block seen`;
}

export function projectionLimitLine(projection: UsageProjection | null | undefined, tokenLimit: UsageTokenLimit | null | undefined) {
  const pct = projectedLimitPct(projection, tokenLimit);
  if (pct === null) return '';
  if (pct >= 100) return `On this burn rate the block ends past that reference, at ${Math.round(pct)}% of it.`;
  return `On this burn rate the block ends at ${Math.round(pct)}% of that reference.`;
}

// ── Token composition ──
// Where the tokens went, measured against the four parts' own sum rather than the report's token total:
// the parts ARE that total, and a share of anything else would not add up to 100.

const COMPOSITION_PARTS = Object.freeze([
  { key: 'input', label: 'input' },
  { key: 'output', label: 'output' },
  { key: 'cacheCreate', label: 'cache write' },
  { key: 'cacheRead', label: 'cache read' },
]);

export function compositionParts(totals) {
  const parts = COMPOSITION_PARTS.map((spec) => {
    const raw = Number(totals?.[spec.key]);
    return { spec, tokens: Number.isFinite(raw) && raw > 0 ? raw : 0 };
  });
  const sum = parts.reduce((total, part) => total + part.tokens, 0);
  if (sum <= 0) return [];
  return parts.map((part) => {
    const pct = percentOfTotal(part.tokens, sum) ?? 0;
    const value = formatTokens(part.tokens);
    return { key: part.spec.key, label: part.spec.label, value, pct, title: `${part.spec.label} ${value}, ${formatPercent(pct)}` };
  });
}

// ── Glissa lanes ──
// Which of Glissa's own automation lanes the spend belonged to. The join is exact (Glissa recorded spawning
// the session), so `other` genuinely means "not spawned by Glissa" rather than "unrecognized".

const LANE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  interactive: 'Interactive',
  'pr-review': 'PR review',
  'pack-distill': 'Pack distiller',
  posthog: 'PostHog',
  other: 'Other',
});

export const LANE_SCOPE_HINT = 'Sessions spawned by Glissa; terminal sessions count as other';

export function laneLabel(lane: unknown) {
  const key = typeof lane === 'string' ? lane.trim() : '';
  if (!key) return LANE_LABELS.other;
  return LANE_LABELS[key] || key;
}

export function laneRows(report: UsageReport | null | undefined): UsageLaneRow[] {
  const rows = report?.byLane;
  if (!Array.isArray(rows)) return [];
  return (rows as UsageLaneRow[]).filter((row) => row && typeof row.lane === 'string');
}

/*
 * The section is worth showing only once a lane OTHER than interactive-or-other has spend. A fresh install
 * has nothing but the operator's own sessions, and a section that says "Interactive: everything" restates
 * the totals directly above it.
 */
export function hasLaneAttribution(report: UsageReport | null | undefined) {
  return laneRows(report).some((row) => row.lane !== 'interactive' && row.lane !== 'other');
}

export function laneSessionsText(sessions: unknown) {
  const count = finiteNumber(sessions);
  if (count === null || count <= 0) return '';
  return `${formatCount(count)} ${count === 1 ? 'session' : 'sessions'}`;
}

// ── Savings ──
// What the token-saving systems around a session are worth. Two independent claims kept apart on purpose:
// rtk counts compressed command output across the whole machine from its own records, while the cache
// figure is Glissa's arithmetic over the same Claude model rows the cost estimate uses.

export function rtkSavings(savings: UsageSavings | null | undefined): RtkSavings | null {
  const rtk = savings?.rtk;
  if (!rtk || typeof rtk !== 'object' || rtk.available !== true) return null;
  return rtk;
}

export function cacheSavings(savings: UsageSavings | null | undefined): CacheSavings | null {
  const cache = savings?.cache;
  if (!cache || typeof cache !== 'object') return null;
  return cache;
}

export function hasSavings(savings: UsageSavings | null | undefined) {
  return rtkSavings(savings) !== null || cacheSavings(savings) !== null;
}

// The headline is the tokens rtk never sent, because that is the figure with a unit an operator can
// compare against the totals above it; the rate and the sample size qualify it underneath.
export function rtkSavingsTile(savings: UsageSavings | null | undefined) {
  const rtk = rtkSavings(savings);
  if (!rtk) return null;
  const commands = finiteNumber(rtk.commands) ?? 0;
  const noun = commands === 1 ? 'command' : 'commands';
  return {
    value: `${formatTokens(finiteNumber(rtk.savedTokens) ?? 0)} tokens`,
    sub: `${formatPercent(finiteNumber(rtk.savingsPct) ?? 0)} avg across ${formatCount(commands)} ${noun}`,
  };
}

export function cacheSavingsTile(savings: UsageSavings | null | undefined) {
  const cache = cacheSavings(savings);
  if (!cache) return null;
  const tokens = formatTokens(finiteNumber(cache.cacheReadTokens) ?? 0);
  const unpricedModels: unknown[] = Array.isArray(cache.unpricedModels) ? cache.unpricedModels : [];
  const unpriced = unpricedModels.filter((model) => model);
  const sub = `${tokens} cache read tokens`;
  if (unpriced.length === 0) return { value: formatUsd(finiteNumber(cache.savedUSD) ?? 0), sub };
  // Named as a floor rather than a total: an unpriced model's tokens are counted, its dollars are not.
  const noun = unpriced.length === 1 ? 'model' : 'models';
  return {
    value: formatUsd(finiteNumber(cache.savedUSD) ?? 0),
    sub: `${sub}, a floor (${unpriced.length} unpriced ${noun})`,
  };
}

// ── Spend budgets ──
// The rows and their tones come from server/core/usage-budget-core.ts, which owns the ladder; nothing is
// recomputed here. These only format them, and decide when the tab dot is owed.

// The tone ladder's own top step. A budget that far along is worth pulling an operator over, which is a
// stronger claim than the warn step and so has its own threshold.
export const BUDGET_ATTENTION_PCT = 90;

export function budgetRows(report: UsageReport | null | undefined): UsageBudgetRow[] {
  const rows = report?.budget?.rows;
  if (!Array.isArray(rows)) return [];
  return (rows as UsageBudgetRow[]).filter((row) => row && finiteNumber(row.budgetUsd) !== null);
}

export function budgetScopeLabel(scope: unknown) {
  if (scope === 'monthly') return 'this month';
  return 'today';
}

// "$12.40 of $16.00" reads as a position; a bare percentage does not say how much room is left.
export function budgetRowText(row: UsageBudgetRow | null | undefined) {
  return `${formatUsd(finiteNumber(row?.spentUsd) ?? 0)} of ${formatUsd(finiteNumber(row?.budgetUsd) ?? 0)}`;
}

export function budgetRowPct(row: UsageBudgetRow | null | undefined) {
  const pct = finiteNumber(row?.pct);
  if (pct === null) return 0;
  return pct;
}

export function budgetRowMeterLabel(row: UsageBudgetRow | null | undefined) {
  return `${budgetScopeLabel(row?.scope)} spend against budget`;
}

// ── Period rollups ──
// Week and month views are derived HERE, from the daily rows the report already ships, rather than being
// three more arrays on the wire: the merged daily series is the single source, so a period total can never
// disagree with the days it is made of.

export const PERIOD_VIEWS = Object.freeze([
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
]);
export const DEFAULT_PERIOD_VIEW = 'day';

function parseDayKey(day: unknown) {
  const parts = DAY_KEY_RE.exec(String(day ?? ''));
  if (!parts) return null;
  // Local noon, so a period key can never be shifted a day by a DST transition.
  return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 12);
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

function dayKeyOfDate(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// Weeks start Monday and are keyed by that Monday's day key, so a week spanning a month boundary stays one
// bucket instead of splitting.
export function weekStartKey(day: unknown) {
  const date = parseDayKey(day);
  if (!date) return '';
  const dayOfWeek = date.getDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday);
  return dayKeyOfDate(date);
}

export function monthKey(day: unknown) {
  const parts = DAY_KEY_RE.exec(String(day ?? ''));
  if (!parts) return '';
  return `${parts[1]}-${parts[2]}`;
}

interface PeriodModelRow {
  key: string;
  model: string;
  vendor?: string;
  tokens: number;
  costUSD: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

interface PeriodBucket {
  key: string;
  tokens: number;
  costUSD: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  days: number;
  sources: Set<string>;
  vendorSet: Set<string>;
  modelByName: Map<string, PeriodModelRow>;
}

function emptyPeriodBucket(key: string): PeriodBucket {
  return {
    key,
    tokens: 0,
    costUSD: 0,
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    days: 0,
    sources: new Set<string>(),
    vendorSet: new Set<string>(),
    modelByName: new Map<string, PeriodModelRow>(),
  };
}

function addDayToPeriod(bucket: PeriodBucket, row: UsageWireRow | null | undefined) {
  bucket.tokens += finiteNumber(row?.tokens) ?? 0;
  bucket.costUSD += finiteNumber(row?.costUSD) ?? 0;
  bucket.input += finiteNumber(row?.input) ?? 0;
  bucket.output += finiteNumber(row?.output) ?? 0;
  bucket.cacheCreate += finiteNumber(row?.cacheCreate) ?? 0;
  bucket.cacheRead += finiteNumber(row?.cacheRead) ?? 0;
  bucket.days += 1;
  bucket.sources.add(row?.source === 'history' ? 'history' : 'live');
  // Vendors union from row.vendors AND model rows: history rows rebuilt from rollups carry no vendors.
  const vendors: string[] = Array.isArray(row?.vendors) ? row.vendors : [];
  for (const vendor of vendors) bucket.vendorSet.add(vendor);
  const modelRows = (row?.models || []) as UsageModelRow[];
  for (const model of modelRows) {
    if (model?.vendor) bucket.vendorSet.add(model.vendor);
    const name = modelLabel(model);
    const existing: PeriodModelRow = bucket.modelByName.get(name) || { key: name, model: model?.model ?? name, vendor: model?.vendor, tokens: 0, costUSD: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    existing.tokens += finiteNumber(model?.tokens) ?? 0;
    existing.costUSD += finiteNumber(model?.costUSD) ?? 0;
    existing.input += finiteNumber(model?.input) ?? 0;
    existing.output += finiteNumber(model?.output) ?? 0;
    existing.cacheCreate += finiteNumber(model?.cacheCreate) ?? 0;
    existing.cacheRead += finiteNumber(model?.cacheRead) ?? 0;
    bucket.modelByName.set(name, existing);
  }
}

// A period is history only when EVERY day in it is: one live day makes the total a live claim.
function serializePeriodBucket(bucket: PeriodBucket): UsageWireRow {
  const { modelByName, sources, vendorSet, ...rest } = bucket;
  const row: UsageWireRow = { ...rest };
  row.day = bucket.key;
  row.models = Array.from(modelByName.values()).sort((a, b) => b.tokens - a.tokens);
  row.source = sources.has('live') ? 'live' : 'history';
  row.vendors = Array.from(vendorSet).sort();
  return row;
}

function rollupByPeriod(daily: unknown, keyOf: (day: unknown) => string): UsageWireRow[] {
  const buckets = new Map<string, PeriodBucket>();
  const dailyRows: UsageWireRow[] = Array.isArray(daily) ? daily : [];
  for (const row of dailyRows) {
    const key = keyOf(row?.day);
    if (!key) continue;
    const bucket = buckets.get(key) || emptyPeriodBucket(key);
    addDayToPeriod(bucket, row);
    buckets.set(key, bucket);
  }
  return Array.from(buckets.values()).map(serializePeriodBucket);
}

export function weeklyRows(daily: unknown) {
  return rollupByPeriod(daily, weekStartKey);
}

export function monthlyRows(daily: unknown) {
  return rollupByPeriod(daily, monthKey);
}

export function periodRows(daily: unknown, view: string): UsageWireRow[] {
  if (view === 'week') return weeklyRows(daily);
  if (view === 'month') return monthlyRows(daily);
  return Array.isArray(daily) ? [...daily] : [];
}

const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;

// One label rule for all three views, so a switch between them reads as the same table.
export function periodLabel(key: unknown, view: string) {
  if (view === 'month') {
    const parts = MONTH_KEY_RE.exec(String(key ?? ''));
    if (!parts) return String(key ?? '') || NO_VALUE;
    const month = MONTH_NAMES[Number(parts[2]) - 1];
    if (!month) return String(key);
    return `${month} ${parts[1]}`;
  }
  if (view === 'week') {
    const label = dayLabel(key);
    return label === NO_VALUE ? label : `week of ${label}`;
  }
  return dayLabel(key);
}

export function periodHint(view: string) {
  if (view === 'week') return 'weeks start Monday';
  if (view === 'month') return 'calendar months';
  return 'newest first by default';
}

// A row Glissa REMEMBERS is a different claim from one it can still see, so history is labelled wherever
// it appears rather than blended in silently.
export function historyNote(rows: unknown) {
  const list: UsageWireRow[] = Array.isArray(rows) ? rows : [];
  const hasHistory = list.some((row) => row?.source === 'history');
  if (!hasHistory) return '';
  return 'older days from local history';
}

// ── Calendar heatmap ──
// Trailing 16 weeks of the merged series as week columns of Monday-to-Sunday rows. Tone is a FIXED
// fraction of the window's own maximum rather than a quantile: quantiles guarantee dark cells even on a
// quiet fortnight, which would read as heavy usage that is not there.
export const HEATMAP_WEEKS = 16;
const HEATMAP_TONE_FRACTIONS = Object.freeze([0.05, 0.25, 0.5, 0.75]);
export const HEATMAP_DAY_LABELS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

export function heatmapTone(tokens: unknown, max: unknown) {
  const value = finiteNumber(tokens) ?? 0;
  const peak = finiteNumber(max) ?? 0;
  if (value <= 0 || peak <= 0) return 0;
  const share = value / peak;
  let tone = 1;
  for (let index = 0; index < HEATMAP_TONE_FRACTIONS.length; index += 1) {
    if (share >= HEATMAP_TONE_FRACTIONS[index]) tone = index + 1;
  }
  return tone;
}

/*
 * Cells for the grid, oldest week first. An EMPTY day (in range, no usage) is distinct from a NO-DATA day
 * (before the series began, or after today): the first is a real zero, the second is an absence, and
 * colouring them alike would invent quiet days that were never observed.
 */
export function heatmapCells(
  daily: unknown,
  { weeks = HEATMAP_WEEKS, today = new Date() }: { weeks?: number; today?: Date | number | string } = {}
): { cells: HeatmapCell[]; max: number; weeks: number } {
  const dailyRows: UsageWireRow[] = Array.isArray(daily) ? daily : [];
  const rows = dailyRows.filter((row) => DAY_KEY_RE.test(String(row?.day ?? '')));
  const byDay = new Map(rows.map((row): [string, UsageWireRow] => [String(row.day), row]));
  const todayKey = dayKeyOfDate(today instanceof Date ? today : new Date(today));
  const anchor = parseDayKey(weekStartKey(todayKey));
  if (!anchor) return { cells: [], max: 0, weeks: 0 };
  const firstDay = rows.length > 0 ? rows.map((row) => String(row.day)).sort()[0] : null;
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - (weeks - 1) * 7, 12);
  const startKey = dayKeyOfDate(start);
  const cells: HeatmapCell[] = [];
  // Scaled to the window's OWN peak, not the whole series: a heavy month last quarter must not flatten
  // every cell of the fortnight on screen.
  let max = 0;
  for (const row of rows) {
    if (String(row.day) < startKey || String(row.day) > todayKey) continue;
    max = Math.max(max, finiteNumber(row.tokens) ?? 0);
  }
  for (let week = 0; week < weeks; week += 1) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + week * 7 + weekday, 12);
      const key = dayKeyOfDate(date);
      const row = byDay.get(key) || null;
      const beyondToday = key > todayKey;
      const beforeSeries = firstDay !== null && key < firstDay;
      cells.push({
        day: key,
        week,
        weekday,
        tokens: finiteNumber(row?.tokens) ?? 0,
        costUSD: finiteNumber(row?.costUSD) ?? 0,
        source: row?.source === 'history' ? 'history' : row ? 'live' : null,
        // No data at all: outside the observed series, so it gets the empty treatment and says so.
        noData: beyondToday || beforeSeries || (!row && firstDay === null),
        tone: heatmapTone(row?.tokens, max),
      });
    }
  }
  return { cells, max, weeks };
}

export function heatmapCellTitle(cell: HeatmapCell | null | undefined) {
  const label = dayLabel(cell?.day);
  if (cell?.noData) return `${label}: no data`;
  const tokens = finiteNumber(cell?.tokens) ?? 0;
  if (tokens <= 0) return `${label}: no usage`;
  return `${label}: ${formatTokens(tokens)} tokens, ${formatUsd(finiteNumber(cell?.costUSD) ?? 0)}`;
}

// ── Anomaly ──
// Machine level, evaluated server-side (the burn check needs block internals). The wording always names
// the comparison: "3.1x the 30 day average" is actionable, "unusual usage" is not.

export function anomalyLine(anomaly: UsageAnomaly | null | undefined) {
  const daily = anomaly?.daily;
  if (daily) {
    const days = finiteNumber(daily.baselineDays);
    const window = days === null ? 'recent' : `${Math.round(days)} day`;
    return `Today is ${formatRatio(daily.ratio)} the ${window} average: ${formatUsd(daily.todayUsd)} against ${formatUsd(daily.baselineUsd)}.`;
  }
  const burn = anomaly?.burn;
  if (burn) {
    return `This block is burning ${formatRatio(burn.ratio)} the usual rate: ${formatTokens(burn.current)} tokens per minute against ${formatTokens(burn.baseline)}.`;
  }
  return '';
}

export function anomalyTone(anomaly: UsageAnomaly | null | undefined) {
  if (anomaly?.daily || anomaly?.burn) return 'warn';
  return 'ok';
}

export function hasAnomaly(anomaly: UsageAnomaly | null | undefined) {
  return Boolean(anomaly?.daily || anomaly?.burn);
}

export const NO_ANOMALY_LINE = 'Today is in line with recent usage.';

function formatRatio(ratio: unknown) {
  const value = finiteNumber(ratio);
  if (value === null) return NO_VALUE;
  return `${trimTrailingZeros(value.toFixed(1))}x`;
}

// ── Vendors ──
// The lane reads Codex CLI and Grok CLI transcripts alongside Claude's. Everything vendor-aware is
// additive: a machine with only Claude usage reports one vendor and renders exactly as it did before.

const VENDOR_LABELS: Readonly<Record<string, string>> = Object.freeze({ claude: 'Claude', codex: 'Codex', grok: 'Grok' });

export function vendorLabel(vendor: unknown) {
  const key = typeof vendor === 'string' ? vendor.trim() : '';
  if (!key) return VENDOR_LABELS.claude;
  return VENDOR_LABELS[key] || key;
}

// A model row's vendor is only worth showing once another vendor is on the page; on an all-Claude machine
// it is noise on every row.
export function modelRowPrefix(row: { vendor?: unknown } | null | undefined, totals: UsageTotals | null | undefined) {
  if (!hasMultiVendorUsage(totals)) return '';
  return vendorLabel(row?.vendor);
}

export function vendorTotalsRows(totals: UsageTotals | null | undefined) {
  const byVendor = totals?.byVendor;
  if (!byVendor || typeof byVendor !== 'object') return [];
  return Object.keys(byVendor)
    .filter((vendor) => byVendor[vendor] && typeof byVendor[vendor] === 'object')
    .sort((left, right) => (finiteNumber(byVendor[right]?.tokens) ?? 0) - (finiteNumber(byVendor[left]?.tokens) ?? 0))
    .map((vendor) => ({
      vendor,
      label: vendorLabel(vendor),
      tokens: finiteNumber(byVendor[vendor]?.tokens) ?? 0,
      costUSD: finiteNumber(byVendor[vendor]?.costUSD) ?? 0,
    }));
}

// More than one vendor, or a single vendor that is not Claude: either way the split is worth showing.
// Key inspection only (no row building): this runs once per rendered model row via modelRowPrefix.
export function hasMultiVendorUsage(totals: UsageTotals | null | undefined) {
  const byVendor = totals?.byVendor;
  if (!byVendor || typeof byVendor !== 'object') return false;
  const vendors = Object.keys(byVendor).filter((vendor) => byVendor[vendor] && typeof byVendor[vendor] === 'object');
  if (vendors.length > 1) return true;
  return vendors.length === 1 && vendors[0] !== 'claude';
}

// One short clause, wherever a number is deliberately Claude-only, so a smaller figure next to a
// multi-vendor total does not read as an inconsistency.
export const CLAUDE_ONLY_HINT = 'Claude only';

export function claudeOnlyHint(totals: UsageTotals | null | undefined) {
  if (!hasMultiVendorUsage(totals)) return '';
  return CLAUDE_ONLY_HINT;
}

// ── Official plan limits ──
// The rate limits Claude Code publishes through its statusLine payload: the same numbers `/usage`
// shows, for the whole account rather than one session. When they are present they REPLACE the
// largest-completed-block heuristic, which only ever existed because nothing official was reachable.

// A snapshot older than this is still shown, labelled with its age, because a stale official number
// beats no number and beats silently falling back to an estimate the operator did not ask for.
export const PLAN_LIMIT_STALE_MS = 60 * 60 * 1000;

export interface PlanWindow {
  pct?: unknown;
  resetsAtMs?: unknown;
}

export interface PlanLimits {
  ts?: unknown;
  fiveHour?: PlanWindow;
  sevenDay?: PlanWindow;
}

export const PLAN_WINDOWS: readonly { key: 'fiveHour' | 'sevenDay'; label: string }[] = Object.freeze([
  { key: 'fiveHour', label: '5 hour' },
  { key: 'sevenDay', label: '7 day' },
]);

export function planWindowOf(planLimits: PlanLimits | null | undefined, key: 'fiveHour' | 'sevenDay') {
  const window = planLimits?.[key];
  if (!window || typeof window !== 'object') return null;
  const pct = finiteNumber(window.pct);
  const resetsAtMs = finiteNumber(window.resetsAtMs);
  if (pct === null && resetsAtMs === null) return null;
  return { pct, resetsAtMs };
}

export function hasOfficialPlanLimits(planLimits: PlanLimits | null | undefined) {
  return PLAN_WINDOWS.some((window) => planWindowOf(planLimits, window.key) !== null);
}

export function officialFiveHourPct(planLimits: PlanLimits | null | undefined) {
  return planWindowOf(planLimits, 'fiveHour')?.pct ?? null;
}

// An estimate presented as a plan limit would be a claim Glissa cannot make, so every percentage on the
// page is rendered next to the name of the thing it came from.
export function provenanceLabel(source: unknown) {
  if (source === 'official') return 'official, from Claude Code';
  if (source === 'estimated') return 'estimated from the largest completed block';
  return '';
}

/*
 * One judge of whether usage is alarming. Official five-hour usage wins outright when it exists; only
 * without it does this fall back to the heuristic, which takes the worse of where the block IS and where
 * its burn rate lands it (a purely reactive alarm fires after the tokens are already spent).
 */
export function blockAttentionTone(report: UsageReport | null | undefined, planLimits: PlanLimits | null = null) {
  const official = officialFiveHourPct(planLimits);
  if (official !== null) return tokenLimitTone(official);
  const current = tokenLimitTone(limitPct(report?.tokenLimit));
  if (current !== 'ok') return current;
  return tokenLimitTone(projectedLimitPct(report?.activeBlock?.projection, report?.tokenLimit));
}

// What the Usage dot is acknowledged against: which arbiters fire, at a COARSE bucket each. A flagged
// anomaly counts on its own (it is the one usage fact that appears without any threshold being crossed),
// and a budget is the operator's OWN ceiling, independent of the plan limit and the anomaly check. The
// buckets are deliberately coarse so a percentage drifting 91 to 92 does not re-light a dot the operator
// just cleared, while warn to crit (or near-budget to over-budget) does.
export function usageAttentionSignature(report: UsageReport | null | undefined, planLimits: PlanLimits | null = null) {
  const parts: string[] = [];
  const tone = blockAttentionTone(report, planLimits);
  if (tone !== 'ok') parts.push(`block:${tone}`);
  if (report?.anomaly?.daily) parts.push('anomaly:daily');
  if (report?.anomaly?.burn) parts.push('anomaly:burn');
  for (const row of budgetRows(report)) {
    const pct = budgetRowPct(row);
    if (pct < BUDGET_ATTENTION_PCT) continue;
    const scope = typeof row?.scope === 'string' && row.scope ? row.scope : 'budget';
    parts.push(`budget:${scope}:${pct >= 100 ? 'over' : 'near'}`);
  }
  return attentionSignature(parts);
}

export function hasUsageAttention(report: UsageReport | null | undefined, planLimits: PlanLimits | null = null) {
  return usageAttentionSignature(report, planLimits) !== '';
}

export function planWindowUsedText(window: PlanWindow | null | undefined) {
  const pct = finiteNumber(window?.pct);
  if (pct === null) return NO_VALUE;
  return `${formatPercent(pct)} used`;
}

// Counts DOWN, so it is repainted by the shared tick rather than being written once at build time.
export function resetCountdownText(resetsAtMs: unknown, now = Date.now()) {
  const resetsAt = finiteNumber(resetsAtMs);
  if (resetsAt === null || resetsAt <= 0) return '';
  const remainingMinutes = (resetsAt - now) / 60000;
  if (remainingMinutes <= 0) return 'resetting now';
  return `resets in ${formatMinutes(remainingMinutes)}`;
}

export function planLimitAgeText(ts: unknown, now = Date.now()) {
  const stamped = finiteNumber(ts);
  if (stamped === null || stamped <= 0) return '';
  const minutes = Math.max(0, Math.round((now - stamped) / 60000));
  return `${minutes}m old`;
}

export function isPlanLimitStale(ts: unknown, now = Date.now()) {
  const stamped = finiteNumber(ts);
  if (stamped === null || stamped <= 0) return true;
  return now - stamped > PLAN_LIMIT_STALE_MS;
}

// The degradation line, matching what `/usage` itself does with a stale read: keep showing the numbers
// and say how old they are.
export function planLimitStaleNote(ts: unknown, now = Date.now()) {
  if (!isPlanLimitStale(ts, now)) return '';
  const age = planLimitAgeText(ts, now);
  if (!age) return 'showing last-known usage';
  return `showing last-known usage (${age})`;
}

export function pricingSourceLine(pricing: { source?: unknown } | null | undefined, agoText = '') {
  const source = pricing?.source;
  if (source === 'fetched') {
    const ago = typeof agoText === 'string' ? agoText.trim() : '';
    if (!ago) return 'Prices fetched from the public model price table.';
    return `Prices fetched from the public model price table, ${ago}.`;
  }
  if (source === 'snapshot') return 'Prices from the price table bundled with this Glissa build.';
  if (source === 'unavailable') return 'Model prices could not be loaded, so every cost below counts as zero.';
  return 'Pricing source not reported yet.';
}

export function missingPricingLine(missing: unknown) {
  const entries: unknown[] = Array.isArray(missing) ? missing : [];
  const models = entries.map((m) => String(m)).filter((m) => m);
  if (models.length === 0) return '';
  const noun = models.length === 1 ? 'model' : 'models';
  return `No price for ${models.length} ${noun}: ${models.join(', ')}. Their cost counts as zero here.`;
}

// scan.dirs is an ARRAY of resolved transcript directories on the wire, so a count is taken rather
// than assuming a number and silently dropping the clause.
function countOf(value: unknown) {
  if (Array.isArray(value)) return value.length;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

export function scanLine(scan: UsageScan | null | undefined) {
  if (!scan || typeof scan !== 'object') return '';
  const parts: string[] = [];
  const dirs = countOf(scan.dirs);
  if (dirs !== null) parts.push(`${formatCount(dirs)} transcript ${dirs === 1 ? 'directory' : 'directories'}`);
  if (Number.isFinite(scan.files)) parts.push(`${formatCount(scan.files)} files`);
  if (Number.isFinite(scan.entries)) parts.push(`${formatCount(scan.entries)} entries`);
  if (Number.isFinite(scan.lastScanMs)) parts.push(`last pass ${formatCount(scan.lastScanMs)}ms`);
  if (parts.length === 0) return '';
  const head = `Scanned ${parts.join(', ')}.`;
  if (scan.partial !== true) return head;
  return `${head} Some files were skipped this pass and will be re-read on the next one.`;
}

// ── Unavailable reports ──
// An error report carries no totals, so rendering the normal sections against it prints a confident
// zero for a lane that is off or blind. These say which it is instead.
export function usageErrorLine(report: UsageReport | null | undefined) {
  const error = typeof report?.error === 'string' ? report.error.trim() : '';
  return error;
}

export function usageWarningLine(report: UsageReport | null | undefined) {
  const warning = typeof report?.warning === 'string' ? report.warning.trim() : '';
  if (!warning) return '';
  return `Glissa could not read every transcript location: ${warning}`;
}

export function isUsageUnavailable(report: UsageReport | null | undefined) {
  return usageErrorLine(report) !== '';
}

export function shouldApplyUsageReport(msg: unknown, latestRequestId: unknown) {
  if (!msg || typeof msg !== 'object') return false;
  const id = (msg as { requestId?: unknown }).requestId;
  // A connect-time replay and a broadcast carry no id; only a reply to a request we superseded is stale.
  if (id == null) return true;
  return id === latestRequestId;
}

function projectBasename(path: unknown) {
  const text = String(path ?? '').trim();
  if (!text) return '';
  const segments = text.split(/[\\/]+/).filter((part) => part);
  if (segments.length === 0) return text;
  return segments[segments.length - 1];
}

export function isGlissaSessionRow(row: UsageWireRow | null | undefined) {
  return typeof row?.id === 'string' && row.id !== '';
}

// A Glissa-managed session wears its card name; anything not managed is identified by the project it
// ran in, because a raw transcript directory name means nothing to an operator.
export function sessionRowLabel(row: UsageWireRow | null | undefined) {
  const label = typeof row?.label === 'string' ? row.label.trim() : '';
  if (isGlissaSessionRow(row) && label) return label;
  const project = projectBasename(row?.project);
  if (project) return project;
  if (label) return label;
  return 'unknown project';
}

// A null model is what the scanner reports for a synthetic transcript entry, not a bug to hide.
export function modelLabel(row: unknown) {
  const model = typeof row === 'string' ? row : (row as { model?: unknown } | null | undefined)?.model;
  const text = typeof model === 'string' ? model.trim() : '';
  if (!text) return 'unknown model';
  return text;
}

function dayKeyOf(row: UsageWireRow | null | undefined) {
  return String(row?.day ?? '');
}

function sortValueOf(row: UsageWireRow, key: string, labelOf: (row: UsageWireRow) => string): string | number {
  if (!TEXT_SORT_KEYS.has(key)) {
    const numeric = Number(row?.[key]);
    return Number.isFinite(numeric) ? numeric : 0;
  }
  if (key === 'day') return dayKeyOf(row);
  return labelOf(row);
}

// One comparator for every usage table, so a column header and the default order cannot disagree.
export function sortUsageRows(
  rows: unknown,
  key: string,
  dir: string,
  labelOf: (row: UsageWireRow) => string = sessionRowLabel
): UsageWireRow[] {
  const list: UsageWireRow[] = Array.isArray(rows) ? [...rows] : [];
  const sign = dir === 'asc' ? 1 : -1;
  return list.sort((a, b) => {
    const left = sortValueOf(a, key, labelOf);
    const right = sortValueOf(b, key, labelOf);
    if (typeof left === 'string' || typeof right === 'string') {
      return sign * String(left).localeCompare(String(right));
    }
    if (left !== right) return sign * (left - right);
    const leftTokens = Number(a?.tokens);
    const rightTokens = Number(b?.tokens);
    const leftSafe = Number.isFinite(leftTokens) ? leftTokens : 0;
    const rightSafe = Number.isFinite(rightTokens) ? rightTokens : 0;
    if (leftSafe !== rightSafe) return rightSafe - leftSafe;
    return labelOf(a).localeCompare(labelOf(b));
  });
}

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

export function defaultSortDir(key: string): 'asc' | 'desc' {
  return ASC_BY_DEFAULT_KEYS.has(key) ? 'asc' : 'desc';
}

export function nextSortState(current: SortState | null | undefined, key: string): SortState {
  if (current?.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: defaultSortDir(key) };
}

export function ariaSortValue(current: SortState | null | undefined, key: string) {
  if (current?.key !== key) return 'none';
  return current.dir === 'asc' ? 'ascending' : 'descending';
}

export const DEFAULT_SESSION_SORT: Readonly<SortState> = Object.freeze({ key: 'lastTs', dir: 'desc' });
export const DEFAULT_MODEL_SORT: Readonly<SortState> = Object.freeze({ key: 'tokens', dir: 'desc' });
export const DEFAULT_DAY_SORT: Readonly<SortState> = Object.freeze({ key: 'day', dir: 'desc' });

export function sortSessionRows(rows: unknown, sort: Readonly<SortState> = DEFAULT_SESSION_SORT) {
  return sortUsageRows(rows, sort.key, sort.dir, sessionRowLabel);
}

export function visibleSessionRows(sortedRows: unknown, expanded: boolean, limit: number = SESSION_ROW_LIMIT): { rows: UsageWireRow[]; hiddenCount: number } {
  if (!Array.isArray(sortedRows)) return { rows: [], hiddenCount: 0 };
  const maxRows = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : SESSION_ROW_LIMIT;
  if (expanded || sortedRows.length <= maxRows) return { rows: sortedRows, hiddenCount: 0 };
  return {
    rows: sortedRows.slice(0, maxRows),
    hiddenCount: sortedRows.length - maxRows,
  };
}

export function sessionOverflowText(hiddenCount: unknown) {
  const hidden = Number(hiddenCount);
  if (!Number.isFinite(hidden) || hidden <= 0) return '';
  return `${formatCount(hidden)} hidden`;
}

export function sortModelRows(models: unknown, sort: Readonly<SortState> = DEFAULT_MODEL_SORT) {
  return sortUsageRows(models, sort.key, sort.dir, modelLabel);
}

export function sortDailyRows(daily: unknown, sort: Readonly<SortState> = DEFAULT_DAY_SORT) {
  return sortUsageRows(daily, sort.key, sort.dir, dayKeyOf);
}

export function dailyRowForDay(daily: unknown, day: unknown): UsageWireRow | null {
  const list: UsageWireRow[] = Array.isArray(daily) ? daily : [];
  return list.find((row) => String(row?.day ?? '') === String(day ?? '')) || null;
}

// Newest first, gaps dropped: a gap block is the absence of work, and a row of zeros for it would read
// as a quiet block rather than no block at all.
export function blockHistoryRows(blocks: unknown, limit = 8) {
  const rows: UsageBlock[] = Array.isArray(blocks) ? blocks : [];
  const list = rows.filter((block) => block && block.isGap !== true);
  const sorted = list.sort((a, b) => (Number(b?.startTs) || 0) - (Number(a?.startTs) || 0));
  return sorted.slice(0, Math.max(0, limit)).map((block) => ({
    startTs: Number(block.startTs),
    tokens: typeof block.tokens === 'number' && Number.isFinite(block.tokens) ? block.tokens : 0,
    costUSD: typeof block.costUSD === 'number' && Number.isFinite(block.costUSD) ? block.costUSD : 0,
    isActive: block.isActive === true,
  }));
}

// Claude's own cumulative figure for this conversation when a statusLine callback has reported one,
// otherwise the scanner's list-price arithmetic. Official is preferred because it is the same number
// Claude Code shows the operator, and the chip's title says which one is on screen.
export function sessionChipCost(usage: UsageSessionUsage | null | undefined): { costUSD: number | null; source: string | null } {
  const official = finiteNumber(usage?.officialCostUSD);
  if (official !== null && official > 0) return { costUSD: official, source: 'official' };
  const estimated = finiteNumber(usage?.costUSD);
  if (estimated !== null && estimated > 0) return { costUSD: estimated, source: 'estimated' };
  return { costUSD: null, source: null };
}

// The per-card chip: tokens plus cost for the conversation the card is currently in.
export function sessionChipText(usage: UsageSessionUsage | null | undefined) {
  const tokens = Number(usage?.tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  const { costUSD } = sessionChipCost(usage);
  if (costUSD === null) return formatTokens(tokens);
  return `${formatTokens(tokens)} ${formatUsd(costUSD)}`;
}

export function sessionChipTitle(usage: UsageSessionUsage | null | undefined) {
  const { source } = sessionChipCost(usage);
  if (source === 'official') return 'Tokens counted from the transcript; cost reported by Claude Code for this conversation';
  return 'Tokens and estimated API list-price cost for this conversation';
}
