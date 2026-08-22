// ── Visions view ───────────────────────────────────────────
// What the Visions lane currently believes and currently sees: the intent model at the top (the one
// statement of what is being built, correctable right there), then one section per open document that has
// something to say: one row per tier 2 finding, one card per tier 3 model comment. Fed by four control-WS
// messages, `visions-findings` and `visions-comments` (one uri each, pushed whenever a sweep publishes
// or a dispatch lands, an empty array clearing that uri), `visions-intent` (the whole statement, pushed
// whenever it moves) and `visions-snapshot` (the whole map plus the intent, sent to every client on
// connect so a reconnect repairs rather than accumulates).
//
// The phone layout borrows this panel as its Visions screen. The grouping, ordering and wording live
// in visions-view-core.mjs.

import { sendControlMsg } from './control-ws.js';
import { el, isPanelHidden } from './dom-helpers.js';
import {
  INGEST_EMPTY_TEXT,
  VISIONS_EMPTY_TEXT,
  VISIONS_FIXES_EMPTY_TEXT,
  VISIONS_INTENT_EMPTY_TEXT,
  VISIONS_INTENT_MAX_CHARS,
  activityAgeText,
  activityCountText,
  activityOverflowCount,
  activityOverflowText,
  activityScopeText,
  activitySourceLabel,
  applyActivityMessage,
  applyActivitySnapshot,
  applyCommentsMessage,
  applyCommentsSnapshot,
  applyFindingsMessage,
  applyFindingsSnapshot,
  applyFixMessage,
  applyFixSnapshot,
  applyHandMessage,
  applyHandSnapshot,
  basenameOfUri,
  commentLineLabel,
  emptyIntent,
  findingLineLabel,
  fixCountText,
  fixLineLabel,
  fixOutcomeText,
  hasActivity,
  hasComments,
  hasFindings,
  hasFix,
  hasHand,
  hasIntentChanged,
  intentMetaText,
  intentOfMessage,
  visionsHandText,
  visionsSections,
  sectionCountText,
  shouldAdoptIntentText,
  totalCommentCount,
  totalFindingCount,
  totalHandCount,
} from './visions-view-core.mjs';

let _findingsByUri = new Map();
let _commentsByUri = new Map();
let _handsByUri = new Map();
let _intent = emptyIntent();
let _root = null;
let _feed = null;
// The intent block's live nodes, built once: the field can hold a half-typed correction, so it is
// updated in place rather than rebuilt under the operator.
let _intentUI = null;
// The statement the field last adopted, which is what tells a pristine field from a started draft.
let _adoptedIntentText = '';
let _activityCallback = null;
// The ingest lane's cross-source timeline, newest first and already capped by the view core.
let _activityEvents = [];
// What the last batched frame could not fit. A count, never the events themselves.
let _activityOverflow = 0;
let _activityUI = null;
// The tier 1 changelog, newest first and already capped by the view core.
let _fixEntries = [];
let _fixUI = null;
// Findings that landed while the operator was looking at another tab. Cleared when this one is shown,
// which is the whole point of the dot: it says "something arrived since you last looked".
let _unseen = false;

/*
 * The intent block: the statement, who set it and how old it is, and the one field that corrects it.
 * The button label is constant for the control's whole lifecycle (house convention), because the
 * action is always the same one; submitting an EMPTY field is the documented way to clear the
 * statement and hand control back to the model.
 */
function buildIntentBlock() {
  const section = el('section', 'visions-intent');
  const head = el('div', 'visions-intent-head');
  head.append(el('h2', 'visions-intent-title', 'Intent'));
  const meta = el('span', 'visions-intent-meta');
  head.append(meta);
  section.append(head);

  // Model text and operator text alike: built as text, never markup.
  const statement = el('p', 'visions-intent-text');
  section.append(statement);

  const form = el('form', 'visions-intent-form');
  const input = el('input', 'visions-intent-input');
  input.type = 'text';
  input.maxLength = VISIONS_INTENT_MAX_CHARS;
  input.placeholder = 'What are you building?';
  input.setAttribute('aria-label', 'Working intent');
  const submit = el('button', 'visions-intent-submit', 'Set intent');
  submit.type = 'submit';
  form.append(input, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitIntent();
  });
  section.append(form);

  _intentUI = { meta, statement, input };
  return section;
}

