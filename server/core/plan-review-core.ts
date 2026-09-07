import { PLAN_HOOK_EVENT, PLAN_TOOL_NAME, planTitle } from '../../shared/contracts/plan-review.ts';
import type {
  ExitPlanModeRequest,
  PlanChangedPush,
  PlanReview,
  PlanReviewStateValue,
  PlanRevision,
  PlanRevisionSummary,
} from '../../shared/contracts/plan-review.ts';

const MAIN_AGENT_KEY = '';

type PlanReviewEvent = 'release' | 'decide' | 'close' | 'revise';

interface PlanRevisionIndexEntry {
  revision: number;
  agentId: string | null;
  agentType: string | null;
  receivedAt: number;
  offset: number;
  length: number;
  chars: number;
  title: string;
}

interface PlanReviewProgress {
  state: PlanReviewStateValue;
  openRevision: { revision: number; since: number } | null;
  approvedRevision: number | null;
}

type PlanChangedPayload = PlanChangedPush;

const REVIEW_TRANSITIONS: Record<PlanReviewStateValue, Partial<Record<PlanReviewEvent, PlanReviewStateValue>>> = {
  open: { release: 'released', decide: 'decided', close: 'closed', revise: 'open' },
  released: { close: 'closed', revise: 'open' },
  decided: { close: 'closed', revise: 'open' },
  closed: { revise: 'open' },
};

function isPlanHookEvent(event: unknown): boolean {
  return String(event ?? '').toLowerCase() === PLAN_HOOK_EVENT;
}

function isPlanToolResult(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  return (payload as { tool_name?: unknown }).tool_name === PLAN_TOOL_NAME;
}

function agentKey(agentId: string | null | undefined): string {
  if (typeof agentId !== 'string' || agentId.length === 0) return MAIN_AGENT_KEY;
  return agentId;
}

function entriesForAgent(entries: PlanRevisionIndexEntry[], agentId: string | null): PlanRevisionIndexEntry[] {
  const key = agentKey(agentId);
  return entries.filter((entry) => agentKey(entry.agentId) === key);
}

function agentIdsIn(entries: PlanRevisionIndexEntry[]): (string | null)[] {
  const agentIdByKey = new Map<string, string | null>();
  for (const entry of entries) {
    const key = agentKey(entry.agentId);
    if (agentIdByKey.has(key)) continue;
    agentIdByKey.set(key, key === MAIN_AGENT_KEY ? null : entry.agentId);
  }
  const subagentIds = [...agentIdByKey.entries()]
    .filter(([key]) => key !== MAIN_AGENT_KEY)
    .map(([, agentId]) => agentId);
  if (!agentIdByKey.has(MAIN_AGENT_KEY)) return subagentIds;
  return [null, ...subagentIds];
}

function nextRevisionNumber(entries: PlanRevisionIndexEntry[]): number {
  let highest = 0;
  for (const entry of entries) {
    if (entry.revision > highest) highest = entry.revision;
  }
  return highest + 1;
}

function newestEntry(entries: PlanRevisionIndexEntry[]): PlanRevisionIndexEntry | null {
  let newest: PlanRevisionIndexEntry | null = null;
  for (const entry of entries) {
    if (!newest || entry.revision > newest.revision) newest = entry;
  }
  return newest;
}

function selectEntry(entries: PlanRevisionIndexEntry[], revision?: number | null): PlanRevisionIndexEntry | null {
  if (revision === undefined || revision === null) return newestEntry(entries);
  return entries.find((entry) => entry.revision === revision) ?? null;
}

function indexEntryFor(
  revision: PlanRevision,
  { offset, length }: { offset: number; length: number },
): PlanRevisionIndexEntry {
  return {
    revision: revision.revision,
    agentId: revision.agentId,
    agentType: revision.agentType,
    receivedAt: revision.receivedAt,
    offset,
    length,
    chars: revision.plan.length,
    title: planTitle(revision.plan),
  };
}

function revisionRecord(
  sessionId: string,
  request: ExitPlanModeRequest,
  { revision, receivedAt }: { revision: number; receivedAt: number },
): PlanRevision {
  return {
    sessionId,
    revision,
    receivedAt,
    plan: request.plan,
    planFilePath: request.planFilePath,
    agentId: request.agentId,
    agentType: request.agentType,
  };
}

function revisionSummary(entry: PlanRevisionIndexEntry): PlanRevisionSummary {
  return {
    revision: entry.revision,
    receivedAt: entry.receivedAt,
    chars: entry.chars,
    title: entry.title,
  };
}

function reviewFrom(
  entries: PlanRevisionIndexEntry[],
  agentId: string | null,
  progress: PlanReviewProgress,
): PlanReview {
  const own = entriesForAgent(entries, agentId);
  const newest = newestEntry(own);
  return {
    agentId,
    agentType: newest?.agentType ?? null,
    revisions: own.slice().sort((left, right) => left.revision - right.revision).map(revisionSummary),
    state: progress.state,
    openRevision: progress.openRevision,
    approvedRevision: progress.approvedRevision,
  };
}

function closedProgress(): PlanReviewProgress {
  return { state: 'closed', openRevision: null, approvedRevision: null };
}

function nextReviewState(state: PlanReviewStateValue, event: PlanReviewEvent): PlanReviewStateValue {
  return REVIEW_TRANSITIONS[state][event] ?? state;
}

function progressAfterRevision(progress: PlanReviewProgress): PlanReviewProgress {
  return {
    state: nextReviewState(nextReviewState(progress.state, 'revise'), 'release'),
    openRevision: null,
    approvedRevision: progress.approvedRevision,
  };
}

function progressAfterPlanToolResult(
  progress: PlanReviewProgress,
  newest: PlanRevisionIndexEntry,
  approvedPlan: string | null,
): PlanReviewProgress {
  const approvesNewestRevision = approvedPlan === null || approvedPlan.length === newest.chars;
  return {
    state: nextReviewState(progress.state, 'close'),
    openRevision: null,
    approvedRevision: approvesNewestRevision ? newest.revision : null,
  };
}

function planChangedPayload(
  sessionId: string,
  entry: PlanRevisionIndexEntry,
  progress: PlanReviewProgress,
  hasPlan: boolean,
): PlanChangedPayload {
  return {
    id: sessionId,
    agentId: entry.agentId,
    agentType: entry.agentType,
    revision: entry.revision,
    receivedAt: entry.receivedAt,
    state: progress.state,
    chars: entry.chars,
    title: entry.title,
    hasPlan,
  };
}

export {
  agentIdsIn,
  agentKey,
  closedProgress,
  entriesForAgent,
  indexEntryFor,
  isPlanHookEvent,
  isPlanToolResult,
  newestEntry,
  nextReviewState,
  nextRevisionNumber,
  planChangedPayload,
  progressAfterPlanToolResult,
  progressAfterRevision,
  reviewFrom,
  revisionRecord,
  selectEntry,
};
export type { PlanChangedPayload, PlanReviewEvent, PlanReviewProgress, PlanRevisionIndexEntry };
