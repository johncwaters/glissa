// ── Mill view ─────────────────────────────────────────────────
// The context mill (AGENTS.md "Context Packs") as a surface: what each pack spec asks for, what its
// last build produced, how much of its token budget that spent, which live sessions were spawned
// against it and whether they ever read it, which derived files have drifted, and which config keys
// name it.
//
// A PULL surface like Usage: the report is assembled on demand (`request-mill-report`) rather than
// broadcast, because nothing about it changes on its own between a rebuild and a spawn. The panel is
// DOM only; every string and tone comes from mill-view-core.mjs.

import { createAttentionAck } from './attention-ack-core.mjs';
import { buildPanelSection, buildStatChip, el, isPanelHidden } from './dom-helpers.js';
import { getMillAttentionAck, setMillAttentionAck } from './ui-prefs.js';
import {
  DELIVER_TO_CAP_NOTE,
  DELIVER_TO_EMPTY_TEXT,
  DELIVER_TO_TITLE,
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
  deliverToCapHint,
  deliveryDetail,
  deliveryEmptyText,
  deliveryLabel,
  deliveryStaleText,
  deliveryTargets,
  variantNote,
  deliveryTone,
  distillText,
  distillTone,
  distillerLine,
  indexLine,
  isMillUnavailable,
  millAttentionSignature,
  millErrorLine,
  moreOutputsLine,
  outputTokenLine,
  packDeltaFor,
  shouldApplyMillReport,
  sortPackRows,
  specErrorLine,
  totalsChips,
} from './mill-view-core.mjs';

let _report = null;
let _root = null;
let _activityCallback = null;
let _sendRequest = null;
let _requestSeq = 0;
let _latestRequestId = null;

const _attention = createAttentionAck({
  getAck: getMillAttentionAck,
  setAck: setMillAttentionAck,
  signature: () => millAttentionSignature(_report),
  isLooking: () => !isPanelHidden(_root),
});

const buildSection = (title, hint) => buildPanelSection('mill', title, hint);

function clampPct(pct) {
  const numeric = Number(pct);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(Math.max(numeric, 0), 100);
}

