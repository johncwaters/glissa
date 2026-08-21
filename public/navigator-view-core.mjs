// ── Navigator view: pure grouping, ordering and wording ───────
// Every decision the Navigator tab makes about WHICH sections exist, in what order, and what the counts
// read as, so navigator-panel.js is DOM only. No literal em dash, en dash or ellipsis is produced here.

export const NAVIGATOR_EMPTY_TEXT = 'No findings. Open a markdown file in a connected editor.';

// The intent model (docs/plan-navigator.md, M5): one machine-wide statement of what the navigator
// believes is being built. Empty is a first-class state, and the hint says how it stops being empty.
export const NAVIGATOR_INTENT_EMPTY_TEXT = 'No intent yet. The navigator proposes one after its first pass; typing here sets it directly.';
export const NAVIGATOR_INTENT_MAX_CHARS = 300;

export function emptyIntent() {
  return { text: '', source: null, locked: false, ts: 0 };
}

// One intent, however it arrived (its own push or the connect-time snapshot), normalized to the shape
// the panel renders. Anything malformed reads as no intent rather than as a half-rendered one.
export function intentOfMessage(msg) {
  const raw = msg?.intent;
  if (!raw || typeof raw !== 'object') return emptyIntent();
  const text = typeof raw.text === 'string' ? raw.text : '';
  const ts = Number(raw.ts);
  return {
    text,
    source: raw.source === 'operator' || raw.source === 'model' ? raw.source : null,
    locked: raw.locked === true,
    ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
  };
}

// Who the statement belongs to, in the second person, because the correction field is right below it.
export function intentSourceText(intent) {
  if (!intent?.text) return '';
  if (intent.source === 'operator') return 'set by you';
  return 'proposed by navigator';
}

