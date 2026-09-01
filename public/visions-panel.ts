import { el, isPanelHidden } from './dom-helpers.ts';
import { createSettingsLink } from './settings-link.ts';
import {
  INGEST_EMPTY_TEXT,
  VISIONS_EMPTY_TEXT,
  VISIONS_FIXES_EMPTY_TEXT,
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
  applyIntentMessage,
  basenameOfUri,
  commentLineLabel,
  decideVisionsAttention,
  emptyIntentState,
  findingLineLabel,
  fixCountText,
  fixLineLabel,
  fixOutcomeText,
  hasActivity,
  hasComments,
  hasFindings,
  hasFix,
  hasHand,
  hasIntentStateChanged,
  intentRows,
  intentStateOfMessage,
  visionsHandText,
  visionsSections,
  sectionCountText,
  totalCommentCount,
  totalFindingCount,
  totalHandCount,
} from './visions-view-core.ts';
import type { ActivityEvent, IntentRow, IntentState, VisionsComment, VisionsFinding, VisionsFixEntry, VisionsSection } from './visions-view-core.ts';

type VisionsMessage = Record<string, unknown>;

let _findingsByUri = new Map<string, VisionsFinding[]>();
let _commentsByUri = new Map<string, VisionsComment[]>();
let _handsByUri = new Map<string, string>();
let _intent: IntentState = emptyIntentState();

let _projectNames = new Map<string, string>();
let _root: HTMLDivElement | null = null;
let _feed: HTMLDivElement | null = null;
let _intentUI: { list: HTMLDivElement } | null = null;
let _activityCallback: ((level: string | null) => void) | null = null;
let _isEnabled: boolean | null = null;

let _activityEvents: ActivityEvent[] = [];

let _activityOverflow = 0;
let _activityUI: { count: HTMLSpanElement; list: HTMLDivElement; overflow: HTMLParagraphElement } | null = null;

let _fixEntries: VisionsFixEntry[] = [];
let _fixUI: { count: HTMLSpanElement; list: HTMLDivElement } | null = null;

let _unseen = false;

function buildIntentBlock() {
  const section = el('section', 'visions-intent');
  section.append(el('h2', 'visions-intent-title', 'Intent'));
  const list = el('div', 'visions-intent-list');
  section.append(list);
  _intentUI = { list };
  return section;
}

function buildIntentRow(row: IntentRow) {
  const item = el('div', 'visions-intent-item');
  const head = el('div', 'visions-intent-head');

  head.append(el('span', 'visions-intent-scope', row.label), el('span', 'visions-intent-meta', row.meta));
  const statement = el('p', 'visions-intent-text', row.text);
  statement.classList.toggle('visions-intent-none', !row.hasText);
  item.classList.toggle('visions-intent-active', row.active === true);
  item.append(head, statement);
  return item;
}

function renderIntent() {
  if (!_intentUI) return;
  _intentUI.list.replaceChildren(...intentRows(_intent, _projectNames).map(buildIntentRow));
}

export function setVisionsProjectNames(namesById: unknown) {
  _projectNames = namesById instanceof Map ? namesById : new Map();
  renderIntent();
}

