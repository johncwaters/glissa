export const VISIONS_EMPTY_TEXT = 'No findings. Open a markdown file in a connected editor.';

export const VISIONS_INTENT_EMPTY_TEXT = 'No intent yet. The visions proposes one after its first pass.';

export function emptyIntent() {
  return { text: '', source: null, ts: 0 };
}

export function intentOfMessage(msg) {
  const raw = msg?.intent;
  if (!raw || typeof raw !== 'object') return emptyIntent();
  const text = typeof raw.text === 'string' ? raw.text : '';
  const ts = Number(raw.ts);
  return {
    text,
    source: raw.source === 'model' ? raw.source : null,
    ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
  };
}

export function intentSourceText(intent) {
  if (!intent?.text) return '';
  return 'proposed by visions';
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

export function hasIntentChanged(previous, next) {
  const before = previous || emptyIntent();
  const after = next || emptyIntent();
  return before.text !== after.text || before.source !== after.source;
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

// One head line for a section, omitting quiet kinds rather than padding with zeroes.
export function sectionCountText(section) {
  const findings = boundedCount(section?.findings?.length);
  const comments = boundedCount(section?.comments?.length);
  const hand = typeof section?.hand === 'string' && section.hand ? 1 : 0;
  const parts = [];
  if (hand > 0) parts.push('raised hand');
  if (findings > 0) parts.push(findingCountText(findings));
  if (comments > 0) parts.push(commentCountText(comments));
  if (parts.length > 0) return parts.join(', ');
  return findingCountText(0);
}

export function visionsHandText(hand) {
  const text = typeof hand === 'string' ? hand.trim() : '';
  if (!text) return '';
  return `Raised hand: ${text}`;
}

export function handOfMessage(msg) {
  const hand = typeof msg?.hand === 'string' ? msg.hand.trim() : '';
  return hand || null;
}

export function hasHand(msg) {
  return handOfMessage(msg) !== null;
}

export function applyHandMessage(handsByUri, msg) {
  const next = new Map(handsByUri);
  const uri = typeof msg?.uri === 'string' ? msg.uri : '';
  if (!uri) return next;
  const hand = handOfMessage(msg);
  if (!hand) {
    next.delete(uri);
    return next;
  }
  next.set(uri, hand);
  return next;
}

export function applyHandSnapshot(msg) {
  const next = new Map();
  const documents = Array.isArray(msg?.documents) ? msg.documents : [];
  for (const document of documents) {
    const uri = typeof document?.uri === 'string' ? document.uri : '';
    const hand = typeof document?.hand === 'string' ? document.hand.trim() : '';
    if (!uri || !hand) continue;
    next.set(uri, hand);
  }
  return next;
}

export function totalHandCount(handsByUri) {
  return handsByUri.size;
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

// Sections by file name, with full uri as the tie-breaker so order is stable across repaints.
export function visionsSections(findingsByUri, commentsByUri = new Map(), handsByUri = new Map()) {
  const sections = [];
  const uris = new Set([...findingsByUri.keys(), ...commentsByUri.keys(), ...handsByUri.keys()]);
  for (const uri of uris) {
    const diagnostics = findingsByUri.get(uri);
    const comments = commentsByUri.get(uri);
    const hand = handsByUri.get(uri) || null;
    const findings = Array.isArray(diagnostics) ? diagnostics : [];
    const modelComments = Array.isArray(comments) ? comments : [];
    if (findings.length === 0 && modelComments.length === 0 && !hand) continue;
    sections.push({
      uri,
      name: basenameOfUri(uri) || uri,
      hand,
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

// ── Tier 1 fix changelog (docs/archive/plan-navigator-2.md, M6) ───────
// What the lane actually touched, applied and refused alike. A refused edit is as much of an audit line
// as an applied one: it says the lane tried and the buffer had already moved.

export const VISIONS_FIXES_EMPTY_TEXT = 'No fixes yet. Silent fixes appear here once the lane applies or is refused one.';
// Must agree with DEFAULT_FIX_LOG_MAX in server/core/visions-fix-core.js (CJS/ESM split forbids one import).
export const MAX_RENDERED_FIXES = 20;

export function fixCountText(count) {
  const total = boundedCount(count);
  return total === 1 ? '1 fix' : `${total} fixes`;
}

// Zero-based on the wire like the diagnostic it came from, one-based here like every other line label.
export function fixLineLabel(entry) {
  const line = Number(entry?.line);
  if (!Number.isFinite(line) || line < 0) return 'L?';
  return `L${Math.floor(line) + 1}`;
}

export function fixOutcomeText(entry) {
  return entry?.applied === true ? 'applied' : 'refused';
}

// One entry, however it arrived: the per-fix broadcast splits uri and ts off the fix, the snapshot ring
// carries whole records. Anything without a message is not a line this list can show.
export function normalizeFixEntry(raw, { uri = '', ts = 0 } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const message = typeof raw.message === 'string' ? raw.message.trim() : '';
  if (!message) return null;
  const line = Number(raw.line);
  const stamp = Number(raw.ts ?? ts);
  return {
    uri: typeof raw.uri === 'string' && raw.uri ? raw.uri : uri,
    code: typeof raw.code === 'string' ? raw.code : '',
    line: Number.isFinite(line) && line > 0 ? Math.floor(line) : 0,
    message,
    applied: raw.applied === true,
    ts: Number.isFinite(stamp) && stamp > 0 ? stamp : 0,
  };
}

export function fixEntryOfMessage(msg) {
  const uri = typeof msg?.uri === 'string' ? msg.uri : '';
  const ts = Number(msg?.ts);
  return normalizeFixEntry(msg?.fix, { uri, ts: Number.isFinite(ts) ? ts : 0 });
}

export function hasFix(msg) {
  return fixEntryOfMessage(msg) !== null;
}

// Newest first, and capped: the server ring is already bounded, so this only keeps the two agreeing.
export function applyFixMessage(entries, msg, { max = MAX_RENDERED_FIXES } = {}) {
  const entry = fixEntryOfMessage(msg);
  if (!entry) return [...entries];
  return [entry, ...entries].slice(0, Math.max(0, Math.floor(max)));
}

// Connect-time repair: the server's ring REPLACES this tab's list, in the order the server keeps it.
export function applyFixSnapshot(msg, { max = MAX_RENDERED_FIXES } = {}) {
  const raw = Array.isArray(msg?.fixes) ? msg.fixes : [];
  const entries = [];
  for (const record of raw) {
    const entry = normalizeFixEntry(record);
    if (entry) entries.push(entry);
  }
  return entries.slice(0, Math.max(0, Math.floor(max)));
}

// ── Ingest activity feed (docs/plan-ingestion.md, M6) ─────────
// The cross-source timeline the ingest lane publishes, rendered under the Visions lane's own findings
// because it is the same question from the other side: what the Visions lane can currently see.

export const INGEST_EMPTY_TEXT = 'No activity yet. The ingest lane reports what your sessions and tools are doing.';
// The DOM is bounded, not the rings: the server keeps far more than a scrolling list should ever hold.
export const MAX_RENDERED_ACTIVITY = 100;

const SOURCE_LABELS = {
  terminal: 'terminal',
  agentLogs: 'agent',
  git: 'git',
  fs: 'files',
  shellHistory: 'shell',
  editor: 'editor',
};

export function activitySourceLabel(source) {
  const name = typeof source === 'string' ? source : '';
  return SOURCE_LABELS[name] || name || 'source';
}

// Seconds matter here in a way they never do for the intent statement: a terminal event is interesting
// precisely because it just happened.
export function activityAgeText(ts, now = Date.now()) {
  const stamp = Number(ts);
  if (!Number.isFinite(stamp) || stamp <= 0) return '';
  const seconds = Math.max(0, Math.floor((Number(now) - stamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// One wire event, normalized. Anything without a seq and a summary is not an event this list can order
// or show, so it is dropped rather than rendered as a blank row.
export function normalizeActivityEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const seq = Number(raw.seq);
  if (!Number.isFinite(seq)) return null;
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) return null;
  const ts = Number(raw.ts);
  const scope = raw.scope && typeof raw.scope === 'object' ? raw.scope : {};
  return {
    seq: Math.floor(seq),
    source: typeof raw.source === 'string' ? raw.source : '',
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
    summary,
    root: typeof scope.root === 'string' && scope.root ? scope.root : null,
    sessionId: typeof scope.sessionId === 'string' && scope.sessionId ? scope.sessionId : null,
  };
}

export function eventsOfMessage(msg) {
  const raw = Array.isArray(msg?.events) ? msg.events : [];
  const events = [];
  for (const entry of raw) {
    const event = normalizeActivityEvent(entry);
    if (event) events.push(event);
  }
  return events;
}

export function activityOverflowCount(msg) {
  const overflow = Number(msg?.overflow);
  if (!Number.isFinite(overflow) || overflow <= 0) return 0;
  return Math.floor(overflow);
}

// The frame said more happened than it carried. Everything the count stands for is still on the server,
// so the wording says what was skipped rather than implying anything was lost.
export function activityOverflowText(count) {
  const total = boundedCount(count);
  if (total <= 0) return '';
  if (total === 1) return '1 more event not shown';
  return `${total} more events not shown`;
}

function sortedAndCapped(events, max) {
  return [...events]
    .sort((left, right) => right.seq - left.seq)
    .slice(0, Math.max(0, Math.floor(max)));
}

/**
 * One batched delta merged into the standing list: newest first, deduped by seq (a snapshot and a
 * delta can legitimately carry the same event), and capped so the rendered list stays bounded no matter
 * how long the tab is left open.
 */
export function applyActivityMessage(events, msg, { max = MAX_RENDERED_ACTIVITY } = {}) {
  const arriving = eventsOfMessage(msg);
  if (arriving.length === 0) return sortedAndCapped(events, max);
  const bySeq = new Map();
  for (const event of events) bySeq.set(event.seq, event);
  for (const event of arriving) bySeq.set(event.seq, event);
  return sortedAndCapped([...bySeq.values()], max);
}

// Connect-time repair: the server's current rings REPLACE this tab's list rather than merging into it,
// so an event evicted while the tab was away disappears instead of lingering.
export function applyActivitySnapshot(msg, { max = MAX_RENDERED_ACTIVITY } = {}) {
  return sortedAndCapped(eventsOfMessage(msg), max);
}

export function hasActivity(msg) {
  return eventsOfMessage(msg).length > 0;
}

export function activityCountText(count) {
  const total = boundedCount(count);
  return total === 1 ? '1 event' : `${total} events`;
}

// An event with no root belongs to no project (shell history is the source that can never know one), and
// the row says so rather than letting a reader assume this project produced it.
export function activityScopeText(event) {
  if (!event?.root) return 'machine';
  const root = event.root.replace(/[\\/]+$/, '');
  const lastSeparator = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'));
  return lastSeparator === -1 ? root : root.slice(lastSeparator + 1);
}
