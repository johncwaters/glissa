// ── Usage view: pure formatting and ordering ──────────────────
// Every string the Usage panel renders is built here, so the panel is DOM only and the wording is
// testable without a browser. No literal em dash, en dash or ellipsis is produced anywhere: a missing
// value reads as the ASCII placeholder below, ranges read "Aug 12 to Aug 19", and a projection reads
// "->" (tests/frontend-usage-view.test.js pins that).

export const NO_VALUE = '-';

// The one honesty line the panel leads with. Costs are list-price arithmetic over local transcripts,
// which is a different thing from a bill.
export const USAGE_CAVEAT = 'Costs are API list-price estimates. A Claude subscription does not bill per token, and only the Claude Code transcripts stored on this machine are counted.';

// ccusage's own warning threshold for a token limit, and the panel's attention condition with it.
export const TOKEN_LIMIT_WARN_PCT = 80;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function trimTrailingZeros(fixed) {
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

export function formatCount(value) {
  if (!Number.isFinite(value)) return NO_VALUE;
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  return `${sign}${groupThousands(String(Math.abs(rounded)))}`;
}

// Sub-cent totals are real on a per-model row, so they keep four decimals instead of rounding to a
// misleading $0.00.
export function formatUsd(value) {
  if (!Number.isFinite(value)) return NO_VALUE;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  const [whole, cents] = abs.toFixed(2).split('.');
  return `${sign}$${groupThousands(whole)}.${cents}`;
}

export function formatTokens(value) {
  if (!Number.isFinite(value)) return NO_VALUE;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  // 999950 already rounds to 1.0M at this precision, so it crosses here rather than reading "1000k".
  if (abs < 999950) return `${sign}${trimTrailingZeros((abs / 1000).toFixed(1))}k`;
  return `${sign}${trimTrailingZeros((abs / 1e6).toFixed(2))}M`;
}

export function localDayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export function dayLabel(day) {
  const parts = DAY_KEY_RE.exec(String(day ?? ''));
  if (!parts) return String(day ?? '') || NO_VALUE;
  const month = MONTH_NAMES[Number(parts[2]) - 1];
  if (!month) return String(day);
  return `${month} ${Number(parts[3])}`;
}

// "Aug 12 to Aug 19", the no-dash form of a date range.
export function dayRangeLabel(days) {
  const keys = (Array.isArray(days) ? days : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.day))
    .filter((key) => DAY_KEY_RE.test(String(key ?? '')))
    .sort();
  if (keys.length === 0) return '';
  if (keys.length === 1) return dayLabel(keys[0]);
  return `${dayLabel(keys[0])} to ${dayLabel(keys[keys.length - 1])}`;
}

