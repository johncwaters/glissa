import type { PlanChangedPush, PlanDecisionKind, PlanReview, PlanReviewState } from '#shared/contracts/plan-review.ts';

export type PlanChangedMessage = PlanChangedPush;

export type PlanActionKind = PlanDecisionKind | 'edit';

export interface PlanViewInput {
  state: PlanReviewState;
  selectedAgentId: string | null;
  selectedRevision: number | null;
  body: string | null;
  isConnected: boolean;
  isDecisionInFlight?: boolean;
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
    && !input.isDecisionInFlight;
  return ACTION_LABELS.map(({ kind, label }) => ({
    kind,
    label,
    enabled: kind !== 'edit' && isOpenForDecision,
  }));
}

function reviewStatus(review: PlanReview, revision: number | null): string {
  if (review.state === 'open') return 'waiting for your decision';
  if (review.state === 'released') return 'Answer in the terminal';
  if (review.state === 'decided') {
    return review.lastDecision === 'revise' ? 'Feedback sent, waiting for the next revision' : 'Approved';
  }
  if (review.approvedRevision !== null && review.approvedRevision === revision) return 'Approved';
  return 'Closed';
}

function statusLine(input: PlanViewInput, review: PlanReview | null, revision: number | null) {
  if (!review || revision === null) return input.isConnected ? 'No plan revision selected' : 'Disconnected';
  const summary = review.revisions.find((entry) => entry.revision === revision);
  const position = review.revisions.findIndex((entry) => entry.revision === revision) + 1;
  const bytes = input.body === null ? summary?.chars ?? 0 : new TextEncoder().encode(input.body).byteLength;
  const prefix = `Revision ${position} of ${review.revisions.length}, ${formatSize(bytes)}`;
  if (!input.isConnected) return `${prefix}, disconnected`;
  if (input.isDecisionInFlight) return `${prefix}, sending your decision`;
  if (input.body === null) return `${prefix}, loading`;
  return `${prefix}, ${reviewStatus(review, revision)}`;
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