function buildMeter(pct, tone, label) {
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

function buildLine(className, text, tone) {
  const line = el('p', className, text);
  if (tone && tone !== 'ok') line.dataset.tone = tone;
  return line;
}

// ── Sections ──

function buildTotalsSection() {
  const section = buildSection('Context mill', MILL_HINT);
  const chips = el('div', 'mill-stats');
  for (const chip of totalsChips(_report)) {
    chips.append(buildStatChip('mill', chip.label, chip.value, chip.tone));
  }
  section.append(chips);
  section.append(buildLine('mill-meta', autoRebuildLine(_report)));
  section.append(buildLine('mill-meta', distillerLine(_report)));
  for (const warning of configWarningsOf(_report)) {
    section.append(buildLine('mill-warning', warning));
  }
  return section;
}

function buildBudgetBlock(pack) {
  const wrap = el('div', 'mill-budget');
  const pct = budgetPct(pack);
  const tone = budgetTone(pct);
  wrap.append(buildLine('mill-budget-line', budgetLine(pack), tone));
  if (pct !== null) wrap.append(buildMeter(pct, tone, `${pack.name} token budget used`));
  wrap.append(buildLine('mill-meta', indexLine(pack.built)));
  return wrap;
}

function buildDeliveriesBlock(pack) {
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

/*
 * The one WRITE on this tab: which projects a pack is delivered to. A toggle sends one delta
 * (`set-project-packs`), and the server's broadcast pulls a fresh report, which is what re-renders the
 * boxes. The box is disabled while that round trip is out, so a double click cannot send two toggles
 * for the same pack.
 */
function buildDeliverToBlock(pack) {
  const wrap = el('div', 'mill-deliver');
  wrap.append(el('p', 'mill-deliver-title', DELIVER_TO_TITLE));
  const targets = deliveryTargets(_report, pack);
  if (targets.length === 0) {
    wrap.append(buildLine('mill-empty', DELIVER_TO_EMPTY_TEXT));
    return wrap;
  }
  for (const target of targets) {
    const row = el('label', 'mill-deliver-target');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'mill-deliver-box';
    box.checked = target.checked;
    box.disabled = target.disabled;
    box.addEventListener('change', () => {
      box.disabled = true;
      sendPackDelta(packDeltaFor(target, pack.name));
    });
    row.append(box);
    row.append(el('span', 'mill-deliver-name', target.name));
    if (target.disabled) row.append(el('span', 'mill-deliver-note', DELIVER_TO_CAP_NOTE));
    wrap.append(row);
  }
  const hint = deliverToCapHint(_report);
  if (hint) wrap.append(buildLine('mill-meta', hint));
  return wrap;
}

function buildDistillBlock(pack) {
  if (pack.distill.length === 0) return null;
  const wrap = el('div', 'mill-distills');
  for (const row of pack.distill) {
    const item = el('div', 'mill-distill');
    const output = el('span', 'mill-distill-output', row.output);
    output.title = row.output;
    item.dataset.tone = distillTone(row);
    item.append(output);
    item.append(el('span', 'mill-distill-status', distillText(row)));
    wrap.append(item);
  }
  return wrap;
}

function buildOutputsBlock(built) {
  if (!built || built.outputs.length === 0) return null;
  const wrap = el('div', 'mill-outputs');
  for (const output of built.outputs) {
    const item = el('div', 'mill-output');
    const path = el('span', 'mill-output-path', output.relPath);
    path.title = output.relPath;
    item.append(path);
    item.append(el('span', 'mill-output-tokens', outputTokenLine(output)));
    wrap.append(item);
  }
  const moreOutputs = moreOutputsLine(built.moreOutputs);
  if (moreOutputs) wrap.append(buildLine('mill-meta', moreOutputs));
  return wrap;
}

function buildPackSection(pack) {
  const section = buildSection(pack.name, '');
  const variant = variantNote(pack);
  if (variant) section.append(buildLine('mill-meta', variant));
  if (!pack.specValid) section.append(buildLine('mill-warning', specErrorLine(pack)));
  section.append(buildLine('mill-meta', builtLine(pack), builtTone(pack)));
  if (pack.built) section.append(buildBudgetBlock(pack));
  if (pack.built) section.append(buildLine('mill-meta', contentLine(pack.built)));
  section.append(buildDeliveriesBlock(pack));
  const distills = buildDistillBlock(pack);
  if (distills) section.append(distills);
  const outputs = buildOutputsBlock(pack.built);
  if (outputs) section.append(outputs);
  section.append(buildLine('mill-meta', consumerLine(pack)));
  if (!variant) section.append(buildDeliverToBlock(pack));
  return section;
}

function buildNoticeSection(text) {
  const section = buildSection('Context mill', MILL_HINT);
  section.append(buildLine('mill-empty', text));
  return section;
}

function buildBody() {
  // A missing or failed report has no totals, so the chips above would each print a confident zero for
  // a mill nobody has read yet.
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

// Scroll position has to be carried across a rebuild by hand: emptying the content collapses the
// scroller, so the browser clamps it back to the top.
function render({ force = false } = {}) {
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

export function setMillActivityCallback(callback) {
  _activityCallback = callback;
  refreshActivity();
}

export function acknowledgeMillAttention() {
  _attention.acknowledge();
  refreshActivity();
}

// app.js owns the socket; the panel owns which reply is still current, so every request goes here.
export function setMillRequestSender(send) {
  _sendRequest = send;
}

export function requestMillReport() {
  if (!_sendRequest) return;
  _requestSeq += 1;
  _latestRequestId = `mill-${_requestSeq}`;
  _sendRequest({ type: 'request-mill-report', requestId: _latestRequestId });
}

function sendPackDelta(delta) {
  if (!_sendRequest) return;
  _requestSeq += 1;
  _sendRequest({ type: 'set-project-packs', requestId: `mill-set-${_requestSeq}`, ...delta });
}

export function mountMillView(parent) {
  if (_root) return _root;
  const root = el('div', 'mill-content');
  parent.appendChild(root);
  _root = root;
  render({ force: true });
  return root;
}

// Called when the Mill surface becomes visible. On the phone the screen is still hidden at that point,
// so the render is forced rather than deferred again.
export function refreshMillView() {
  render({ force: true });
}

export function applyMillReport(msg) {
  if (!shouldApplyMillReport(msg, _latestRequestId)) return;
  _report = msg;
  render();
  refreshActivity();
}
