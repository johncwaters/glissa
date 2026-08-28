/*
 * The intent model as threads (docs/plan-visions-4-focus.md, M20): several live statements per project,
 * each bound to the uris it was advanced on, decaying on read. Pure: ids are minted from content and
 * the clock the caller passes, so a revive or a replay lands the same state.
 */

'use strict';

const crypto = require('node:crypto');

const { VISIONS_THREAD_ID_PATTERN } = require('../../shared/visions-intent-ids');
const { sanitizeOneLine } = require('./text-core');

const MAX_INTENT_CHARS = 300;
const MODEL_SOURCE = 'model';
const LEGACY_OPERATOR_SOURCE = 'operator';
const MAX_THREADS_PER_PROJECT = 5;
const DEFAULT_THREAD_TTL_MS = 72 * 3600000;
// Built from the ONE definition every id check in the lane and in the browser reads, never restated.
const THREAD_ID_PATTERN = VISIONS_THREAD_ID_PATTERN;
const THREAD_ID_RE = new RegExp(`^${THREAD_ID_PATTERN}$`);
const THREAD_ID_HEX_CHARS = 8;
const NEW_THREAD = 'new';
const MAX_THREAD_URIS = 20;
const MAX_THREAD_URI_CHARS = 2048;

/** @typedef {{ id: string, text: string, uris: string[], ts: number, hits: number }} IntentThread */
/** @typedef {{ byProject: Record<string, IntentThread[]>, unowned: IntentThread[] }} IntentState */

/** @returns {IntentState} */
function createIntentState() {
  return { byProject: {}, unowned: [] };
}

function normalizeProjectKey(projectId) {
  return typeof projectId === 'string' && projectId ? projectId : null;
}

// Strings only, and one line by construction: the text is model-authored from an untrusted buffer, so
// an embedded break in it could otherwise read as a Glissa-authored prompt line.
function sanitizeIntentText(raw, { maxChars = MAX_INTENT_CHARS } = {}) {
  if (typeof raw !== 'string') return '';
  return sanitizeOneLine(raw, maxChars);
}

function isThreadId(value) {
  return typeof value === 'string' && THREAD_ID_RE.test(value);
}

function mintThreadId(seed, taken) {
  for (let attempt = 0; ; attempt += 1) {
    const digest = crypto.createHash('sha256').update(`${seed}|${attempt}`, 'utf8').digest('hex');
    const id = `t-${digest.slice(0, THREAD_ID_HEX_CHARS)}`;
    if (!taken.has(id)) return id;
  }
}

// Newest kept and each one bounded: a long-lived thread would otherwise carry every uri it was ever
// advanced on, and every one of them rides every broadcast of that thread.
function sanitizeUris(raw) {
  if (!Array.isArray(raw)) return [];
  const unique = [...new Set(raw.filter((uri) => typeof uri === 'string' && uri && uri.length <= MAX_THREAD_URI_CHARS))];
  return unique.slice(-MAX_THREAD_URIS);
}

// The one uri a single advance may bind, held to the same rules as a stored list: over-long is no uri.
function sanitizeUri(raw) {
  const [uri] = sanitizeUris([raw]);
  return uri || null;
}

function reviveThread(raw, { maxChars = MAX_INTENT_CHARS } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = sanitizeIntentText(raw.text, { maxChars });
  if (!text || !isThreadId(raw.id)) return null;
  if (Object.hasOwn(raw, 'ts') && (!Number.isFinite(raw.ts) || raw.ts < 0)) return null;
  const hits = Number.isInteger(raw.hits) && raw.hits > 0 ? raw.hits : 1;
  return {
    id: raw.id, text, uris: sanitizeUris(raw.uris), ts: Number.isFinite(raw.ts) ? raw.ts : 0, hits,
  };
}

// The M5 slot and the M11 per-project slot, each lifted into one thread so an upgrade keeps the statement.
function reviveLegacySlot(raw, projectKey, { maxChars = MAX_INTENT_CHARS } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = sanitizeIntentText(raw.text, { maxChars });
  if (!text) return null;
  if (raw.source !== MODEL_SOURCE && raw.source !== LEGACY_OPERATOR_SOURCE) return null;
  if (Object.hasOwn(raw, 'ts') && (!Number.isFinite(raw.ts) || raw.ts < 0)) return null;
  const ts = Number.isFinite(raw.ts) ? raw.ts : 0;
  return {
    id: mintThreadId(`${projectKey || ''}|${ts}|${text}`, new Set()), text, uris: [], ts, hits: 1,
  };
}

function reviveThreadList(raw, { maxChars = MAX_INTENT_CHARS } = {}) {
  if (!Array.isArray(raw)) return [];
  const threads = [];
  const seen = new Set();
  for (const entry of raw) {
    const thread = reviveThread(entry, { maxChars });
    if (!thread || seen.has(thread.id)) continue;
    seen.add(thread.id);
    threads.push(thread);
  }
  return threads.slice(0, MAX_THREADS_PER_PROJECT);
}