// The server decides what the correction does; this only reports what was typed, empty included.
function submitIntent() {
  if (!_intentUI) return;
  const text = _intentUI.input.value;
  _adoptedIntentText = text;
  sendControlMsg({ type: 'visions-set-intent', text });
}

function renderIntent() {
  if (!_intentUI) return;
  const { meta, statement, input } = _intentUI;
  meta.textContent = intentMetaText(_intent);
  statement.textContent = _intent.text || VISIONS_INTENT_EMPTY_TEXT;
  statement.classList.toggle('visions-intent-none', !_intent.text);
  const adopt = shouldAdoptIntentText({
    focused: document.activeElement === input,
    currentValue: input.value,
    previousText: _adoptedIntentText,
    nextText: _intent.text,
  });
  if (!adopt) return;
  input.value = _intent.text;
  _adoptedIntentText = _intent.text;
}

function buildSection(section) {
  const wrap = el('section', 'visions-doc');
  const head = el('div', 'visions-doc-head');
  // Buffer paths come from an editor: built as text, never markup.
  const name = el('h2', 'visions-doc-name');
  name.textContent = section.name;
  name.title = section.uri;
  head.append(name, el('span', 'visions-doc-count', sectionCountText(section)));
  wrap.append(head);

  if (section.hand) wrap.append(buildHandBanner(section.hand));
  if (section.findings.length > 0) {
    const list = el('div', 'visions-findings');
    for (const finding of section.findings) list.append(buildFindingRow(finding));
    wrap.append(list);
  }
  if (section.comments.length > 0) {
    const cards = el('div', 'visions-comments');
    for (const comment of section.comments) cards.append(buildCommentCard(comment));
    wrap.append(cards);
  }
  return wrap;
}

function buildHandBanner(hand) {
  const banner = el('div', 'visions-hand');
  banner.textContent = visionsHandText(hand);
  return banner;
}

// A tier 3 card, deliberately unlike a tier 2 row: a chip naming who is talking, then a sentence.
function buildCommentCard(comment) {
  const card = el('div', 'visions-comment');
  const head = el('div', 'visions-comment-head');
  head.append(el('span', 'visions-comment-chip', 'visions'));
  head.append(el('span', 'visions-comment-line', commentLineLabel(comment)));
  card.append(head);
  // Model text about the carbon unit's own prose: built as text, never markup.
  const message = el('p', 'visions-comment-message');
  message.textContent = comment?.message == null ? '' : String(comment.message);
  card.append(message);
  return card;
}

function buildFindingRow(finding) {
  const row = el('div', 'visions-finding');
  row.append(el('span', 'visions-finding-line', findingLineLabel(finding)));
  const code = finding?.code == null ? '' : String(finding.code);
  if (code) row.append(el('span', 'visions-finding-code', code));
  // Rule messages quote the carbon unit's own prose back at them: text, never markup.
  const message = el('span', 'visions-finding-message');
  message.textContent = finding?.message == null ? '' : String(finding.message);
  row.append(message);
  return row;
}

// A push while another tab is open is dropped: the surface rebuilds when it is next looked at, which is
// what the dot is for. The lane sweeps on every pause boundary, so this is not a rare path.
function render({ force = false } = {}) {
  if (!_feed) return;
  if (!force && isPanelHidden(_root)) return;
  _feed.textContent = '';
  const sections = visionsSections(_findingsByUri, _commentsByUri, _handsByUri);
  // The bare hint, with no section chrome to make an idle lane look like a broken one (Radar's precedent).
  if (sections.length === 0) {
    _feed.append(el('p', 'visions-empty', VISIONS_EMPTY_TEXT));
    return;
  }
  for (const section of sections) _feed.append(buildSection(section));
}

