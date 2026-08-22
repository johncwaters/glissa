// ── Navigator view ───────────────────────────────────────────
// What the navigator lane currently believes and currently sees: the intent model at the top (the one
// statement of what is being built, correctable right there), then one section per open document that has
// something to say: one row per tier 2 finding, one card per tier 3 model comment. Fed by four control-WS
// messages, `navigator-findings` and `navigator-comments` (one uri each, pushed whenever a sweep publishes
// or a dispatch lands, an empty array clearing that uri), `navigator-intent` (the whole statement, pushed
// whenever it moves) and `navigator-snapshot` (the whole map plus the intent, sent to every client on
// connect so a reconnect repairs rather than accumulates).
//
// Desktop only in v1: the phone layout hides the tab strip entirely, so no phone screen borrows this panel.
// The panel is DOM only; the grouping, ordering and wording live in navigator-view-core.mjs.

import { sendControlMsg } from './control-ws.js';
import { el, isPanelHidden } from './dom-helpers.js';
import {
  INGEST_EMPTY_TEXT,
  NAVIGATOR_EMPTY_TEXT,
  NAVIGATOR_INTENT_EMPTY_TEXT,
  NAVIGATOR_INTENT_MAX_CHARS,
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
  commentLineLabel,
  emptyIntent,
  findingLineLabel,
  hasActivity,
  hasComments,
  hasFindings,
  hasIntentChanged,
  intentMetaText,
  intentOfMessage,
  navigatorSections,
  sectionCountText,
  shouldAdoptIntentText,
  totalCommentCount,
  totalFindingCount,
} from './navigator-view-core.mjs';

let _findingsByUri = new Map();
let _commentsByUri = new Map();
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
  const section = el('section', 'navigator-intent');
  const head = el('div', 'navigator-intent-head');
  head.append(el('h2', 'navigator-intent-title', 'Intent'));
  const meta = el('span', 'navigator-intent-meta');
  head.append(meta);
  section.append(head);

  // Model text and operator text alike: built as text, never markup.
  const statement = el('p', 'navigator-intent-text');
  section.append(statement);

  const form = el('form', 'navigator-intent-form');
  const input = el('input', 'navigator-intent-input');
  input.type = 'text';
  input.maxLength = NAVIGATOR_INTENT_MAX_CHARS;
  input.placeholder = 'What are you building?';
  input.setAttribute('aria-label', 'Working intent');
  const submit = el('button', 'navigator-intent-submit', 'Set intent');
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
  sendControlMsg({ type: 'navigator-set-intent', text });
}

function renderIntent() {
  if (!_intentUI) return;
  const { meta, statement, input } = _intentUI;
  meta.textContent = intentMetaText(_intent);
  statement.textContent = _intent.text || NAVIGATOR_INTENT_EMPTY_TEXT;
  statement.classList.toggle('navigator-intent-none', !_intent.text);
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
  const wrap = el('section', 'navigator-doc');
  const head = el('div', 'navigator-doc-head');
  // Buffer paths come from an editor: built as text, never markup.
  const name = el('h2', 'navigator-doc-name');
  name.textContent = section.name;
  name.title = section.uri;
  head.append(name, el('span', 'navigator-doc-count', sectionCountText(section)));
  wrap.append(head);

  if (section.findings.length > 0) {
    const list = el('div', 'navigator-findings');
    for (const finding of section.findings) list.append(buildFindingRow(finding));
    wrap.append(list);
  }
  if (section.comments.length > 0) {
    const cards = el('div', 'navigator-comments');
    for (const comment of section.comments) cards.append(buildCommentCard(comment));
    wrap.append(cards);
  }
  return wrap;
}

// A tier 3 card, deliberately unlike a tier 2 row: a chip naming who is talking, then a sentence.
function buildCommentCard(comment) {
  const card = el('div', 'navigator-comment');
  const head = el('div', 'navigator-comment-head');
  head.append(el('span', 'navigator-comment-chip', 'navigator'));
  head.append(el('span', 'navigator-comment-line', commentLineLabel(comment)));
  card.append(head);
  // Model text about the carbon unit's own prose: built as text, never markup.
  const message = el('p', 'navigator-comment-message');
  message.textContent = comment?.message == null ? '' : String(comment.message);
  card.append(message);
  return card;
}

