import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlanReview, PlanReviewState } from '../shared/contracts/plan-review.ts';
import { createPlanViewModel, mergePlanChanged } from '../public/plan/plan-view-core.ts';
import type { PlanChangedMessage, PlanViewInput } from '../public/plan/plan-view-core.ts';

const state: PlanReviewState = {
  reviews: [
    {
      agentId: null,
      agentType: null,
      revisions: [
        { revision: 1, receivedAt: 10, chars: 4000, title: 'First' },
        { revision: 2, receivedAt: 20, chars: 8400, title: 'Second' },
      ],
      state: 'open',
      openRevision: { revision: 2, since: 20 },
      approvedRevision: null,
      lastDecision: null,
    },
    {
      agentId: 'agent-1',
      agentType: 'Explore',
      revisions: [{ revision: 1, receivedAt: 30, chars: 1000, title: 'Explore plan' }],
      state: 'closed',
      openRevision: null,
      approvedRevision: 1,
      lastDecision: 'approve',
    },
  ],
};

test('plan view exposes main and subagent tabs with revision metadata', () => {
  const view = createPlanViewModel({
    state,
    selectedAgentId: null,
    selectedRevision: 2,
    body: 'x'.repeat(8400),
    isConnected: true,
  });
  assert.deepEqual(view.tabs.map((tab) => tab.label), ['Plan', 'Explore']);
  assert.deepEqual(view.revisions.map((revision) => [revision.label, revision.receivedAt]), [
    ['Revision 1', 10],
    ['Revision 2', 20],
  ]);
  assert.equal(view.status, 'Revision 2 of 2, 8.4 KB, waiting for your decision');
});

const CONSTANT_LABELS = ['Approve', 'Approve and accept edits', 'Send feedback', 'Answer in terminal', 'Edit plan'];

function viewFor(overrides: Partial<PlanReview>, input: Partial<PlanViewInput> = {}) {
  const review: PlanReview = {
    agentId: null,
    agentType: null,
    revisions: [{ revision: 1, receivedAt: 10, chars: 100, title: 'First' }],
    state: 'open',
    openRevision: { revision: 1, since: 10 },
    approvedRevision: null,
    lastDecision: null,
    ...overrides,
  };
  return createPlanViewModel({
    state: { reviews: [review] },
    selectedAgentId: null,
    selectedRevision: 1,
    body: 'plan',
    isConnected: true,
    ...input,
  });
}

test('an open review enables every decision, and Edit plan stays disabled until M3', () => {
  const view = viewFor({});
  assert.deepEqual(view.actions.map((action) => action.label), CONSTANT_LABELS);
  assert.deepEqual(
    view.actions.filter((action) => action.enabled).map((action) => action.kind),
    ['approve', 'approve-accept-edits', 'revise', 'terminal'],
  );
  assert.equal(view.actions.find((action) => action.kind === 'edit')?.enabled, false);
});

test('a review that is not open disables every action and says why, with labels unchanged', () => {
  const cases = [
    { overrides: { state: 'released' as const }, status: 'Answer in the terminal' },
    { overrides: { state: 'decided' as const, lastDecision: 'approve' as const }, status: 'Approved' },
    { overrides: { state: 'decided' as const, lastDecision: 'approve-accept-edits' as const }, status: 'Approved' },
    { overrides: { state: 'decided' as const, lastDecision: 'revise' as const }, status: 'Feedback sent, waiting for the next revision' },
    { overrides: { state: 'closed' as const }, status: 'Closed' },
    { overrides: { state: 'closed' as const, approvedRevision: 1 }, status: 'Approved' },
  ];
  for (const { overrides, status } of cases) {
    const view = viewFor({ openRevision: null, ...overrides });
    assert.deepEqual(view.actions.map((action) => action.label), CONSTANT_LABELS, 'labels never change with state');
    assert.equal(view.actions.every((action) => action.enabled === false), true, `${overrides.state} disables every action`);
    assert.equal(view.status, `Revision 1 of 1, 4 B, ${status}`);
  }
});

test('a revision the open one has moved past disables every action, so no click can name it', () => {
  const view = viewFor(
    {
      revisions: [
        { revision: 1, receivedAt: 10, chars: 100, title: 'First' },
        { revision: 2, receivedAt: 20, chars: 100, title: 'Second' },
      ],
      openRevision: { revision: 2, since: 20 },
    },
    { selectedRevision: 1 },
  );
  assert.deepEqual(view.actions.map((action) => action.label), CONSTANT_LABELS, 'labels never change with selection');
  assert.equal(view.actions.every((action) => action.enabled === false), true);
});

test('an open revision whose body has not loaded disables every action, so no click approves unread bytes', () => {
  const view = viewFor({}, { body: null });
  assert.equal(view.actions.every((action) => action.enabled === false), true);
  assert.equal(view.status, 'Revision 1 of 1, 100 B, loading');
});

test('a decision in flight disables every action and says so beside them', () => {
  const view = viewFor({}, { isDecisionInFlight: true });
  assert.equal(view.actions.every((action) => action.enabled === false), true);
  assert.equal(view.status, 'Revision 1 of 1, 4 B, sending your decision');
});

test('a disconnected socket disables every action on an open review', () => {
  const view = viewFor({}, { isConnected: false });
  assert.equal(view.actions.every((action) => action.enabled === false), true);
  assert.equal(view.status, 'Revision 1 of 1, 4 B, disconnected');
});

function planChanged(overrides: Partial<PlanChangedMessage> = {}): PlanChangedMessage {
  return {
    id: 'session-1',
    agentId: null,
    agentType: null,
    revision: 1,
    receivedAt: 10,
    state: 'open',
    lastDecision: null,
    approvedRevision: null,
    chars: 100,
    title: 'First',
    hasPlan: true,
    ...overrides,
  };
}

test('a resent summary for a known revision replaces it instead of appending a duplicate', () => {
  const opened = mergePlanChanged({ reviews: [] }, planChanged());
  const resent = mergePlanChanged(opened, planChanged({ chars: 250, title: 'First, revised' }));
  assert.equal(resent.reviews.length, 1);
  assert.deepEqual(resent.reviews[0].revisions, [{ revision: 1, receivedAt: 10, chars: 250, title: 'First, revised' }]);
});

test('summaries that arrive out of order are ordered by revision, not arrival', () => {
  const third = mergePlanChanged({ reviews: [] }, planChanged({ revision: 3, receivedAt: 30, title: 'Third' }));
  const first = mergePlanChanged(third, planChanged({ revision: 1, receivedAt: 10, title: 'First' }));
  const merged = mergePlanChanged(first, planChanged({ revision: 2, receivedAt: 20, title: 'Second' }));
  assert.deepEqual(merged.reviews[0].revisions.map((entry) => entry.revision), [1, 2, 3]);
  assert.deepEqual(merged.reviews[0].openRevision, { revision: 2, since: 20 });
});

test('a subagent summary lands beside the main review and the close push carries the approved revision', () => {
  const opened = mergePlanChanged({ reviews: [] }, planChanged());
  const withSubagent = mergePlanChanged(opened, planChanged({ agentId: 'agent-1', agentType: 'Explore' }));
  const closedMain = mergePlanChanged(withSubagent, planChanged({ state: 'closed', approvedRevision: 1 }));
  assert.deepEqual(closedMain.reviews.map((review) => review.agentId), [null, 'agent-1'], 'an updated review keeps its tab position');
  assert.equal(closedMain.reviews.find((review) => review.agentId === null)?.approvedRevision, 1);
  assert.equal(closedMain.reviews.find((review) => review.agentId === null)?.openRevision, null);
});