/*
 * The ingest activity feed: one section under the findings, one row per normalized event, newest first.
 * It carries no controls, so nothing here has a label to keep constant; the head's count is status text
 * beside the title rather than anything clickable.
 */
function buildActivityBlock() {
  const section = el('section', 'visions-activity');
  const head = el('div', 'visions-activity-head');
  head.append(el('h2', 'visions-activity-title', 'Activity'));
  const count = el('span', 'visions-activity-count');
  head.append(count);
  section.append(head);
  const list = el('div', 'visions-activity-list');
  section.append(list);
  const overflow = el('p', 'visions-activity-overflow');
  section.append(overflow);
  _activityUI = { count, list, overflow };
  return section;
}

function buildActivityRow(event, now) {
  const row = el('div', 'visions-activity-row');
  row.append(el('span', 'visions-activity-source', activitySourceLabel(event.source)));
  row.append(el('span', 'visions-activity-age', activityAgeText(event.ts, now)));
  row.append(el('span', 'visions-activity-scope', activityScopeText(event)));
  // Captured output about whatever the carbon unit was doing: built as text, never markup.
  const summary = el('span', 'visions-activity-summary');
  summary.textContent = event.summary;
  row.append(summary);
  return row;
}

function renderActivity({ force = false } = {}) {
  if (!_activityUI) return;
  if (!force && isPanelHidden(_root)) return;
  const { count, list, overflow } = _activityUI;
  count.textContent = activityCountText(_activityEvents.length);
  list.textContent = '';
  if (_activityEvents.length === 0) {
    list.append(el('p', 'visions-empty', INGEST_EMPTY_TEXT));
    overflow.textContent = '';
    return;
  }
  const now = Date.now();
  for (const event of _activityEvents) list.append(buildActivityRow(event, now));
  overflow.textContent = activityOverflowText(_activityOverflow);
}

/*
 * The tier 1 changelog: what the lane silently changed, and what it tried to change and was refused.
 * It carries no controls either, so the head's count is status text beside the title.
 */
function buildFixesBlock() {
  const section = el('section', 'visions-fixes');
  const head = el('div', 'visions-fixes-head');
  head.append(el('h2', 'visions-fixes-title', 'Fixes'));
  const count = el('span', 'visions-fixes-count');
  head.append(count);
  section.append(head);
  const list = el('div', 'visions-fixes-list');
  section.append(list);
  _fixUI = { count, list };
  return section;
}

function buildFixRow(entry) {
  const row = el('div', 'visions-fix-row');
  row.dataset.applied = entry.applied ? 'yes' : 'no';
  // Buffer paths come from an editor: built as text, never markup.
  const file = el('span', 'visions-fix-file');
  file.textContent = basenameOfUri(entry.uri) || entry.uri;
  file.title = entry.uri;
  row.append(file);
  row.append(el('span', 'visions-fix-line', fixLineLabel(entry)));
  row.append(el('span', 'visions-fix-outcome', fixOutcomeText(entry)));
  row.append(el('span', 'visions-fix-code', entry.code || ''));
  // Rule messages quote the carbon unit's own prose back at them: text, never markup.
  const message = el('span', 'visions-fix-message');
  message.textContent = entry.message;
  row.append(message);
  return row;
}

function renderFixes({ force = false } = {}) {
  if (!_fixUI) return;
  if (!force && isPanelHidden(_root)) return;
  const { count, list } = _fixUI;
  count.textContent = fixCountText(_fixEntries.length);
  list.textContent = '';
  if (_fixEntries.length === 0) {
    list.append(el('p', 'visions-empty', VISIONS_FIXES_EMPTY_TEXT));
    return;
  }
  for (const entry of _fixEntries) list.append(buildFixRow(entry));
}

