// ── Radar core (pure) ────────────────────────────────────────
// Attention ordering and severity mapping for PostHog issue rows, plus the aggregation that turns the
// three outside-world feeds (PostHog issues, ops telemetry, PR auto-review) into Radar's sections and
// its one attention count. No DOM, no IO.

import { normalizePhase, prNeedsAction, severityFor as prSeverityFor, sortPrsByAttention } from './pr-view-core.mjs';

// Rank is attention-first, deliberately NOT the same grouping as severity: a brand new issue is
// less urgent than one that already regressed, yet both share the warn stripe.
const CHANGE_RANK = {
  spiking: 0,
  regressed: 1,
  worsened: 2,
  new: 3,
  quiet: 4,
};

const CHANGE_SEVERITY = {
  spiking: 'crit',
  regressed: 'crit',
  worsened: 'warn',
  new: 'warn',
  quiet: 'dim',
};

const UNKNOWN_RANK = 99;

export function severityFor(change) {
  return CHANGE_SEVERITY[change] || 'dim';
}

function finiteNumbers(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
}

export function sparklinePoints(values, width = 64, height = 16) {
  const numbers = finiteNumbers(values);
  if (numbers.length < 2) return '';
  const max = Math.max(...numbers);
  const min = Math.min(...numbers);
  const xStep = width / (numbers.length - 1);
  const yMid = height / 2;
  const span = max - min;
  return numbers.map((value, index) => {
    const x = index * xStep;
    const y = span === 0 ? yMid : height - ((value - min) / span) * height;
    return `${Number(x.toFixed(2))},${Number(y.toFixed(2))}`;
  }).join(' ');
}

// One pass for the per-project summary line and the tab attention badge. Active is every tracked
// issue; spiking and needsHuman are the two conditions that mean "look at this now".
export function summarizeIssues(issues) {
  const list = Array.isArray(issues) ? issues : [];
  let spiking = 0;
  let needsHuman = 0;
  for (const issue of list) {
    if (issue?.change === 'spiking') spiking += 1;
    if (issue?.verdict === 'NEEDS_HUMAN') needsHuman += 1;
  }
  return { active: list.length, spiking, needsHuman };
}

// ── Investigations inbox ─────────────────────────────────────
// The persisted log of completed investigations (server/core/posthog-core.js), carried on the same
// posthog-status broadcast. Rows survive their issue: a resolved issue leaves the Errors section
// immediately, and its verdict would leave with it. An absent field renders nothing, so an older
// server keeps behaving exactly as before.
// `locallyArchivedIds` is the panel's own record of what the operator archived in this page session.
// It is a SECOND filter, not a replacement for `archived`: a payload the server built before (or a
// cached one it replayed after) the archive still carries the record, and the row must stay gone.
export function investigationRows(snapshot, locallyArchivedIds = null) {
  const list = Array.isArray(snapshot?.investigations) ? snapshot.investigations : [];
  return list
    .filter((record) => record && typeof record === 'object')
    .filter((record) => typeof record.id === 'string' && record.id)
    .filter((record) => record.archived !== true)
    .filter((record) => !locallyArchivedIds?.has(record.id))
    .map((record) => ({
      id: record.id,
      issueId: textOr(record.issueId, ''),
      projectId: record.projectId ?? null,
      projectLabel: textOr(record.projectName, ''),
      title: textOr(record.title, 'Untitled issue'),
      summaryLine: textOr(record.summaryLine, ''),
      url: textOr(record.url, ''),
      verdict: textOr(record.verdict, 'ERROR').toUpperCase(),
      at: Number.isFinite(Number(record.at)) ? Number(record.at) : 0,
    }))
    .sort((a, b) => b.at - a.at);
}

// Drop, IN PLACE, every remembered id this payload no longer carries at all. Once the server stops
// sending a record (the archive round-tripped, or the retention purge dropped it) there is nothing
// left to suppress, so the caller's guard set can never grow without bound. Returns the same set so
// a caller can chain; mutating in place is deliberate, the panel holds one long-lived set.
export function retainKnownInvestigationIds(snapshot, ids) {
  if (!ids || ids.size === 0) return ids;
  const list = Array.isArray(snapshot?.investigations) ? snapshot.investigations : [];
  const present = new Set();
  for (const record of list) {
    if (record && typeof record === 'object' && typeof record.id === 'string') present.add(record.id);
  }
  for (const id of [...ids]) {
    if (present.has(id)) continue;
    ids.delete(id);
  }
  return ids;
}

