import { VISIONS_THREAD_ID_PATTERN } from '#shared/visions-intent-ids.ts';

export const VISIONS_EMPTY_TEXT = 'No findings. Open a markdown file in a connected editor.';

export const VISIONS_INTENT_EMPTY_TEXT = 'No intent yet. The visions proposes one after its first pass.';

// The list a uri no configured project owns lands in. It is never read into a project's prompt.
export const VISIONS_INTENT_UNOWNED_LABEL = 'Unowned';

export interface IntentThread {
  id: string | null;
  text: string;
  uris: string[];
  ts: number;
  hits: number;
}

export interface IntentState {
  byProject: Record<string, IntentThread[]>;
  unowned: IntentThread[];
}

export interface IntentRow {
  key: string;
  label: string;
  text: string;
  hasText: boolean;
  active: boolean;
  meta: string;
}

export interface VisionsFinding {
  range?: { start?: { line?: unknown; character?: unknown } };
  message?: unknown;
  code?: unknown;
  severity?: unknown;
}

export interface VisionsComment {
  line?: unknown;
  message?: unknown;
  text?: unknown;
}

export interface VisionsSection {
  uri: string;
  name: string;
  hand: string | null;
  findings: VisionsFinding[];
  comments: VisionsComment[];
}

export interface VisionsFixEntry {
  uri: string;
  code: string;
  line: number;
  message: string;
  applied: boolean;
  ts: number;
}

export interface ActivityEvent {
  seq: number;
  source: string;
  kind: string;
  ts: number;
  summary: string;
  root: string | null;
  sessionId: string | null;
}

const THREAD_ID_RE = new RegExp(`^${VISIONS_THREAD_ID_PATTERN}$`);

export function emptyIntentState(): IntentState {
  return { byProject: {}, unowned: [] };
}

export function normalizeIntentThread(rawThread: unknown): IntentThread | null {
  if (!rawThread || typeof rawThread !== 'object') return null;
  const raw = rawThread as { id?: unknown; text?: unknown; uris?: unknown; ts?: unknown; hits?: unknown };
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!text) return null;
  const ts = Number(raw.ts);
  const hits = Number(raw.hits);
  return {
    id: typeof raw.id === 'string' && THREAD_ID_RE.test(raw.id) ? raw.id : null,
    text,
    uris: Array.isArray(raw.uris) ? (raw.uris as unknown[]).filter((uri): uri is string => typeof uri === 'string' && uri !== '') : [],
    ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
    hits: Number.isInteger(hits) && hits > 0 ? hits : 1,
  };
}

// A thread list, or a single pre-thread slot lifted into one thread; junk reads as no threads.
function threadsOf(raw: unknown): IntentThread[] {
  if (Array.isArray(raw)) return (raw as unknown[]).map(normalizeIntentThread).filter((thread): thread is IntentThread => thread !== null);
  const lifted = normalizeIntentThread(raw);
  return lifted ? [lifted] : [];
}

// Tolerant of both slot shapes: a tab that outlives a server update reads them as one thread each.
export function intentStateOfMessage(msg: { intent?: unknown } | null | undefined): IntentState {
  const rawIntent = msg?.intent;
  if (!rawIntent || typeof rawIntent !== 'object') return emptyIntentState();
  const raw = rawIntent as { byProject?: unknown; unowned?: unknown; global?: unknown };
  const isKeyed = Object.hasOwn(raw, 'byProject') || Object.hasOwn(raw, 'unowned') || Object.hasOwn(raw, 'global');
  if (!isKeyed) return { byProject: {}, unowned: threadsOf(raw) };
  const rawByProject = (raw.byProject && typeof raw.byProject === 'object' ? raw.byProject : {}) as Record<string, unknown>;
  const entries: [string, IntentThread[]][] = [];
  for (const [projectId, value] of Object.entries(rawByProject)) {
    const threads = threadsOf(value);
    if (threads.length === 0 || !projectId) continue;
    entries.push([projectId, threads]);
  }
  return { byProject: Object.fromEntries(entries), unowned: threadsOf(Object.hasOwn(raw, 'unowned') ? raw.unowned : raw.global) };
}

