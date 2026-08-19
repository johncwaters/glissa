// ── Usage view ────────────────────────────────────────────────
// Token and estimated-cost insight over the Claude Code transcripts on this machine, fed by two
// control-WS messages: `usage-sessions` (small, pushed whenever a session's totals move) and
// `usage-report` (the full roll-up, pulled with `request-usage-report`). The panel is DOM only: every
// string it shows is built in usage-view-core.mjs, which is where the no-dash wording lives.
//
// The tab is always present, so an operator who has switched usage tracking off still finds the surface
// and is told where to switch it back on.

import { el } from './dom-helpers.js';
import { createPollAgoTicker, formatAgo } from './poll-ago.js';
import {
  DEFAULT_DAY_SORT,
  DEFAULT_MODEL_SORT,
  DEFAULT_RANGE_VALUE,
  DEFAULT_SESSION_SORT,
  PLAN_WINDOWS,
  RANGE_OPTIONS,
  USAGE_CAVEAT,
  USAGE_CAVEAT_SHORT,
  USAGE_DISABLED_HINT,
  ariaSortValue,
  claudeOnlyHint,
  blockAttentionTone,
  blockHistoryRows,
  blockLabel,
  blockProgress,
  burnTiles,
  dailyRowForDay,
  dayLabel,
  dayRangeLabel,
  formatMinutes,
  formatPercent,
  formatTokens,
  formatUsd,
  hasMultiVendorUsage,
  hasOfficialPlanLimits,
  hasUsageAttention,
  isGlissaSessionRow,
  isUsageUnavailable,
  limitPct,
  missingPricingLine,
  modelLabel,
  modelRowPrefix,
  nextSortState,
  percentOfTotal,
  planLimitAgeText,
  planLimitStaleNote,
  planWindowOf,
  planWindowUsedText,
  pricingSourceLine,
  projectionLimitLine,
  projectionLine,
  provenanceLabel,
  reportDayKey,
  resetCountdownText,
  scanLine,
  sessionRowLabel,
  shareBasis,
  shareLabel,
  shouldApplyUsageReport,
  sortDailyRows,
  sortModelRows,
  sortSessionRows,
  tokenLimitLine,
  tokenLimitTone,
  usageErrorLine,
  usageWarningLine,
  vendorTotalsRows,
} from './usage-view-core.mjs';

const REFRESH_STATUS_TIMEOUT_MS = 20000;

let _report = null;
let _sessions = null;
let _planLimits = null;
let _root = null;
let _activityCallback = null;
let _sendRequest = null;
let _requestSeq = 0;
let _latestRequestId = null;
let _rangeValue = DEFAULT_RANGE_VALUE;
let _refreshPending = false;
let _refreshTimer = null;

let _daySort = DEFAULT_DAY_SORT;
let _modelSort = DEFAULT_MODEL_SORT;
let _sessionSort = DEFAULT_SESSION_SORT;
let _focusAfterRender = null;
const _expandedDays = new Set();

// Elements the shared tick repaints in place, so a report that has not changed is never rebuilt just to
// advance a clock.
let _reportAgeEl = null;
let _sessionsTsEl = null;
let _pricingEl = null;
let _planAgeEl = null;
let _blockElapsedEl = null;
let _blockRemainingEl = null;
let _blockMeterEl = null;
let _refreshButtonEl = null;
let _refreshStatusEl = null;

const _ticker = createPollAgoTicker(() => _root);

// ── Small builders ──

function buildSection(title, hint) {
  const section = el('section', 'usage-section');
  const head = el('div', 'usage-section-head');
  head.append(el('h2', 'usage-section-title', title));
  if (hint) head.append(el('span', 'usage-section-hint', hint));
  section.append(head);
  return section;
}

function buildTile(label, value, sub, tone) {
  const tile = el('div', 'usage-tile');
  if (tone && tone !== 'ok') tile.dataset.tone = tone;
  const valueEl = el('span', 'usage-tile-value', value);
  tile.append(valueEl, el('span', 'usage-tile-label', label));
  const subEl = sub ? el('span', 'usage-tile-sub', sub) : null;
  if (subEl) tile.append(subEl);
  return { tile, valueEl, subEl };
}

