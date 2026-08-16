'use strict';

// Pure cross-issue recurrence memory for the PostHog lane: a signature registry under one
// underscore state key, conservative token matching that fails toward spawning (a false positive
// silently swallows a real bug), and the spawn/dedupe/escalate decision the poller acts on.

const { planInvestigations, toCount } = require('./posthog-core');

// The recency window a prior TRANSIENT verdict is trusted within. Past it the registry record is not
// just unusable for matching, it is pruned: a transient nobody has seen for a week is not evidence.
const DEFAULT_RECURRENCE_WINDOW_DAYS = 7;
// Which recurrence stops trusting the old verdict. 3 means the third repeat of a signature escalates:
// twice is a coincidence, three times in a week is a pattern worth paying to diagnose.
const DEFAULT_TRANSIENT_RECURRENCE_LIMIT = 3;

const SIGNATURES_KEY = '_signatures';
// Newest-by-lastAt, oldest dropped. Records also age out at the window, so this cap only bounds a
// pathological project that mints hundreds of distinct transients inside one window.
const SIGNATURE_CAP = 200;
// How many recurring issue ids one record remembers, for the operator reading the state file.
const RECURRED_ID_CAP = 10;

// Below this many distinctive tokens a title says nothing specific enough to dedupe on, whichever
// side of the comparison it is on.
const MIN_DISTINCTIVE_TOKENS = 3;
// An absolute floor under the ratio: two three-token titles sharing two tokens score 0.5 by Jaccard,
// which is not evidence of the same incident.
const MIN_SHARED_TOKENS = 3;
// Jaccard over the distinctive token sets. Union-based (not the far more generous overlap
// coefficient) so a short title cannot match by being a subset of a long one.
const MATCH_THRESHOLD = 0.6;
// The prior verdict's own summary line is written by the investigating agent, in its own vocabulary,
// so it is corroboration rather than a primary signal: sharing this many distinctive tokens with it
// lowers the title threshold to CORROBORATED_MATCH_THRESHOLD. It can only ever loosen a near miss,
// never tighten a match, and the shared-token floor still applies.
const MIN_SUMMARY_CORROBORATION = 2;
const CORROBORATED_MATCH_THRESHOLD = 0.5;

// Only a would-be FIRST investigation of an issue id can be deduped. 'regressed' and 'worsened' carry
// that issue's OWN history saying something changed, which is exactly the evidence a stale cluster
// verdict must not override. 'spiking' is eligible only so a spike can trip the escalation below: it
// never dedupes.
const DEDUPE_ELIGIBLE_CHANGES = new Set(['new', 'spiking']);

// Error-message boilerplate. Two unrelated defects share all of this, so leaving it in would let
// stock V8 phrasing carry a match on its own.
const GENERIC_TOKENS = new Set([
  'error', 'errors', 'exception', 'failed', 'failure', 'failing', 'fail',
  'cannot', 'could', 'not', 'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that',
  'undefined', 'null', 'nan', 'defined', 'object', 'string', 'number', 'boolean', 'value', 'values',
  'function', 'method', 'call', 'called', 'calling', 'when', 'while', 'has', 'have', 'was', 'were',
  'are', 'its', 'you', 'your', 'they', 'them',
  'read', 'reading', 'property', 'properties', 'invalid', 'unexpected', 'token', 'required',
  'type', 'types', 'unknown', 'missing', 'empty',
]);

function dayMs(days, fallback) {
  const n = toCount(days, fallback);
  const safe = n > 0 ? n : fallback;
  return safe * 86400000;
}

// A build hash (`maplibre-gl-B3nQ.js`) changes on every deploy while naming the same asset, so a
// short mixed letters-and-digits token is noise that would otherwise pull a true recurrence apart.
function isBuildHashish(token) {
  if (token.length > 8) return false;
  return /[a-z]/.test(token) && /\d/.test(token);
}