export function relativeAgo(ts, now = Date.now()) {
  if (!Number.isFinite(ts) || ts <= 0) return 'never';
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function formatMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return NO_VALUE;
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

export function burnLine(burn) {
  if (!burn || typeof burn !== 'object') return '';
  const parts = [];
  if (Number.isFinite(burn.tokensPerMinute)) parts.push(`${formatTokens(burn.tokensPerMinute)} tokens per minute`);
  if (Number.isFinite(burn.tokensPerMinuteExCache)) parts.push(`${formatTokens(burn.tokensPerMinuteExCache)} excluding cache`);
  if (Number.isFinite(burn.costPerHour)) parts.push(`${formatUsd(burn.costPerHour)} per hour`);
  return parts.join(', ');
}

export function projectionLine(projection) {
  if (!projection || typeof projection !== 'object') return '';
  const totals = [];
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
export function blockProgress(block, now = Date.now()) {
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

export function tokenLimitTone(pct) {
  if (!Number.isFinite(pct)) return 'ok';
  if (pct >= 100) return 'crit';
  if (pct >= TOKEN_LIMIT_WARN_PCT) return 'warn';
  return 'ok';
}

export function tokenLimitLine(tokenLimit) {
  const max = Number(tokenLimit?.max);
  if (!Number.isFinite(max) || max <= 0) return '';
  const pct = Number.isFinite(tokenLimit?.pct) ? Math.round(tokenLimit.pct) : 0;
  return `${pct}% of ${formatTokens(max)} tokens, the largest completed block seen`;
}

// The panel's tab-dot condition, the peer of Radar's attention count: a block running at or past the
// warning threshold is the one usage fact worth pulling an operator over.
export function hasUsageAttention(report) {
  const pct = Number(report?.tokenLimit?.pct);
  if (!Number.isFinite(pct)) return false;
  return pct >= TOKEN_LIMIT_WARN_PCT;
}

export function pricingSourceLine(pricing, now = Date.now()) {
  const source = pricing?.source;
  if (source === 'fetched') {
    const fetchedAt = Number(pricing?.fetchedAt);
    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return 'Prices fetched from the public model price table.';
    return `Prices fetched from the public model price table, ${relativeAgo(fetchedAt, now)}.`;
  }
  if (source === 'snapshot') return 'Prices from the price table bundled with this Glissa build.';
  return 'Pricing source not reported yet.';
}

export function missingPricingLine(missing) {
  const models = (Array.isArray(missing) ? missing : []).map((m) => String(m)).filter((m) => m);
  if (models.length === 0) return '';
  const noun = models.length === 1 ? 'model' : 'models';
  return `No price for ${models.length} ${noun}: ${models.join(', ')}. Their cost counts as zero here.`;
}

export function scanLine(scan) {
  if (!scan || typeof scan !== 'object') return '';
  const parts = [];
  if (Number.isFinite(scan.dirs)) parts.push(`${formatCount(scan.dirs)} transcript ${scan.dirs === 1 ? 'directory' : 'directories'}`);
  if (Number.isFinite(scan.files)) parts.push(`${formatCount(scan.files)} files`);
  if (Number.isFinite(scan.entries)) parts.push(`${formatCount(scan.entries)} entries`);
  if (Number.isFinite(scan.lastScanMs)) parts.push(`last pass ${formatCount(scan.lastScanMs)}ms`);
  if (parts.length === 0) return '';
  const head = `Scanned ${parts.join(', ')}.`;
  if (scan.partial !== true) return head;
  return `${head} Some files were skipped this pass and will be re-read on the next one.`;
}

function projectBasename(path) {
  const text = String(path ?? '').trim();
  if (!text) return '';
  const segments = text.split(/[\\/]+/).filter((part) => part);
  if (segments.length === 0) return text;
  return segments[segments.length - 1];
}

export function isGlissaSessionRow(row) {
  return typeof row?.id === 'string' && row.id !== '';
}

// A Glissa-managed session wears its card name; anything else is identified by the project it ran in,
// because a raw transcript directory name means nothing to an operator.
export function sessionRowLabel(row) {
  const label = typeof row?.label === 'string' ? row.label.trim() : '';
  if (isGlissaSessionRow(row) && label) return label;
  const project = projectBasename(row?.project);
  if (project) return project;
  if (label) return label;
  return 'unknown project';
}

export function sortSessionRows(rows) {
  const list = Array.isArray(rows) ? [...rows] : [];
  return list.sort((a, b) => {
    const aTs = Number.isFinite(a?.lastTs) ? a.lastTs : 0;
    const bTs = Number.isFinite(b?.lastTs) ? b.lastTs : 0;
    if (bTs !== aTs) return bTs - aTs;
    const aTokens = Number.isFinite(a?.tokens) ? a.tokens : 0;
    const bTokens = Number.isFinite(b?.tokens) ? b.tokens : 0;
    if (bTokens !== aTokens) return bTokens - aTokens;
    return sessionRowLabel(a).localeCompare(sessionRowLabel(b));
  });
}

export function sortDailyRows(daily) {
  const list = Array.isArray(daily) ? [...daily] : [];
  return list.sort((a, b) => String(b?.day ?? '').localeCompare(String(a?.day ?? '')));
}

export function sortModelRows(models) {
  const list = Array.isArray(models) ? [...models] : [];
  return list.sort((a, b) => {
    const aTokens = Number.isFinite(a?.tokens) ? a.tokens : 0;
    const bTokens = Number.isFinite(b?.tokens) ? b.tokens : 0;
    if (bTokens !== aTokens) return bTokens - aTokens;
    return modelLabel(a).localeCompare(modelLabel(b));
  });
}

// A null model is what the scanner reports for a synthetic transcript entry, not a bug to hide.
export function modelLabel(row) {
  const model = typeof row === 'string' ? row : row?.model;
  const text = typeof model === 'string' ? model.trim() : '';
  if (!text) return 'unknown model';
  return text;
}

export function dailyRowForDay(daily, day) {
  const list = Array.isArray(daily) ? daily : [];
  return list.find((row) => String(row?.day ?? '') === String(day ?? '')) || null;
}

// The per-card chip: tokens plus estimated cost for the conversation the card is currently in.
export function sessionChipText(usage) {
  const tokens = Number(usage?.tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  const cost = Number(usage?.costUSD);
  if (!Number.isFinite(cost) || cost <= 0) return formatTokens(tokens);
  return `${formatTokens(tokens)} ${formatUsd(cost)}`;
}