function clampPct(pct) {
  const numeric = Number(pct);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(Math.max(numeric, 0), 100);
}

function buildMeter(pct, tone, label) {
  const meter = el('div', 'usage-meter');
  meter.dataset.tone = tone;
  meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-label', label);
  const fill = el('span', 'usage-meter-fill');
  meter.append(fill);
  paintMeter(meter, pct);
  return meter;
}

function paintMeter(meter, pct) {
  if (!meter) return;
  const value = clampPct(pct);
  meter.setAttribute('aria-valuenow', String(Math.round(value)));
  const fill = meter.querySelector('.usage-meter-fill');
  if (fill) fill.style.width = `${value}%`;
}

// The by-model table is eight columns wide, so it scrolls inside its own box rather than letting the
// page scroll sideways on a narrow window or a phone.
function buildTable(headings, sort, onSort, tableId) {
  const wrap = el('div', 'usage-table-scroll');
  wrap.dataset.usageTable = tableId;
  const table = el('table', 'usage-table');
  const head = el('thead');
  const headRow = el('tr');
  for (const heading of headings) {
    const cell = el('th', heading.numeric ? 'usage-num' : null);
    cell.scope = 'col';
    if (!heading.key) {
      cell.textContent = heading.label;
      headRow.append(cell);
      continue;
    }
    cell.setAttribute('aria-sort', ariaSortValue(sort, heading.key));
    const button = el('button', 'usage-sort', heading.label);
    button.type = 'button';
    button.dataset.sortKey = heading.key;
    button.addEventListener('click', () => {
      // Sorting rebuilds the table, so the control the operator just activated has to be handed its
      // focus back or a keyboard sort drops them to the top of the document.
      _focusAfterRender = { kind: 'sort', table: tableId, key: heading.key };
      onSort(heading.key);
    });
    cell.append(button);
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
    const td = el('td', cell.numeric ? 'usage-num' : cell.className || null, cell.node ? null : cell.text);
    if (cell.node) td.append(cell.node);
    if (cell.title) td.title = cell.title;
    if (cell.span) td.colSpan = cell.span;
    row.append(td);
  }
}

// Share of the whole, as a number and a bar: an absolute cost says nothing about whether a row is the
// one worth acting on.
function buildShareCell(pct) {
  const wrap = el('div', 'usage-share');
  if (!Number.isFinite(pct)) {
    wrap.append(el('span', 'usage-share-text', formatPercent(pct)));
    return wrap;
  }
  const bar = el('span', 'usage-share-bar');
  const fill = el('span', 'usage-share-fill');
  fill.style.width = `${clampPct(pct)}%`;
  bar.append(fill);
  wrap.append(bar, el('span', 'usage-share-text', formatPercent(pct)));
  return wrap;
}

// ── Tick painters ──
// Each reads module state rather than a captured value, so a targeted update and the shared tick can
// share one painter and neither can go stale.

function paintReportAge() {
  if (!_reportAgeEl?.isConnected) return;
  const ts = Number(_report?.ts);
  _reportAgeEl.textContent = Number.isFinite(ts) && ts > 0 ? `Report built ${formatAgo(ts)}.` : '';
}

function paintSessionsTs() {
  if (!_sessionsTsEl?.isConnected) return;
  const ts = Number(_sessions?.ts);
  _sessionsTsEl.textContent = Number.isFinite(ts) && ts > 0 ? `Session totals updated ${formatAgo(ts)}.` : '';
}

function pricingOf() {
  if (_report?.pricing) return _report.pricing;
  if (_sessions) return { source: _sessions.pricingSource };
  return null;
}

function paintPricing() {
  if (!_pricingEl?.isConnected) return;
  const pricing = pricingOf();
  const fetchedAt = Number(pricing?.fetchedAt);
  const agoText = Number.isFinite(fetchedAt) && fetchedAt > 0 ? formatAgo(fetchedAt) : '';
  _pricingEl.textContent = pricingSourceLine(pricing, agoText);
}

