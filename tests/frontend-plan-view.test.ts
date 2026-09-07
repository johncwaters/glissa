import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlanReviewState } from '../shared/contracts/plan-review.ts';
import { createPlanViewModel, mergePlanChanged } from '../public/plan/plan-view-core.ts';
import type { PlanChangedMessage } from '../public/plan/plan-view-core.ts';

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
    },
    {
      agentId: 'agent-1',
      agentType: 'Explore',
      revisions: [{ revision: 1, receivedAt: 30, chars: 1000, title: 'Explore plan' }],
      state: 'closed',
      openRevision: null,
      approvedRevision: 1,
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
  assert.equal(view.status, 'Revision 2 of 2, 8.4 KB, waiting for a decision in the terminal');
});

test('M1 action labels are constant and every action stays disabled', () => {
  const view = createPlanViewModel({
    state,
    selectedAgentId: 'agent-1',
    selectedRevision: 1,
    body: 'plan',
    isConnected: true,
  });
  assert.deepEqual(view.actions.map((action) => action.label), [
    'Approve',
    'Approve and accept edits',
    'Send feedback',
    'Answer in terminal',
    'Edit plan',
  ]);
  assert.equal(view.actions.every((action) => action.enabled === false), true);
});

function planChanged(overrides: Partial<PlanChangedMessage> = {}): PlanChangedMessage {
  return {
    id: 'session-1',
    agentId: null,
    agentType: null,
    revision: 1,
    receivedAt: 10,
    state: 'open',
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

test('a subagent summary lands beside the main review and carries its approved revision forward', () => {
  const opened = mergePlanChanged({ reviews: [] }, planChanged());
  const approved = { reviews: [{ ...opened.reviews[0], approvedRevision: 1 }] };
  const withSubagent = mergePlanChanged(approved, planChanged({ agentId: 'agent-1', agentType: 'Explore' }));
  const closedMain = mergePlanChanged(withSubagent, planChanged({ state: 'closed' }));
  assert.deepEqual(closedMain.reviews.map((review) => review.agentId), ['agent-1', null]);
  assert.equal(closedMain.reviews.find((review) => review.agentId === null)?.approvedRevision, 1);
  assert.equal(closedMain.reviews.find((review) => review.agentId === null)?.openRevision, null);
});
