/*
 * Pure core of the ingestion pipeline (docs/plan-ingestion.md, M6): the config resolver, event
 * normalization, the publish-time scrub, the per-source bounded rings, and the context digest the
 * Visions lane's dispatch prompt carries. No IO, no timers, no clock: the caller passes `now` in and gets
 * a verdict, an event, or a string back.
 *
 * The scrub runs HERE, at publish time, before ring insertion, so a secret never sits in a ring, a
 * snapshot, an activity delta, or a digest.
 */

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

// The Sources table in docs/plan-ingestion.md. These are the load-bearing bound, not tuning hints.
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

// A source may only publish the kinds it declared, so a typo becomes a dropped event rather than a
// category nobody consumes.
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

// --- Config ---------------------------------------------------------------

/*
 * The two non-numeric source options: `sources.fs.roots`, a list of directories widening the fs source
 * beyond the projects with active sessions, and `sources.shellHistory.shells`, naming which shells to
 * tail. They need their own branch because every other option resolves through positiveInt, which would
 * silently turn a configured list back into the empty default.
 */
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

/**
 * config.ingest, normalized, visions-style: absent, malformed, or anything other than
 * `enabled: true` resolves to the disabled shape, and each source needs its own `enabled: true` on top
 * of that. This is what makes the lane cost nothing until it is asked for.
 */
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

// --- Scrub ----------------------------------------------------------------

/*
 * PSReadLine's own sensitive-word list, plus the two shapes it does not cover: a bearer header and a
 * url with credentials in it. Every value pattern stops at a line break, so one secret on one line of a
 * multi-line terminal chunk costs that line and nothing else.
 */
const SECRET_WORD = '(?:password|passwd|pwd|token|api[_-]?key|secret|credential|auth[_-]?token|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|connection[_-]?string)';
const QUOTED_OR_BARE = '(?:"[^"\\r\\n]*"|\'[^\'\\r\\n]*\'|[^\\s\\r\\n]+)';
// Horizontal whitespace only. A plain \s would let the gap between the name and its value swallow a
// newline, and one secret assignment would then scrub the innocent line under it.
const GAP = '[^\\S\\r\\n]';
/*
 * How far a command-anchored pattern may reach for its flag. Some short flags are a credential in one
 * command and a port, a listing or a uid everywhere else (`-p`, `-u`), so the COMMAND NAME is what makes
 * them safe to match at all; the reach is bounded so the lazy walk can never cost a whole line per start.
 *
 * It stops at a command SEPARATOR, which is what keeps `curl ... | sh && docker run -u 1000:1000` from
 * handing curl's anchor to a flag on the other side of the pipe. A separator can only appear inside a
 * credential value when the value is quoted, and a quoted value is matched by its own alternative, which
 * reaches through all three characters happily.
 */
const FLAG_REACH = '[^\\r\\n;&|]{0,200}?';
const MYSQL_TOOLS = '(?:mysql|mysqldump|mysqladmin|mysqlshow|mariadb|mariadb-dump)';