function paintBlockProgress() {
  const progress = blockProgress(_report?.activeBlock);
  if (!progress) return;
  if (_blockElapsedEl?.isConnected) _blockElapsedEl.textContent = `${progress.pct}%`;
  if (_blockRemainingEl?.isConnected) _blockRemainingEl.textContent = `${formatMinutes(progress.remainingMinutes)} left`;
  if (_blockMeterEl?.isConnected) paintMeter(_blockMeterEl, progress.pct);
}

// ── Header ──

function daysForRange(value) {
  const option = RANGE_OPTIONS.find((entry) => entry.value === value);
  if (!option) return null;
  return option.days;
}

function buildControls() {
  const controls = el('div', 'usage-controls');

  const rangeLabel = el('label', 'usage-control');
  rangeLabel.append(el('span', 'usage-control-label', 'Range'));
  const select = el('select', 'usage-select');
  for (const option of RANGE_OPTIONS) {
    const opt = el('option', null, option.label);
    opt.value = option.value;
    select.append(opt);
  }
  select.value = _rangeValue;
  select.addEventListener('change', () => {
    _rangeValue = select.value;
    requestUsageReport();
  });
  rangeLabel.append(select);

  // Constant label, always: the in-flight state lives on the disabled attribute and the status span
  // beside the button, never in its text.
  const button = el('button', 'usage-refresh', 'Refresh');
  button.type = 'button';
  button.title = 'Re-read every transcript from the start';
  button.addEventListener('click', () => requestUsageReport({ force: true }));
  // Deliberately not a live region: a pull also fires on every turn end while the tab is open, and
  // announcing each one would talk over the operator for a background refresh they did not ask for.
  const status = el('span', 'usage-refresh-status', '');
  _refreshButtonEl = button;
  _refreshStatusEl = status;
  applyRefreshPending();

  controls.append(rangeLabel, button, status);
  return controls;
}

function buildHeaderSection() {
  const section = buildSection('Usage', dayRangeLabel(_report?.daily || []));
  section.append(buildControls());

  const caveat = el('p', 'usage-caveat', USAGE_CAVEAT_SHORT);
  caveat.title = USAGE_CAVEAT;
  section.append(caveat);

  _reportAgeEl = el('p', 'usage-meta', '');
  section.append(_reportAgeEl);
  paintReportAge();
  _ticker.onTick(paintReportAge);

  _pricingEl = el('p', 'usage-meta', '');
  section.append(_pricingEl);
  paintPricing();
  _ticker.onTick(paintPricing);

  const warning = usageWarningLine(_report);
  if (warning) section.append(el('p', 'usage-warning', warning));

  const missing = missingPricingLine(_report?.pricing?.missing);
  if (missing) section.append(el('p', 'usage-warning', missing));

  const scan = scanLine(_report?.scan);
  if (scan) section.append(el('p', 'usage-meta', scan));
  return section;
}

// ── Plan limits ──
// The official account rate limits, first on the page because they are the only hard ceiling here: every
// other number is arithmetic about spend, this one is how much of the plan is gone. Kept visible when
// stale, with its age, rather than hidden or silently swapped for the estimate.
function buildPlanLimitsSection() {
  if (!hasOfficialPlanLimits(_planLimits)) return null;
  const claudeOnly = claudeOnlyHint(_report?.totals);
  const section = buildSection('Plan limits', claudeOnly
    ? `${provenanceLabel('official')}, ${claudeOnly}`
    : provenanceLabel('official'));
  const stale = planLimitStaleNote(_planLimits?.ts);
  if (stale) {
    const note = el('p', 'usage-meta', stale);
    note.dataset.tone = 'warn';
    section.append(note);
  }
  const list = el('div', 'usage-plan');
  for (const spec of PLAN_WINDOWS) {
    const window = planWindowOf(_planLimits, spec.key);
    if (!window) continue;
    list.append(buildPlanWindow(spec, window));
  }
  section.append(list);
  _planAgeEl = el('p', 'usage-meta', '');
  section.append(_planAgeEl);
  paintPlanAge();
  _ticker.onTick(paintPlanAge);
  return section;
}

