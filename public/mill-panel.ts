import { createAttentionAck } from './attention-ack-core.ts';
import { buildPanelSection, buildStatChip, el, isPanelHidden } from './dom-helpers.ts';
import { getMillAttentionAck, setMillAttentionAck } from './ui-prefs.ts';
import { createSettingsLink } from './settings-link.ts';
import {
  MILL_EMPTY_TEXT,
  MILL_HINT,
  MILL_LOADING_TEXT,
  autoRebuildLine,
  budgetLine,
  budgetPct,
  budgetTone,
  builtLine,
  builtTone,
  configWarningsOf,
  consumerLine,
  contentLine,
  deliveryDetail,
  deliveryEmptyText,
  deliveryLabel,
  deliveryStaleText,
  variantNote,
  deliveryTone,
  distillText,
  distillTone,
  distillerLine,
  indexLine,
  isMillUnavailable,
  millAttentionSignature,
  millErrorLine,
  measurementEmptyText,
  measurementLines,
  moreOutputsLine,
  outcomeSplitLines,
  outputTokenLine,
  shouldApplyMillReport,
  sortPackRows,
  specErrorLine,
  totalsChips,
} from './mill-view-core.ts';
import type { MillBuild, MillPack, MillReport } from './mill-view-core.ts';

let _report: MillReport | null = null;
let _root: HTMLDivElement | null = null;
let _activityCallback: ((isActive: boolean) => void) | null = null;
let _sendRequest: ((message: Record<string, unknown>) => void) | null = null;
let _requestSeq = 0;
let _latestRequestId: string | null = null;

const _attention = createAttentionAck({
  getAck: getMillAttentionAck,
  setAck: setMillAttentionAck,
  signature: () => millAttentionSignature(_report),
  isLooking: () => !isPanelHidden(_root),
});

const buildSection = (title: string | null | undefined, hint?: string | null) => buildPanelSection('mill', title, hint);

function clampPct(pct: unknown) {
  const numeric = Number(pct);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(Math.max(numeric, 0), 100);
}

function buildMeter(pct: unknown, tone: string, label: string) {
  const meter = el('div', 'mill-meter');
  meter.dataset.tone = tone;
  meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-valuenow', String(Math.round(clampPct(pct))));
  meter.setAttribute('aria-label', label);
  const fill = el('span', 'mill-meter-fill');
  fill.style.width = `${clampPct(pct)}%`;
  meter.append(fill);
  return meter;
}

function buildLine(className: string, text: string | null | undefined, tone?: string | null) {
  const line = el('p', className, text);
  if (tone && tone !== 'ok') line.dataset.tone = tone;
  return line;
}

function buildTotalsSection() {
  const section = buildSection('Context mill', MILL_HINT);
  const chips = el('div', 'mill-stats');
  for (const chip of totalsChips(_report)) {
    chips.append(buildStatChip('mill', chip.label, chip.value, chip.tone));
  }
  section.append(chips);
  const autoRebuild = buildLine('mill-meta', autoRebuildLine(_report));
  const autoRebuildLink = createSettingsLink('lanes-mill', 'mill-enabled', 'Settings');
  autoRebuild.append(document.createTextNode(' '), autoRebuildLink);
  section.append(autoRebuild);
  section.append(buildLine('mill-meta', distillerLine(_report)));
  for (const warning of configWarningsOf(_report)) {
    section.append(buildLine('mill-warning', warning));
  }
  return section;
}

function buildBudgetBlock(pack: MillPack) {
  const wrap = el('div', 'mill-budget');
  const pct = budgetPct(pack);
  const tone = budgetTone(pct);
  wrap.append(buildLine('mill-budget-line', budgetLine(pack), tone));
  if (pct !== null) wrap.append(buildMeter(pct, tone, `${pack.name} token budget used`));
  wrap.append(buildLine('mill-meta', indexLine(pack.built)));
  return wrap;
}

function buildDeliveriesBlock(pack: MillPack) {
  const wrap = el('div', 'mill-deliveries');
  if (pack.deliveredTo.length === 0) {
    wrap.append(buildLine('mill-empty', deliveryEmptyText(pack)));
    return wrap;
  }
  for (const delivery of pack.deliveredTo) {
    const row = el('div', 'mill-delivery');
    row.dataset.tone = deliveryTone(delivery);
    row.append(el('span', 'mill-delivery-name', deliveryLabel(delivery)));
    row.append(el('span', 'mill-delivery-detail', deliveryDetail(delivery)));
    const stale = deliveryStaleText(delivery);
    if (stale) row.append(el('span', 'mill-delivery-tag', stale));
    wrap.append(row);
  }
  return wrap;
}