// The wire names the active thread; a payload that names none (the snapshot path) leaves the first one
// active, which is the order every sender already sends.
function activeFirst(threads: IntentThread[], active: unknown): IntentThread[] {
  const activeId = typeof (active as { id?: unknown } | null | undefined)?.id === 'string' ? (active as { id: string }).id : null;
  if (!activeId) return threads;
  const index = threads.findIndex((thread) => thread.id === activeId);
  if (index <= 0) return threads;
  return [threads[index], ...threads.slice(0, index), ...threads.slice(index + 1)];
}

// One project moved: its whole list arrives, active first. An empty list is a project with nothing left.
export function applyIntentMessage(state: IntentState | null | undefined, msg: { intent?: unknown; projectId?: unknown } | null | undefined): IntentState {
  const current = state || emptyIntentState();
  const rawIntent = msg?.intent;
  if (!rawIntent || typeof rawIntent !== 'object') return current;
  const raw = rawIntent as { threads?: unknown; active?: unknown };
  const threads = activeFirst(Array.isArray(raw.threads) ? threadsOf(raw.threads) : threadsOf(raw), raw.active);
  const projectId = typeof msg?.projectId === 'string' && msg.projectId ? msg.projectId : null;
  if (!projectId) return { byProject: { ...current.byProject }, unowned: threads };
  const byProject = { ...current.byProject };
  if (threads.length === 0) delete byProject[projectId];
  if (threads.length > 0) byProject[projectId] = threads;
  return { byProject, unowned: current.unowned };
}

export function intentProjectLabel(projectId: string, namesById: Map<string, string> | null = null) {
  const name = namesById && typeof namesById.get === 'function' ? namesById.get(projectId) : null;
  return typeof name === 'string' && name ? name : projectId;
}

function threadRows(threads: IntentThread[], { key, label, now }: { key: string; label: string; now: number }): IntentRow[] {
  return threads.map((thread, index) => ({
    key: `${key}:${thread.id || index}`,
    label,
    text: thread.text,
    hasText: true,
    active: index === 0,
    meta: intentMetaText(thread, now),
  }));
}

// One row per live thread, the active one first inside its project, projects by name.
export function intentRows(state: IntentState | null | undefined, namesById: Map<string, string> | null = null, now = Date.now()): IntentRow[] {
  const current = state || emptyIntentState();
  const projects = Object.entries(current.byProject || {})
    .filter(([projectId, threads]) => projectId && Array.isArray(threads) && threads.length > 0)
    .map(([projectId, threads]) => ({ projectId, label: intentProjectLabel(projectId, namesById), threads }))
    .sort((left, right) => left.label.localeCompare(right.label))
    .flatMap(({ projectId, label, threads }) => threadRows(threads, { key: projectId, label, now }));
  const unowned = threadRows(Array.isArray(current.unowned) ? current.unowned : [], {
    key: 'unowned', label: VISIONS_INTENT_UNOWNED_LABEL, now,
  });
  if (projects.length + unowned.length > 0) return [...unowned, ...projects];
  return [{
    key: 'unowned', label: VISIONS_INTENT_UNOWNED_LABEL, text: VISIONS_INTENT_EMPTY_TEXT, hasText: false, active: false, meta: '',
  }];
}

export function intentSourceText(intent: { text?: unknown } | null | undefined) {
  if (!intent?.text) return '';
  return 'proposed by visions';
}

