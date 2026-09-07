import type { PlanChangedPush, PlanReviewState } from '#shared/contracts/plan-review.ts';

export type PlanChangedMessage = PlanChangedPush;

export interface PlanViewInput {
  state: PlanReviewState;
  selectedAgentId: string | null;
  selectedRevision: number | null;
  body: string | null;
  isConnected: boolean;
}

export interface PlanActionView {
  label: string;
  enabled: false;
}

const actionButtons: readonly PlanActionView[] = Object.freeze([
  { label: 'Approve', enabled: false },
  { label: 'Approve and accept edits', enabled: false },
  { label: 'Send feedback', enabled: false },
  { label: 'Answer in terminal', enabled: false },
  { label: 'Edit plan', enabled: false },
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

function formatSize(byteCount: number) {
  if (byteCount < 1000) return `${byteCount} B`;
  return `${(byteCount / 1000).toFixed(1)} KB`;
}

function statusLine(input: PlanViewInput, revision: number | null) {
  const review = reviewFor(input.state, input.selectedAgentId);
  if (!review || revision === null) return input.isConnected ? 'No plan revision selected' : 'Disconnected';
  const summary = review.revisions.find((entry) => entry.revision === revision);
  const position = review.revisions.findIndex((entry) => entry.revision === revision) + 1;
  const bytes = input.body === null ? summary?.chars ?? 0 : new TextEncoder().encode(input.body).byteLength;
  const prefix = `Revision ${position} of ${review.revisions.length}, ${formatSize(bytes)}`;
  if (!input.isConnected) return `${prefix}, disconnected`;
  if (input.body === null) return `${prefix}, loading`;
  return `${prefix}, waiting for a decision in the terminal`;
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
    status: statusLine(input, selectedRevision),
    actions: actionButtons,
  };
}

export function mergePlanChanged(state: PlanReviewState, message: PlanChangedMessage): PlanReviewState {
  const currentReview = state.reviews.find((review) => review.agentId === message.agentId);
  const revisions = [...(currentReview?.revisions ?? [])];
  const knownRevisionIndex = revisions.findIndex((entry) => entry.revision === message.revision);
  const summary = { revision: message.revision, receivedAt: message.receivedAt, chars: message.chars, title: message.title };
  revisions[knownRevisionIndex === -1 ? revisions.length : knownRevisionIndex] = summary;
  revisions.sort((left, right) => left.revision - right.revision);
  const review = {
    agentId: message.agentId,
    agentType: message.agentType,
    revisions,
    state: message.state,
    openRevision: message.state === 'open' ? { revision: message.revision, since: message.receivedAt } : null,
    approvedRevision: currentReview?.approvedRevision ?? null,
  };
  return { reviews: [...state.reviews.filter((entry) => entry.agentId !== message.agentId), review] };
}
