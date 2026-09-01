import type { PosthogIssueChange } from './posthog-core.ts';
import { planInvestigations, toCount } from './posthog-core.ts';

const DEFAULT_RECURRENCE_WINDOW_DAYS = 7;

const DEFAULT_TRANSIENT_RECURRENCE_LIMIT = 3;

const SIGNATURES_KEY = '_signatures';

const SIGNATURE_CAP = 200;

const RECURRED_ID_CAP = 10;

const MIN_DISTINCTIVE_TOKENS = 3;

const MIN_SHARED_TOKENS = 3;

const MATCH_THRESHOLD = 0.6;

const MIN_SUMMARY_CORROBORATION = 2;
const CORROBORATED_MATCH_THRESHOLD = 0.5;

const DEDUPE_ELIGIBLE_CHANGES = new Set(['new', 'spiking']);

export interface SignatureRecord {
  projectId: string;
  issueId: string;
  title: string;
  summaryLine: string | null;
  firstAt: number;
  lastAt: number;
  recurrences: number;
  escalated: boolean;
  recurredIssueIds: string[];
}

export interface RecurrenceScore {
  score: number;
  shared: number;
  corroboration: number;
  threshold: number;
  matched: boolean;
}

export interface RecurrenceMatch extends RecurrenceScore {
  key: string;
  record: SignatureRecord;
}

export interface RecurrenceDecision {
  action: string;
  reason: string;
  matchKey: string | null;
  matchIssueId: string | null;
  ordinal: number;
  score: number;
}

export interface RecurrenceOptions {
  recurrenceDedupe?: boolean;
  recurrenceWindowDays?: number;
  transientRecurrenceLimit?: number;
  now?: number;
  minUsersToInvestigate?: number;
  userEscalationThreshold?: number;
}

const GENERIC_TOKENS = new Set([
  'error', 'errors', 'exception', 'failed', 'failure', 'failing', 'fail',
  'cannot', 'could', 'not', 'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that',
  'undefined', 'null', 'nan', 'defined', 'object', 'string', 'number', 'boolean', 'value', 'values',
  'function', 'method', 'call', 'called', 'calling', 'when', 'while', 'has', 'have', 'was', 'were',
  'are', 'its', 'you', 'your', 'they', 'them',
  'read', 'reading', 'property', 'properties', 'invalid', 'unexpected', 'token', 'required',
  'type', 'types', 'unknown', 'missing', 'empty',
]);

function dayMs(days: unknown, fallback: number): number {
  const n = toCount(days, fallback);
  const safe = n > 0 ? n : fallback;
  return safe * 86400000;
}

function isBuildHashish(token: string): boolean {
  if (token.length > 8) return false;
  return /[a-z]/.test(token) && /\d/.test(token);
}

function distinctiveTokens(...texts: unknown[]): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const text of texts) {
    for (const raw of String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3) continue;
      if (!/[a-z]/.test(raw)) continue;
      if (/^[0-9a-f]{6,}$/.test(raw)) continue;
      if (isBuildHashish(raw)) continue;
      if (GENERIC_TOKENS.has(raw)) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      tokens.push(raw);
    }
  }
  return tokens;
}

function sharedTokenCount(a: Iterable<string>, b: Iterable<string>): number {
  const other = new Set(b);
  let shared = 0;
  for (const token of new Set(a)) {
    if (other.has(token)) shared += 1;
  }
  return shared;
}

function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  const shared = sharedTokenCount(left, right);
  const union = left.size + right.size - shared;
  if (union <= 0) return 0;
  return shared / union;
}

function scoreAgainstPrior(
  candidateTokens: string[],
  prior: { title?: unknown; summaryLine?: unknown } = {},
): RecurrenceScore {
  const priorTokens = distinctiveTokens(prior.title);
  const summaryTokens = distinctiveTokens(prior.summaryLine);
  const shared = sharedTokenCount(candidateTokens, priorTokens);
  const corroboration = sharedTokenCount(candidateTokens, summaryTokens);
  const score = jaccard(candidateTokens, priorTokens);
  const threshold = corroboration >= MIN_SUMMARY_CORROBORATION ? CORROBORATED_MATCH_THRESHOLD : MATCH_THRESHOLD;
  const matched = priorTokens.length >= MIN_DISTINCTIVE_TOKENS
    && shared >= MIN_SHARED_TOKENS
    && score >= threshold;
  return { score, shared, corroboration, threshold, matched };
}

function signatureRecords(state: unknown = {}): Record<string, SignatureRecord> {
  const registry = state && typeof state === 'object' ? (state as Record<string, unknown>)[SIGNATURES_KEY] : null;
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return {};
  return registry as Record<string, SignatureRecord>;
}