// Coarse on purpose: the statement is a living belief, so the question is whether it is minutes or
// days old, never how many seconds.
export function intentAgeText(ts: unknown, now: number = Date.now()) {
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

export function intentMetaText(intent: Partial<IntentThread> | null | undefined, now = Date.now()) {
  const source = intentSourceText(intent);
  if (!source) return '';
  const thread = typeof intent?.id === 'string' && intent.id ? `thread ${intent.id}, ` : '';
  const age = intentAgeText(intent?.ts, now);
  if (!age) return `${thread}${source}`;
  return `${thread}${source}, ${age}`;
}

function intentSignature(state: IntentState | null | undefined) {
  return intentRows(state, null, 0).map((row) => `${row.key}\u0000${row.text}\u0000${row.hasText}\u0000${row.active}`).join('\u0001');
}

export function hasIntentStateChanged(previous: IntentState | null | undefined, next: IntentState | null | undefined) {
  return intentSignature(previous) !== intentSignature(next);
}

// LSP counts lines from zero; editors and carbon units count from one.
export function findingLineLabel(finding: VisionsFinding | null | undefined) {
  const line = Number(finding?.range?.start?.line);
  if (!Number.isFinite(line) || line < 0) return 'L?';
  return `L${Math.floor(line) + 1}`;
}

function characterOf(finding: VisionsFinding | null | undefined) {
  const character = Number(finding?.range?.start?.character);
  return Number.isFinite(character) ? character : 0;
}

function lineOf(finding: VisionsFinding | null | undefined) {
  const line = Number(finding?.range?.start?.line);
  return Number.isFinite(line) ? line : 0;
}

// A file uri carries percent escapes (a Windows drive colon, a space in a path), so the tab shows the
// decoded name and keeps the raw uri for the title attribute.
export function basenameOfUri(uri: unknown) {
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

function boundedCount(count: unknown) {
  return typeof count === 'number' && Number.isFinite(count) ? Math.max(Math.floor(count), 0) : 0;
}

export function findingCountText(count: unknown) {
  const total = boundedCount(count);
  return total === 1 ? '1 finding' : `${total} findings`;
}

export function commentCountText(count: unknown) {
  const total = boundedCount(count);
  return total === 1 ? '1 comment' : `${total} comments`;
}

// One head line for a section, omitting quiet kinds rather than padding with zeroes.
// Only the three counted fields are read, so a partly-built section can still be counted.
export function sectionCountText(section: Partial<VisionsSection> | null | undefined) {
  const findings = boundedCount(section?.findings?.length);
  const comments = boundedCount(section?.comments?.length);
  const hand = typeof section?.hand === 'string' && section.hand ? 1 : 0;
  const parts: string[] = [];
  if (hand > 0) parts.push('raised hand');
  if (findings > 0) parts.push(findingCountText(findings));
  if (comments > 0) parts.push(commentCountText(comments));
  if (parts.length > 0) return parts.join(', ');
  return findingCountText(0);
}

export function visionsHandText(hand: unknown) {
  const text = typeof hand === 'string' ? hand.trim() : '';
  if (!text) return '';
  return `Raised hand: ${text}`;
}

export function handOfMessage(msg: { hand?: unknown } | null | undefined) {
  const hand = typeof msg?.hand === 'string' ? msg.hand.trim() : '';
  return hand || null;
}

export function hasHand(msg: { hand?: unknown } | null | undefined) {
  return handOfMessage(msg) !== null;
}

export function applyHandMessage(handsByUri: Map<string, string>, msg: { uri?: unknown; hand?: unknown } | null | undefined) {
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

export function applyHandSnapshot(msg: { documents?: unknown } | null | undefined) {
  const next = new Map<string, string>();
  const documents: { uri?: unknown; hand?: unknown }[] = Array.isArray(msg?.documents) ? msg.documents : [];
  for (const document of documents) {
    const uri = typeof document?.uri === 'string' ? document.uri : '';
    const hand = typeof document?.hand === 'string' ? document.hand.trim() : '';
    if (!uri || !hand) continue;
    next.set(uri, hand);
  }
  return next;
}

export function totalHandCount(handsByUri: Map<string, string>) {
  return handsByUri.size;
}

export const VISIONS_ATTENTION_HAND = 'hand';
export const VISIONS_ATTENTION_UNSEEN = 'unseen';

/*
 * What the Visions tab is asking of the operator, as one level rather than one boolean.
 *
 * A raised hand outranks unseen arrivals and, unlike them, is a STANDING condition rather than an
 * arrival: it survives the panel being looked at and clears only when the lane lowers it. Sharing one
 * dot meant the rarest thing the lane produces looked exactly like the noisiest (an ingest activity
 * row), which is how a hand went unnoticed on a tab nobody was watching.
 */
export function decideVisionsAttention({ unseen = false, handCount = 0 }: { unseen?: boolean; handCount?: number } = {}) {
  if (handCount > 0) return VISIONS_ATTENTION_HAND;
  if (unseen) return VISIONS_ATTENTION_UNSEEN;
  return null;
}

export function commentLineLabel(comment: VisionsComment | null | undefined) {
  const line = Number(comment?.line);
  if (!Number.isFinite(line) || line < 1) return 'L?';
  return `L${Math.floor(line)}`;
}

export function diagnosticsOfMessage(msg: { diagnostics?: unknown } | null | undefined): VisionsFinding[] {
  return Array.isArray(msg?.diagnostics) ? msg.diagnostics : [];
}

export function hasFindings(msg: { diagnostics?: unknown } | null | undefined) {
  return diagnosticsOfMessage(msg).length > 0;
}

// One per-uri broadcast applied to the standing map. An empty array clears that uri rather than storing
// an empty section, so "in the map" and "has a section" stay the same statement.
export function applyFindingsMessage(findingsByUri: Map<string, VisionsFinding[]>, msg: { uri?: unknown; diagnostics?: unknown } | null | undefined) {
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

export function commentsOfMessage(msg: { comments?: unknown } | null | undefined): VisionsComment[] {
  return Array.isArray(msg?.comments) ? msg.comments : [];
}

export function hasComments(msg: { comments?: unknown } | null | undefined) {
  return commentsOfMessage(msg).length > 0;
}

// The model comments for one uri, replaced whole by each dispatch. Empty clears that uri, exactly as
// an empty findings push does, so the map and the rendered sections stay the same statement.
export function applyCommentsMessage(commentsByUri: Map<string, VisionsComment[]>, msg: { uri?: unknown; comments?: unknown } | null | undefined) {
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
export function applyFindingsSnapshot(msg: { documents?: unknown } | null | undefined) {
  const next = new Map<string, VisionsFinding[]>();
  const documents: { uri?: unknown; diagnostics?: unknown }[] = Array.isArray(msg?.documents) ? msg.documents : [];
  for (const document of documents) {
    const uri = typeof document?.uri === 'string' ? document.uri : '';
    const diagnostics: VisionsFinding[] = Array.isArray(document?.diagnostics) ? document.diagnostics : [];
    if (!uri || diagnostics.length === 0) continue;
    next.set(uri, diagnostics);
  }
  return next;
}

// The same repair for the comments half of the snapshot; the frame carries both, so each half reads
// the field it owns and a document that has only one kind still earns a section.
export function applyCommentsSnapshot(msg: { documents?: unknown } | null | undefined) {
  const next = new Map<string, VisionsComment[]>();
  const documents: { uri?: unknown; comments?: unknown }[] = Array.isArray(msg?.documents) ? msg.documents : [];
  for (const document of documents) {
    const uri = typeof document?.uri === 'string' ? document.uri : '';
    const comments: VisionsComment[] = Array.isArray(document?.comments) ? document.comments : [];
    if (!uri || comments.length === 0) continue;
    next.set(uri, comments);
  }
  return next;
}

export function totalFindingCount(findingsByUri: Map<string, VisionsFinding[]>) {
  let total = 0;
  for (const diagnostics of findingsByUri.values()) total += diagnostics.length;
  return total;
}

export function totalCommentCount(commentsByUri: Map<string, VisionsComment[]>) {
  let total = 0;
  for (const comments of commentsByUri.values()) total += comments.length;
  return total;
}

// Sections by file name, with full uri as the tie-breaker so order is stable across repaints.
export function visionsSections(
  findingsByUri: Map<string, VisionsFinding[]>,
  commentsByUri: Map<string, VisionsComment[]> = new Map(),
  handsByUri: Map<string, string> = new Map()
): VisionsSection[] {
  const sections: VisionsSection[] = [];
  const uris = new Set([...findingsByUri.keys(), ...commentsByUri.keys(), ...handsByUri.keys()]);
  for (const uri of uris) {
    const diagnostics = findingsByUri.get(uri);
    const comments = commentsByUri.get(uri);
    const hand = handsByUri.get(uri) || null;
    const findings: VisionsFinding[] = Array.isArray(diagnostics) ? diagnostics : [];
    const modelComments: VisionsComment[] = Array.isArray(comments) ? comments : [];
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

function compareText(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// ── Tier 1 fix changelog (docs/archive/plan-navigator-2.md, M6) ───────
// What the lane actually touched, applied and refused alike. A refused edit is as much of an audit line
// as an applied one: it says the lane tried and the buffer had already moved.

export const VISIONS_FIXES_EMPTY_TEXT = 'No fixes yet. Silent fixes appear here once the lane applies or is refused one.';
// Must agree with DEFAULT_FIX_LOG_MAX in server/core/visions-fix-core.ts (CJS/ESM split forbids one import).
export const MAX_RENDERED_FIXES = 20;

export function fixCountText(count: unknown) {
  const total = boundedCount(count);
  return total === 1 ? '1 fix' : `${total} fixes`;
}

// Zero-based on the wire like the diagnostic it came from, one-based here like every other line label.
export function fixLineLabel(entry: { line?: unknown } | null | undefined) {
  const line = Number(entry?.line);
  if (!Number.isFinite(line) || line < 0) return 'L?';
  return `L${Math.floor(line) + 1}`;
}

export function fixOutcomeText(entry: { applied?: unknown } | null | undefined) {
  return entry?.applied === true ? 'applied' : 'refused';
}

// One entry, however it arrived: the per-fix broadcast splits uri and ts off the fix, the snapshot ring
// carries whole records. Anything without a message is not a line this list can show.
export function normalizeFixEntry(rawEntry: unknown, { uri = '', ts = 0 }: { uri?: string; ts?: number } = {}): VisionsFixEntry | null {
  if (!rawEntry || typeof rawEntry !== 'object') return null;
  const raw = rawEntry as { message?: unknown; line?: unknown; ts?: unknown; uri?: unknown; code?: unknown; applied?: unknown };
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

export function fixEntryOfMessage(msg: { uri?: unknown; ts?: unknown; fix?: unknown } | null | undefined) {
  const uri = typeof msg?.uri === 'string' ? msg.uri : '';
  const ts = Number(msg?.ts);
  return normalizeFixEntry(msg?.fix, { uri, ts: Number.isFinite(ts) ? ts : 0 });
}

export function hasFix(msg: { uri?: unknown; ts?: unknown; fix?: unknown } | null | undefined) {
  return fixEntryOfMessage(msg) !== null;
}

// Newest first, and capped: the server ring is already bounded, so this only keeps the two agreeing.
export function applyFixMessage(
  entries: VisionsFixEntry[],
  msg: { uri?: unknown; ts?: unknown; fix?: unknown } | null | undefined,
  { max = MAX_RENDERED_FIXES }: { max?: number } = {}
) {
  const entry = fixEntryOfMessage(msg);
  if (!entry) return [...entries];
  return [entry, ...entries].slice(0, Math.max(0, Math.floor(max)));
}

// Connect-time repair: the server's ring REPLACES this tab's list, in the order the server keeps it.
export function applyFixSnapshot(msg: { fixes?: unknown } | null | undefined, { max = MAX_RENDERED_FIXES }: { max?: number } = {}) {
  const raw: unknown[] = Array.isArray(msg?.fixes) ? msg.fixes : [];
  const entries: VisionsFixEntry[] = [];
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

const SOURCE_LABELS: Record<string, string> = {
  terminal: 'terminal',
  agentLogs: 'agent',
  git: 'git',
  fs: 'files',
  shellHistory: 'shell',
  editor: 'editor',
};

export function activitySourceLabel(source: unknown) {
  const name = typeof source === 'string' ? source : '';
  return SOURCE_LABELS[name] || name || 'source';
}

// Seconds matter here in a way they never do for the intent statement: a terminal event is interesting
// precisely because it just happened.
export function activityAgeText(ts: unknown, now: number = Date.now()) {
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
export function normalizeActivityEvent(rawEvent: unknown): ActivityEvent | null {
  if (!rawEvent || typeof rawEvent !== 'object') return null;
  const raw = rawEvent as { seq?: unknown; summary?: unknown; ts?: unknown; scope?: unknown; source?: unknown; kind?: unknown };
  const seq = Number(raw.seq);
  if (!Number.isFinite(seq)) return null;
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) return null;
  const ts = Number(raw.ts);
  const scope = (raw.scope && typeof raw.scope === 'object' ? raw.scope : {}) as { root?: unknown; sessionId?: unknown };
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

export function eventsOfMessage(msg: { events?: unknown } | null | undefined): ActivityEvent[] {
  const raw: unknown[] = Array.isArray(msg?.events) ? msg.events : [];
  const events: ActivityEvent[] = [];
  for (const entry of raw) {
    const event = normalizeActivityEvent(entry);
    if (event) events.push(event);
  }
  return events;
}

export function activityOverflowCount(msg: { overflow?: unknown } | null | undefined) {
  const overflow = Number(msg?.overflow);
  if (!Number.isFinite(overflow) || overflow <= 0) return 0;
  return Math.floor(overflow);
}

// The frame said more happened than it carried. Everything the count stands for is still on the server,
// so the wording says what was skipped rather than implying anything was lost.
export function activityOverflowText(count: unknown) {
  const total = boundedCount(count);
  if (total <= 0) return '';
  if (total === 1) return '1 more event not shown';
  return `${total} more events not shown`;
}

function sortedAndCapped(events: ActivityEvent[], max: number) {
  return [...events]
    .sort((left, right) => right.seq - left.seq)
    .slice(0, Math.max(0, Math.floor(max)));
}

/**
 * One batched delta merged into the standing list: newest first, deduped by seq (a snapshot and a
 * delta can legitimately carry the same event), and capped so the rendered list stays bounded no matter
 * how long the tab is left open.
 */
export function applyActivityMessage(
  events: ActivityEvent[],
  msg: { events?: unknown } | null | undefined,
  { max = MAX_RENDERED_ACTIVITY }: { max?: number } = {}
) {
  const arriving = eventsOfMessage(msg);
  if (arriving.length === 0) return sortedAndCapped(events, max);
  const bySeq = new Map<number, ActivityEvent>();
  for (const event of events) bySeq.set(event.seq, event);
  for (const event of arriving) bySeq.set(event.seq, event);
  return sortedAndCapped([...bySeq.values()], max);
}

// Connect-time repair: the server's current rings REPLACE this tab's list rather than merging into it,
// so an event evicted while the tab was away disappears instead of lingering.
export function applyActivitySnapshot(msg: { events?: unknown } | null | undefined, { max = MAX_RENDERED_ACTIVITY }: { max?: number } = {}) {
  return sortedAndCapped(eventsOfMessage(msg), max);
}

export function hasActivity(msg: { events?: unknown } | null | undefined) {
  return eventsOfMessage(msg).length > 0;
}

export function activityCountText(count: unknown) {
  const total = boundedCount(count);
  return total === 1 ? '1 event' : `${total} events`;
}

// An event with no root belongs to no project (shell history is the source that can never know one), and
// the row says so rather than letting a reader assume this project produced it.
// Only the root is read, so a caller holding a partly-built row (or a scope alone) can label it.
export function activityScopeText(event: Pick<ActivityEvent, 'root'> | null | undefined) {
  if (!event?.root) return 'machine';
  const root = event.root.replace(/[\\/]+$/, '');
  const lastSeparator = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'));
  return lastSeparator === -1 ? root : root.slice(lastSeparator + 1);
}
