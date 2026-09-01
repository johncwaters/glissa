import crypto from 'node:crypto';

import { VISIONS_THREAD_ID_PATTERN } from '../../shared/visions-intent-ids.ts';
import { sanitizeOneLine } from './text-core.ts';

const MAX_INTENT_CHARS = 300;
const MODEL_SOURCE = 'model';
const LEGACY_OPERATOR_SOURCE = 'operator';
const MAX_THREADS_PER_PROJECT = 5;
const DEFAULT_THREAD_TTL_MS = 72 * 3600000;

const THREAD_ID_PATTERN = VISIONS_THREAD_ID_PATTERN;
const THREAD_ID_RE = new RegExp(`^${THREAD_ID_PATTERN}$`);
const THREAD_ID_HEX_CHARS = 8;
const NEW_THREAD = 'new';
const MAX_THREAD_URIS = 20;
const MAX_THREAD_URI_CHARS = 2048;

export interface IntentThread {
  id: string;
  text: string;
  uris: string[];
  ts: number;
  hits: number;
}

export interface IntentState {
  byProject: Record<string, IntentThread[]>;
  unowned: IntentThread[];
}

function createIntentState(): IntentState {
  return { byProject: {}, unowned: [] };
}

function normalizeProjectKey(projectId: unknown): string | null {
  return typeof projectId === 'string' && projectId ? projectId : null;
}

function sanitizeIntentText(raw: unknown, { maxChars = MAX_INTENT_CHARS }: { maxChars?: number } = {}): string {
  if (typeof raw !== 'string') return '';
  return sanitizeOneLine(raw, maxChars);
}

function isThreadId(value: unknown): value is string {
  return typeof value === 'string' && THREAD_ID_RE.test(value);
}

function mintThreadId(seed: string, taken: Set<string>): string {
  for (let attempt = 0; ; attempt += 1) {
    const digest = crypto.createHash('sha256').update(`${seed}|${attempt}`, 'utf8').digest('hex');
    const id = `t-${digest.slice(0, THREAD_ID_HEX_CHARS)}`;
    if (!taken.has(id)) return id;
  }
}

function sanitizeUris(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const unique = [...new Set(raw.filter((uri): uri is string => typeof uri === 'string' && uri !== '' && uri.length <= MAX_THREAD_URI_CHARS))];
  return unique.slice(-MAX_THREAD_URIS);
}

function sanitizeUri(raw: unknown): string | null {
  const [uri] = sanitizeUris([raw]);
  return uri || null;
}

function reviveThread(raw: unknown, { maxChars = MAX_INTENT_CHARS }: { maxChars?: number } = {}): IntentThread | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = raw as { id?: unknown; text?: unknown; ts?: unknown; hits?: unknown; uris?: unknown };
  const text = sanitizeIntentText(fields.text, { maxChars });
  if (!text || !isThreadId(fields.id)) return null;
  const ts = fields.ts;
  if (Object.hasOwn(raw, 'ts') && (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0)) return null;
  const hits = typeof fields.hits === 'number' && Number.isInteger(fields.hits) && fields.hits > 0 ? fields.hits : 1;
  return {
    id: fields.id,
    text,
    uris: sanitizeUris(fields.uris),
    ts: typeof ts === 'number' && Number.isFinite(ts) ? ts : 0,
    hits,
  };
}

function reviveLegacySlot(
  raw: unknown,
  projectKey: string | null,
  { maxChars = MAX_INTENT_CHARS }: { maxChars?: number } = {},
): IntentThread | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = raw as { text?: unknown; source?: unknown; ts?: unknown };
  const text = sanitizeIntentText(fields.text, { maxChars });
  if (!text) return null;
  if (fields.source !== MODEL_SOURCE && fields.source !== LEGACY_OPERATOR_SOURCE) return null;
  const rawTs = fields.ts;
  if (Object.hasOwn(raw, 'ts') && (typeof rawTs !== 'number' || !Number.isFinite(rawTs) || rawTs < 0)) return null;
  const ts = typeof rawTs === 'number' && Number.isFinite(rawTs) ? rawTs : 0;
  return {
    id: mintThreadId(`${projectKey || ''}|${ts}|${text}`, new Set()), text, uris: [], ts, hits: 1,
  };
}

