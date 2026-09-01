import { createAttentionAck } from './attention-ack-core.ts';
import { buildPanelSection, el, isPanelHidden } from './dom-helpers.ts';
import { createPollAgoTicker, formatAgo } from './poll-ago.ts';
import { createSettingsLink } from './settings-link.ts';
import { getUsageAttentionAck, setUsageAttentionAck } from './ui-prefs.ts';
import {
  DEFAULT_DAY_SORT,
  DEFAULT_MODEL_SORT,
  DEFAULT_PERIOD_VIEW,
  DEFAULT_RANGE_VALUE,
  DEFAULT_SESSION_SORT,
  HEATMAP_DAY_LABELS,
  LANE_SCOPE_HINT,
  PERIOD_VIEWS,
  PLAN_WINDOWS,
  RANGE_OPTIONS,
  SESSION_ROW_LIMIT,
  USAGE_CAVEAT_SHORT,
  USAGE_DISABLED_HINT,
  anomalyLine,
  anomalyTone,
  ariaSortValue,
  claudeOnlyHint,
  blockAttentionTone,
  blockHistoryRows,
  blockLabel,
  blockProgress,
  budgetRowMeterLabel,
  budgetRowPct,
  budgetRowText,
  budgetRows,
  budgetScopeLabel,
  burnTiles,
  cacheSavingsTile,
  compositionParts,
  dailyRowForDay,
  dayRangeLabel,
  formatMinutes,
  formatPercent,
  formatTokens,
  formatUsd,
  hasAnomaly,
  hasLaneAttribution,
  hasMultiVendorUsage,
  hasOfficialPlanLimits,
  hasSavings,
  heatmapCellTitle,
  heatmapCells,
  historyNote,
  isGlissaSessionRow,
  isUsageUnavailable,
  laneLabel,
  laneRows,
  laneSessionsText,
  limitPct,
  missingPricingLine,
  modelLabel,
  modelRowPrefix,
  nextSortState,
  percentOfTotal,
  periodLabel,
  periodRows,
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
  rtkSavingsTile,
  scanLine,
  sessionOverflowText,
  sessionRowLabel,
  shareBasis,
  shareLabel,
  shouldApplyUsageReport,
  sortDailyRows,
  sortModelRows,
  sortSessionRows,
  tokenLimitLine,
  tokenLimitTone,
  usageAttentionSignature,
  usageErrorLine,
  usageWarningLine,
  vendorTotalsRows,
  visibleSessionRows,
} from './usage-view-core.ts';
import type { PlanLimits, SortState, UsageReport, UsageTotals, UsageWireRow } from './usage-view-core.ts';

const REFRESH_STATUS_TIMEOUT_MS = 20000;

interface UsageSessionsPush {
  ts?: unknown;
  pricingSource?: unknown;
}

type FocusTarget =
  | { kind: 'sort'; table: string; key: string }
  | { kind: 'period'; view: string }
  | { kind: 'day'; day: string }
  | { kind: 'sessions-toggle' };

interface TableHeading {
  label: string;
  numeric?: boolean;
  key?: string;
}

interface TableCell {
  text?: string;
  node?: Node | null;
  numeric?: boolean;
  className?: string | null;
  title?: string;
  span?: number;
}

let _report: UsageReport | null = null;
let _sessions: UsageSessionsPush | null = null;
let _planLimits: PlanLimits | null = null;
let _root: HTMLDivElement | null = null;
let _activityCallback: ((isActive: boolean) => void) | null = null;
let _sendRequest: ((message: Record<string, unknown>) => void) | null = null;
let _requestSeq = 0;
let _latestRequestId: string | null = null;
let _rangeValue: string = DEFAULT_RANGE_VALUE;
let _refreshPending = false;
let _refreshTimer: number | null = null;

