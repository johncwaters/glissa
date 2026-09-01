
import { positiveInt } from './ingest-number-core.ts';

export type SourceName = 'terminal' | 'agentLogs' | 'git' | 'fs' | 'shellHistory' | 'editor';

export type IngestSourceConfig = {
  enabled: boolean;
  maxEntries: number;
  maxBytes: number;
  digestQuota: number;
  flushMs?: number;
  accumulatorBytes?: number;
  windowBytes?: number;
  pollMs?: number;
  debounceMs?: number;
  batchMs?: number;
  roots?: string[];
  shells?: string[];
};

export interface IngestConfig {
  enabled: boolean;
  sources: Record<string, IngestSourceConfig>;
}

export interface IngestScope {
  root: string | null;
  sessionId: string | null;
}

export type IngestEvent = {
  source: string;
  kind: string;
  ts: number;
  seq: number;
  scope: IngestScope;
  summary: string;
  detail: Record<string, string | number | boolean> | null;
}

export interface IngestRing {
  entries: { event: IngestEvent; bytes: number }[];
  totalBytes: number;
  maxEntries: number;
  maxBytes: number;
}

export interface IngestStore {
  config: IngestConfig;
  rings: Map<string, IngestRing>;
  seq: number;
}

const SOURCE_NAMES: readonly SourceName[] = ['terminal', 'agentLogs', 'git', 'fs', 'shellHistory', 'editor'];

const SOURCE_DEFAULTS = Object.freeze({
  terminal: Object.freeze({
    maxEntries: 200,
    maxBytes: 256 * 1024,
    digestQuota: 8,
    flushMs: 500,
    accumulatorBytes: 8 * 1024,
    windowBytes: 64 * 1024,
  }),
  agentLogs: Object.freeze({ maxEntries: 200, maxBytes: 128 * 1024, digestQuota: 8, pollMs: 2000 }),
  git: Object.freeze({
    maxEntries: 100, maxBytes: 64 * 1024, digestQuota: 6, debounceMs: 1000, pollMs: 60000,
  }),
  fs: Object.freeze({ maxEntries: 500, maxBytes: 128 * 1024, digestQuota: 8, batchMs: 500 }),
  shellHistory: Object.freeze({
    maxEntries: 100, maxBytes: 32 * 1024, digestQuota: 6, pollMs: 2000,
  }),
  editor: Object.freeze({ maxEntries: 100, maxBytes: 32 * 1024, digestQuota: 6 }),
});

const KINDS_BY_SOURCE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  terminal: Object.freeze(['output']),
  agentLogs: Object.freeze(['agent-turn', 'agent-tool']),
  git: Object.freeze(['commit', 'status-change', 'branch-change']),
  fs: Object.freeze(['file-change']),
  shellHistory: Object.freeze(['command']),
  editor: Object.freeze(['doc-save', 'doc-open', 'doc-close']),
});

const MAX_SUMMARY_CHARS = 400;
const MAX_DETAIL_CHARS = 1000;
const MAX_DETAIL_KEYS = 12;
const DEFAULT_DIGEST_BUDGET_CHARS = 2000;
const SCRUB_PLACEHOLDER = '[scrubbed]';
const DIGEST_HEADER = 'Recent activity on this machine, newest first:';


const LIST_KEYS: Partial<Record<SourceName, string>> = Object.freeze({ fs: 'roots', shellHistory: 'shells' });

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const values: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim() || values.includes(entry.trim())) continue;
    values.push(entry.trim());
  }
  return values;
}

function disabledSource(name: SourceName): IngestSourceConfig {
  const source: Record<string, unknown> = { enabled: false, ...SOURCE_DEFAULTS[name] };
  const listKey = LIST_KEYS[name];
  if (listKey) source[listKey] = [];
  return source as IngestSourceConfig;
}

function disabledConfig(): IngestConfig {
  const sources: Record<string, IngestSourceConfig> = {};
  for (const name of SOURCE_NAMES) sources[name] = disabledSource(name);
  return { enabled: false, sources };
}

function resolveSource(name: SourceName, raw: unknown): IngestSourceConfig {
  const defaults = SOURCE_DEFAULTS[name];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return disabledSource(name);
  const rawSource = raw as Record<string, unknown>;
  const resolved: Record<string, unknown> = { enabled: rawSource.enabled === true };
  for (const [key, value] of Object.entries(defaults)) resolved[key] = positiveInt(rawSource[key], value);
  const listKey = LIST_KEYS[name];
  if (listKey) resolved[listKey] = stringList(rawSource[listKey]);
  return resolved as IngestSourceConfig;
}

function resolveIngestConfig(raw: unknown): IngestConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return disabledConfig();
  const rawConfig = raw as Record<string, unknown>;
  if (rawConfig.enabled !== true) return disabledConfig();
  const rawSourcesValue = rawConfig.sources;
  const rawSources = rawSourcesValue && typeof rawSourcesValue === 'object' && !Array.isArray(rawSourcesValue)
    ? (rawSourcesValue as Record<string, unknown>)
    : {};
  const sources: Record<string, IngestSourceConfig> = {};
  for (const name of SOURCE_NAMES) sources[name] = resolveSource(name, rawSources[name]);
  return { enabled: true, sources };
}