function reviveThreadList(raw: unknown, { maxChars = MAX_INTENT_CHARS }: { maxChars?: number } = {}): IntentThread[] {
  if (!Array.isArray(raw)) return [];
  const threads: IntentThread[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const thread = reviveThread(entry, { maxChars });
    if (!thread || seen.has(thread.id)) continue;
    seen.add(thread.id);
    threads.push(thread);
  }
  return threads.slice(0, MAX_THREADS_PER_PROJECT);
}

function pruneIntentProjects(state: IntentState | null | undefined, projectIds: unknown): IntentState {
  const current = state || createIntentState();
  if (!Array.isArray(projectIds)) return current;
  const known = new Set(projectIds.filter((id) => normalizeProjectKey(id)));
  const entries = Object.entries(current.byProject || {}).filter(([projectId]) => known.has(projectId));
  if (entries.length === Object.keys(current.byProject || {}).length) return current;
  return { byProject: Object.fromEntries(entries), unowned: current.unowned };
}

function reviveIntentState(
  raw: unknown,
  { maxChars = MAX_INTENT_CHARS, projectIds = null }: { maxChars?: number; projectIds?: unknown } = {},
): IntentState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createIntentState();
  const fields = raw as { byProject?: unknown; unowned?: unknown; global?: unknown };
  const isThreaded = Object.hasOwn(raw, 'unowned')
    || Array.isArray(Object.values((fields.byProject as Record<string, unknown>) || {})[0]);
  const isScoped = Object.hasOwn(raw, 'global') || Object.hasOwn(raw, 'byProject');
  if (!isThreaded && !isScoped) {
    const lifted = reviveLegacySlot(raw, null, { maxChars });
    return pruneIntentProjects({ byProject: {}, unowned: lifted ? [lifted] : [] }, projectIds);
  }
  const rawByProject: Record<string, unknown> = fields.byProject
    && typeof fields.byProject === 'object' && !Array.isArray(fields.byProject)
    ? (fields.byProject as Record<string, unknown>)
    : {};
  const entries: [string, IntentThread[]][] = [];
  for (const [projectId, value] of Object.entries(rawByProject)) {
    if (!normalizeProjectKey(projectId)) continue;
    const threads = Array.isArray(value)
      ? reviveThreadList(value, { maxChars })
      : [reviveLegacySlot(value, projectId, { maxChars })].filter((thread): thread is IntentThread => thread !== null);
    if (threads.length === 0) continue;
    entries.push([projectId, threads]);
  }
  const unowned = isThreaded
    ? reviveThreadList(fields.unowned, { maxChars })
    : [reviveLegacySlot(fields.global, null, { maxChars })].filter((thread): thread is IntentThread => thread !== null);
  return pruneIntentProjects({ byProject: Object.fromEntries(entries), unowned }, projectIds);
}

function threadsOf(state: IntentState | null | undefined, projectId: unknown): IntentThread[] {
  const current = state || createIntentState();
  const key = normalizeProjectKey(projectId);
  if (!key) return Array.isArray(current.unowned) ? current.unowned : [];
  const byProject = current.byProject || {};
  return Object.hasOwn(byProject, key) ? byProject[key] : [];
}

function withThreads(state: IntentState | null | undefined, projectId: unknown, threads: IntentThread[]): IntentState {
  const current = state || createIntentState();
  const key = normalizeProjectKey(projectId);
  if (!key) return { byProject: { ...current.byProject }, unowned: threads };
  const byProject = { ...current.byProject };
  if (threads.length === 0) delete byProject[key];
  if (threads.length > 0) byProject[key] = threads;
  return { byProject, unowned: current.unowned };
}

function byRecency(left: IntentThread, right: IntentThread): number {
  return right.ts - left.ts || right.hits - left.hits;
}

function liveThreadsFor(
  state: IntentState | null | undefined,
  projectId: string | null,
  uri: string | null = null,
): IntentThread[] {
  const threads = [...threadsOf(state, projectId)].sort(byRecency);
  if (!uri) return threads;
  const bound = threads.filter((thread) => thread.uris.includes(uri));
  const rest = threads.filter((thread) => !thread.uris.includes(uri));
  return [...bound, ...rest];
}

function activeThreadFor(
  state: IntentState | null | undefined,
  projectId: string | null,
  uri: string | null = null,
): IntentThread | null {
  const [first] = liveThreadsFor(state, projectId, uri);
  return first || null;
}