function buildSection(section: VisionsSection) {
  const wrap = el('section', 'visions-doc');
  const head = el('div', 'visions-doc-head');

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

function buildHandBanner(hand: string) {
  const banner = el('div', 'visions-hand');
  banner.textContent = visionsHandText(hand);
  return banner;
}

function buildCommentCard(comment: VisionsComment) {
  const card = el('div', 'visions-comment');
  const head = el('div', 'visions-comment-head');
  head.append(el('span', 'visions-comment-chip', 'visions'));
  head.append(el('span', 'visions-comment-line', commentLineLabel(comment)));
  card.append(head);

  const message = el('p', 'visions-comment-message');
  message.textContent = comment?.message == null ? '' : String(comment.message);
  card.append(message);
  return card;
}

function buildFindingRow(finding: VisionsFinding) {
  const row = el('div', 'visions-finding');
  row.append(el('span', 'visions-finding-line', findingLineLabel(finding)));
  const code = finding?.code == null ? '' : String(finding.code);
  if (code) row.append(el('span', 'visions-finding-code', code));

  const message = el('span', 'visions-finding-message');
  message.textContent = finding?.message == null ? '' : String(finding.message);
  row.append(message);
  return row;
}

function render({ force = false }: { force?: boolean } = {}) {
  if (!_feed) return;
  if (!force && isPanelHidden(_root)) return;
  _feed.textContent = '';
  const sections = visionsSections(_findingsByUri, _commentsByUri, _handsByUri);

  if (sections.length === 0) {
    const empty = el('p', 'visions-empty', VISIONS_EMPTY_TEXT);
    if (_isEnabled === false) {
      const link = createSettingsLink('lanes-visions', 'visions-enabled', 'Enable Visions');
      empty.append(document.createTextNode(' '), link);
    }
    _feed.append(empty);
    return;
  }
  for (const section of sections) _feed.append(buildSection(section));
}

export function applyVisionsSettings(settings: unknown) {
  _isEnabled = (settings as { visions?: { enabled?: unknown } } | null | undefined)?.visions?.enabled === true;
  render();
}

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

function buildActivityRow(event: ActivityEvent, now: number) {
  const row = el('div', 'visions-activity-row');
  row.append(el('span', 'visions-activity-source', activitySourceLabel(event.source)));
  row.append(el('span', 'visions-activity-age', activityAgeText(event.ts, now)));
  row.append(el('span', 'visions-activity-scope', activityScopeText(event)));

  const summary = el('span', 'visions-activity-summary');
  summary.textContent = event.summary;
  row.append(summary);
  return row;
}

function renderActivity({ force = false }: { force?: boolean } = {}) {
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

function buildFixRow(entry: VisionsFixEntry) {
  const row = el('div', 'visions-fix-row');
  row.dataset.applied = entry.applied ? 'yes' : 'no';

  const file = el('span', 'visions-fix-file');
  file.textContent = basenameOfUri(entry.uri) || entry.uri;
  file.title = entry.uri;
  row.append(file);
  row.append(el('span', 'visions-fix-line', fixLineLabel(entry)));
  row.append(el('span', 'visions-fix-outcome', fixOutcomeText(entry)));
  row.append(el('span', 'visions-fix-code', entry.code || ''));

  const message = el('span', 'visions-fix-message');
  message.textContent = entry.message;
  row.append(message);
  return row;
}

function renderFixes({ force = false }: { force?: boolean } = {}) {
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
  _activityCallback(decideVisionsAttention({ unseen: _unseen, handCount: totalHandCount(_handsByUri) }));
}

function noteArrival(arrived: boolean) {
  if (!arrived) return;
  if (!isPanelHidden(_root)) return;
  _unseen = true;
}

export function setVisionsActivityCallback(callback: (level: string | null) => void) {
  _activityCallback = callback;
  refreshActivity();
}

export function mountVisionsView(parent: HTMLElement) {
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

export function refreshVisionsView() {
  _unseen = false;
  refreshActivity();
  renderIntent();
  render({ force: true });
  renderFixes({ force: true });
  renderActivity({ force: true });
}

export function applyVisionsFix(msg: VisionsMessage) {
  _fixEntries = applyFixMessage(_fixEntries, msg);
  noteArrival(hasFix(msg));
  renderFixes();
  refreshActivity();
}

export function applyVisionsFindings(msg: VisionsMessage) {
  _findingsByUri = applyFindingsMessage(_findingsByUri, msg);
  noteArrival(hasFindings(msg));
  render();
  refreshActivity();
}

export function applyVisionsComments(msg: VisionsMessage) {
  _commentsByUri = applyCommentsMessage(_commentsByUri, msg);
  noteArrival(hasComments(msg));
  render();
  refreshActivity();
}

export function applyVisionsHand(msg: VisionsMessage) {
  _handsByUri = applyHandMessage(_handsByUri, msg);
  noteArrival(hasHand(msg));
  render();
  refreshActivity();
}

export function applyVisionsIntent(msg: VisionsMessage) {
  const next = applyIntentMessage(_intent, msg);
  const moved = hasIntentStateChanged(_intent, next);
  _intent = next;
  noteArrival(moved);
  renderIntent();
  refreshActivity();
}

export function applyIngestActivity(msg: VisionsMessage) {
  _activityEvents = applyActivityMessage(_activityEvents, msg);
  _activityOverflow = activityOverflowCount(msg);
  noteArrival(hasActivity(msg));
  renderActivity();
  refreshActivity();
}

export function applyIngestSnapshot(msg: VisionsMessage) {
  _activityEvents = applyActivitySnapshot(msg);
  _activityOverflow = 0;
  noteArrival(_activityEvents.length > 0);
  renderActivity();
  refreshActivity();
}

export function applyVisionsSnapshot(msg: VisionsMessage) {
  _findingsByUri = applyFindingsSnapshot(msg);
  _commentsByUri = applyCommentsSnapshot(msg);
  _handsByUri = applyHandSnapshot(msg);
  _intent = intentStateOfMessage(msg);
  _fixEntries = applyFixSnapshot(msg);
  noteArrival(totalFindingCount(_findingsByUri) + totalCommentCount(_commentsByUri) + totalHandCount(_handsByUri) > 0);
  renderIntent();
  render();
  renderFixes();
  refreshActivity();
}