function enabledSourceNames(config: IngestConfig | null | undefined): SourceName[] {
  if (!config || config.enabled !== true) return [];
  return SOURCE_NAMES.filter((name) => config.sources[name] && config.sources[name].enabled === true);
}


const SECRET_WORD = '(?:password|passwd|pwd|token|api[_-]?key|secret|credential|auth[_-]?token|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|connection[_-]?string)';
const QUOTED_OR_BARE = '(?:"[^"\\r\\n]*"|\'[^\'\\r\\n]*\'|[^\\s\\r\\n]+)';
const GAP = '[^\\S\\r\\n]';
const FLAG_REACH = '[^\\r\\n;&|]{0,200}?';
const MYSQL_TOOLS = '(?:mysql|mysqldump|mysqladmin|mysqlshow|mariadb|mariadb-dump)';

const SCRUB_PATTERNS = [
  new RegExp(`(${SECRET_WORD}${GAP}*(?:=>|[:=])${GAP}*)${QUOTED_OR_BARE}`, 'gi'),
  new RegExp(`((?:^|\\s)--?${SECRET_WORD}${GAP}+)${QUOTED_OR_BARE}`, 'gi'),
  new RegExp(`((?:^|\\s)-(?:pwd|pw)(?![a-z])${GAP}*=?${GAP}*)${QUOTED_OR_BARE}`, 'g'),
  new RegExp(`(-AsPlainText${GAP}+)${QUOTED_OR_BARE}`, 'gi'),
  new RegExp(`((?:^|\\s)setx${GAP}+[^\\s\\r\\n]*${SECRET_WORD}[^\\s\\r\\n]*${GAP}+)${QUOTED_OR_BARE}`, 'gi'),
  new RegExp(`(\\bBearer${GAP}+)[A-Za-z0-9._~+/=-]{8,}`, 'gi'),
  new RegExp(`(\\bauthorization${GAP}*:${GAP}*Basic${GAP}+)[A-Za-z0-9+/=_-]{8,}`, 'gi'),
  new RegExp(`(\\bdocker${GAP}+login\\b${FLAG_REACH}${GAP}-p(?:${GAP}+|=))${QUOTED_OR_BARE}`, 'gi'),
  new RegExp(`(\\bcurl\\b${FLAG_REACH}${GAP}(?:--user|-u)(?:${GAP}+|=)[^\\s:\\r\\n]+:)${QUOTED_OR_BARE}`, 'gi'),
  new RegExp(`(\\b${MYSQL_TOOLS}\\b${FLAG_REACH}${GAP}-p)${QUOTED_OR_BARE}`, 'g'),
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi,
];

const SECRET_SHAPE_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_=-]{6,}\.[A-Za-z0-9_=-]{6,}\.[A-Za-z0-9_=-]{4,}/g,
  /-----BEGIN(?:[A-Z0-9 ]+)? PRIVATE KEY-----/g,
];

function scrubText(text: unknown): string {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  let scrubbed = text;
  for (const pattern of SCRUB_PATTERNS) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, (_match: string, prefix: string) => `${prefix}${SCRUB_PLACEHOLDER}`);
  }
  for (const pattern of SECRET_SHAPE_PATTERNS) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, SCRUB_PLACEHOLDER);
  }
  return scrubbed;
}

function scrubDetail(detail: unknown): Record<string, string | number | boolean> | null {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const scrubbed: Record<string, string | number | boolean> = {};
  let keys = 0;
  for (const [key, value] of Object.entries(detail)) {
    if (keys >= MAX_DETAIL_KEYS) break;
    keys += 1;
    if (typeof value === 'string') {
      scrubbed[key] = scrubText(value).slice(0, MAX_DETAIL_CHARS);
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) scrubbed[key] = value;
    if (typeof value === 'boolean') scrubbed[key] = value;
  }
  return scrubbed;
}


function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeScope(raw: unknown): IngestScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { root: null, sessionId: null };
  const rawScope = raw as { root?: unknown; sessionId?: unknown };
  return { root: nonEmptyString(rawScope.root), sessionId: nonEmptyString(rawScope.sessionId) };
}

function normalizeEvent(raw: unknown, { seq, now }: { seq: number; now: number }): IngestEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rawEvent = raw as Record<string, unknown>;
  const source = nonEmptyString(rawEvent.source);
  if (!source || !KINDS_BY_SOURCE[source]) return null;
  const kind = nonEmptyString(rawEvent.kind);
  if (!kind || !KINDS_BY_SOURCE[source].includes(kind)) return null;
  const summary = scrubText(typeof rawEvent.summary === 'string' ? rawEvent.summary : '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SUMMARY_CHARS);
  if (!summary) return null;
  const ts = Number(rawEvent.ts);
  return {
    source,
    kind,
    ts: Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : now,
    seq,
    scope: normalizeScope(rawEvent.scope),
    summary,
    detail: scrubDetail(rawEvent.detail),
  };
}

