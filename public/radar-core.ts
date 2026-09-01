// ── Radar core (pure) ────────────────────────────────────────
// Attention ordering and severity mapping for PostHog issue rows, plus the aggregation that turns the
// three outside-world feeds (PostHog issues, ops telemetry, PR auto-review) into Radar's sections and
// its one attention count. No DOM, no IO.

import { attentionSignature } from './attention-ack-core.ts';
import { numberOr, textOr } from './coerce-core.ts';
import { lanePlaceholder } from './lane-placeholder-core.ts';
import type { PrProject, PrRow, PrStatusSnapshot } from './pr-view-core.ts';
import { normalizePhase, prNeedsAction, severityFor as prSeverityFor, sortPrsByAttention } from './pr-view-core.ts';

// Rank is attention-first, deliberately NOT the same grouping as severity: a brand new issue is
// less urgent than one that already regressed, yet both share the warn stripe.
export interface RadarIssue {
  issueId?: unknown;
  title?: unknown;
  change?: string;
  verdict?: string;
  users?: unknown;
  occurrences?: unknown;
  history?: unknown;
  summaryLine?: unknown;
  inFlight?: unknown;
  url?: unknown;
  lastSeen?: unknown;
  status?: unknown;
}

export interface RadarProject {
  projectId?: unknown;
  name?: unknown;
  host?: unknown;
  error?: unknown;
  lastTickAt?: unknown;
  issues?: RadarIssue[];
}

export interface RadarInvestigation {
  id?: unknown;
  issueId?: unknown;
  projectId?: unknown;
  projectName?: unknown;
  title?: unknown;
  summaryLine?: unknown;
  url?: unknown;
  verdict?: unknown;
  mode?: unknown;
  prUrl?: unknown;
  at?: unknown;
  archived?: unknown;
}

export interface RadarSnapshot {
  type?: string;
  projects?: RadarProject[];
  // Off the wire, so a record here can be anything; investigationRows narrows before it reads one.
  investigations?: unknown[];
  configured?: boolean;
  reason?: unknown;
  intervalMs?: unknown;
}

export interface RadarUpdateFeed {
  command?: unknown;
  current?: unknown;
  latest?: unknown;
  latestSha?: unknown;
  [key: string]: unknown;
}

export interface RadarHealthFeed {
  anomalies?: Record<string, unknown> | null;
}

export interface RadarProjectAlert {
  loud: boolean;
  counts: { active: number; spiking: number; needsHuman: number };
  error: string;
  staleMs: number;
}

const CHANGE_RANK: Record<string, number> = {
  spiking: 0,
  regressed: 1,
  worsened: 2,
  new: 3,
  quiet: 4,
};

const CHANGE_SEVERITY: Record<string, string> = {
  spiking: 'crit',
  regressed: 'crit',
  worsened: 'warn',
  new: 'warn',
  quiet: 'dim',
};

const UNKNOWN_RANK = 99;

// Shared by the issue rows and the investigations inbox so one verdict can never read two ways.
const VERDICT_LABEL: Record<string, string> = {
  ROOT_CAUSE: 'root cause',
  NEEDS_HUMAN: 'needs you',
  TRANSIENT: 'transient',
  FIXED: 'fixed',
  ERROR: 'error',
};

export function verdictLabel(verdict: unknown) {
  const key = typeof verdict === 'string' ? verdict.toUpperCase() : '';
  return VERDICT_LABEL[key] || String(verdict ?? '').toLowerCase();
}

export function radarPlaceholder(status: RadarSnapshot | null | undefined) {
  return lanePlaceholder(status, { label: 'PostHog monitoring', tab: 'PostHog' });
}

export function severityFor(change: string | undefined) {
  return CHANGE_SEVERITY[change ?? ''] || 'dim';
}

function finiteNumbers(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return (values as unknown[]).map((value) => Number(value)).filter((value) => Number.isFinite(value));
}