// Deduped distinctive tokens: lowercased, split on non-alphanumerics, stripped of short fragments,
// digits, hex ids, build hashes, and boilerplate that cannot distinguish two incidents.
function distinctiveTokens(...texts) {
  const seen = new Set();
  const tokens = [];
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

function sharedTokenCount(a, b) {
  const other = new Set(b);
  let shared = 0;
  for (const token of new Set(a)) {
    if (other.has(token)) shared += 1;
  }
  return shared;
}

/** Jaccard similarity of two token lists: shared over union, so a subset never scores a free 1.0. */
function jaccard(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  const shared = sharedTokenCount(left, right);
  const union = left.size + right.size - shared;
  if (union <= 0) return 0;
  return shared / union;
}

// Returns the decision inputs, not a bare boolean, so tests can see why a near miss missed.
function scoreAgainstPrior(candidateTokens, prior = {}) {
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

function signatureRecords(state = {}) {
  const registry = state && typeof state === 'object' ? state[SIGNATURES_KEY] : null;
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return {};
  return registry;
}

// Best in-window same-project prior transient, or null; total ordering (score, recency, key) keeps
// the pick deterministic for a given state file.
function findRecurrenceMatch({ title, projectId, key } = {}, state = {}, nowMs = 0, opts = {}) {
  const candidateTokens = distinctiveTokens(title);
  if (candidateTokens.length < MIN_DISTINCTIVE_TOKENS) return null;
  const windowMs = dayMs(opts.recurrenceWindowDays, DEFAULT_RECURRENCE_WINDOW_DAYS);
  const now = toCount(nowMs, 0);
  const wantedProject = String(projectId ?? '');
  const matches = [];
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

// Why a matched recurrence must be investigated anyway (repeats, blast radius, or a spike), or null
// when the prior verdict still holds.
function escalationReason(change, ordinal, opts = {}) {
  const limit = toCount(opts.transientRecurrenceLimit, DEFAULT_TRANSIENT_RECURRENCE_LIMIT);
  const safeLimit = limit > 0 ? limit : DEFAULT_TRANSIENT_RECURRENCE_LIMIT;
  if (ordinal >= safeLimit) return 'limit';
  if (toCount(change?.issue?.users, 0) > 1) return 'users';
  if (change?.change === 'spiking') return 'spike';
  return null;
}

// Spawn (no usable prior), dedupe (confident in-window match, no session spawned), or escalate
// (matched but the pattern changed, so the stale verdict is never reused again).
function decideRecurrence(change = {}, state = {}, opts = {}) {
  const spawn = (reason) => ({ action: 'spawn', reason, matchKey: null, matchIssueId: null, ordinal: 0, score: 0 });
  if (opts.recurrenceDedupe === false) return spawn('disabled');
  if (!DEDUPE_ELIGIBLE_CHANGES.has(change.change)) return spawn('not-eligible');
  if (state[change.key]?.verdict) return spawn('own-verdict');
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

// planInvestigations crossed with recurrence memory; deduped items are split out, not dropped,
// because they still get a verdict, an inbox record and a broadcast.
function planIssueActions(changes, state = {}, opts = {}) {
  const investigate = [];
  const dedupe = [];
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

function normalizeRecord(record) {
  return {
    projectId: String(record.projectId ?? ''),
    issueId: String(record.issueId ?? ''),
    title: String(record.title ?? ''),
    summaryLine: record.summaryLine == null ? null : String(record.summaryLine),
    firstAt: toCount(record.firstAt, 0),
    lastAt: toCount(record.lastAt, 0),
    recurrences: toCount(record.recurrences, 0),
    escalated: record.escalated === true,
    recurredIssueIds: Array.isArray(record.recurredIssueIds) ? record.recurredIssueIds.map(String) : [],
  };
}

// Open or refresh a cluster; a refresh keeps the original title (the matching corpus) and counter,
// moving only the recency window forward. Returns a new registry.
function recordTransientSignature(state = {}, { key, projectId, issueId, title, summaryLine, at } = {}) {
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

// Count one repeat (optionally latching escalated); the counter lives on the cluster so it outlives
// the deduped issue's own entry.
function noteRecurrence(state = {}, key, { at, issueId, escalated = false } = {}) {
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

// Drop clusters past the window and cap the rest at the newest SIGNATURE_CAP. Returns a new registry.
function pruneSignatures(state = {}, nowMs = 0, opts = {}) {
  const windowMs = dayMs(opts.recurrenceWindowDays, DEFAULT_RECURRENCE_WINDOW_DAYS);
  const now = toCount(nowMs, 0);
  const live = Object.entries(signatureRecords(state))
    .filter(([, record]) => record && typeof record === 'object')
    .filter(([, record]) => now - toCount(record.lastAt, 0) < windowMs)
    .sort((a, b) => toCount(b[1].lastAt, 0) - toCount(a[1].lastAt, 0) || a[0].localeCompare(b[0]))
    .slice(0, SIGNATURE_CAP);
  return Object.fromEntries(live);
}

/** The verdict summary recorded for an investigation that never ran, naming the prior it reused. */
function recurrenceSummaryLine({ matchIssueId, ordinal } = {}) {
  const priorId = String(matchIssueId ?? '').trim() || 'unknown';
  return `TRANSIENT by recurrence: matches prior transient issue ${priorId} (repeat ${toCount(ordinal, 1)}); no investigation spawned`;
}

/** The extra Telegram line for an escalation, explaining what stopped the old verdict being reused. */
function escalationDetail({ ordinal, matchIssueId, reason, recurrenceWindowDays } = {}) {
  const days = toCount(recurrenceWindowDays, DEFAULT_RECURRENCE_WINDOW_DAYS);
  const priorId = String(matchIssueId ?? '').trim() || 'unknown';
  const head = `recurring transient escalated: repeat ${toCount(ordinal, 1)} within ${days} days of issue ${priorId}`;
  if (reason === 'users') return `${head}, now affecting more than one user`;
  if (reason === 'spike') return `${head}, and PostHog reports it spiking`;
  return head;
}

module.exports = {
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
