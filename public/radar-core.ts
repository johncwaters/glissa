
import { attentionSignature } from './attention-ack-core.ts';
import { numberOr, textOr } from './coerce-core.ts';
import { lanePlaceholder } from './lane-placeholder-core.ts';
import type { PrProject, PrRow, PrStatusSnapshot } from './pr-view-core.ts';
import { normalizePhase, prNeedsAction, severityFor as prSeverityFor, sortPrsByAttention } from './pr-view-core.ts';

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

export function radarDisplayName(project: RadarProject | null | undefined) {
  const configured = lastPathSegment(textOr(project?.name, ''));
  if (configured) return configured;
  const projectId = project?.projectId;
  return projectId == null || projectId === '' ? 'project' : String(projectId);
}

export function shortHost(host: unknown) {
  const raw = textOr(host, '');
  if (!raw) return '';
  const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
  return (authority.split('@').pop() ?? '').replace(/:\d+$/, '');
}

export function hostsDiffer(projects: unknown) {
  const seen = new Set<string>();
  const list: RadarProject[] = Array.isArray(projects) ? projects : [];
  for (const project of list) {
    const host = shortHost(project?.host);
    if (host) seen.add(host);
  }
  return seen.size > 1;
}

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
      prUrl: /^https:\/\/[^\s"'<>]{1,300}$/.test(textOr(record.prUrl, '')) ? textOr(record.prUrl, '') : '',
      at: Number.isFinite(Number(record.at)) ? Number(record.at) : 0,
    }))
    .sort((a, b) => b.at - a.at);
}

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

const HEALTH_ANOMALIES: readonly [string, string][] = [
  ['listenerMismatch', 'Listener count mismatch: data WS listener leaked or missing'],
  ['orphanPty', 'Orphan PTY: session has live PTY but state is DONE/FAILED/DORMANT'],
  ['destroyedReachable', 'Destroyed session still reachable in sessions map'],
];

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

export function opsRows({ update, health }: { update?: RadarUpdateFeed | null; health?: RadarHealthFeed | null } = {}) {
  const rows: { kind: string; key: string; text: string; detail: string; tone: string }[] = [];
  const updateEntry = updateAvailableRow(update);
  if (updateEntry) rows.push({ kind: 'update', key: 'update', text: updateEntry.text, detail: updateEntry.command, tone: 'dim' });
  for (const anomaly of healthAnomalyRows(health)) {
    rows.push({ kind: 'anomaly', key: anomaly.key, text: anomaly.label, detail: '', tone: 'warn' });
  }
  return rows;
}

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