// ── Ops section ──────────────────────────────────────────────
// Wording is the health monitor's own anomaly copy, kept identical so the compact Radar row and the
// expanded footer panel can never describe the same condition two different ways.
const HEALTH_ANOMALIES = [
  ['listenerMismatch', 'Listener count mismatch: data WS listener leaked or missing'],
  ['orphanPty', 'Orphan PTY: session has live PTY but state is DONE/FAILED/DORMANT'],
  ['destroyedReachable', 'Destroyed session still reachable in sessions map'],
];

// Only ACTIVE anomalies produce a row: an all-zero snapshot arrives every ten seconds and must leave
// the board silent.
export function healthAnomalyRows(snapshot) {
  const anomalies = snapshot?.anomalies;
  if (!anomalies) return [];
  const rows = [];
  for (const [key, label] of HEALTH_ANOMALIES) {
    if (!anomalies[key]) continue;
    rows.push({ key, label });
  }
  return rows;
}

function textOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function updateAvailableRow(update) {
  const current = textOr(update?.current, '');
  const latest = textOr(update?.latest, '');
  if (!current || !latest) return null;
  return { text: `Update available: ${current} -> ${latest}`, command: textOr(update?.command, '') };
}

// One list so the panel renders ops in a fixed order regardless of which feed landed first: the
// advisory update line, then every live anomaly.
export function opsRows({ update, health } = {}) {
  const rows = [];
  const updateEntry = updateAvailableRow(update);
  if (updateEntry) rows.push({ kind: 'update', key: 'update', text: updateEntry.text, detail: updateEntry.command, tone: 'dim' });
  for (const anomaly of healthAnomalyRows(health)) {
    rows.push({ kind: 'anomaly', key: anomaly.key, text: anomaly.label, detail: '', tone: 'warn' });
  }
  return rows;
}

// ── Pull requests section ────────────────────────────────────
// Attention-worthy PRs only, flattened across projects. The needs-action predicate and the ordering
// both come from pr-view-core: Radar summarizes the PR lane, it does not own a second reading of it.
export function needsActionPrRows(snapshot) {
  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
  const rows = [];
  for (const project of projects) {
    const prs = Array.isArray(project?.prs) ? project.prs : [];
    const actionable = sortPrsByAttention(prs.filter((pr) => prNeedsAction(pr)));
    for (const pr of actionable) {
      rows.push({
        projectId: textOr(project?.projectId, ''),
        projectLabel: textOr(project?.repoSlug, textOr(project?.name, textOr(project?.projectId, 'project'))),
        number: Number.isFinite(pr?.number) ? pr.number : null,
        title: textOr(pr?.title, 'Untitled pull request'),
        phase: normalizePhase(pr?.phase),
        severity: prSeverityFor(pr?.phase, { inFlight: !!pr?.inFlight, pingedError: !!pr?.pingedError }),
      });
    }
  }
  return rows;
}

// ── Attention count ──────────────────────────────────────────
// The single number behind the desktop tab dot and the phone More dot. An available update is
// advisory and deliberately contributes nothing; anomalies and needs-action PRs each count once.
export function radarAttentionCount({ posthog, health, prs } = {}) {
  const projects = Array.isArray(posthog?.projects) ? posthog.projects : [];
  const issues = projects.reduce((total, project) => {
    const counts = summarizeIssues(project?.issues);
    return total + counts.spiking + counts.needsHuman;
  }, 0);
  return issues + healthAnomalyRows(health).length + needsActionPrRows(prs).length;
}

function rankFor(change) {
  const rank = CHANGE_RANK[change];
  return rank == null ? UNKNOWN_RANK : rank;
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

// Returns a new array; the input is never mutated. Ties fall back to blast radius (users, then
// occurrences) and finally to the order the backend sent, so a steady poll does not reshuffle rows.
export function sortIssuesByAttention(issues) {
  if (!Array.isArray(issues)) return [];
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => {
      const byRank = rankFor(a.issue?.change) - rankFor(b.issue?.change);
      if (byRank !== 0) return byRank;
      const byUsers = numberOr(b.issue?.users, 0) - numberOr(a.issue?.users, 0);
      if (byUsers !== 0) return byUsers;
      const byOccurrences = numberOr(b.issue?.occurrences, 0) - numberOr(a.issue?.occurrences, 0);
      if (byOccurrences !== 0) return byOccurrences;
      return a.index - b.index;
    })
    .map((entry) => entry.issue);
}