export function sparklinePoints(values: unknown, width = 64, height = 16) {
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
export function summarizeIssues(issues: unknown) {
  const list: RadarIssue[] = Array.isArray(issues) ? issues : [];
  let spiking = 0;
  let needsHuman = 0;
  for (const issue of list) {
    if (issue?.change === 'spiking') spiking += 1;
    if (issue?.verdict === 'NEEDS_HUMAN') needsHuman += 1;
  }
  return { active: list.length, spiking, needsHuman };
}

// ── Errors section: quiet vs loud projects ───────────────────
// A healthy project is not news. Every project used to render a full card (name, host, two stats, its
// own poll clock, "No tracked issues."), so five healthy projects filled a phone screen with five
// identical ways of saying nothing. Loud projects keep the card; quiet ones collapse to one row each.

// Used only when the payload carries no poll interval (an older server): the real threshold is twice
// the interval, so a project is stale once it has missed a poll rather than at a wall-clock guess.
export const DEFAULT_STALE_MS = 5 * 60 * 1000;

export function staleThresholdMs(intervalMs: unknown) {
  const interval = Number(intervalMs);
  if (!Number.isFinite(interval) || interval <= 0) return DEFAULT_STALE_MS;
  return interval * 2;
}

function lastPathSegment(value: string) {
  const segments = value.split(/[\\/]+/).filter(Boolean);
  return segments.length === 0 ? '' : segments[segments.length - 1];
}

// posthog.projectMap entries name either a display name or the project's PATH (the same entry
// resolveIssueProject reads), and the payload's `name` is that entry verbatim, so a mapped project
// currently renders its whole absolute path as a title. One rule covers both: the last path segment
// of a path IS its display name, and a plain name has exactly one segment.
export function radarDisplayName(project: RadarProject | null | undefined) {
  const configured = lastPathSegment(textOr(project?.name, ''));
  if (configured) return configured;
  const projectId = project?.projectId;
  return projectId == null || projectId === '' ? 'project' : String(projectId);
}

// Hostname only: the scheme, port and any path are noise on a row that exists to disambiguate two
// PostHog installs from each other.
export function shortHost(host: unknown) {
  const raw = textOr(host, '');
  if (!raw) return '';
  const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
  return (authority.split('@').pop() ?? '').replace(/:\d+$/, '');
}

// One host across the board tells the operator nothing, so it is shown only when there are two to
// tell apart.
export function hostsDiffer(projects: unknown) {
  const seen = new Set<string>();
  const list: RadarProject[] = Array.isArray(projects) ? projects : [];
  for (const project of list) {
    const host = shortHost(project?.host);
    if (host) seen.add(host);
  }
  return seen.size > 1;
}

// The four conditions that earn a full card. `error` is the poll error the server reports for a
// project whose issue query failed; a project that never ticked successfully carries no age at all,
// so it can only be loud through that error.
export function radarProjectAlert(
  project: RadarProject | null | undefined,
  nowTs: unknown,
  opts: { intervalMs?: unknown } = {}
): RadarProjectAlert {
  const counts = summarizeIssues(project?.issues);
  const error = textOr(project?.error, '').slice(0, 200);
  const now = Number(nowTs);
  const lastTickAt = Number(project?.lastTickAt);
  const age = Number.isFinite(now) && Number.isFinite(lastTickAt) && lastTickAt > 0 ? now - lastTickAt : 0;
  const threshold = staleThresholdMs(opts.intervalMs);
  const staleMs = age > threshold ? age : 0;
  return { loud: counts.active > 0 || counts.spiking > 0 || !!error || staleMs > 0, counts, error, staleMs };
}

export function partitionRadarProjects(projects: unknown, nowTs: unknown, opts: { intervalMs?: unknown } = {}) {
  const loud: (RadarProjectAlert & { project: RadarProject })[] = [];
  const quiet: (RadarProjectAlert & { project: RadarProject })[] = [];
  const list: RadarProject[] = Array.isArray(projects) ? projects : [];
  for (const project of list) {
    const alert = radarProjectAlert(project, nowTs, opts);
    const entry = { project, ...alert };
    if (alert.loud) {
      loud.push(entry);
      continue;
    }
    quiet.push(entry);
  }
  return { loud, quiet };
}

// ── Investigations inbox ─────────────────────────────────────
// The persisted log of completed investigations (server/core/posthog-core.js), carried on the same
// posthog-status broadcast. Rows survive their issue: a resolved issue leaves the Errors section
// immediately, and its verdict would leave with it. An absent field renders nothing, so an older
// server keeps behaving exactly as before.
// `locallyArchivedIds` is the panel's own record of what the operator archived in this page session.
// It is a SECOND filter, not a replacement for `archived`: a payload the server built before (or a
// cached one it replayed after) the archive still carries the record, and the row must stay gone.
export function investigationRows(snapshot: RadarSnapshot | null | undefined, locallyArchivedIds: Set<string> | null = null) {
  const list: unknown[] = Array.isArray(snapshot?.investigations) ? snapshot.investigations : [];
  return list
    .filter((record): record is RadarInvestigation => typeof record === 'object' && record !== null)
    .filter((record): record is RadarInvestigation & { id: string } => typeof record.id === 'string' && record.id !== '')
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
      mode: textOr(record.mode, 'investigate'),
      // Only ever rendered as an href, so anything that is not an https url is dropped here rather
      // than being handed to the DOM and hoped about.
      prUrl: /^https:\/\/[^\s"'<>]{1,300}$/.test(textOr(record.prUrl, '')) ? textOr(record.prUrl, '') : '',
      at: Number.isFinite(Number(record.at)) ? Number(record.at) : 0,
    }))
    .sort((a, b) => b.at - a.at);
}