function buildPlanWindow(spec, window) {
  const row = el('div', 'usage-plan-window');
  const head = el('div', 'usage-plan-head');
  head.append(el('span', 'usage-plan-label', spec.label));
  head.append(el('span', 'usage-plan-used', planWindowUsedText(window)));
  const countdown = el('span', 'usage-plan-reset', '');
  head.append(countdown);
  row.append(head);
  // No meter for a window that reported only a reset time: a zero-width bar would read as 0% used,
  // which is the one thing an absent percentage does not mean.
  if (Number.isFinite(window.pct)) {
    row.append(buildMeter(window.pct, tokenLimitTone(window.pct), `${spec.label} plan limit used`));
  }
  // The countdown is the one part that moves on its own, so it rides the shared tick and reads the
  // window it was built from.
  const paint = () => {
    if (!countdown.isConnected) return;
    countdown.textContent = resetCountdownText(window.resetsAtMs);
  };
  paint();
  _ticker.onTick(paint);
  return row;
}

function paintPlanAge() {
  if (!_planAgeEl?.isConnected) return;
  const age = planLimitAgeText(_planLimits?.ts);
  _planAgeEl.textContent = age ? `Reported ${age}.` : '';
}

// ── Current block ──
// Promoted above the totals: "am I burning too fast right now" is the only question here with a clock
// on it, and its two rate numbers get tile weight rather than a sentence.
function buildActiveBlockSection() {
  const block = _report?.activeBlock;
  const hours = Number.isFinite(_report?.blockHours) ? _report.blockHours : 5;
  // The 5h window is a Claude subscription concept, so the block numbers exclude other vendors. Said out
  // loud, because otherwise they read as inconsistent with the multi-vendor totals below.
  const claudeOnly = claudeOnlyHint(_report?.totals);
  const section = buildSection('Current block', claudeOnly ? `${hours}h window, ${claudeOnly}` : `${hours}h window`);
  if (!block) {
    section.append(el('p', 'usage-empty', 'No block is active. The window opens again with the next turn.'));
    return section;
  }

  const tone = blockAttentionTone(_report, _planLimits);
  const tiles = el('div', 'usage-tiles');
  tiles.append(buildTile('block tokens', formatTokens(block.tokens ?? 0), formatUsd(block.costUSD ?? 0), tone).tile);
  for (const spec of burnTiles(block.burn)) {
    tiles.append(buildTile(spec.label, spec.value, spec.sub, tone).tile);
  }

  const progress = blockProgress(block);
  if (progress) {
    const elapsed = buildTile('elapsed', `${progress.pct}%`, `${formatMinutes(progress.remainingMinutes)} left`);
    _blockElapsedEl = elapsed.valueEl;
    _blockRemainingEl = elapsed.subEl;
    tiles.append(elapsed.tile);
  }
  section.append(tiles);

  if (progress) {
    _blockMeterEl = buildMeter(progress.pct, 'ok', 'Elapsed share of the current block window');
    section.append(_blockMeterEl);
    _ticker.onTick(paintBlockProgress);
  }

  const projection = projectionLine(block.projection);
  if (projection) {
    const projectionEl = el('p', 'usage-projection', projection);
    projectionEl.dataset.tone = tone;
    section.append(projectionEl);
  }

  const limit = tokenLimitLine(_report?.tokenLimit);
  if (!limit) return section;
  // The heuristic reference. Always labelled as the estimate it is, because with official plan limits on
  // the page above it an unlabelled percentage would read as a second official ceiling.
  const currentPct = limitPct(_report?.tokenLimit);
  const heuristicTone = blockAttentionTone(_report);
  section.append(buildMeter(currentPct, heuristicTone, 'Share of the largest completed block seen, estimated'));
  const limitLine = el('p', 'usage-meta', limit);
  limitLine.dataset.tone = heuristicTone;
  section.append(limitLine);
  section.append(el('p', 'usage-provenance', provenanceLabel('estimated')));
  const projected = projectionLimitLine(block.projection, _report?.tokenLimit);
  if (projected) {
    const projectedEl = el('p', 'usage-meta', projected);
    projectedEl.dataset.tone = heuristicTone;
    section.append(projectedEl);
  }
  return section;
}