function buildMeasurementBlock(pack: MillPack) {
  const wrap = el('div', 'mill-measurement');
  const emptyText = measurementEmptyText(pack);
  if (emptyText) {
    wrap.append(buildLine('mill-empty', emptyText));
    return wrap;
  }
  for (const line of [...measurementLines(pack), ...outcomeSplitLines(pack.measurement)]) {
    wrap.append(buildLine('mill-meta', `${line.label}: ${line.value}`, line.tone));
  }
  return wrap;
}

function titledSpan(className: string, text: string) {
  const span = el('span', className, text);
  span.title = text;
  return span;
}

function buildDistillBlock(pack: MillPack) {
  if (pack.distill.length === 0) return null;
  const wrap = el('div', 'mill-distills');
  for (const row of pack.distill) {
    const item = el('div', 'mill-distill');
    item.dataset.tone = distillTone(row);
    item.append(titledSpan('mill-distill-output', row.output));
    item.append(el('span', 'mill-distill-status', distillText(row)));
    wrap.append(item);
  }
  return wrap;
}

function buildOutputsBlock(built: MillBuild | null | undefined) {
  if (!built || built.outputs.length === 0) return null;
  const wrap = el('div', 'mill-outputs');
  for (const output of built.outputs) {
    const item = el('div', 'mill-output');
    item.append(titledSpan('mill-output-path', output.relPath));
    item.append(el('span', 'mill-output-tokens', outputTokenLine(output)));
    wrap.append(item);
  }
  const moreOutputs = moreOutputsLine(built.moreOutputs);
  if (moreOutputs) wrap.append(buildLine('mill-meta', moreOutputs));
  return wrap;
}

function buildPackSection(pack: MillPack) {
  const section = buildSection(pack.name, '');
  const variant = variantNote(pack);
  if (variant) section.append(buildLine('mill-meta', variant));
  if (!pack.specValid) section.append(buildLine('mill-warning', specErrorLine(pack)));
  section.append(buildLine('mill-meta', builtLine(pack), builtTone(pack)));
  if (pack.built) section.append(buildBudgetBlock(pack));
  if (pack.built) section.append(buildLine('mill-meta', contentLine(pack.built)));
  section.append(buildDeliveriesBlock(pack));
  section.append(buildMeasurementBlock(pack));
  const distills = buildDistillBlock(pack);
  if (distills) section.append(distills);
  const outputs = buildOutputsBlock(pack.built);
  if (outputs) section.append(outputs);
  section.append(buildLine('mill-meta', consumerLine(pack)));
  return section;
}

function buildNoticeSection(text: string) {
  const section = buildSection('Context mill', MILL_HINT);
  section.append(buildLine('mill-empty', text));
  return section;
}

function buildBody() {
  if (!_root) return;

  if (!_report) {
    _root.append(buildNoticeSection(MILL_LOADING_TEXT));
    return;
  }
  if (isMillUnavailable(_report)) {
    _root.append(buildNoticeSection(millErrorLine(_report)));
    return;
  }
  _root.append(buildTotalsSection());
  const packs = sortPackRows(_report.packs);
  if (packs.length === 0) {
    _root.append(buildLine('mill-empty', MILL_EMPTY_TEXT));
    return;
  }
  for (const pack of packs) _root.append(buildPackSection(pack));
}

function render({ force = false }: { force?: boolean } = {}) {
  if (!_root) return;
  if (!force && isPanelHidden(_root)) return;
  const scroller = _root.parentElement;
  const scrollTop = scroller ? scroller.scrollTop : 0;
  _root.textContent = '';
  buildBody();
  if (scroller) scroller.scrollTop = scrollTop;
}

function refreshActivity() {
  if (!_activityCallback) return;
  _activityCallback(_attention.refresh());
}

export function setMillActivityCallback(callback: (isActive: boolean) => void) {
  _activityCallback = callback;
  refreshActivity();
}

export function acknowledgeMillAttention() {
  _attention.acknowledge();
  refreshActivity();
}

export function setMillRequestSender(send: (message: Record<string, unknown>) => void) {
  _sendRequest = send;
}

export function requestMillReport() {
  if (!_sendRequest) return;
  _requestSeq += 1;
  _latestRequestId = `mill-${_requestSeq}`;
  _sendRequest({ type: 'request-mill-report', requestId: _latestRequestId });
}

export function mountMillView(parent: HTMLElement) {
  if (_root) return _root;
  const root = el('div', 'mill-content');
  parent.appendChild(root);
  _root = root;
  render({ force: true });
  return root;
}

export function refreshMillView() {
  render({ force: true });
}

export function applyMillReport(msg: unknown) {
  if (!shouldApplyMillReport(msg, _latestRequestId)) return;
  _report = msg as MillReport;
  render();
  refreshActivity();
}
