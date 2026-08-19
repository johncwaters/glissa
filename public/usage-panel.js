// ── Usage view ────────────────────────────────────────────────
// Token and estimated-cost insight over the Claude Code transcripts on this machine, fed by two
// control-WS messages: `usage-sessions` (small, pushed whenever a session's totals move) and
// `usage-report` (the full roll-up, pulled with `request-usage-report`). The panel is DOM only: every
// string it shows is built in usage-view-core.mjs, which is where the no-dash wording lives.
//
// The tab is always present, so an operator who has switched usage tracking off still finds the surface
// and is told where to switch it back on.

import { el } from './dom-helpers.js';
import {
  USAGE_CAVEAT,
  blockProgress,
  burnLine,
  dayLabel,
  dayRangeLabel,
  dailyRowForDay,
  formatMinutes,
  formatTokens,
  formatUsd,
  hasUsageAttention,
  isGlissaSessionRow,
  localDayKey,
  missingPricingLine,
  modelLabel,
  pricingSourceLine,
  projectionLine,
  relativeAgo,
  scanLine,
  sessionRowLabel,
  sortDailyRows,
  sortModelRows,
  sortSessionRows,
  tokenLimitLine,
  tokenLimitTone,
} from './usage-view-core.mjs';

let _report = null;
let _sessions = null;
let _root = null;
let _activityCallback = null;

function buildSection(title, hint) {
  const section = el('section', 'usage-section');
  const head = el('div', 'usage-section-head');
  head.append(el('h2', 'usage-section-title', title));
  if (hint) head.append(el('span', 'usage-section-hint', hint));
  section.append(head);
  return section;
}

function buildTile(label, value, sub) {
  const tile = el('div', 'usage-tile');
  tile.append(el('span', 'usage-tile-value', value), el('span', 'usage-tile-label', label));
  if (sub) tile.append(el('span', 'usage-tile-sub', sub));
  return tile;
}

function buildMeter(pct, tone) {
  const meter = el('div', 'usage-meter');
  meter.dataset.tone = tone;
  meter.setAttribute('role', 'img');
  meter.setAttribute('aria-label', `${pct}%`);
  const fill = el('span', 'usage-meter-fill');
  fill.style.width = `${Math.min(Math.max(pct, 0), 100)}%`;
  meter.append(fill);
  return meter;
}

// The by-model table is seven numeric columns wide, so it scrolls inside its own box rather than
// letting the page scroll sideways on a narrow window or a phone.
function buildTable(headings) {
  const wrap = el('div', 'usage-table-scroll');
  const table = el('table', 'usage-table');
  const head = el('thead');
  const headRow = el('tr');
  for (const heading of headings) {
    const cell = el('th', heading.numeric ? 'usage-num' : null, heading.label);
    cell.scope = 'col';
    headRow.append(cell);
  }
  head.append(headRow);
  const body = el('tbody');
  table.append(head, body);
  wrap.append(table);
  return { wrap, body };
}

function appendCells(row, cells) {
  for (const cell of cells) {
    const td = el('td', cell.numeric ? 'usage-num' : cell.className || null, cell.text);
    if (cell.title) td.title = cell.title;
    if (cell.span) td.colSpan = cell.span;
    row.append(td);
  }
}

// ── Header ──
// The caveat leads, because every number under it is arithmetic over list prices rather than anything
// Anthropic charged this account.
function buildHeaderSection() {
  const section = buildSection('Usage', dayRangeLabel(_report?.daily || []));
  section.append(el('p', 'usage-caveat', USAGE_CAVEAT));
  const pricing = _report?.pricing || (_sessions ? { source: _sessions.pricingSource } : null);
  section.append(el('p', 'usage-meta', pricingSourceLine(pricing)));
  const missing = missingPricingLine(_report?.pricing?.missing);
  if (missing) {
    const warning = el('p', 'usage-warning', missing);
    warning.dataset.tone = 'warn';
    section.append(warning);
  }
  const scan = scanLine(_report?.scan);
  if (scan) section.append(el('p', 'usage-meta', scan));
  return section;
}

