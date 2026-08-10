'use strict';

/*
 * Pure core of the PostHog monitoring lane (sibling of core/pr-review-core.js). No IO, no requires:
 * every decision the poller makes about an error-tracking issue lives here so it is unit-testable
 * without a PostHog instance, a state file, or a spawned session.
 *
 * The lane diffs each tick's issue aggregates against the persisted per-issue entry and classifies
 * the change; the poller turns that classification into investigations and Telegram pings.
 */

const DEFAULT_USER_ESCALATION_THRESHOLD = 25;
const DEFAULT_MIN_USERS_TO_INVESTIGATE = 1;
// How long a tracked issue survives after it stops appearing in the active query. queryIssues only
// returns the top 50 active issues of the last 24h, so ABSENCE IS NOT DEATH: a recurring issue that
// slips off the list would otherwise lose its verdict history and re-classify as brand new on its
// next appearance. Entries age out on a clock instead.
const DEFAULT_ENTRY_RETENTION_DAYS = 7;
// Titles are end-user error messages: attacker-influenced free text that reaches Telegram verbatim.
// They are a display surface, so they are truncated and flattened rather than dropped.
const MAX_PING_TITLE_CHARS = 200;

// Telegram ping labels. A kind absent from this map is digest-only or unknown and never pings:
// 'root_cause' deliberately has no entry (a diagnosed issue belongs in the daily digest, not on the
// operator's lock screen).
const PING_LABELS = {
  spike: 'SPIKE',
  regression: 'REGRESSED',
  needs_human: 'NEEDS HUMAN',
  error: 'ERROR',
  new_high_impact: 'HIGH IMPACT',
};

