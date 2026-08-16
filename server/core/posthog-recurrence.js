'use strict';

/*
 * Pure recurrence core of the PostHog lane. Sibling of core/posthog-core.js (which it composes with,
 * and which stays require-free): no IO, no clock, no state file.
 *
 * WHY THIS EXISTS. PostHog mints a fresh issue id whenever an error's grouping fingerprint shifts, so
 * one non-event (a crawler failing to lazy-load a chunk) produced two ids hours apart and each one
 * bought its own paid investigation, both concluding TRANSIENT. The lane had no cross-issue memory:
 * every id is new to it. This module is that memory, and the decision it feeds.
 *
 * The memory is a SIGNATURE REGISTRY parked under one underscore key in the state file, so an older
 * server (which iterates issue keys and skips anything starting with '_') loads a newer file unharmed.
 * A record is written when an investigation concludes TRANSIENT and holds the tokens a later issue is
 * matched against, plus the recurrence counter and the escalated latch. It lives in the registry
 * rather than on the issue entry because entries age out on their own clock: the counter has to
 * outlive both the entry that opened the cluster and every entry deduped into it.
 *
 * MATCHING IS DELIBERATELY CONSERVATIVE. A false positive here silently swallows a real bug, while a
 * false negative only costs one investigation, so every rule below is written to fail toward spawning:
 * boilerplate tokens are stripped before comparison (an error title alone means nothing, "TypeError"
 * matches half the internet), a signature with fewer than MIN_DISTINCTIVE_TOKENS distinctive tokens
 * never matches at all, and a match needs both a high token overlap and an absolute floor of shared
 * tokens.
 */

const { planInvestigations } = require('./posthog-core');

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

function toCount(value, fallback = 0) {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  return fallback;
}

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

/**
 * The distinctive tokens of one or more texts, deduped, in first-seen order. Lowercased, split on
 * every non-alphanumeric run, then stripped of anything that cannot distinguish two incidents:
 * fragments under three characters, pure digits, hex-looking ids, build hashes, and boilerplate.
 */
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

/**
 * Score one candidate title against one prior transient. Returns the decision inputs rather than a
 * bare boolean so a test (and the decision log) can see WHY a near miss missed.
 */
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

/**
 * The best prior transient this candidate recurs from, or null.
 *
 * Records outside the recency window, from another PostHog project, or belonging to this very issue
 * are not candidates. Ordering is total (score, then recency, then key) so the same state file always
 * picks the same prior.
 */
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

/**
 * Why a matched recurrence must be investigated anyway, or null when the prior verdict still holds.
 *
 * Each trigger is a way the pattern changed since the verdict that is being reused: enough repeats
 * that "one-off" stopped being credible, a blast radius past a single carbon unit, or PostHog's own
 * spike detection naming it.
 */
function escalationReason(change, ordinal, opts = {}) {
  const limit = toCount(opts.transientRecurrenceLimit, DEFAULT_TRANSIENT_RECURRENCE_LIMIT);
  const safeLimit = limit > 0 ? limit : DEFAULT_TRANSIENT_RECURRENCE_LIMIT;
  if (ordinal >= safeLimit) return 'limit';
  if (toCount(change?.issue?.users, 0) > 1) return 'users';
  if (change?.change === 'spiking') return 'spike';
  return null;
}

/**
 * Spawn, dedupe, or escalate one candidate investigation.
 *
 *   'spawn'    - no usable prior, or the feature is off: the lane behaves exactly as it did before.
 *   'dedupe'   - a confident match against a prior transient inside the window. No session is spawned;
 *                the caller records the verdict directly and increments the cluster's counter.
 *   'escalate' - matched, but the pattern changed (see escalationReason). A fresh investigation runs
 *                and the cluster latches escalated, so its stale verdict is never reused again.
 *
 * `reason` is carried on every verdict for the operator reading a state file or a test naming a case.
 */
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

/**
 * The one planning call the poller makes: which changes earn attention (core.planInvestigations, the
 * pre-existing filter) crossed with what recurrence memory says to do about each. Deduped items are
 * split out rather than dropped, because they still get a verdict, an inbox record and a broadcast.
 */
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

/**
 * Open or refresh the cluster a TRANSIENT verdict belongs to. Refreshing keeps the ORIGINAL title and
 * counter (that title is the corpus every later candidate is matched against, and the counter must
 * survive) and only moves the recency window forward. Returns a new registry; the input is untouched.
 */
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

/**
 * Count one repeat against a cluster, optionally latching it escalated. The counter lives here, on
 * the cluster, precisely so it outlives the deduped issue's own entry when that entry ages out.
 */
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

/**
 * Drop clusters past the recency window (they can no longer match anything) and cap what is left at
 * the newest SIGNATURE_CAP. Returns a new registry; the input is not mutated.
 */
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