function findRecurrenceMatch(
  { title, projectId, key }: { title?: unknown; projectId?: unknown; key?: unknown } = {},
  state: unknown = {},
  nowMs: unknown = 0,
  opts: RecurrenceOptions = {},
): RecurrenceMatch | null {
  const candidateTokens = distinctiveTokens(title);
  if (candidateTokens.length < MIN_DISTINCTIVE_TOKENS) return null;
  const windowMs = dayMs(opts.recurrenceWindowDays, DEFAULT_RECURRENCE_WINDOW_DAYS);
  const now = toCount(nowMs, 0);
  const wantedProject = String(projectId ?? '');
  const matches: RecurrenceMatch[] = [];
  for (const [recordKey, record] of Object.entries(signatureRecords(state))) {
    if (!record || typeof record !== 'object') continue;
    if (recordKey === String(key ?? '')) continue;
    if (String(record.projectId ?? '') !== wantedProject) continue;
    if (now - toCount(record.lastAt, 0) >= windowMs) continue;
    const scored = scoreAgainstPrior(candidateTokens, record);
    if (!scored.matched) continue;
    matches.push({ key: recordKey, record, ...scored });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => (
    b.score - a.score
    || toCount(b.record.lastAt, 0) - toCount(a.record.lastAt, 0)
    || a.key.localeCompare(b.key)
  ));
  return matches[0];
}

function escalationReason(
  change: { change?: string; issue?: { users?: unknown } | null } | null | undefined,
  ordinal: number,
  opts: RecurrenceOptions = {},
): string | null {
  const limit = toCount(opts.transientRecurrenceLimit, DEFAULT_TRANSIENT_RECURRENCE_LIMIT);
  const safeLimit = limit > 0 ? limit : DEFAULT_TRANSIENT_RECURRENCE_LIMIT;
  if (ordinal >= safeLimit) return 'limit';
  if (toCount(change?.issue?.users, 0) > 1) return 'users';
  if (change?.change === 'spiking') return 'spike';
  return null;
}

function decideRecurrence(
  change: { change?: string; key?: string; issue?: { title?: unknown; users?: unknown } | null; projectId?: unknown } = {},
  state: Record<string, unknown> = {},
  opts: RecurrenceOptions = {},
): RecurrenceDecision {
  const spawn = (reason: string): RecurrenceDecision => ({ action: 'spawn', reason, matchKey: null, matchIssueId: null, ordinal: 0, score: 0 });
  if (opts.recurrenceDedupe === false) return spawn('disabled');
  if (!DEDUPE_ELIGIBLE_CHANGES.has(change.change ?? '')) return spawn('not-eligible');
  if ((state[change.key ?? ''] as { verdict?: unknown } | undefined)?.verdict) return spawn('own-verdict');
  const match = findRecurrenceMatch({
    title: change.issue?.title,
    projectId: change.projectId,
    key: change.key,
  }, state, opts.now, opts);
  if (!match) return spawn('no-match');
  if (match.record.escalated === true) return spawn('escalated-cluster');
  const ordinal = toCount(match.record.recurrences, 0) + 1;
  const verdict = {
    matchKey: match.key,
    matchIssueId: String(match.record.issueId ?? ''),
    ordinal,
    score: match.score,
  };
  const escalation = escalationReason(change, ordinal, opts);
  if (escalation) return { action: 'escalate', reason: escalation, ...verdict };
  return { action: 'dedupe', reason: 'prior-transient', ...verdict };
}

function planIssueActions(
  changes: PosthogIssueChange[],
  state: Record<string, unknown> = {},
  opts: RecurrenceOptions = {},
): {
  investigate: { change: PosthogIssueChange; recurrence: RecurrenceDecision }[];
  dedupe: { change: PosthogIssueChange; recurrence: RecurrenceDecision }[];
} {
  const investigate: { change: PosthogIssueChange; recurrence: RecurrenceDecision }[] = [];
  const dedupe: { change: PosthogIssueChange; recurrence: RecurrenceDecision }[] = [];
  for (const change of planInvestigations(changes, state, opts)) {
    const recurrence = decideRecurrence(change, state, opts);
    if (recurrence.action === 'dedupe') {
      dedupe.push({ change, recurrence });
      continue;
    }
    investigate.push({ change, recurrence });
  }
  return { investigate, dedupe };
}