const SCRUB_PATTERNS = [
  // name = value, name: value, name => value. Also covers npm `:_authToken=`, `aws_secret_access_key=`,
  // `set NAME=value`, and an assignment quoted inside an `echo "token=abc" > .env`.
  new RegExp(`(${SECRET_WORD}${GAP}*(?:=>|[:=])${GAP}*)${QUOTED_OR_BARE}`, 'gi'),
  // --token value, -Password value, docker login --password value
  new RegExp(`((?:^|\\s)--?${SECRET_WORD}${GAP}+)${QUOTED_OR_BARE}`, 'gi'),
  /*
   * -pwSecret, -pw secret, -pw=secret. Single dash only, so `--password value` stays with the pattern
   * above it, and the lookahead is what makes `-pw`/`-pwd` a COMPLETE flag: without it `-pwfile` reads as
   * `-pw` plus a value and a bare `-pwd` backtracks into `-pw` plus `d`. Case sensitive, because under an
   * `i` flag that lookahead would also refuse the uppercase start of `-pwSecret`; the separated forms of
   * `pwd` are covered case-insensitively by the two patterns above regardless.
   */
  new RegExp(`((?:^|\\s)-(?:pwd|pw)(?![a-z])${GAP}*=?${GAP}*)${QUOTED_OR_BARE}`, 'g'),
  // PowerShell's own plaintext-credential idiom
  new RegExp(`(-AsPlainText${GAP}+)${QUOTED_OR_BARE}`, 'gi'),
  // Windows `setx NAME value`, whose value is positional where `set NAME=value` is an assignment.
  new RegExp(`((?:^|\\s)setx${GAP}+[^\\s\\r\\n]*${SECRET_WORD}[^\\s\\r\\n]*${GAP}+)${QUOTED_OR_BARE}`, 'gi'),
  // Authorization: Bearer <token>
  new RegExp(`(\\bBearer${GAP}+)[A-Za-z0-9._~+/=-]{8,}`, 'gi'),
  // Authorization: Basic <base64>. The header is the anchor, because `Basic` alone opens ordinary prose.
  new RegExp(`(\\bauthorization${GAP}*:${GAP}*Basic${GAP}+)[A-Za-z0-9+/=_-]{8,}`, 'gi'),
  // `docker login -p secret`: -p is a port mapping everywhere else in docker, so `login` is the anchor.
  // Both separators, since pflag takes `-p=secret` as readily as `-p secret`.
  new RegExp(`(\\bdocker${GAP}+login\\b${FLAG_REACH}${GAP}-p(?:${GAP}+|=))${QUOTED_OR_BARE}`, 'gi'),
  // `curl -u user:pass`: -u is a uid:gid in docker and a plain username elsewhere, so curl is the anchor.
  new RegExp(`(\\bcurl\\b${FLAG_REACH}${GAP}(?:--user|-u)(?:${GAP}+|=)[^\\s:\\r\\n]+:)${QUOTED_OR_BARE}`, 'gi'),
  /*
   * `mysql -pHunter2`: this family attaches the password to -p with no space. Case SENSITIVE on purpose,
   * because -P is that same family's port flag and a case-insensitive match would eat the port number.
   */
  new RegExp(`(\\b${MYSQL_TOOLS}\\b${FLAG_REACH}${GAP}-p)${QUOTED_OR_BARE}`, 'g'),
  // scheme://user:password@host
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi,
];

/*
 * Shapes that ARE the secret. These carry no name to anchor on, so there is no prefix to keep and the
 * whole match goes; every one of them is an issued-credential shape whose own prefix identifies its
 * issuer, which is what keeps a git sha, a UUID or a bare `eyJ` out of them.
 */
const SECRET_SHAPE_PATTERNS = [
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub: ghp_ (personal), gho_ (oauth), ghu_/ghs_ (app), ghr_ (refresh), plus the fine-grained shape
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Slack bot, user, app and legacy tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  // A JWT is the period-separated triplet, never a bare eyJ
  /\beyJ[A-Za-z0-9_=-]{6,}\.[A-Za-z0-9_=-]{6,}\.[A-Za-z0-9_=-]{4,}/g,
  // The header announcing a private key. Its BODY is a documented limit, not a pattern.
  /-----BEGIN(?:[A-Z0-9 ]+)? PRIVATE KEY-----/g,
];

// Named patterns keep their leading group (the name, the flag, the scheme) and replace only the value;
// a shape pattern is the value, so the match goes whole.
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

// Detail is small and structured by contract, so one shallow pass covers it.
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

// --- Events ---------------------------------------------------------------

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeScope(raw: unknown): IngestScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { root: null, sessionId: null };
  const rawScope = raw as { root?: unknown; sessionId?: unknown };
  return { root: nonEmptyString(rawScope.root), sessionId: nonEmptyString(rawScope.sessionId) };
}

/**
 * One raw adapter push, checked and scrubbed. An unknown source, an undeclared kind, or an empty
 * summary is rejected (null) rather than stored half-formed: the rings only ever hold the one shape
 * every consumer reads. `seq` is stamped by the caller and is the sole ordering key; `ts` is display.
 */