// ── Block history ──
function buildBlockHistorySection() {
  const rows = blockHistoryRows(_report?.blocks);
  if (rows.length === 0) return null;
  const claudeOnly = claudeOnlyHint(_report?.totals);
  const section = buildSection('Recent blocks', claudeOnly ? `newest first, ${claudeOnly}` : 'newest first');
  const list = el('div', 'usage-blocks');
  const peak = rows.reduce((best, row) => Math.max(best, row.tokens), 0);
  for (const row of rows) {
    const item = el('div', 'usage-block');
    if (row.isActive) item.dataset.active = 'true';
    item.append(el('span', 'usage-block-label', blockLabel(row.startTs)));
    const bar = el('span', 'usage-block-bar');
    const fill = el('span', 'usage-block-fill');
    fill.style.width = `${clampPct(percentOfTotal(row.tokens, peak) ?? 0)}%`;
    bar.append(fill);
    item.append(bar);
    item.append(el('span', 'usage-block-value', `${formatTokens(row.tokens)} ${formatUsd(row.costUSD)}`));
    list.append(item);
  }
  section.append(list);
  return section;
}

// ── Totals ──
function buildTotalsSection() {
  const totals = _report?.totals || {};
  const today = dailyRowForDay(_report?.daily, reportDayKey(_report));
  const section = buildSection('Totals', _report?.tz ? `daily buckets in ${_report.tz}` : '');
  const tone = blockAttentionTone(_report, _planLimits);
  const tiles = el('div', 'usage-tiles');
  tiles.append(buildTile('today', formatTokens(today?.tokens ?? 0), formatUsd(today?.costUSD ?? 0), tone).tile);
  tiles.append(buildTile('all tokens', formatTokens(totals.tokens ?? 0), formatUsd(totals.costUSD ?? 0)).tile);
  tiles.append(buildTile('input', formatTokens(totals.input ?? 0)).tile);
  tiles.append(buildTile('output', formatTokens(totals.output ?? 0)).tile);
  tiles.append(buildTile('cache write', formatTokens(totals.cacheCreate ?? 0)).tile);
  tiles.append(buildTile('cache read', formatTokens(totals.cacheRead ?? 0)).tile);
  section.append(tiles);
  // The per-vendor split, only once a non-Claude vendor has data: on an all-Claude machine it would just
  // restate the totals above.
  const vendorRows = hasMultiVendorUsage(totals) ? vendorTotalsRows(totals) : [];
  if (vendorRows.length > 0) {
    const vendorTiles = el('div', 'usage-tiles usage-vendor-tiles');
    for (const row of vendorRows) {
      vendorTiles.append(buildTile(row.label, formatTokens(row.tokens), formatUsd(row.costUSD)).tile);
    }
    section.append(vendorTiles);
  }
  _sessionsTsEl = el('p', 'usage-meta', '');
  section.append(_sessionsTsEl);
  paintSessionsTs();
  _ticker.onTick(paintSessionsTs);
  return section;
}

// ── Daily ──
function buildDailySection() {
  const rows = sortDailyRows(_report?.daily, _daySort);
  const section = buildSection('By day', 'newest first by default');
  if (rows.length === 0) {
    section.append(el('p', 'usage-empty', 'No daily usage recorded yet.'));
    return section;
  }
  const { wrap, body } = buildTable(
    [
      { label: 'Day', key: 'day' },
      { label: 'Tokens', numeric: true, key: 'tokens' },
      { label: 'Cost', numeric: true, key: 'costUSD' },
      { label: 'Models' },
    ],
    _daySort,
    (key) => {
      _daySort = nextSortState(_daySort, key);
      render();
    },
    'day',
  );
  for (const row of rows) {
    const day = String(row.day ?? '');
    const tr = el('tr', 'usage-row');
    const models = sortModelRows(row.models);
    const toggle = buildBreakdownToggle(day, models.length);
    appendCells(tr, [
      { text: dayLabel(row.day), title: day },
      { text: formatTokens(row.tokens), numeric: true },
      { text: formatUsd(row.costUSD), numeric: true },
      { node: toggle, className: 'usage-toggle-cell' },
    ]);
    body.append(tr);
    if (models.length === 0) continue;
    if (!_expandedDays.has(day)) continue;
    body.append(buildBreakdownRow(models));
  }
  section.append(wrap);
  return section;
}