function refreshActivity() {
  if (!_activityCallback) return;
  _activityCallback(_unseen);
}

function noteArrival(arrived) {
  if (!arrived) return;
  if (!isPanelHidden(_root)) return;
  _unseen = true;
}

// The tab-activity seam (defined in pr-panel.js): the view owns the condition, app.js owns the dot element.
export function setVisionsActivityCallback(callback) {
  _activityCallback = callback;
  refreshActivity();
}

export function mountVisionsView(parent) {
  if (_root) return _root;
  const root = el('div', 'visions-content');
  root.append(buildIntentBlock());
  const feed = el('div', 'visions-feed');
  root.append(feed);
  root.append(buildFixesBlock());
  root.append(buildActivityBlock());
  parent.appendChild(root);
  _root = root;
  _feed = feed;
  renderIntent();
  render({ force: true });
  renderFixes({ force: true });
  renderActivity({ force: true });
  return root;
}

// Called when the Visions surface becomes visible: seeing the findings is what clears the dot.
export function refreshVisionsView() {
  _unseen = false;
  refreshActivity();
  renderIntent();
  render({ force: true });
  renderFixes({ force: true });
  renderActivity({ force: true });
}

// Tier 1: one edit the lane applied, or tried to and was refused. Both are news worth the dot.
export function applyVisionsFix(msg) {
  _fixEntries = applyFixMessage(_fixEntries, msg);
  noteArrival(hasFix(msg));
  renderFixes();
  refreshActivity();
}

export function applyVisionsFindings(msg) {
  _findingsByUri = applyFindingsMessage(_findingsByUri, msg);
  noteArrival(hasFindings(msg));
  render();
  refreshActivity();
}

// Tier 3: what a visions dispatch had to say about one buffer, replacing that uri's cards whole.
export function applyVisionsComments(msg) {
  _commentsByUri = applyCommentsMessage(_commentsByUri, msg);
  noteArrival(hasComments(msg));
  render();
  refreshActivity();
}

export function applyVisionsHand(msg) {
  _handsByUri = applyHandMessage(_handsByUri, msg);
  noteArrival(hasHand(msg));
  render();
  refreshActivity();
}

/*
 * The intent model moved. A model proposal is visions output and raises the dot; the operator's own
 * correction is not news to the operator, so it does not.
 */
export function applyVisionsIntent(msg) {
  const next = intentOfMessage(msg);
  const moved = hasIntentChanged(_intent, next);
  _intent = next;
  noteArrival(moved && next.source === 'model' && !!next.text);
  renderIntent();
  refreshActivity();
}

/*
 * One batched ingest frame (docs/plan-ingestion.md, M6). The lane sends at most one per second carrying
 * at most 50 events, and what it could not fit rides as a count rather than as more rows.
 */
export function applyIngestActivity(msg) {
  _activityEvents = applyActivityMessage(_activityEvents, msg);
  _activityOverflow = activityOverflowCount(msg);
  noteArrival(hasActivity(msg));
  renderActivity();
  refreshActivity();
}

// Connect-time repair for the feed: the rings as they stand now, replacing this tab's list.
export function applyIngestSnapshot(msg) {
  _activityEvents = applyActivitySnapshot(msg);
  _activityOverflow = 0;
  noteArrival(_activityEvents.length > 0);
  renderActivity();
  refreshActivity();
}

// Connect-time repair: the server's whole current map, replacing this tab's rather than merging into it.
export function applyVisionsSnapshot(msg) {
  _findingsByUri = applyFindingsSnapshot(msg);
  _commentsByUri = applyCommentsSnapshot(msg);
  _handsByUri = applyHandSnapshot(msg);
  _intent = intentOfMessage(msg);
  _fixEntries = applyFixSnapshot(msg);
  noteArrival(totalFindingCount(_findingsByUri) + totalCommentCount(_commentsByUri) + totalHandCount(_handsByUri) > 0);
  renderIntent();
  render();
  renderFixes();
  refreshActivity();
}