function normalizeEvent(raw: unknown, { seq, now }: { seq: number; now: number }): IngestEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rawEvent = raw as Record<string, unknown>;
  const source = nonEmptyString(rawEvent.source);
  if (!source || !KINDS_BY_SOURCE[source]) return null;
  const kind = nonEmptyString(rawEvent.kind);
  if (!kind || !KINDS_BY_SOURCE[source].includes(kind)) return null;
  /*
   * Scrub, then FOLD, then slice. The scrub runs first because its value patterns are line-aware and
   * folding would let one cross a break; the fold runs because a summary is one line by contract and
   * digestLine renders it as one, so a multi-line summary from any adapter would otherwise inject bare
   * lines into the fenced DATA block a dispatch prompt carries.
   */
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

// --- Rings ----------------------------------------------------------------

function createRing({ maxEntries, maxBytes }: { maxEntries: number; maxBytes: number }): IngestRing {
  return { entries: [], totalBytes: 0, maxEntries, maxBytes };
}

/**
 * Bounded by entry count AND total bytes, evicting oldest first. Both bounds matter: 500 one-word file
 * events and one 256KB terminal burst are the same ring pressure from two directions. A single entry
 * larger than the whole byte cap is kept (an empty ring reports nothing at all), so the loop stops at
 * one survivor.
 */
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

/**
 * The one write path. A push to a disabled (or unknown) source is dropped, the event is normalized and
 * scrubbed, seq is stamped monotonically, and the ring evicts to stay inside both of its bounds. Returns
 * the stored event, or null when nothing was stored.
 */
function publishEvent(store: IngestStore, raw: unknown, now: number): IngestEvent | null {
  const rawEvent = (raw ?? null) as { source?: unknown } | null;
  const source = nonEmptyString(rawEvent?.source);
  if (!source) return null;
  const ring = store.rings.get(source);
  if (!ring) return null;
  // Stamped only once the event is known to be storable: a seq burnt on a rejected push would read as
  // machine movement to anyone gating on latestSeq.
  const event = normalizeEvent(raw, { seq: store.seq + 1, now });
  if (!event) return null;
  store.seq += 1;
  return pushToRing(ring, event);
}

/*
 * The newest seq the store has stamped, 0 before anything is published. This is the machine's movement
 * signal (docs/plan-ingestion.md, M7.5): seq only ever advances on a NEW event, so a consumer gating on
 * it cannot be fooled by a digest whose relative times merely aged.
 */
function latestSeq(store: { seq?: unknown } | null | undefined): number {
  const seq = Number(store?.seq);
  if (!Number.isFinite(seq)) return 0;
  return seq;
}

// Newest first across every ring, which is the order both the feed and the digest read in.
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

// --- Digest ---------------------------------------------------------------

const SOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  terminal: 'terminal',
  agentLogs: 'agent',
  git: 'git',
  fs: 'files',
  shellHistory: 'shell',
  editor: 'editor',
});

// Coarse on purpose and derived from `now`, because source clocks disagree and the reader only needs to
// know whether something happened seconds or hours ago.
function ageText(ts: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/*
 * shellHistory records no cwd, so its events cannot be correlated to a project and the line says so
 * rather than letting a reader assume this project ran the command (docs/plan-ingestion.md redline).
 */
function digestLine(event: IngestEvent, now: number): string {
  const label = SOURCE_LABELS[event.source] || event.source;
  const scope = event.scope.root ? '' : ' (machine scope)';
  return `- ${label} ${ageText(event.ts, now)}${scope}: ${event.summary}`;
}

function matchesScopes(event: IngestEvent, scopes: string[] | null): boolean {
  if (!Array.isArray(scopes) || scopes.length === 0) return true;
  // A machine-scope event belongs to no project, so no project filter can exclude it.
  if (!event.scope.root) return true;
  return scopes.includes(event.scope.root);
}

/**
 * The cross-source context section, built exactly once per visions dispatch. Synchronous and pure:
 * one pass over the rings with no await between reads, newest first by seq, a per-source quota so one
 * noisy source cannot starve the rest, and a hard char budget. Empty rings produce an empty string,
 * which every consumer renders as absent.
 */
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
    // The scrub already ran at publish time; this second pass is defense in depth, not the guarantee.
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
