import { CONTROL_FRAME_ENVELOPE_BYTES, CONTROL_FRAME_MAX_BYTES } from '#shared/contracts/control-messages.ts';
import {
  PLAN_BODY_CAP_BYTES,
  PLAN_COMMENTS_MAX,
  PLAN_COMMENT_MAX_CHARS,
  PLAN_FEEDBACK_MAX_CHARS,
  PLAN_HOOK_OUTPUT_MAX_CHARS,
} from '#shared/contracts/plan-review.ts';
import type {
  PlanChangedPush,
  PlanDecisionKind,
  PlanReview,
  PlanReviewState,
  PlanSectionComment,
} from '#shared/contracts/plan-review.ts';

export type PlanChangedMessage = PlanChangedPush;

export type PlanActionKind = PlanDecisionKind | 'edit';

export interface PlanViewInput {
  state: PlanReviewState;
  selectedAgentId: string | null;
  selectedRevision: number | null;
  body: string | null;
  isConnected: boolean;
  isDecisionInFlight?: boolean;
  isDraft?: boolean;
  pendingCommentCount?: number;
  problem?: string | null;
}

export interface PlanDecisionExtras {
  feedback?: string;
  comments?: PlanSectionComment[];
  plan?: string;
}

export interface PlanActionView {
  kind: PlanActionKind;
  label: string;
  enabled: boolean;
}

const ACTION_LABELS: readonly { kind: PlanActionKind; label: string }[] = Object.freeze([
  { kind: 'approve', label: 'Approve' },
  { kind: 'approve-accept-edits', label: 'Approve and accept edits' },
  { kind: 'revise', label: 'Send feedback' },
  { kind: 'terminal', label: 'Answer in terminal' },
  { kind: 'edit', label: 'Edit plan' },
]);

function reviewFor(state: PlanReviewState, selectedAgentId: string | null) {
  return state.reviews.find((review) => review.agentId === selectedAgentId) ?? state.reviews[0] ?? null;
}

function selectedRevisionFor(input: PlanViewInput) {
  const review = reviewFor(input.state, input.selectedAgentId);
  if (!review) return null;
  if (input.selectedRevision && review.revisions.some((entry) => entry.revision === input.selectedRevision)) {
    return input.selectedRevision;
  }
  return review.revisions.at(-1)?.revision ?? null;
}

export function openRevisionFor(state: PlanReviewState, selectedAgentId: string | null): number | null {
  return reviewFor(state, selectedAgentId)?.openRevision?.revision ?? null;
}

export function previousRevisionFor(
  state: PlanReviewState,
  selectedAgentId: string | null,
  revision: number | null,
): number | null {
  if (revision === null) return null;
  const revisions = reviewFor(state, selectedAgentId)?.revisions ?? [];
  const position = revisions.findIndex((entry) => entry.revision === revision);
  if (position <= 0) return null;
  return revisions[position - 1].revision;
}

function formatSize(byteCount: number) {
  if (byteCount < 1000) return `${byteCount} B`;
  return `${(byteCount / 1000).toFixed(1)} KB`;
}

function actionsFor(input: PlanViewInput, review: PlanReview | null, selectedRevision: number | null): PlanActionView[] {
  const isOpenForDecision = review !== null
    && review.state === 'open'
    && review.openRevision !== null
    && review.openRevision.revision === selectedRevision
    && input.body !== null
    && input.isConnected
    && input.isDraft !== true
    && !input.isDecisionInFlight;
  return ACTION_LABELS.map(({ kind, label }) => ({ kind, label, enabled: isOpenForDecision }));
}

function reviewStatus(review: PlanReview, revision: number | null): string {
  if (review.openRevision !== null) {
    if (review.openRevision.revision === revision) return 'waiting for your decision';
    return `Revision ${review.openRevision.revision} is the one open`;
  }
  if (revision !== null && review.approvedRevision === revision) return 'Approved';
  if (review.state === 'released') return 'Answer in the terminal';
  if (review.state === 'decided') {
    return review.lastDecision === 'revise' ? 'Feedback sent, waiting for the next revision' : 'Approved';
  }
  return 'Closed';
}

function composedFeedbackChars(extras: PlanDecisionExtras): number {
  let total = extras.feedback?.trim().length ?? 0;
  for (const entry of extras.comments ?? []) total += entry.comment.trim().length + (entry.heading?.length ?? 0);
  return total;
}

function decisionFrameBytes(extras: PlanDecisionExtras): number {
  return new TextEncoder().encode(JSON.stringify(extras)).byteLength + CONTROL_FRAME_ENVELOPE_BYTES;
}