function isEmptyIntent(state: IntentState | null | undefined): boolean {
  const current = state || createIntentState();
  if (Array.isArray(current.unowned) && current.unowned.length > 0) return false;
  return Object.values(current.byProject || {}).every((threads) => !Array.isArray(threads) || threads.length === 0);
}

function retireStaleThreads(
  state: IntentState | null | undefined,
  { now, ttlMs = DEFAULT_THREAD_TTL_MS }: { now?: unknown; ttlMs?: number } = {},
): { state: IntentState; changed: boolean; projects: Array<string | null> } {
  const current = state || createIntentState();
  const cutoff = Number(now) - ttlMs;
  const projects: Array<string | null> = [];
  const keep = (threads: IntentThread[], projectKey: string | null): IntentThread[] => {
    const live = threads.filter((thread) => thread.ts >= cutoff);
    if (live.length !== threads.length) projects.push(projectKey);
    return live;
  };
  const byProject: Record<string, IntentThread[]> = {};
  for (const [projectId, threads] of Object.entries(current.byProject || {})) {
    const live = keep(threads, projectId);
    if (live.length > 0) byProject[projectId] = live;
  }
  const unowned = keep(current.unowned || [], null);
  if (projects.length === 0) return { state: current, changed: false, projects: [] };
  return { state: { byProject, unowned }, changed: true, projects };
}

function readIntentProposal(
  raw: unknown,
  { maxChars = MAX_INTENT_CHARS }: { maxChars?: number } = {},
): { thread: string | null; text: string } | null {
  if (typeof raw === 'string') {
    const text = sanitizeIntentText(raw, { maxChars });
    return text ? { thread: null, text } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = raw as { text?: unknown; thread?: unknown };
  const text = sanitizeIntentText(fields.text, { maxChars });
  if (!text) return null;
  if (fields.thread === null) return { thread: null, text };
  if (fields.thread === NEW_THREAD) return { thread: NEW_THREAD, text };
  if (isThreadId(fields.thread)) return { thread: fields.thread, text };
  return null;
}

function advanceThread(thread: IntentThread, { text, now, uri }: { text: string; now: unknown; uri: string | null }): IntentThread {
  const appended = uri && !thread.uris.includes(uri) ? [...thread.uris, uri] : thread.uris;
  return {
    ...thread, text, ts: Number(now) || 0, uris: sanitizeUris(appended), hits: thread.hits + 1,
  };
}

function applyModelIntent(state: IntentState | null | undefined, {
  intent, now = 0, projectId = null, uri = null,
}: {
  intent?: unknown;
  now?: number;
  projectId?: string | null;
  uri?: string | null;
} = {}): { state: IntentState; changed: boolean; thread: IntentThread | null; refused: 'unknown-thread' | null } {
  const current = state || createIntentState();
  const proposal = readIntentProposal(intent);
  if (!proposal) return { state: current, changed: false, thread: null, refused: null };

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

  const kept = [...threads].sort(byRecency).slice(0, MAX_THREADS_PER_PROJECT - 1);
  return { state: withThreads(current, projectId, [...kept, opened]), changed: true, thread: opened, refused: null };
}

function threadPayload(thread: IntentThread) {
  return {
    id: thread.id, text: thread.text, uris: [...thread.uris], ts: thread.ts, hits: thread.hits,
  };
}

function intentProjectPayload(state: IntentState | null | undefined, projectId: string | null, uri: string | null = null) {
  const threads = liveThreadsFor(state, projectId, uri).map(threadPayload);
  return { active: threads[0] || null, threads };
}

function intentPayload(state: IntentState | null | undefined) {
  const current = state || createIntentState();
  const entries = Object.entries(current.byProject || {})
    .filter(([, threads]) => Array.isArray(threads) && threads.length > 0)
    .map(([projectId, threads]) => [projectId, [...threads].sort(byRecency).map(threadPayload)] as const);
  return {
    byProject: Object.fromEntries(entries),
    unowned: [...(current.unowned || [])].sort(byRecency).map(threadPayload),
  };
}

export { DEFAULT_THREAD_TTL_MS, MAX_INTENT_CHARS, MAX_THREADS_PER_PROJECT, THREAD_ID_PATTERN, THREAD_ID_RE, activeThreadFor, applyModelIntent, createIntentState, intentPayload, intentProjectPayload, isEmptyIntent, liveThreadsFor, pruneIntentProjects, readIntentProposal, retireStaleThreads, reviveIntentState, sanitizeIntentText };
