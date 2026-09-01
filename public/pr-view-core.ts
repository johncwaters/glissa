import { attentionSignature } from './attention-ack-core.ts';
import { numberOr, textOr } from './coerce-core.ts';
import { lanePlaceholder } from './lane-placeholder-core.ts';

export interface PrRow {
  number?: number;
  phase?: string | null;
  inFlight?: boolean;
  pingedError?: boolean;
  wasConflicting?: boolean;
  title?: string;
  url?: string;
  headSha?: string;
  reason?: string;
}

export interface PrProject {
  projectId?: string;
  name?: string;
  repoSlug?: string;
  lastTickAt?: number;
  prs?: PrRow[] | null;
}

export interface PrStatusSnapshot {
  projects?: (PrProject | null)[];
  configured?: boolean;
  reason?: unknown;
}

const PHASE_RANK: Record<string, number> = {
  error: 0,
  done: 1,
  'changes-requested': 1,
  conflicting: 2,
  'resolving-conflicts': 2,
  'awaiting-checks': 3,
  'in-review': 3,
  pending: 4,
  merged: 5,
};

const PHASE_SEVERITY: Record<string, string> = {
  error: 'crit',
  done: 'warn',
  'changes-requested': 'warn',
  conflicting: 'warn',
  'resolving-conflicts': 'warn',
  'awaiting-checks': 'info',
  'in-review': 'info',
  pending: 'dim',
  merged: 'ok',
};

const PHASE_LABEL: Record<string, string> = {
  error: 'error',
  done: 'changes requested',
  'changes-requested': 'changes requested',
  conflicting: 'conflicting',
  'resolving-conflicts': 'resolving',
  'awaiting-checks': 'awaiting checks',
  'in-review': 'in review',
  pending: 'pending',
  merged: 'merged',
};

const UNKNOWN_RANK = 99;

export const PENDING_PHASE = 'pending';

export function prStatusPlaceholder(status: PrStatusSnapshot | null | undefined) {
  return lanePlaceholder(status, { label: 'PR auto-review', tab: 'PR Review' });
}

export function normalizePhase(phase: string | null | undefined) {
  return phase == null ? PENDING_PHASE : phase;
}

export function phaseLabel(phase: string | null | undefined) {
  const key = normalizePhase(phase);
  const label = PHASE_LABEL[key];
  if (label) return { label, known: true };
  return { label: String(key), known: false };
}

export function severityFor(phase: string | null | undefined, { inFlight = false, pingedError = false }: { inFlight?: boolean; pingedError?: boolean } = {}) {
  if (pingedError) return 'crit';
  const mapped = PHASE_SEVERITY[normalizePhase(phase)];
  if (mapped) return mapped;
  if (inFlight) return 'info';
  return 'dim';
}

export function prHasError(pr: PrRow | null | undefined) {
  return Boolean(pr?.pingedError) || pr?.phase === 'error';
}

export function summarizePrs(prs: unknown) {
  const list: PrRow[] = Array.isArray(prs) ? prs : [];
  let inReview = 0;
  let errors = 0;
  for (const pr of list) {
    if (pr?.inFlight) inReview += 1;
    if (prHasError(pr)) errors += 1;
  }
  return { open: list.length, inReview, errors };
}

export function prAttentionSignature(snapshot: PrStatusSnapshot | null | undefined) {
  const projects: (PrProject | null)[] = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
  const parts: string[] = [];
  for (const project of projects) {
    const label = textOr(project?.repoSlug, textOr(project?.projectId, 'project'));
    const prs: PrRow[] = Array.isArray(project?.prs) ? project.prs : [];
    for (const pr of prs) {
      if (!prHasError(pr)) continue;
      parts.push(`${label}#${numberOr(pr?.number, '?')}:${normalizePhase(pr?.phase)}`);
    }
  }
  return attentionSignature(parts);
}

const NEEDS_ACTION_PHASES = new Set(['error', 'done', 'changes-requested', 'conflicting']);

export function prNeedsAction(pr: PrRow | null | undefined) {
  if (pr?.pingedError) return true;
  return NEEDS_ACTION_PHASES.has(normalizePhase(pr?.phase));
}

function rankFor(pr: PrRow | null | undefined) {
  if (pr?.pingedError) return PHASE_RANK.error;
  const rank = PHASE_RANK[normalizePhase(pr?.phase)];
  return rank == null ? UNKNOWN_RANK : rank;
}

export function sortPrsByAttention(prs: unknown): PrRow[] {
  if (!Array.isArray(prs)) return [];
  return (prs as PrRow[])
    .map((pr, index) => ({ pr, index }))
    .sort((a, b) => {
      const byRank = rankFor(a.pr) - rankFor(b.pr);
      if (byRank !== 0) return byRank;
      const byNumber = numberOr(b.pr?.number, 0) - numberOr(a.pr?.number, 0);
      if (byNumber !== 0) return byNumber;
      return a.index - b.index;
    })
    .map((entry) => entry.pr);
}