// Drop, IN PLACE, every remembered id this payload no longer carries at all. Once the server stops
// sending a record (the archive round-tripped, or the retention purge dropped it) there is nothing
// left to suppress, so the caller's guard set can never grow without bound. Returns the same set so
// a caller can chain; mutating in place is deliberate, the panel holds one long-lived set.
export function retainKnownInvestigationIds(snapshot: RadarSnapshot | null | undefined, ids: Set<string> | null) {
  if (!ids || ids.size === 0) return ids;
  const list: unknown[] = Array.isArray(snapshot?.investigations) ? snapshot.investigations : [];
  const present = new Set<string>();
  for (const record of list) {
    if (typeof record !== 'object' || record === null) continue;
    const { id } = record as { id?: unknown };
    if (typeof id === 'string') present.add(id);
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
const HEALTH_ANOMALIES: readonly [string, string][] = [
  ['listenerMismatch', 'Listener count mismatch: data WS listener leaked or missing'],
  ['orphanPty', 'Orphan PTY: session has live PTY but state is DONE/FAILED/DORMANT'],
  ['destroyedReachable', 'Destroyed session still reachable in sessions map'],
];

// Only ACTIVE anomalies produce a row: an all-zero snapshot arrives every ten seconds and must leave
// the board silent.
export function healthAnomalyRows(snapshot: RadarHealthFeed | null | undefined) {
  const anomalies = snapshot?.anomalies;
  if (!anomalies) return [];
  const rows: { key: string; label: string }[] = [];
  for (const [key, label] of HEALTH_ANOMALIES) {
    if (!anomalies[key]) continue;
    rows.push({ key, label });
  }
  return rows;
}

// First 7 chars of a commit id, for display. Empty string for anything that is not a hex sha, so a
// caller can treat "no short sha" and "no sha" the same way.
export function shortSha(sha: unknown) {
  const text = textOr(sha, '');
  if (!/^[0-9a-f]{7,40}$/i.test(text)) return '';
  return text.slice(0, 7).toLowerCase();
}

export function updateAvailableRow(update: RadarUpdateFeed | null | undefined) {
  const command = textOr(update?.command, '');
  const current = textOr(update?.current, '');
  const latest = textOr(update?.latest, '');
  if (!current || !latest) return null;
  return { text: `Update available: ${current} -> ${latest}`, command };
}

export function updateBannerText(update: RadarUpdateFeed | null | undefined) {
  const current = textOr(update?.current, '');
  const latest = textOr(update?.latest, '');
  return `Update available: ${current} -> ${latest}`;
}

// One list so the panel renders ops in a fixed order regardless of which feed landed first: the
// advisory update line, then every live anomaly.
export function opsRows({ update, health }: { update?: RadarUpdateFeed | null; health?: RadarHealthFeed | null } = {}) {
  const rows: { kind: string; key: string; text: string; detail: string; tone: string }[] = [];
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
export function needsActionPrRows(snapshot: PrStatusSnapshot | null | undefined) {
  const projects: (PrProject | null)[] = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
  const rows: {
    projectId: string;
    projectLabel: string;
    number: number | null;
    title: string;
    phase: string;
    severity: string;
    reason: string;
  }[] = [];
  for (const project of projects) {
    const prs: PrRow[] = Array.isArray(project?.prs) ? project.prs : [];
    const actionable = sortPrsByAttention(prs.filter((pr) => prNeedsAction(pr)));
    for (const pr of actionable) {
      rows.push({
        projectId: textOr(project?.projectId, ''),
        projectLabel: textOr(project?.repoSlug, textOr(project?.name, textOr(project?.projectId, 'project'))),
        number: typeof pr?.number === 'number' && Number.isFinite(pr.number) ? pr.number : null,
        title: textOr(pr?.title, 'Untitled pull request'),
        phase: normalizePhase(pr?.phase),
        severity: prSeverityFor(pr?.phase, { inFlight: !!pr?.inFlight, pingedError: !!pr?.pingedError }),
        reason: textOr(pr?.reason, ''),
      });
    }
  }
  return rows;
}

// ── Attention ────────────────────────────────────────────────
// One derivation, two readings: the count for anything that wants a number, and the signature the dot
// is acknowledged against. An available update is advisory and contributes nothing.
//
// PR facts are deliberately ABSENT. Radar still renders its PR section, but a single failing PR used to
// light Radar, PRs and the phone More dot at once, so one fact read as three places needing attention.
// The PRs surfaces own that fact; Radar owns PostHog issues and live health anomalies.
function radarAttentionParts({ posthog, health }: { posthog?: RadarSnapshot | null; health?: RadarHealthFeed | null } = {}) {
  const parts: string[] = [];
  const projects: RadarProject[] = Array.isArray(posthog?.projects) ? posthog.projects : [];
  for (const project of projects) {
    const projectId = textOr(project?.projectId, textOr(project?.name, 'project'));
    const issues: RadarIssue[] = Array.isArray(project?.issues) ? project.issues : [];
    for (let index = 0; index < issues.length; index++) {
      const issue = issues[index];
      const issueId = textOr(issue?.issueId, textOr(issue?.title, `#${index}`));
      if (issue?.change === 'spiking') parts.push(`issue:${projectId}/${issueId}:spiking`);
      if (issue?.verdict === 'NEEDS_HUMAN') parts.push(`issue:${projectId}/${issueId}:needs-human`);
    }
  }
  for (const row of healthAnomalyRows(health)) parts.push(`health:${row.key}`);
  return parts;
}

export function radarAttentionCount(input: { posthog?: RadarSnapshot | null; health?: RadarHealthFeed | null } = {}) {
  return radarAttentionParts(input).length;
}

export function radarAttentionSignature(input: { posthog?: RadarSnapshot | null; health?: RadarHealthFeed | null } = {}) {
  return attentionSignature(radarAttentionParts(input));
}

function rankFor(change: string | undefined) {
  const rank = CHANGE_RANK[change ?? ''];
  return rank == null ? UNKNOWN_RANK : rank;
}

// Returns a new array; the input is never mutated. Ties fall back to blast radius (users, then
// occurrences) and finally to the order the backend sent, so a steady poll does not reshuffle rows.
export function sortIssuesByAttention(issues: unknown): RadarIssue[] {
  if (!Array.isArray(issues)) return [];
  return (issues as RadarIssue[])
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