// Coarse on purpose: the statement is a living belief, so the question is whether it is minutes or
// days old, never how many seconds.
export function intentAgeText(ts, now = Date.now()) {
  const stamp = Number(ts);
  if (!Number.isFinite(stamp) || stamp <= 0) return '';
  const minutes = Math.floor(Math.max(0, Number(now) - stamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

export function intentMetaText(intent, now = Date.now()) {
  const source = intentSourceText(intent);
  if (!source) return '';
  const age = intentAgeText(intent?.ts, now);
  if (!age) return source;
  return `${source}, ${age}`;
}

// Whether a push actually moved the statement. The timestamp alone is not a move: the panel repaints
// on this, and repainting for an unchanged statement would fight the field the operator is typing in.
export function hasIntentChanged(previous, next) {
  const before = previous || emptyIntent();
  const after = next || emptyIntent();
  return before.text !== after.text || before.source !== after.source || before.locked !== after.locked;
}

/**
 * Whether the correction field should adopt the standing statement, so a correction is an edit rather
 * than a retype. Never while the field has focus, and never over a draft the operator already started:
 * an intent landing mid-edit must not eat what they typed.
 */
export function shouldAdoptIntentText({ focused = false, currentValue = '', previousText = '', nextText = '' } = {}) {
  if (focused) return false;
  if (currentValue !== previousText) return false;
  return currentValue !== nextText;
}

// LSP counts lines from zero; editors and carbon units count from one.
export function findingLineLabel(finding) {
  const line = Number(finding?.range?.start?.line);
  if (!Number.isFinite(line) || line < 0) return 'L?';
  return `L${Math.floor(line) + 1}`;
}

function characterOf(finding) {
  const character = Number(finding?.range?.start?.character);
  return Number.isFinite(character) ? character : 0;
}

function lineOf(finding) {
  const line = Number(finding?.range?.start?.line);
  return Number.isFinite(line) ? line : 0;
}

// A file uri carries percent escapes (a Windows drive colon, a space in a path), so the tab shows the
// decoded name and keeps the raw uri for the title attribute.
export function basenameOfUri(uri) {
  const text = typeof uri === 'string' ? uri : '';
  if (!text) return '';
  const lastSlash = text.lastIndexOf('/');
  const tail = lastSlash === -1 ? text : text.slice(lastSlash + 1);
  if (!tail) return text;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

function boundedCount(count) {
  return Number.isFinite(count) ? Math.max(Math.floor(count), 0) : 0;
}

export function findingCountText(count) {
  const total = boundedCount(count);
  return total === 1 ? '1 finding' : `${total} findings`;
}

export function commentCountText(count) {
  const total = boundedCount(count);
  return total === 1 ? '1 comment' : `${total} comments`;
}

// One head line for a section that can carry either kind, or both. A kind with nothing in it is left
// out entirely rather than printed as a zero, so the head never pads a quiet document.
export function sectionCountText(section) {
  const findings = boundedCount(section?.findings?.length);
  const comments = boundedCount(section?.comments?.length);
  if (findings > 0 && comments > 0) return `${findingCountText(findings)}, ${commentCountText(comments)}`;
  if (comments > 0) return commentCountText(comments);
  return findingCountText(findings);
}

export function commentLineLabel(comment) {
  const line = Number(comment?.line);
  if (!Number.isFinite(line) || line < 1) return 'L?';
  return `L${Math.floor(line)}`;
}

export function diagnosticsOfMessage(msg) {
  return Array.isArray(msg?.diagnostics) ? msg.diagnostics : [];
}

export function hasFindings(msg) {
  return diagnosticsOfMessage(msg).length > 0;
}

// One per-uri broadcast applied to the standing map. An empty array clears that uri rather than storing
// an empty section, so "in the map" and "has a section" stay the same statement.
export function applyFindingsMessage(findingsByUri, msg) {
  const next = new Map(findingsByUri);
  const uri = typeof msg?.uri === 'string' ? msg.uri : '';
  if (!uri) return next;
  const diagnostics = diagnosticsOfMessage(msg);
  if (diagnostics.length === 0) {
    next.delete(uri);
    return next;
  }
  next.set(uri, diagnostics);
  return next;
}

export function commentsOfMessage(msg) {
  return Array.isArray(msg?.comments) ? msg.comments : [];
}

export function hasComments(msg) {
  return commentsOfMessage(msg).length > 0;
}

// The model comments for one uri, replaced whole by each dispatch. Empty clears that uri, exactly as
// an empty findings push does, so the map and the rendered sections stay the same statement.
export function applyCommentsMessage(commentsByUri, msg) {
  const next = new Map(commentsByUri);
  const uri = typeof msg?.uri === 'string' ? msg.uri : '';
  if (!uri) return next;
  const comments = commentsOfMessage(msg);
  if (comments.length === 0) {
    next.delete(uri);
    return next;
  }
  next.set(uri, comments);
  return next;
}

// The connect-time repair frame: a full replacement, so a uri closed while this tab was disconnected
// disappears instead of lingering.
export function applyFindingsSnapshot(msg) {
  const next = new Map();
  const documents = Array.isArray(msg?.documents) ? msg.documents : [];
  for (const document of documents) {
    const uri = typeof document?.uri === 'string' ? document.uri : '';
    const diagnostics = Array.isArray(document?.diagnostics) ? document.diagnostics : [];
    if (!uri || diagnostics.length === 0) continue;
    next.set(uri, diagnostics);
  }
  return next;
}

// The same repair for the comments half of the snapshot; the frame carries both, so each half reads
// the field it owns and a document that has only one kind still earns a section.
export function applyCommentsSnapshot(msg) {
  const next = new Map();
  const documents = Array.isArray(msg?.documents) ? msg.documents : [];
  for (const document of documents) {
    const uri = typeof document?.uri === 'string' ? document.uri : '';
    const comments = Array.isArray(document?.comments) ? document.comments : [];
    if (!uri || comments.length === 0) continue;
    next.set(uri, comments);
  }
  return next;
}

export function totalFindingCount(findingsByUri) {
  let total = 0;
  for (const diagnostics of findingsByUri.values()) total += diagnostics.length;
  return total;
}

export function totalCommentCount(commentsByUri) {
  let total = 0;
  for (const comments of commentsByUri.values()) total += comments.length;
  return total;
}

// Sections by file name, because that is what the eye scans; the full uri breaks a tie between two files
// of the same name in different directories, so the order is stable across repaints. A document earns a
// section from either half: tier 2 findings, tier 3 comments, or both.
export function navigatorSections(findingsByUri, commentsByUri = new Map()) {
  const sections = [];
  const uris = new Set([...findingsByUri.keys(), ...commentsByUri.keys()]);
  for (const uri of uris) {
    const diagnostics = findingsByUri.get(uri);
    const comments = commentsByUri.get(uri);
    const findings = Array.isArray(diagnostics) ? diagnostics : [];
    const modelComments = Array.isArray(comments) ? comments : [];
    if (findings.length === 0 && modelComments.length === 0) continue;
    sections.push({
      uri,
      name: basenameOfUri(uri) || uri,
      findings: [...findings].sort((a, b) => lineOf(a) - lineOf(b) || characterOf(a) - characterOf(b)),
      comments: [...modelComments].sort((a, b) => (Number(a?.line) || 0) - (Number(b?.line) || 0)),
    });
  }
  sections.sort((a, b) => compareText(a.name, b.name) || compareText(a.uri, b.uri));
  return sections;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
