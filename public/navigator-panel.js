// ── Navigator view ───────────────────────────────────────────
// What the navigator lane currently sees in the editor buffers it mirrors: one section per open document
// that has something to say: one row per tier 2 finding, one card per tier 3 model comment. Fed by three
// control-WS messages, `navigator-findings` and `navigator-comments` (one uri each, pushed whenever a
// sweep publishes or a dispatch lands, an empty array clearing that uri) and `navigator-snapshot` (the
// whole map, both halves, sent to every client on connect so a reconnect repairs rather than accumulates).
//
// Desktop only in v1: the phone layout hides the tab strip entirely, so no phone screen borrows this panel.
// The panel is DOM only; the grouping, ordering and wording live in navigator-view-core.mjs.

import { el } from './dom-helpers.js';
import {
  NAVIGATOR_EMPTY_TEXT,
  applyCommentsMessage,
  applyCommentsSnapshot,
  applyFindingsMessage,
  applyFindingsSnapshot,
  commentLineLabel,
  findingLineLabel,
  hasComments,
  hasFindings,
  navigatorSections,
  sectionCountText,
  totalCommentCount,
  totalFindingCount,
} from './navigator-view-core.mjs';

let _findingsByUri = new Map();
let _commentsByUri = new Map();
let _root = null;
let _activityCallback = null;
// Findings that landed while the operator was looking at another tab. Cleared when this one is shown,
// which is the whole point of the dot: it says "something arrived since you last looked".
let _unseen = false;

function isHidden() {
  return !_root || !!_root.closest('[hidden]');
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
  if (!_root) return;
  if (!force && isHidden()) return;
  _root.textContent = '';
  const sections = navigatorSections(_findingsByUri, _commentsByUri);
  // The bare hint, with no section chrome to make an idle lane look like a broken one (Radar's precedent).
  if (sections.length === 0) {
    _root.append(el('p', 'navigator-empty', NAVIGATOR_EMPTY_TEXT));
    return;
  }
  for (const section of sections) _root.append(buildSection(section));
}

function refreshActivity() {
  if (!_activityCallback) return;
  _activityCallback(_unseen);
}

function noteArrival(arrived) {
  if (!arrived) return;
  if (!isHidden()) return;
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
  parent.appendChild(root);
  _root = root;
  render({ force: true });
  return root;
}

// Called when the Navigator surface becomes visible: seeing the findings is what clears the dot.
export function refreshNavigatorView() {
  _unseen = false;
  refreshActivity();
  render({ force: true });
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

// Connect-time repair: the server's whole current map, replacing this tab's rather than merging into it.
export function applyNavigatorSnapshot(msg) {
  _findingsByUri = applyFindingsSnapshot(msg);
  _commentsByUri = applyCommentsSnapshot(msg);
  noteArrival(totalFindingCount(_findingsByUri) + totalCommentCount(_commentsByUri) > 0);
  render();
  refreshActivity();
}