function stripProtocol(host) {
  return String(host || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function toCount(value, fallback = 0) {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  return fallback;
}

// Stable cross-instance identity of one issue: the same issue id can exist in two PostHog projects
// and two self-hosted instances, so both are part of the key (mirrors prKey's repoSlug#number).
function issueKey(host, projectId, issueId) {
  return `${stripProtocol(host)}/${projectId}#${issueId}`;
}

function issueUrl(host, projectId, issueId) {
  const base = String(host || '').replace(/\/+$/, '');
  return `${base}/project/${projectId}/error_tracking/${issueId}`;
}

function isActive(status) {
  return String(status || 'active').toLowerCase() === 'active';
}

// Flatten to a single line (a title carrying newlines could otherwise forge the lane-tag header of a
// Telegram message) and cap the length so a crafted megabyte title cannot blow up the send.
function displayTitle(title) {
  const flat = String(title || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_PING_TITLE_CHARS) return flat;
  return `${flat.slice(0, MAX_PING_TITLE_CHARS - 3)}...`;
}

/**
 * Classify what happened to one issue since the last tick.
 *
 * Ordered by severity, not by cheapness: a spiking issue that also just regressed reports 'spiking',
 * because that is the fact worth waking the operator for. 'worsened' needs a PRIOR VERDICT: without
 * one there is nothing to re-open, and the first-sighting case is already covered by 'new'.
 */
function classifyIssueChange(prevEntry, current, spikeIssueIds, opts = {}) {
  const threshold = opts.userEscalationThreshold ?? DEFAULT_USER_ESCALATION_THRESHOLD;
  const spikes = spikeIssueIds || new Set();
  if (spikes.has(String(current.issueId))) return 'spiking';
  if (prevEntry && String(prevEntry.status).toLowerCase() === 'resolved' && isActive(current.status)) {
    return 'regressed';
  }
  if (!prevEntry && isActive(current.status)) return 'new';
  if (prevEntry?.verdict) {
    const before = toCount(prevEntry.investigatedUsers, 0);
    const now = toCount(current.users, 0);
    if (before < threshold && now >= threshold) return 'worsened';
  }
  return 'quiet';
}

/**
 * Select the changes that earn an investigation session. Regressed and worsened always do; a
 * brand-new issue must clear minUsersToInvestigate so a one-off crash on a single device does not
 * spend a Claude session. Entries already inFlight are skipped. The concurrency cap is NOT applied
 * here - the poller owns the slots (it knows what is already running).
 *
 * SPIKING is the one classification that can repeat indefinitely: an issue whose spike endpoint keeps
 * naming it classifies spiking on every tick, so an unconditional re-investigation meant a fresh
 * Claude session every interval, forever, for an issue that was already diagnosed. An ALREADY
 * DIAGNOSED spiking issue therefore only re-investigates when the blast radius actually grew past the
 * escalation threshold since that diagnosis (the same evidence 'worsened' demands).
 */
function planInvestigations(changes, state = {}, opts = {}) {
  const minUsers = opts.minUsersToInvestigate ?? DEFAULT_MIN_USERS_TO_INVESTIGATE;
  const threshold = opts.userEscalationThreshold ?? DEFAULT_USER_ESCALATION_THRESHOLD;
  return changes.filter((change) => {
    const entry = state[change.key];
    if (entry?.inFlight) return false;
    if (change.change === 'spiking') {
      if (!entry?.verdict) return true;
      const before = toCount(entry.investigatedUsers, 0);
      const now = toCount(change.issue?.users, 0);
      return before < threshold && now >= threshold;
    }
    if (change.change === 'regressed') return true;
    if (change.change === 'worsened') return true;
    if (change.change === 'new') return toCount(change.issue?.users, 0) >= minUsers;
    return false;
  });
}

/**
 * Build the Telegram text for one ping kind, or null when the kind never pings. The lane tag comes
 * first so a shared chat can be filtered by lane (mirrors the PR lane's messages).
 */
function pingFor(kind, ctx = {}) {
  const label = PING_LABELS[kind];
  if (!label) return null;
  const head = ctx.projectName ? `[glissa/posthog] ${label} ${ctx.projectName}` : `[glissa/posthog] ${label}`;
  return [
    head,
    displayTitle(ctx.title),
    `${toCount(ctx.occurrences, 0)} occurrences / ${toCount(ctx.users, 0)} users`,
    String(ctx.url || ''),
  ].join('\n');
}

/**
 * Fold this tick's observation (and an optional investigation result) into the persisted entry.
 * `verdictInfo.at` is passed in rather than read from a clock so this stays synchronously testable.
 */
function nextState(prevEntry, current, verdictInfo = {}) {
  const prev = prevEntry || {};
  const info = verdictInfo || {};
  const entry = {
    status: current.status || prev.status || 'active',
    lastOccurrences: toCount(current.occurrences, toCount(prev.lastOccurrences, 0)),
    lastUsers: toCount(current.users, toCount(prev.lastUsers, 0)),
    lastSeen: current.lastSeen || prev.lastSeen || null,
    investigatedAt: prev.investigatedAt ?? null,
    investigatedUsers: prev.investigatedUsers ?? null,
    verdict: prev.verdict ?? null,
    inFlight: info.inFlight === true,
    pingedPhases: Array.isArray(info.pingedPhases) ? [...info.pingedPhases] : [...(prev.pingedPhases || [])],
  };
  if (!info.verdict) return entry;
  entry.verdict = info.verdict;
  entry.investigatedAt = info.at ?? null;
  entry.investigatedUsers = toCount(current.users, 0);
  return entry;
}

/**
 * What to do with a tracked entry whose issue is absent from this tick's active list.
 *
 *   'keep'    - an investigation is still running against it; deleting the entry would undercount
 *               concurrency and lose its pingedPhases mid-run.
 *   'resolve' - first tick of absence: mark it resolved (ASSUMED, not read back from PostHog) and
 *               stamp vanishedAt. That assumed status is what lets a later reappearance classify as
 *               'regressed'; the active-only query can never hand us a resolved row to compare.
 *   'prune'   - it has been gone longer than the retention window, so its history is stale enough to
 *               drop and a reappearance may legitimately read as new.
 */
function decideVanishedEntry(entry, nowTs, opts = {}) {
  if (!entry || typeof entry !== 'object') return 'prune';
  if (entry.inFlight) return 'keep';
  const days = opts.entryRetentionDays ?? DEFAULT_ENTRY_RETENTION_DAYS;
  const vanishedAt = toCount(entry.vanishedAt, 0);
  if (!vanishedAt) return 'resolve';
  if (toCount(nowTs, 0) - vanishedAt >= days * 86400000) return 'prune';
  return 'keep';
}

module.exports = {
  issueKey,
  issueUrl,
  classifyIssueChange,
  planInvestigations,
  decideVanishedEntry,
  pingFor,
  nextState,
  displayTitle,
  DEFAULT_USER_ESCALATION_THRESHOLD,
  DEFAULT_MIN_USERS_TO_INVESTIGATE,
  DEFAULT_ENTRY_RETENTION_DAYS,
  MAX_PING_TITLE_CHARS,
};