let _daySort: SortState = DEFAULT_DAY_SORT;
let _modelSort: SortState = DEFAULT_MODEL_SORT;
let _sessionSort: SortState = DEFAULT_SESSION_SORT;
let _sessionsExpanded = false;
let _focusAfterRender: FocusTarget | null = null;
let _periodView: string = DEFAULT_PERIOD_VIEW;
const _expandedDays = new Set<string>();
const _attention = createAttentionAck({
  getAck: getUsageAttentionAck,
  setAck: setUsageAttentionAck,
  signature: () => usageAttentionSignature(_report, _planLimits),
  isLooking: () => !isPanelHidden(_root),
});

let _reportAgeEl: HTMLParagraphElement | null = null;
let _sessionsTsEl: HTMLParagraphElement | null = null;
let _planAgeEl: HTMLParagraphElement | null = null;
let _blockElapsedEl: HTMLSpanElement | null = null;
let _blockRemainingEl: HTMLSpanElement | null = null;
let _blockMeterEl: HTMLDivElement | null = null;
let _refreshButtonEl: HTMLButtonElement | null = null;
let _refreshStatusEl: HTMLSpanElement | null = null;

const _ticker = createPollAgoTicker(() => _root);

const buildSection = (title: string, hint?: string | null) => buildPanelSection('usage', title, hint);

function buildTile(label: string, value: string, sub?: string | null, tone?: string | null) {
  const tile = el('div', 'usage-tile');
  if (tone && tone !== 'ok') tile.dataset.tone = tone;
  const valueEl = el('span', 'usage-tile-value', value);
  tile.append(valueEl, el('span', 'usage-tile-label', label));
  const subEl = sub ? el('span', 'usage-tile-sub', sub) : null;
  if (subEl) tile.append(subEl);
  return { tile, valueEl, subEl };
}

function clampPct(pct: unknown) {
  const numeric = Number(pct);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(Math.max(numeric, 0), 100);
}

function buildMeter(pct: unknown, tone: unknown, label: string) {
  const meter = el('div', 'usage-meter');
  meter.dataset.tone = String(tone);
  meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-label', label);
  const fill = el('span', 'usage-meter-fill');
  meter.append(fill);
  paintMeter(meter, pct);
  return meter;
}

function paintMeter(meter: HTMLElement | null, pct: unknown) {
  if (!meter) return;
  const value = clampPct(pct);
  meter.setAttribute('aria-valuenow', String(Math.round(value)));
  const fill = meter.querySelector<HTMLElement>('.usage-meter-fill');
  if (fill) fill.style.width = `${value}%`;
}