// Ids are the stable UUIDs ensureProjectIds assigns, so only a deletion orphans a project, never a rename.
function pruneIntentProjects(state, projectIds) {
  const current = state || createIntentState();
  if (!Array.isArray(projectIds)) return current;
  const known = new Set(projectIds.filter((id) => normalizeProjectKey(id)));
  const entries = Object.entries(current.byProject || {}).filter(([projectId]) => known.has(projectId));
  if (entries.length === Object.keys(current.byProject || {}).length) return current;
  return { byProject: Object.fromEntries(entries), unowned: current.unowned };
}

function reviveIntentState(raw, { maxChars = MAX_INTENT_CHARS, projectIds = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createIntentState();
  const isThreaded = Object.hasOwn(raw, 'unowned') || Array.isArray(Object.values(raw.byProject || {})[0]);
  const isScoped = Object.hasOwn(raw, 'global') || Object.hasOwn(raw, 'byProject');
  if (!isThreaded && !isScoped) {
    const lifted = reviveLegacySlot(raw, null, { maxChars });
    return pruneIntentProjects({ byProject: {}, unowned: lifted ? [lifted] : [] }, projectIds);
  }
  const rawByProject = raw.byProject && typeof raw.byProject === 'object' && !Array.isArray(raw.byProject)
    ? raw.byProject
    : {};
  const entries = [];
  for (const [projectId, value] of Object.entries(rawByProject)) {
    if (!normalizeProjectKey(projectId)) continue;
    const threads = Array.isArray(value)
      ? reviveThreadList(value, { maxChars })
      : [reviveLegacySlot(value, projectId, { maxChars })].filter((thread) => thread !== null);
    if (threads.length === 0) continue;
    entries.push([projectId, threads]);
  }
  const unowned = isThreaded
    ? reviveThreadList(raw.unowned, { maxChars })
    : [reviveLegacySlot(raw.global, null, { maxChars })].filter((thread) => thread !== null);
  return pruneIntentProjects({ byProject: Object.fromEntries(entries), unowned }, projectIds);
}

function threadsOf(state, projectId) {
  const current = state || createIntentState();
  const key = normalizeProjectKey(projectId);
  if (!key) return Array.isArray(current.unowned) ? current.unowned : [];
  const byProject = current.byProject || {};
  return Object.hasOwn(byProject, key) ? byProject[key] : [];
}

function withThreads(state, projectId, threads) {
  const current = state || createIntentState();
  const key = normalizeProjectKey(projectId);
  if (!key) return { byProject: { ...current.byProject }, unowned: threads };
  const byProject = { ...current.byProject };
  if (threads.length === 0) delete byProject[key];
  if (threads.length > 0) byProject[key] = threads;
  return { byProject, unowned: current.unowned };
}

function byRecency(left, right) {
  return right.ts - left.ts || right.hits - left.hits;
}

// Live threads, newest first: the one this uri was advanced on leads whatever its age.
/** @param {IntentState | null} state @param {string | null} projectId @param {string | null} [uri] @returns {IntentThread[]} */
function liveThreadsFor(state, projectId, uri = null) {
  const threads = [...threadsOf(state, projectId)].sort(byRecency);
  if (!uri) return threads;
  const bound = threads.filter((thread) => thread.uris.includes(uri));
  const rest = threads.filter((thread) => !thread.uris.includes(uri));
  return [...bound, ...rest];
}

/*
 * The thread one dispatch is about. An unowned uri reads only the unowned list and a project reads only
 * its own: the fallback the slot model had ran unowned text INTO projects, which is the leak M20 closes.
 */
/** @param {IntentState | null} state @param {string | null} projectId @param {string | null} [uri] @returns {IntentThread | null} */
function activeThreadFor(state, projectId, uri = null) {
  const [first] = liveThreadsFor(state, projectId, uri);
  return first || null;
}

function isEmptyIntent(state) {
  const current = state || createIntentState();
  if (Array.isArray(current.unowned) && current.unowned.length > 0) return false;
  return Object.values(current.byProject || {}).every((threads) => !Array.isArray(threads) || threads.length === 0);
}

// Decay is applied on read, never by a timer: a thread nobody advanced within the ttl is retired. The
// keys whose list shrank come back with it, so the caller broadcasts exactly those and derives nothing.
/** @param {IntentState | null} state @param {{ now: number, ttlMs?: number }} options @returns {{ state: IntentState, changed: boolean, projects: (string | null)[] }} */
function retireStaleThreads(state, { now, ttlMs = DEFAULT_THREAD_TTL_MS } = /** @type {any} */ ({})) {
  const current = state || createIntentState();
  const cutoff = Number(now) - ttlMs;
  /** @type {(string | null)[]} */
  const projects = [];
  /** @param {IntentThread[]} threads @param {string | null} projectKey */
  const keep = (threads, projectKey) => {
    const live = threads.filter((thread) => thread.ts >= cutoff);
    if (live.length !== threads.length) projects.push(projectKey);
    return live;
  };
  const byProject = {};
  for (const [projectId, threads] of Object.entries(current.byProject || {})) {
    const live = keep(threads, projectId);
    if (live.length > 0) byProject[projectId] = live;
  }
  const unowned = keep(current.unowned || [], null);
  if (projects.length === 0) return { state: current, changed: false, projects: [] };
  return { state: { byProject, unowned }, changed: true, projects };
}

/*
 * The result contract: a string advances the active thread, an object names one or asks for `new`, and
 * an explicit null thread is the parsed form of the string, so reading a proposal twice returns it.
 */
function readIntentProposal(raw, { maxChars = MAX_INTENT_CHARS } = {}) {
  if (typeof raw === 'string') {
    const text = sanitizeIntentText(raw, { maxChars });
    return text ? { thread: null, text } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = sanitizeIntentText(raw.text, { maxChars });
  if (!text) return null;
  if (raw.thread === null) return { thread: null, text };
  if (raw.thread === NEW_THREAD || isThreadId(raw.thread)) return { thread: raw.thread, text };
  return null;
}

function advanceThread(thread, { text, now, uri }) {
  const appended = uri && !thread.uris.includes(uri) ? [...thread.uris, uri] : thread.uris;
  return {
    ...thread, text, ts: Number(now) || 0, uris: sanitizeUris(appended), hits: thread.hits + 1,
  };
}

/**
 * @param {IntentState | null} state
 * @param {{ intent: unknown, now?: number, projectId?: string | null, uri?: string | null }} options
 * @returns {{ state: IntentState, changed: boolean, thread: IntentThread | null, refused: 'unknown-thread' | null }}
 */
function applyModelIntent(state, {
  intent, now = 0, projectId = null, uri = null,
} = /** @type {any} */ ({})) {
  const current = state || createIntentState();
  const proposal = readIntentProposal(intent);
  if (!proposal) return { state: current, changed: false, thread: null, refused: null };
  // Sanitized once, here: a uri the thread would refuse to store must not decide selection or change.
  const boundUri = sanitizeUri(uri);
  const threads = threadsOf(current, projectId);
  const target = proposal.thread === null || proposal.thread === NEW_THREAD
    ? null
    : threads.find((thread) => thread.id === proposal.thread) || null;
  if (proposal.thread !== null && proposal.thread !== NEW_THREAD && !target) {
    return { state: current, changed: false, thread: null, refused: 'unknown-thread' };
  }
  const active = target || (proposal.thread === NEW_THREAD ? null : activeThreadFor(current, projectId, boundUri));
  if (active) {
    if (active.text === proposal.text && (!boundUri || active.uris.includes(boundUri))) {
      return { state: current, changed: false, thread: active, refused: null };
    }
    const advanced = advanceThread(active, { text: proposal.text, now, uri: boundUri });
    const next = threads.map((thread) => (thread.id === active.id ? advanced : thread));
    return { state: withThreads(current, projectId, next), changed: true, thread: advanced, refused: null };
  }
  const taken = new Set(threads.map((thread) => thread.id));
  const opened = {
    id: mintThreadId(`${normalizeProjectKey(projectId) || ''}|${Number(now) || 0}|${proposal.text}`, taken),
    text: proposal.text,
    uris: boundUri ? [boundUri] : [],
    ts: Number(now) || 0,
    hits: 1,
  };
  // The oldest retires when a sixth opens, so a project can never hold more than it can read.
  const kept = [...threads].sort(byRecency).slice(0, MAX_THREADS_PER_PROJECT - 1);
  return { state: withThreads(current, projectId, [...kept, opened]), changed: true, thread: opened, refused: null };
}

function threadPayload(thread) {
  return {
    id: thread.id, text: thread.text, uris: [...thread.uris], ts: thread.ts, hits: thread.hits,
  };
}

// What one project puts on the wire: its threads with the active one first.
/** @param {IntentState | null} state @param {string | null} projectId @param {string | null} [uri] */
function intentProjectPayload(state, projectId, uri = null) {
  const threads = liveThreadsFor(state, projectId, uri).map(threadPayload);
  return { active: threads[0] || null, threads };
}

function intentPayload(state) {
  const current = state || createIntentState();
  const entries = Object.entries(current.byProject || {})
    .filter(([, threads]) => Array.isArray(threads) && threads.length > 0)
    .map(([projectId, threads]) => [projectId, [...threads].sort(byRecency).map(threadPayload)]);
  return {
    byProject: Object.fromEntries(entries),
    unowned: [...(current.unowned || [])].sort(byRecency).map(threadPayload),
  };
}

module.exports = {
  DEFAULT_THREAD_TTL_MS,
  MAX_INTENT_CHARS,
  MAX_THREADS_PER_PROJECT,
  THREAD_ID_PATTERN,
  THREAD_ID_RE,
  activeThreadFor,
  applyModelIntent,
  createIntentState,
  intentPayload,
  intentProjectPayload,
  isEmptyIntent,
  liveThreadsFor,
  pruneIntentProjects,
  readIntentProposal,
  retireStaleThreads,
  reviveIntentState,
  sanitizeIntentText,
};