// ── Totals ──
function buildTotalsSection() {
  const totals = _report?.totals || {};
  const today = dailyRowForDay(_report?.daily, localDayKey(new Date()));
  const section = buildSection('Totals', _report?.tz ? `daily buckets in ${_report.tz}` : '');
  const tiles = el('div', 'usage-tiles');
  tiles.append(buildTile('today', formatTokens(today?.tokens ?? 0), formatUsd(today?.costUSD ?? 0)));
  tiles.append(buildTile('all tokens', formatTokens(totals.tokens ?? 0), formatUsd(totals.costUSD ?? 0)));
  tiles.append(buildTile('input', formatTokens(totals.input ?? 0)));
  tiles.append(buildTile('output', formatTokens(totals.output ?? 0)));
  tiles.append(buildTile('cache write', formatTokens(totals.cacheCreate ?? 0)));
  tiles.append(buildTile('cache read', formatTokens(totals.cacheRead ?? 0)));
  section.append(tiles);
  if (_sessions?.ts) section.append(el('p', 'usage-meta', `Session totals updated ${relativeAgo(_sessions.ts)}.`));
  return section;
}

// ── Active block ──
// ccusage's 5h window: where the current burn is heading, and how close it is to the largest block this
// machine has ever completed (the only limit reference a subscription actually exposes).
function buildActiveBlockSection() {
  const block = _report?.activeBlock;
  const hours = Number.isFinite(_report?.blockHours) ? _report.blockHours : 5;
  const section = buildSection('Current block', `${hours}h window`);
  if (!block) {
    section.append(el('p', 'usage-empty', 'No block is active. The window opens again with the next turn.'));
    return section;
  }

  const tiles = el('div', 'usage-tiles');
  tiles.append(buildTile('block tokens', formatTokens(block.tokens ?? 0), formatUsd(block.costUSD ?? 0)));
  const progress = blockProgress(block);
  if (progress) tiles.append(buildTile('elapsed', `${progress.pct}%`, `${formatMinutes(progress.remainingMinutes)} left`));
  section.append(tiles);

  if (progress) section.append(buildMeter(progress.pct, 'ok'));

  const burn = burnLine(block.burn);
  if (burn) section.append(el('p', 'usage-meta', burn));
  const projection = projectionLine(block.projection);
  if (projection) section.append(el('p', 'usage-projection', projection));

  const limit = tokenLimitLine(_report?.tokenLimit);
  if (!limit) return section;
  const tone = tokenLimitTone(_report?.tokenLimit?.pct);
  const limitLine = el('p', 'usage-meta', limit);
  limitLine.dataset.tone = tone;
  section.append(buildMeter(Number(_report?.tokenLimit?.pct) || 0, tone), limitLine);
  return section;
}

// ── Daily ──
// Most recent day first: the operator is asking "what did today cost", not reading a ledger forward.
function buildDailySection() {
  const rows = sortDailyRows(_report?.daily);
  const section = buildSection('By day', 'most recent first');
  if (rows.length === 0) {
    section.append(el('p', 'usage-empty', 'No daily usage recorded yet.'));
    return section;
  }
  const { wrap, body } = buildTable([
    { label: 'Day' },
    { label: 'Tokens', numeric: true },
    { label: 'Cost', numeric: true },
  ]);
  for (const row of rows) {
    const tr = el('tr', 'usage-row');
    appendCells(tr, [
      { text: dayLabel(row.day), title: String(row.day ?? '') },
      { text: formatTokens(row.tokens), numeric: true },
      { text: formatUsd(row.costUSD), numeric: true },
    ]);
    body.append(tr);
    const models = sortModelRows(row.models);
    if (models.length === 0) continue;
    const breakdown = el('tr', 'usage-row-breakdown');
    const cell = el('td', 'usage-models');
    cell.colSpan = 3;
    for (const model of models) {
      const chip = el('span', 'usage-model-chip');
      chip.append(
        el('span', 'usage-model-name', modelLabel(model)),
        el('span', 'usage-model-value', `${formatTokens(model.tokens)} ${formatUsd(model.costUSD)}`),
      );
      cell.append(chip);
    }
    breakdown.append(cell);
    body.append(breakdown);
  }
  section.append(wrap);
  return section;
}