function buildFindingRow(finding) {
  const row = el('div', 'navigator-finding');
  row.append(el('span', 'navigator-finding-line', findingLineLabel(finding)));
  const code = finding?.code == null ? '' : String(finding.code);
  if (code) row.append(el('span', 'navigator-finding-code', code));
  // Rule messages quote the carbon unit's own prose back at them: text, never markup.
  const message = el('span', 'navigator-finding-message');
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
  const sections = navigatorSections(_findingsByUri, _commentsByUri);
  // The bare hint, with no section chrome to make an idle lane look like a broken one (Radar's precedent).
  if (sections.length === 0) {
    _feed.append(el('p', 'navigator-empty', NAVIGATOR_EMPTY_TEXT));
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
  const section = el('section', 'navigator-activity');
  const head = el('div', 'navigator-activity-head');
  head.append(el('h2', 'navigator-activity-title', 'Activity'));
  const count = el('span', 'navigator-activity-count');
  head.append(count);
  section.append(head);
  const list = el('div', 'navigator-activity-list');
  section.append(list);
  const overflow = el('p', 'navigator-activity-overflow');
  section.append(overflow);
  _activityUI = { count, list, overflow };
  return section;
}

function buildActivityRow(event, now) {
  const row = el('div', 'navigator-activity-row');
  row.append(el('span', 'navigator-activity-source', activitySourceLabel(event.source)));
  row.append(el('span', 'navigator-activity-age', activityAgeText(event.ts, now)));
  row.append(el('span', 'navigator-activity-scope', activityScopeText(event)));
  // Captured output about whatever the carbon unit was doing: built as text, never markup.
  const summary = el('span', 'navigator-activity-summary');
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
    list.append(el('p', 'navigator-empty', INGEST_EMPTY_TEXT));
    overflow.textContent = '';
    return;
  }
  const now = Date.now();
  for (const event of _activityEvents) list.append(buildActivityRow(event, now));
  overflow.textContent = activityOverflowText(_activityOverflow);
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
export function setNavigatorActivityCallback(callback) {
  _activityCallback = callback;
  refreshActivity();
}

export function mountNavigatorView(parent) {
  if (_root) return _root;
  const root = el('div', 'navigator-content');
  root.append(buildIntentBlock());
  const feed = el('div', 'navigator-feed');
  root.append(feed);
  root.append(buildActivityBlock());
  parent.appendChild(root);
  _root = root;
  _feed = feed;
  renderIntent();
  render({ force: true });
  renderActivity({ force: true });
  return root;
}

// Called when the Navigator surface becomes visible: seeing the findings is what clears the dot.
export function refreshNavigatorView() {
  _unseen = false;
  refreshActivity();
  renderIntent();
  render({ force: true });
  renderActivity({ force: true });
}

export function applyNavigatorFindings(msg) {
  _findingsByUri = applyFindingsMessage(_findingsByUri, msg);
  noteArrival(hasFindings(msg));
  render();
  refreshActivity();
}

// Tier 3: what a navigator dispatch had to say about one buffer, replacing that uri's cards whole.
export function applyNavigatorComments(msg) {
  _commentsByUri = applyCommentsMessage(_commentsByUri, msg);
  noteArrival(hasComments(msg));
  render();
  refreshActivity();
}

/*
 * The intent model moved. A model proposal is navigator output and raises the dot; the operator's own
 * correction is not news to the operator, so it does not.
 */
export function applyNavigatorIntent(msg) {
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
export function applyNavigatorSnapshot(msg) {
  _findingsByUri = applyFindingsSnapshot(msg);
  _commentsByUri = applyCommentsSnapshot(msg);
  _intent = intentOfMessage(msg);
  noteArrival(totalFindingCount(_findingsByUri) + totalCommentCount(_commentsByUri) > 0);
  renderIntent();
  render();
  refreshActivity();
}