function eventBytes(event: IngestEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}


function createRing({ maxEntries, maxBytes }: { maxEntries: number; maxBytes: number }): IngestRing {
  return { entries: [], totalBytes: 0, maxEntries, maxBytes };
}

function pushToRing(ring: IngestRing, event: IngestEvent): IngestEvent {
  const bytes = eventBytes(event);
  ring.entries.push({ event, bytes });
  ring.totalBytes += bytes;
  while (ring.entries.length > 1 && (ring.entries.length > ring.maxEntries || ring.totalBytes > ring.maxBytes)) {
    const evicted = ring.entries.shift();
    ring.totalBytes -= evicted ? evicted.bytes : 0;
  }
  return event;
}

function createIngestStore(config: IngestConfig | null | undefined): IngestStore {
  const resolved = config?.sources ? config : disabledConfig();
  const rings = new Map<string, IngestRing>();
  for (const name of enabledSourceNames(resolved)) rings.set(name, createRing(resolved.sources[name]));
  return { config: resolved, rings, seq: 0 };
}

function publishEvent(store: IngestStore, raw: unknown, now: number): IngestEvent | null {
  const rawEvent = (raw ?? null) as { source?: unknown } | null;
  const source = nonEmptyString(rawEvent?.source);
  if (!source) return null;
  const ring = store.rings.get(source);
  if (!ring) return null;
  const event = normalizeEvent(raw, { seq: store.seq + 1, now });
  if (!event) return null;
  store.seq += 1;
  return pushToRing(ring, event);
}

function latestSeq(store: { seq?: unknown } | null | undefined): number {
  const seq = Number(store?.seq);
  if (!Number.isFinite(seq)) return 0;
  return seq;
}

function snapshotEvents(store: IngestStore, { limit = 200 }: { limit?: number } = {}): IngestEvent[] {
  const all: IngestEvent[] = [];
  for (const ring of store.rings.values()) {
    for (const entry of ring.entries) all.push(entry.event);
  }
  all.sort((left, right) => right.seq - left.seq);
  return all.slice(0, Math.max(0, Math.floor(limit)));
}

function ringStats(store: IngestStore): { source: string; events: number; bytes: number }[] {
  const stats: { source: string; events: number; bytes: number }[] = [];
  for (const [source, ring] of store.rings) {
    stats.push({ source, events: ring.entries.length, bytes: ring.totalBytes });
  }
  return stats;
}


const SOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  terminal: 'terminal',
  agentLogs: 'agent',
  git: 'git',
  fs: 'files',
  shellHistory: 'shell',
  editor: 'editor',
});

function ageText(ts: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function digestLine(event: IngestEvent, now: number): string {
  const label = SOURCE_LABELS[event.source] || event.source;
  const scope = event.scope.root ? '' : ' (machine scope)';
  return `- ${label} ${ageText(event.ts, now)}${scope}: ${event.summary}`;
}

function matchesScopes(event: IngestEvent, scopes: string[] | null): boolean {
  if (!Array.isArray(scopes) || scopes.length === 0) return true;
  if (!event.scope.root) return true;
  return scopes.includes(event.scope.root);
}

function buildContextDigest(
  store: IngestStore,
  {
    scopes = null,
    budgetChars = DEFAULT_DIGEST_BUDGET_CHARS,
    now = Number.NaN,
  }: { scopes?: string[] | null; budgetChars?: number; now?: number } = {},
): string {
  const budget = positiveInt(budgetChars, DEFAULT_DIGEST_BUDGET_CHARS);
  const candidates: IngestEvent[] = [];
  const takenBySource = new Map<string, number>();
  for (const event of snapshotEvents(store, { limit: Number.MAX_SAFE_INTEGER })) {
    if (!matchesScopes(event, scopes)) continue;
    const quota = store.config.sources[event.source].digestQuota;
    const taken = takenBySource.get(event.source) || 0;
    if (taken >= quota) continue;
    takenBySource.set(event.source, taken + 1);
    candidates.push(event);
  }
  if (candidates.length === 0) return '';
  const lines = [DIGEST_HEADER];
  let used = DIGEST_HEADER.length;
  for (const event of candidates) {
    const line = scrubText(digestLine(event, now));
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 1) return '';
  return lines.join('\n');
}

export {
  DEFAULT_DIGEST_BUDGET_CHARS,
  DIGEST_HEADER,
  KINDS_BY_SOURCE,
  MAX_SUMMARY_CHARS,
  SCRUB_PLACEHOLDER,
  SOURCE_DEFAULTS,
  SOURCE_NAMES,
  buildContextDigest,
  createIngestStore,
  enabledSourceNames,
  latestSeq,
  normalizeEvent,
  publishEvent,
  resolveIngestConfig,
  ringStats,
  scrubText,
  snapshotEvents,
};