// Stable label, state on aria-expanded (the chevron is a CSS response to that attribute), so the
// control never renames itself between open and closed.
function buildBreakdownToggle(day, modelCount) {
  if (modelCount === 0) return null;
  const button = el('button', 'usage-toggle', 'Models');
  button.type = 'button';
  button.dataset.usageDay = day;
  button.setAttribute('aria-expanded', _expandedDays.has(day) ? 'true' : 'false');
  button.addEventListener('click', () => {
    _focusAfterRender = { kind: 'day', day };
    if (_expandedDays.has(day)) {
      _expandedDays.delete(day);
      render();
      return;
    }
    _expandedDays.add(day);
    render();
  });
  return button;
}

function buildBreakdownRow(models) {
  const breakdown = el('tr', 'usage-row-breakdown');
  const cell = el('td', 'usage-models');
  cell.colSpan = 4;
  for (const model of models) {
    const chip = el('span', 'usage-model-chip');
    chip.append(
      el('span', 'usage-model-name', modelLabel(model)),
      el('span', 'usage-model-value', `${formatTokens(model.tokens)} ${formatUsd(model.costUSD)}`),
    );
    cell.append(chip);
  }
  breakdown.append(cell);
  return breakdown;
}

// A muted vendor prefix, added only once the page shows more than one vendor: "gpt-5.5" alone does not
// say where it came from, and on an all-Claude machine the prefix would be on every row for nothing.
function buildModelCell(row, totals) {
  const wrap = el('span', 'usage-model-name-wrap');
  const prefix = modelRowPrefix(row, totals);
  if (prefix) wrap.append(el('span', 'usage-vendor-tag', prefix));
  wrap.append(el('span', null, modelLabel(row)));
  return wrap;
}