function normalizeRecord(record: unknown): SignatureRecord {
  const fields = record as Record<string, unknown>;
  return {
    projectId: String(fields.projectId ?? ''),
    issueId: String(fields.issueId ?? ''),
    title: String(fields.title ?? ''),
    summaryLine: fields.summaryLine == null ? null : String(fields.summaryLine),
    firstAt: toCount(fields.firstAt, 0),
    lastAt: toCount(fields.lastAt, 0),
    recurrences: toCount(fields.recurrences, 0),
    escalated: fields.escalated === true,
    recurredIssueIds: Array.isArray(fields.recurredIssueIds) ? fields.recurredIssueIds.map(String) : [],
  };
}

function recordTransientSignature(
  state: unknown = {},
  {
    key,
    projectId,
    issueId,
    title,
    summaryLine,
    at,
  }: { key?: unknown; projectId?: unknown; issueId?: unknown; title?: unknown; summaryLine?: unknown; at?: unknown } = {},
): Record<string, SignatureRecord> {
  const wanted = String(key ?? '');
  if (!wanted) return signatureRecords(state);
  const registry = { ...signatureRecords(state) };
  const stamp = toCount(at, 0);
  const existing = registry[wanted];
  if (existing && typeof existing === 'object') {
    registry[wanted] = { ...normalizeRecord(existing), lastAt: stamp };
    return registry;
  }
  registry[wanted] = normalizeRecord({
    projectId, issueId, title, summaryLine, firstAt: stamp, lastAt: stamp, recurrences: 0, escalated: false,
  });
  return registry;
}

function noteRecurrence(
  state: unknown = {},
  key?: unknown,
  { at, issueId, escalated = false }: { at?: unknown; issueId?: unknown; escalated?: boolean } = {},
): Record<string, SignatureRecord> {
  const wanted = String(key ?? '');
  const registry = { ...signatureRecords(state) };
  const existing = registry[wanted];
  if (!existing || typeof existing !== 'object') return registry;
  const record = normalizeRecord(existing);
  const ids = [...record.recurredIssueIds, String(issueId ?? '')].filter(Boolean);
  registry[wanted] = {
    ...record,
    lastAt: toCount(at, record.lastAt),
    recurrences: record.recurrences + 1,
    escalated: record.escalated || escalated === true,
    recurredIssueIds: ids.slice(Math.max(0, ids.length - RECURRED_ID_CAP)),
  };
  return registry;
}

function pruneSignatures(
  state: unknown = {},
  nowMs: unknown = 0,
  opts: RecurrenceOptions = {},
): Record<string, SignatureRecord> {
  const windowMs = dayMs(opts.recurrenceWindowDays, DEFAULT_RECURRENCE_WINDOW_DAYS);
  const now = toCount(nowMs, 0);
  const live = Object.entries(signatureRecords(state))
    .filter(([, record]) => record && typeof record === 'object')
    .filter(([, record]) => now - toCount(record.lastAt, 0) < windowMs)
    .sort((a, b) => toCount(b[1].lastAt, 0) - toCount(a[1].lastAt, 0) || a[0].localeCompare(b[0]))
    .slice(0, SIGNATURE_CAP);
  return Object.fromEntries(live);
}

function recurrenceSummaryLine({ matchIssueId, ordinal }: { matchIssueId?: unknown; ordinal?: unknown } = {}): string {
  const priorId = String(matchIssueId ?? '').trim() || 'unknown';
  return `TRANSIENT by recurrence: matches prior transient issue ${priorId} (repeat ${toCount(ordinal, 1)}); no investigation spawned`;
}

function escalationDetail({
  ordinal,
  matchIssueId,
  reason,
  recurrenceWindowDays,
}: { ordinal?: unknown; matchIssueId?: unknown; reason?: string; recurrenceWindowDays?: unknown } = {}): string {
  const days = toCount(recurrenceWindowDays, DEFAULT_RECURRENCE_WINDOW_DAYS);
  const priorId = String(matchIssueId ?? '').trim() || 'unknown';
  const head = `recurring transient escalated: repeat ${toCount(ordinal, 1)} within ${days} days of issue ${priorId}`;
  if (reason === 'users') return `${head}, now affecting more than one user`;
  if (reason === 'spike') return `${head}, and PostHog reports it spiking`;
  return head;
}

export {
  distinctiveTokens,
  jaccard,
  scoreAgainstPrior,
  findRecurrenceMatch,
  escalationReason,
  decideRecurrence,
  planIssueActions,
  recordTransientSignature,
  noteRecurrence,
  pruneSignatures,
  signatureRecords,
  recurrenceSummaryLine,
  escalationDetail,
  SIGNATURES_KEY,
  SIGNATURE_CAP,
  DEFAULT_RECURRENCE_WINDOW_DAYS,
  DEFAULT_TRANSIENT_RECURRENCE_LIMIT,
};