function buildTable(headings: TableHeading[], sort: SortState | null, onSort: (key: string) => void, tableId: string) {
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
    const sortKey = heading.key;
    cell.setAttribute('aria-sort', ariaSortValue(sort, sortKey));
    const button = el('button', 'usage-sort', heading.label);
    button.type = 'button';
    button.dataset.sortKey = sortKey;
    button.addEventListener('click', () => {

      _focusAfterRender = { kind: 'sort', table: tableId, key: sortKey };
      onSort(sortKey);
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

function appendCells(row: HTMLElement, cells: TableCell[]) {
  for (const cell of cells) {
    const td = el('td', cell.numeric ? 'usage-num' : cell.className || null, cell.node ? null : cell.text);
    if (cell.node) td.append(cell.node);
    if (cell.title) td.title = cell.title;
    if (cell.span) td.colSpan = cell.span;
    row.append(td);
  }
}

function buildShareCell(pct: number | null) {
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

function paintReportAge() {
  if (!_reportAgeEl?.isConnected) return;
  const ts = Number(_report?.ts);
  _reportAgeEl.textContent = Number.isFinite(ts) && ts > 0 ? `Report ${formatAgo(ts)}` : '';
}

function paintSessionsTs() {
  if (!_sessionsTsEl?.isConnected) return;
  const ts = Number(_sessions?.ts);
  _sessionsTsEl.textContent = Number.isFinite(ts) && ts > 0 ? `Sessions ${formatAgo(ts)}` : '';
}

function paintBlockProgress() {
  const progress = blockProgress(_report?.activeBlock);
  if (!progress) return;
  if (_blockElapsedEl?.isConnected) _blockElapsedEl.textContent = `${progress.pct}%`;
  if (_blockRemainingEl?.isConnected) _blockRemainingEl.textContent = `${formatMinutes(progress.remainingMinutes)} left`;
  if (_blockMeterEl?.isConnected) paintMeter(_blockMeterEl, progress.pct);
}

function daysForRange(value: string) {
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

  const button = el('button', 'usage-refresh', 'Refresh');
  button.type = 'button';
  button.title = 'Re-read every transcript from the start';
  button.addEventListener('click', () => requestUsageReport({ force: true }));

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

  _reportAgeEl = el('p', 'usage-meta', '');
  section.append(_reportAgeEl);
  paintReportAge();
  _ticker.onTick(paintReportAge);

  const warning = usageWarningLine(_report);
  if (warning) section.append(el('p', 'usage-warning', warning));

  const missing = missingPricingLine(_report?.pricing?.missing);
  if (missing) section.append(el('p', 'usage-warning', missing));
  return section;
}

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

function buildPlanWindow(spec: { key: 'fiveHour' | 'sevenDay'; label: string }, window: { pct: number | null; resetsAtMs: number | null }) {
  const row = el('div', 'usage-plan-window');
  const head = el('div', 'usage-plan-head');
  head.append(el('span', 'usage-plan-label', spec.label));
  head.append(el('span', 'usage-plan-used', planWindowUsedText(window)));
  const countdown = el('span', 'usage-plan-reset', '');
  head.append(countdown);
  row.append(head);

  if (Number.isFinite(window.pct)) {
    row.append(buildMeter(window.pct, tokenLimitTone(window.pct), `${spec.label} plan limit used`));
  }

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
  _planAgeEl.textContent = age ? `Plan ${age}` : '';
}

function buildLanesSection() {
  if (!hasLaneAttribution(_report)) return null;
  const rows = laneRows(_report);
  const section = buildSection('Glissa lanes', LANE_SCOPE_HINT);
  const totalCost = rows.reduce((sum, row) => sum + (typeof row.costUSD === 'number' && Number.isFinite(row.costUSD) ? row.costUSD : 0), 0);
  const { wrap, body } = buildTable(
    [
      { label: 'Lane' },
      { label: 'Cost', numeric: true },
      { label: 'Tokens', numeric: true },
      { label: 'Sessions', numeric: true },
      { label: 'Share', numeric: true },
    ],
    null,
    () => {},
    'lane',
  );
  for (const row of rows) {
    const tr = el('tr', 'usage-row');
    if (row.lane === 'other') tr.dataset.lane = 'other';
    appendCells(tr, [
      { text: laneLabel(row.lane), className: 'usage-lane-cell' },
      { text: formatUsd(row.costUSD), numeric: true },
      { text: formatTokens(row.tokens), numeric: true },
      { text: laneSessionsText(row.sessions), numeric: true },
      { node: buildShareCell(percentOfTotal(row.costUSD, totalCost)), className: 'usage-share-cell' },
    ]);
    body.append(tr);
  }
  section.append(wrap);
  return section;
}

function buildActiveBlockSection() {
  const block = _report?.activeBlock;
  const blockHours = _report?.blockHours;
  const hours = typeof blockHours === 'number' && Number.isFinite(blockHours) ? blockHours : 5;

  const claudeOnly = claudeOnlyHint(_report?.totals);
  const section = buildSection('Current block', claudeOnly ? `${hours}h window, ${claudeOnly}` : `${hours}h window`);
  if (!block) {
    section.append(el('p', 'usage-empty', 'No active block.'));
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
  const anomalyLineEl = buildAnomalyLine();
  if (anomalyLineEl) section.append(anomalyLineEl);

  const limit = tokenLimitLine(_report?.tokenLimit);
  if (!limit) return section;

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

function buildAnomalyLine() {
  const anomaly = _report?.anomaly;
  if (!hasAnomaly(anomaly)) return null;
  const line = el('p', 'usage-meta', anomalyLine(anomaly));
  line.dataset.tone = anomalyTone(anomaly);
  return line;
}

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

function buildTotalsSection() {
  const totals = _report?.totals || {};
  const today = dailyRowForDay(_report?.daily, reportDayKey(_report));
  const hint = [USAGE_CAVEAT_SHORT, _report?.tz ? `TZ ${_report.tz}` : ''].filter(Boolean).join(' ');
  const section = buildSection('Totals', hint);
  const tone = blockAttentionTone(_report, _planLimits);
  const tiles = el('div', 'usage-tiles');
  tiles.append(buildTile('today', formatTokens(today?.tokens ?? 0), formatUsd(today?.costUSD ?? 0), tone).tile);
  tiles.append(buildTile('range total', formatTokens(totals.tokens ?? 0), formatUsd(totals.costUSD ?? 0)).tile);
  section.append(tiles);
  const composition = buildCompositionRow(totals);
  if (composition) section.append(composition);

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

function buildCompositionRow(totals: UsageTotals | null | undefined) {
  const parts = compositionParts(totals);
  if (parts.length === 0) return null;
  const wrap = el('div', 'usage-compo');

  const bar = el('div', 'usage-compo-bar');
  bar.setAttribute('aria-hidden', 'true');
  for (const part of parts) {
    if (part.pct <= 0) continue;
    const fill = el('span', 'usage-compo-fill');
    fill.dataset.part = part.key;
    fill.style.width = `${part.pct}%`;
    fill.title = part.title;
    bar.append(fill);
  }
  const legend = el('div', 'usage-compo-legend');
  for (const part of parts) {
    const item = el('span', 'usage-compo-item');
    const swatch = el('span', 'usage-compo-swatch');
    swatch.dataset.part = part.key;
    item.append(swatch, el('span', 'usage-compo-label', part.label), el('span', 'usage-compo-value', part.value));
    legend.append(item);
  }
  wrap.append(bar, legend);
  return wrap;
}

function buildSavingsSection() {
  const savings = _report?.savings;
  if (!hasSavings(savings)) return null;
  const section = buildSection('Savings', '');
  const tiles = el('div', 'usage-tiles');
  const rtk = rtkSavingsTile(savings);
  if (rtk) tiles.append(buildTile('rtk compression', rtk.value, rtk.sub).tile);
  const cache = cacheSavingsTile(savings);
  if (cache) tiles.append(buildTile('Prompt cache', cache.value, cache.sub).tile);
  section.append(tiles);
  return section;
}

function buildBudgetsSection() {
  const rows = budgetRows(_report);
  if (rows.length === 0) return null;
  const section = buildSection('Budgets', 'your own ceilings');

  const wrap = el('div', 'usage-budgets');
  const settingsLink = createSettingsLink('machine-usage', 'usage-daily-budget', 'Budget settings');
  wrap.appendChild(settingsLink);
  for (const row of rows) {
    const item = el('div', 'usage-budget');
    const head = el('div', 'usage-budget-head');
    head.append(el('span', 'usage-budget-label', budgetScopeLabel(row.scope)));
    head.append(el('span', 'usage-budget-value', budgetRowText(row)));
    head.append(el('span', 'usage-budget-pct', formatPercent(budgetRowPct(row))));
    item.append(head);
    item.append(buildMeter(budgetRowPct(row), row.tone, budgetRowMeterLabel(row)));
    wrap.append(item);
  }
  section.append(wrap);
  return section;
}

function buildDailySection() {
  const daily = _report?.daily || [];
  const periodView = _periodView;
  const rows = sortDailyRows(periodRows(daily, periodView), _daySort);
  const columnLabel = PERIOD_VIEWS.find((view) => view.value === periodView)?.label || 'Day';
  const hints = [historyNote(daily)].filter(Boolean);
  const section = buildSection('Over time', hints.join(', '));
  section.append(buildPeriodSwitch());
  if (rows.length === 0) {
    section.append(el('p', 'usage-empty', 'No usage.'));
    return section;
  }
  const heatmap = buildHeatmap(daily);
  if (heatmap) section.append(heatmap);
  const { wrap, body } = buildTable(
    [
      { label: columnLabel, key: 'day' },
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
    if (row.source === 'history') tr.dataset.source = 'history';
    const models = sortModelRows(row.models);

    const expandKey = `${periodView}:${day}`;
    const toggle = buildBreakdownToggle(expandKey, models.length);
    appendCells(tr, [
      { node: buildPeriodCell(row, periodView), title: day },
      { text: formatTokens(row.tokens), numeric: true },
      { text: formatUsd(row.costUSD), numeric: true },
      { node: toggle, className: 'usage-toggle-cell' },
    ]);
    body.append(tr);
    if (models.length === 0) continue;
    if (!_expandedDays.has(expandKey)) continue;
    body.append(buildBreakdownRow(models));
  }
  section.append(wrap);
  return section;
}

function buildPeriodSwitch() {
  const group = el('div', 'usage-period');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Period');
  for (const view of PERIOD_VIEWS) {
    const button = el('button', 'usage-period-button', view.label);
    button.type = 'button';
    button.dataset.periodView = view.value;
    button.setAttribute('aria-pressed', view.value === _periodView ? 'true' : 'false');
    button.addEventListener('click', () => {
      if (_periodView === view.value) return;
      _periodView = view.value;
      _focusAfterRender = { kind: 'period', view: view.value };
      render();
    });
    group.append(button);
  }
  return group;
}

function buildPeriodCell(row: UsageWireRow, periodView: string) {
  const wrap = el('span', 'usage-period-cell');
  wrap.append(el('span', null, periodLabel(row.day, periodView)));
  if (row.source === 'history') wrap.append(el('span', 'usage-history-tag', 'history'));
  return wrap;
}

function buildHeatmap(daily: unknown) {
  const { cells, max } = heatmapCells(daily);
  if (cells.length === 0 || max <= 0) return null;
  const wrap = el('div', 'usage-heatmap-scroll');
  const grid = el('div', 'usage-heatmap');
  grid.setAttribute('role', 'img');
  grid.setAttribute('aria-label', `Daily usage for the trailing ${Math.max(...cells.map((cell) => cell.week)) + 1} weeks`);
  const labels = el('div', 'usage-heatmap-days');
  for (const label of HEATMAP_DAY_LABELS) labels.append(el('span', 'usage-heatmap-day', label));
  for (const cell of cells) {
    const box = el('span', 'usage-heatmap-cell');
    box.dataset.tone = String(cell.tone);
    if (cell.noData) box.dataset.noData = 'true';
    if (cell.source === 'history') box.dataset.source = 'history';
    box.style.gridColumn = String(cell.week + 1);
    box.style.gridRow = String(cell.weekday + 1);
    box.title = heatmapCellTitle(cell);
    grid.append(box);
  }
  wrap.append(labels, grid);
  return wrap;
}

function buildBreakdownToggle(expandKey: string, modelCount: number) {
  if (modelCount === 0) return null;
  const button = el('button', 'usage-toggle', 'Models');
  button.type = 'button';
  button.dataset.usageDay = expandKey;
  button.setAttribute('aria-expanded', _expandedDays.has(expandKey) ? 'true' : 'false');
  button.addEventListener('click', () => {
    _focusAfterRender = { kind: 'day', day: expandKey };
    if (_expandedDays.has(expandKey)) {
      _expandedDays.delete(expandKey);
      render();
      return;
    }
    _expandedDays.add(expandKey);
    render();
  });
  return button;
}

function buildBreakdownRow(models: UsageWireRow[]) {
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

function buildModelCell(row: UsageWireRow, totals: UsageTotals) {
  const wrap = el('span', 'usage-model-name-wrap');
  const prefix = modelRowPrefix(row, totals);
  if (prefix) wrap.append(el('span', 'usage-vendor-tag', prefix));
  wrap.append(el('span', null, modelLabel(row)));
  return wrap;
}

function buildModelsSection() {
  const rows = sortModelRows(_report?.models, _modelSort);
  const totals = _report?.totals || {};
  const basis = shareBasis(totals);
  const section = buildSection('By model', shareLabel(basis));
  if (rows.length === 0) {
    section.append(el('p', 'usage-empty', 'No models.'));
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

function buildSessionsSection() {
  const rows = sortSessionRows(_report?.sessions, _sessionSort);
  const visible = visibleSessionRows(rows, _sessionsExpanded);
  const totals = _report?.totals || {};
  const basis = shareBasis(totals);
  const section = buildSection('By session', shareLabel(basis));
  if (rows.length === 0) {
    section.append(el('p', 'usage-empty', 'No sessions.'));
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
  for (const row of visible.rows) {
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
  if (rows.length > SESSION_ROW_LIMIT) {
    section.append(buildSessionsOverflow(visible.hiddenCount));
  }
  return section;
}

function buildSessionsOverflow(hiddenCount: number) {
  const wrap = el('div', 'usage-overflow');
  const text = sessionOverflowText(hiddenCount);
  if (text) wrap.append(el('p', 'usage-meta', text));
  const button = el('button', 'usage-toggle', 'All sessions');
  button.type = 'button';
  button.dataset.usageSessionsToggle = 'true';
  button.setAttribute('aria-expanded', _sessionsExpanded ? 'true' : 'false');
  button.addEventListener('click', () => {
    _focusAfterRender = { kind: 'sessions-toggle' };
    _sessionsExpanded = !_sessionsExpanded;
    render();
  });
  wrap.append(button);
  return wrap;
}

function buildUnavailableSection() {
  const section = buildSection('Not available', '');
  section.append(el('p', 'usage-empty', usageErrorLine(_report)));
  section.append(el('p', 'usage-empty', USAGE_DISABLED_HINT));
  return section;
}

function clearRefs() {
  _reportAgeEl = null;
  _sessionsTsEl = null;
  _planAgeEl = null;
  _blockElapsedEl = null;
  _blockRemainingEl = null;
  _blockMeterEl = null;
  _refreshButtonEl = null;
  _refreshStatusEl = null;
}

function render({ force = false }: { force?: boolean } = {}) {
  if (!_root) return;
  if (!force && isPanelHidden(_root)) return;
  const scroller = _root.parentElement;
  const scrollTop = scroller ? scroller.scrollTop : 0;
  _ticker.reset();
  clearRefs();
  _root.textContent = '';
  buildBody();
  if (scroller) scroller.scrollTop = scrollTop;
  restoreFocusAfterRender();
}

function restoreFocusAfterRender() {
  const target = _focusAfterRender;
  _focusAfterRender = null;
  if (!target) return;
  const selector = selectorForFocusTarget(target);
  if (!selector) return;
  if (!_root) return;
  const focusTarget = _root.querySelector(selector);
  if (!(focusTarget instanceof HTMLElement)) return;
  focusTarget.focus();
}

function selectorForFocusTarget(target: FocusTarget) {
  if (target.kind === 'day') return `.usage-toggle[data-usage-day="${CSS.escape(target.day)}"]`;
  if (target.kind === 'period') return `.usage-period-button[data-period-view="${CSS.escape(target.view)}"]`;
  if (target.kind === 'sessions-toggle') return '.usage-toggle[data-usage-sessions-toggle="true"]';
  if (target.kind === 'sort') return `[data-usage-table="${CSS.escape(target.table)}"] .usage-sort[data-sort-key="${CSS.escape(target.key)}"]`;
  return null;
}

function buildBody() {
  if (!_root) return;
  _root.append(buildHeaderSection());

  const plan = buildPlanLimitsSection();
  if (isUsageUnavailable(_report)) {
    if (plan) _root.append(plan);
    _root.append(buildUnavailableSection());
    return;
  }
  if (!_report) {
    if (plan) _root.append(plan);
    _root.append(el('p', 'usage-empty', 'Waiting for scan.'));
    return;
  }
  const ceilings = [plan, buildBudgetsSection()].filter((section) => section !== null);
  _root.append(bandOf('usage-band-now', buildActiveBlockSection(), ceilings, { sideFirst: true }));
  const spendSide = [buildSavingsSection()].filter((section) => section !== null);
  _root.append(bandOf('usage-band-spend', buildTotalsSection(), spendSide));
  const trendSide = [buildBlockHistorySection()].filter((section) => section !== null);
  _root.append(bandOf('usage-band-trend', buildDailySection(), trendSide));
  const lanes = buildLanesSection();
  if (lanes) _root.append(lanes);
  _root.append(buildModelsSection(), buildSessionsSection());
}

function bandOf(
  className: string,
  main: HTMLElement,
  sideSections: HTMLElement[],
  { sideFirst = false }: { sideFirst?: boolean } = {},
): HTMLElement {
  if (sideSections.length === 0) return main;
  const band = el('div', `usage-band ${className}`);
  const col = el('div', 'usage-band-col');
  for (const section of sideSections) col.append(section);
  if (sideFirst) {
    band.append(col, main);
    return band;
  }
  band.append(main, col);
  return band;
}

function refreshActivity() {
  if (!_activityCallback) return;
  _activityCallback(_attention.refresh());
}

export function acknowledgeUsageAttention() {
  _attention.acknowledge();
  refreshActivity();
}

function applyRefreshPending() {
  if (_refreshButtonEl) _refreshButtonEl.disabled = _refreshPending;
  if (_refreshStatusEl) _refreshStatusEl.textContent = _refreshPending ? 'Refreshing' : '';
}

function setRefreshPending(pending: boolean) {
  _refreshPending = pending;
  applyRefreshPending();
  if (_refreshTimer) {
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
  }
  if (!pending) return;

  _refreshTimer = setTimeout(() => {
    _refreshTimer = null;
    _refreshPending = false;
    applyRefreshPending();
  }, REFRESH_STATUS_TIMEOUT_MS);
}

export function setUsageActivityCallback(callback: (isActive: boolean) => void) {
  _activityCallback = callback;
  refreshActivity();
}

export function setUsageRequestSender(send: (message: Record<string, unknown>) => void) {
  _sendRequest = send;
}

export function requestUsageReport({ force = false }: { force?: boolean } = {}) {
  if (!_sendRequest) return;
  _requestSeq += 1;
  _latestRequestId = `usage-${_requestSeq}`;
  const msg: Record<string, unknown> = { type: 'request-usage-report', requestId: _latestRequestId };
  if (force) msg.force = true;
  const days = daysForRange(_rangeValue);
  if (days !== null) msg.days = days;
  setRefreshPending(true);
  _sendRequest(msg);
}

export function mountUsageView(parent: HTMLElement) {
  if (_root) return _root;
  const root = el('div', 'usage-content');
  parent.appendChild(root);
  _root = root;
  _ticker.ensure();
  render({ force: true });
  return root;
}

export function refreshUsageView() {
  render({ force: true });
}

export function applyUsageSessions(msg: unknown) {
  _sessions = msg as UsageSessionsPush;

  if (_report && !isUsageUnavailable(_report) && _sessionsTsEl?.isConnected) {
    paintSessionsTs();
    return;
  }
  render();
}

export function applyPlanLimits(msg: unknown) {
  _planLimits = msg as PlanLimits;
  render();
  refreshActivity();
}

export function applyUsageReport(msg: unknown) {
  if (!shouldApplyUsageReport(msg, _latestRequestId)) return;
  setRefreshPending(false);
  _report = msg as UsageReport;
  render();
  refreshActivity();
}

export function usageStatusLines() {
  const pricing = _report?.pricing || (_sessions ? { source: _sessions.pricingSource } : null);
  const fetchedAt = Number(pricing?.fetchedAt);
  const agoText = Number.isFinite(fetchedAt) && fetchedAt > 0 ? formatAgo(fetchedAt) : '';
  const lines = [pricingSourceLine(pricing, agoText)];
  const error = usageErrorLine(_report);
  if (error) lines.push(error);
  const scan = scanLine(_report?.scan);
  if (scan) lines.push(scan);
  return lines;
}