// ── Per model ──
function buildModelsSection() {
  const rows = sortModelRows(_report?.models);
  const section = buildSection('By model', 'largest first');
  if (rows.length === 0) {
    section.append(el('p', 'usage-empty', 'No model usage recorded yet.'));
    return section;
  }
  const { wrap, body } = buildTable([
    { label: 'Model' },
    { label: 'Tokens', numeric: true },
    { label: 'Cost', numeric: true },
    { label: 'Input', numeric: true },
    { label: 'Output', numeric: true },
    { label: 'Cache write', numeric: true },
    { label: 'Cache read', numeric: true },
  ]);
  for (const row of rows) {
    const tr = el('tr', 'usage-row');
    appendCells(tr, [
      { text: modelLabel(row), className: 'usage-model-cell', title: modelLabel(row) },
      { text: formatTokens(row.tokens), numeric: true },
      { text: formatUsd(row.costUSD), numeric: true },
      { text: formatTokens(row.input), numeric: true },
      { text: formatTokens(row.output), numeric: true },
      { text: formatTokens(row.cacheCreate), numeric: true },
      { text: formatTokens(row.cacheRead), numeric: true },
    ]);
    body.append(tr);
  }
  section.append(wrap);
  return section;
}

// ── Per session ──
// Ordered by last activity, so the conversation the operator just left is the top row. A transcript
// Glissa never managed still counts real cost, and is labelled by its project rather than hidden.
function buildSessionsSection() {
  const rows = sortSessionRows(_report?.sessions);
  const section = buildSection('By session', 'most recent first');
  if (rows.length === 0) {
    section.append(el('p', 'usage-empty', 'No session usage recorded yet.'));
    return section;
  }
  const { wrap, body } = buildTable([
    { label: 'Session' },
    { label: 'Tokens', numeric: true },
    { label: 'Cost', numeric: true },
    { label: 'Last activity', numeric: true },
  ]);
  for (const row of rows) {
    const tr = el('tr', 'usage-row');
    if (isGlissaSessionRow(row)) tr.dataset.managed = 'true';
    const label = sessionRowLabel(row);
    appendCells(tr, [
      { text: label, className: 'usage-session-cell', title: row.project ? String(row.project) : label },
      { text: formatTokens(row.tokens), numeric: true },
      { text: formatUsd(row.costUSD), numeric: true },
      { text: relativeAgo(row.lastTs), numeric: true },
    ]);
    body.append(tr);
  }
  section.append(wrap);
  return section;
}

function render() {
  if (!_root) return;
  _root.textContent = '';
  _root.append(buildHeaderSection());
  if (!_report) {
    _root.append(el('p', 'usage-empty', 'Reading the local transcripts. The report lands on the next scan.'));
    return;
  }
  _root.append(buildTotalsSection(), buildActiveBlockSection(), buildDailySection(), buildModelsSection(), buildSessionsSection());
}

function refreshActivity() {
  if (!_activityCallback) return;
  _activityCallback(hasUsageAttention(_report));
}

// The tab-activity seam (defined in pr-panel.js): the view owns the condition, app.js owns the dot
// element. The condition is the token-limit warning, the one usage fact worth interrupting for.
export function setUsageActivityCallback(callback) {
  _activityCallback = callback;
  refreshActivity();
}

export function mountUsageView(parent) {
  if (_root) return _root;
  const root = el('div', 'usage-content');
  parent.appendChild(root);
  _root = root;
  render();
  return root;
}

export function applyUsageSessions(msg) {
  _sessions = msg;
  render();
}

export function applyUsageReport(msg) {
  _report = msg;
  render();
  refreshActivity();
}

// The Settings dialog's read-only Usage line: the pricing source and the last scan, sourced from the
// same report the panel is showing rather than a second request.
export function usageStatusLines() {
  const pricing = _report?.pricing || (_sessions ? { source: _sessions.pricingSource } : null);
  const lines = [pricingSourceLine(pricing)];
  const scan = scanLine(_report?.scan);
  if (scan) lines.push(scan);
  return lines;
}