export function planLimitRefusal(extras: PlanDecisionExtras): string | null {
  const plan = extras.plan;
  if (plan !== undefined && plan.length === 0) return 'the edited plan is empty, so nothing was sent';
  if (plan !== undefined && new TextEncoder().encode(plan).byteLength > PLAN_BODY_CAP_BYTES) {
    return 'the edited plan is over the plan size cap, so nothing was sent';
  }
  const feedback = extras.feedback ?? '';
  if (feedback.length > PLAN_FEEDBACK_MAX_CHARS) {
    return `the feedback is over ${PLAN_FEEDBACK_MAX_CHARS} characters, so nothing was sent`;
  }
  const comments = extras.comments ?? [];
  if (comments.length > PLAN_COMMENTS_MAX) {
    return `more than ${PLAN_COMMENTS_MAX} section comments are pending, so nothing was sent`;
  }
  const overCap = comments.find((entry) => entry.comment.length > PLAN_COMMENT_MAX_CHARS
    || (entry.heading?.length ?? 0) > PLAN_COMMENT_MAX_CHARS);
  if (overCap) return `a section comment is over ${PLAN_COMMENT_MAX_CHARS} characters, so nothing was sent`;
  if (composedFeedbackChars(extras) > PLAN_HOOK_OUTPUT_MAX_CHARS) {
    return `the feedback composes more than the ${PLAN_HOOK_OUTPUT_MAX_CHARS} characters the hook reply carries, so nothing was sent`;
  }
  if (decisionFrameBytes(extras) > CONTROL_FRAME_MAX_BYTES) {
    return 'the decision is larger than one control frame carries, so nothing was sent';
  }
  return null;
}

function problemNote(problem: string | null | undefined): string {
  if (!problem) return '';
  return `, ${problem}`;
}

function pendingCommentNote(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? ', 1 comment pending' : `, ${count} comments pending`;
}

function statusDetail(input: PlanViewInput, review: PlanReview, revision: number): string {
  if (!input.isConnected) return ', disconnected';
  if (input.isDecisionInFlight) return ', sending your decision';
  if (input.body === null) return ', loading';
  if (input.isDraft === true) return '';
  return `, ${reviewStatus(review, revision)}`;
}

function statusLine(input: PlanViewInput, review: PlanReview | null, revision: number | null) {
  if (!review || revision === null) {
    const idle = input.isConnected ? 'No plan revision selected' : 'Disconnected';
    return `${idle}${problemNote(input.problem)}`;
  }
  const summary = review.revisions.find((entry) => entry.revision === revision);
  const position = review.revisions.findIndex((entry) => entry.revision === revision) + 1;
  const bytes = input.body === null ? summary?.chars ?? 0 : new TextEncoder().encode(input.body).byteLength;
  const prefix = input.isDraft === true
    ? `Draft, ${formatSize(bytes)}`
    : `Revision ${position} of ${review.revisions.length}, ${formatSize(bytes)}`;
  const detail = `${statusDetail(input, review, revision)}${pendingCommentNote(input.pendingCommentCount ?? 0)}`;
  return `${prefix}${detail}${problemNote(input.problem)}`;
}

export function createPlanViewModel(input: PlanViewInput) {
  const review = reviewFor(input.state, input.selectedAgentId);
  const selectedRevision = selectedRevisionFor(input);
  return {
    tabs: input.state.reviews.map((entry) => ({
      agentId: entry.agentId,
      label: entry.agentId === null ? 'Plan' : entry.agentType || 'Agent',
      selected: entry === review,
    })),
    revisions: (review?.revisions ?? []).map((entry) => ({
      revision: entry.revision,
      label: `Revision ${entry.revision}`,
      receivedAt: entry.receivedAt,
      selected: entry.revision === selectedRevision,
    })),
    selectedAgentId: review?.agentId ?? null,
    selectedRevision,
    previousRevision: previousRevisionFor(input.state, review?.agentId ?? null, selectedRevision),
    status: statusLine(input, review, selectedRevision),
    actions: actionsFor(input, review, selectedRevision),
  };
}

export function mergePlanChanged(state: PlanReviewState, message: PlanChangedMessage): PlanReviewState {
  const reviewIndex = state.reviews.findIndex((review) => review.agentId === message.agentId);
  const currentReview = reviewIndex === -1 ? null : state.reviews[reviewIndex];
  const revisions = [...(currentReview?.revisions ?? [])];
  const knownRevisionIndex = revisions.findIndex((entry) => entry.revision === message.revision);
  const summary = { revision: message.revision, receivedAt: message.receivedAt, chars: message.chars, title: message.title };
  revisions[knownRevisionIndex === -1 ? revisions.length : knownRevisionIndex] = summary;
  revisions.sort((left, right) => left.revision - right.revision);
  const review: PlanReview = {
    agentId: message.agentId,
    agentType: message.agentType,
    revisions,
    state: message.state,
    openRevision: message.state === 'open' ? { revision: message.revision, since: message.receivedAt } : null,
    approvedRevision: message.approvedRevision,
    lastDecision: message.lastDecision,
  };
  const reviews = [...state.reviews];
  reviews[reviewIndex === -1 ? reviews.length : reviewIndex] = review;
  return { reviews };
}