// ── Per model ──
function buildModelsSection() {
  const rows = sortModelRows(_report?.models, _modelSort);
  const totals = _report?.totals || {};
  const basis = shareBasis(totals);
  const section = buildSection('By model', shareLabel(basis));
  if (rows.length === 0) {
    section.append(el('p', 'usage-empty', 'No model usage recorded yet.'));
    return section;
  }
  const { wrap, body } = buildTable(
    [
      { label: 'Model', key: 'model' },
      { label: 'Tokens', numeric: true, key: 'tokens' },
      { label: 'Cost', numeric: true, key: 'costUSD' },
      { label: 'Share', numeric: true },
      { label: 'Input', numeric: true, key: 'input' },
      { label: 'Output', numeric: true, key: 'output' },
      { label: 'Cache write', numeric: true, key: 'cacheCreate' },
      { label: 'Cache read', numeric: true, key: 'cacheRead' },
    ],
    _modelSort,
    (key) => {
      _modelSort = nextSortState(_modelSort, key);
      render();
    },
    'model',
  );
  for (const row of rows) {
    const tr = el('tr', 'usage-row');
    appendCells(tr, [
      { node: buildModelCell(row, totals), className: 'usage-model-cell', title: modelLabel(row) },
      { text: formatTokens(row.tokens), numeric: true },
      { text: formatUsd(row.costUSD), numeric: true },
      { node: buildShareCell(percentOfTotal(row[basis], totals[basis])), className: 'usage-share-cell' },
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
// A transcript Glissa never managed still counts real cost, and is labelled by its project rather than
// hidden.
function buildSessionsSection() {
  const rows = sortSessionRows(_report?.sessions, _sessionSort);
  const totals = _report?.totals || {};
  const basis = shareBasis(totals);
  const section = buildSection('By session', shareLabel(basis));
  if (rows.length === 0) {
    section.append(el('p', 'usage-empty', 'No session usage recorded yet.'));
    return section;
  }
  const { wrap, body } = buildTable(
    [
      { label: 'Session', key: 'label' },
      { label: 'Tokens', numeric: true, key: 'tokens' },
      { label: 'Cost', numeric: true, key: 'costUSD' },
      { label: 'Share', numeric: true },
      { label: 'Last activity', numeric: true, key: 'lastTs' },
    ],
    _sessionSort,
    (key) => {
      _sessionSort = nextSortState(_sessionSort, key);
      render();
    },
    'session',
  );
  for (const row of rows) {
    const tr = el('tr', 'usage-row');
    if (isGlissaSessionRow(row)) tr.dataset.managed = 'true';
    const label = sessionRowLabel(row);
    const agoCell = el('span', 'usage-ago', '');
    appendCells(tr, [
      { text: label, className: 'usage-session-cell', title: row.project ? String(row.project) : label },
      { text: formatTokens(row.tokens), numeric: true },
      { text: formatUsd(row.costUSD), numeric: true },
      { node: buildShareCell(percentOfTotal(row[basis], totals[basis])), className: 'usage-share-cell' },
      { node: agoCell, numeric: true },
    ]);
    _ticker.track(agoCell, Number(row.lastTs), formatAgo);
    body.append(tr);
  }
  section.append(wrap);
  return section;
}

// ── Unavailable ──
// An error report carries no totals at all, so the sections below it would each print a confident zero
// for a lane that is switched off or cannot see its transcripts. Radar's precedent: the bare reason,
// with no section chrome to make an off lane look like an empty one.
function buildUnavailableSection() {
  const section = buildSection('Not available', '');
  section.append(el('p', 'usage-empty', usageErrorLine(_report)));
  section.append(el('p', 'usage-empty', USAGE_DISABLED_HINT));
  return section;
}

function buildFootnote() {
  return el('p', 'usage-footnote', USAGE_CAVEAT);
}

function clearRefs() {
  _reportAgeEl = null;
  _sessionsTsEl = null;
  _pricingEl = null;
  _planAgeEl = null;
  _blockElapsedEl = null;
  _blockRemainingEl = null;
  _blockMeterEl = null;
  _refreshButtonEl = null;
  _refreshStatusEl = null;
}

function isHidden() {
  return !_root || !!_root.closest('[hidden]');
}

// A push while another tab is open is dropped; the surface rebuilds when it is next looked at, which is
// also when it asks for a fresh report. Scroll position has to be carried across a rebuild by hand:
// emptying the content collapses the scroller, so the browser clamps it back to the top.
function render({ force = false } = {}) {
  if (!_root) return;
  if (!force && isHidden()) return;
  const scroller = _root.parentElement;
  const scrollTop = scroller ? scroller.scrollTop : 0;
  _ticker.reset();
  clearRefs();
  _root.textContent = '';
  buildBody();
  if (scroller) scroller.scrollTop = scrollTop;
  restoreFocusAfterRender();
}

// Sorting and expanding both rebuild the subtree that held the control, so the equivalent control in the
// fresh DOM takes the focus back.
function restoreFocusAfterRender() {
  const target = _focusAfterRender;
  _focusAfterRender = null;
  if (!target) return;
  const selector = target.kind === 'day'
    ? `.usage-toggle[data-usage-day="${CSS.escape(target.day)}"]`
    : `[data-usage-table="${CSS.escape(target.table)}"] .usage-sort[data-sort-key="${CSS.escape(target.key)}"]`;
  _root.querySelector(selector)?.focus();
}

function buildBody() {
  _root.append(buildHeaderSection());
  // Plan limits come from the statusLine relay, not the transcript scan, so they are shown even when the
  // report itself is missing or unavailable.
  const plan = buildPlanLimitsSection();
  if (plan) _root.append(plan);
  if (isUsageUnavailable(_report)) {
    _root.append(buildUnavailableSection());
    return;
  }
  if (!_report) {
    _root.append(el('p', 'usage-empty', 'Reading the local transcripts. The report lands on the next scan.'));
    return;
  }
  _root.append(buildActiveBlockSection());
  const history = buildBlockHistorySection();
  if (history) _root.append(history);
  _root.append(buildTotalsSection(), buildDailySection(), buildModelsSection(), buildSessionsSection());
  _root.append(buildFootnote());
}

function refreshActivity() {
  if (!_activityCallback) return;
  _activityCallback(hasUsageAttention(_report, _planLimits));
}

function applyRefreshPending() {
  if (_refreshButtonEl) _refreshButtonEl.disabled = _refreshPending;
  if (_refreshStatusEl) _refreshStatusEl.textContent = _refreshPending ? 'Refreshing' : '';
}

function setRefreshPending(pending) {
  _refreshPending = pending;
  applyRefreshPending();
  if (_refreshTimer) {
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
  }
  if (!pending) return;
  // A reply that never arrives must not leave the control disabled forever.
  _refreshTimer = setTimeout(() => {
    _refreshTimer = null;
    _refreshPending = false;
    applyRefreshPending();
  }, REFRESH_STATUS_TIMEOUT_MS);
}

// The tab-activity seam (defined in pr-panel.js): the view owns the condition, app.js owns the dot
// element. The condition is the token limit, both where the block is and where it is heading.
export function setUsageActivityCallback(callback) {
  _activityCallback = callback;
  refreshActivity();
}

// app.js owns the socket; the panel owns what it asks for (range, force) and which reply is still
// current, so every request goes through here.
export function setUsageRequestSender(send) {
  _sendRequest = send;
}

export function requestUsageReport({ force = false } = {}) {
  if (!_sendRequest) return;
  _requestSeq += 1;
  _latestRequestId = `usage-${_requestSeq}`;
  const msg = { type: 'request-usage-report', requestId: _latestRequestId };
  if (force) msg.force = true;
  const days = daysForRange(_rangeValue);
  if (days !== null) msg.days = days;
  setRefreshPending(true);
  _sendRequest(msg);
}

export function mountUsageView(parent) {
  if (_root) return _root;
  const root = el('div', 'usage-content');
  parent.appendChild(root);
  _root = root;
  _ticker.ensure();
  render({ force: true });
  return root;
}

// Called when the Usage surface becomes visible. On the phone the screen is still hidden at that point,
// so the render is forced rather than deferred again.
export function refreshUsageView() {
  render({ force: true });
}

export function applyUsageSessions(msg) {
  _sessions = msg;
  // The only thing a session push changes on a rendered report is its own freshness line, so a full
  // rebuild of every table is not worth paying for.
  if (_report && !isUsageUnavailable(_report) && _sessionsTsEl?.isConnected) {
    paintSessionsTs();
    paintPricing();
    return;
  }
  render();
}

// Official plan limits, broadcast only when a rounded percentage or a reset time actually moved, and
// replayed on connect. Machine-wide, so there is nothing per session to reconcile here.
export function applyPlanLimits(msg) {
  _planLimits = msg;
  render();
  refreshActivity();
}

export function applyUsageReport(msg) {
  if (!shouldApplyUsageReport(msg, _latestRequestId)) return;
  setRefreshPending(false);
  _report = msg;
  render();
  refreshActivity();
}

// The Settings dialog's read-only Usage line: the pricing source and the last scan, sourced from the
// same report the panel is showing rather than a second request.
export function usageStatusLines() {
  const pricing = pricingOf();
  const fetchedAt = Number(pricing?.fetchedAt);
  const agoText = Number.isFinite(fetchedAt) && fetchedAt > 0 ? formatAgo(fetchedAt) : '';
  const lines = [pricingSourceLine(pricing, agoText)];
  const error = usageErrorLine(_report);
  if (error) lines.push(error);
  const scan = scanLine(_report?.scan);
  if (scan) lines.push(scan);
  return lines;
}
