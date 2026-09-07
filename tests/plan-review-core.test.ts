import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
} from '../server/core/plan-review-core.ts';
import type { PlanReviewProgress, PlanRevisionIndexEntry } from '../server/core/plan-review-core.ts';
import { PlanReview as PlanReviewSchema } from '../shared/contracts/plan-review.ts';

function entry(overrides: Partial<PlanRevisionIndexEntry> = {}): PlanRevisionIndexEntry {
  return {
    revision: 1,
    agentId: null,
    agentType: null,
    receivedAt: 1000,
    offset: 0,
    length: 10,
    chars: 5,
    title: 'Plan',
    ...overrides,
  };
}

test('only the dedicated permission request event is the plan endpoint', () => {
  assert.equal(isPlanHookEvent('PermissionRequest-Plan'), true);
  assert.equal(isPlanHookEvent('permissionrequest'), false);
  assert.equal(isPlanHookEvent('stop'), false);
});

test('a subagent revision is numbered on its own review, not the session', () => {
  const entries = [entry({ revision: 1 }), entry({ revision: 2 }), entry({ revision: 1, agentId: 'sub-1' })];
  assert.equal(nextRevisionNumber(entriesForAgent(entries, null)), 3);
  assert.equal(nextRevisionNumber(entriesForAgent(entries, 'sub-1')), 2);
  assert.equal(nextRevisionNumber(entriesForAgent(entries, 'sub-2')), 1);
});

test('the main agent and an empty agent id share one review key', () => {
  assert.equal(agentKey(null), agentKey(''));
  assert.notEqual(agentKey('sub-1'), agentKey(null));
});

test('the newest revision wins when a request names none', () => {
  const entries = [entry({ revision: 1 }), entry({ revision: 3 }), entry({ revision: 2 })];
  assert.equal(newestEntry(entries)?.revision, 3);
  assert.equal(selectEntry(entries)?.revision, 3);
  assert.equal(selectEntry(entries, 2)?.revision, 2);
  assert.equal(selectEntry(entries, 9), null);
  assert.equal(newestEntry([]), null);
});

test('an index entry carries the title and char count but never the body', () => {
  const record = revisionRecord('session-1', {
    plan: '# Ship it\n\nbody',
    planFilePath: '/plans/a.md',
    agentId: 'sub-1',
    agentType: 'Explore',
  }, { revision: 2, receivedAt: 77 });
  const indexed = indexEntryFor(record, { offset: 40, length: 120 });
  assert.deepEqual(indexed, {
    revision: 2,
    agentId: 'sub-1',
    agentType: 'Explore',
    receivedAt: 77,
    offset: 40,
    length: 120,
    chars: '# Ship it\n\nbody'.length,
    title: 'Ship it',
  });
  assert.equal('plan' in indexed, false);
});

test('the review transitions run open to released or decided, then closed', () => {
  assert.equal(nextReviewState('open', 'release'), 'released');
  assert.equal(nextReviewState('open', 'decide'), 'decided');
  assert.equal(nextReviewState('open', 'close'), 'closed');
  assert.equal(nextReviewState('released', 'close'), 'closed');
  assert.equal(nextReviewState('decided', 'close'), 'closed');
  assert.equal(nextReviewState('closed', 'close'), 'closed');
  assert.equal(nextReviewState('released', 'decide'), 'released');
  assert.equal(nextReviewState('decided', 'revise'), 'open');
  assert.equal(nextReviewState('closed', 'revise'), 'open');
});

test('a review projects only its own agent revisions, in revision order', () => {
  const entries = [
    entry({ revision: 2, agentType: 'main' }),
    entry({ revision: 1, agentId: 'sub-1', agentType: 'Explore' }),
    entry({ revision: 1, agentType: 'main' }),
  ];
  const main = reviewFrom(entries, null, { state: 'open', openRevision: { revision: 2, since: 500 }, approvedRevision: null });
  assert.deepEqual(main.revisions.map((revision) => revision.revision), [1, 2]);
  assert.equal(main.agentType, 'main');
  assert.deepEqual(main.openRevision, { revision: 2, since: 500 });
  assert.equal(PlanReviewSchema.safeParse(main).success, true);

  const subagent = reviewFrom(entries, 'sub-1', closedProgress());
  assert.deepEqual(subagent.revisions.map((revision) => revision.revision), [1]);
  assert.equal(subagent.agentType, 'Explore');
  assert.equal(subagent.state, 'closed');
});

test('the changed summary names the agent and the receipt time, and never the plan body', () => {
  const payload = planChangedPayload('session-1', entry({
    revision: 3,
    title: 'Ship it',
    chars: 42,
    agentId: 'sub-1',
    agentType: 'Explore',
    receivedAt: 1234,
  }), {
    state: 'released',
    openRevision: null,
    approvedRevision: null,
  }, true);
  assert.deepEqual(payload, {
    id: 'session-1',
    agentId: 'sub-1',
    agentType: 'Explore',
    revision: 3,
    receivedAt: 1234,
    state: 'released',
    chars: 42,
    title: 'Ship it',
    hasPlan: true,
  });
});

test('the review index lists the main agent first and every subagent once', () => {
  const entries = [
    entry({ revision: 1, agentId: 'sub-2' }),
    entry({ revision: 1 }),
    entry({ revision: 2, agentId: 'sub-2' }),
    entry({ revision: 1, agentId: 'sub-1' }),
    entry({ revision: 2, agentId: '' }),
  ];
  assert.deepEqual(agentIdsIn(entries), [null, 'sub-2', 'sub-1']);
  assert.deepEqual(agentIdsIn([entry({ agentId: 'sub-1' })]), ['sub-1']);
  assert.deepEqual(agentIdsIn([]), []);
});

test('a new revision reopens a closed review and releases it, keeping any earlier approval', () => {
  assert.deepEqual(progressAfterRevision(closedProgress()), {
    state: 'released',
    openRevision: null,
    approvedRevision: null,
  });
  assert.deepEqual(progressAfterRevision({ state: 'open', openRevision: { revision: 1, since: 5 }, approvedRevision: 1 }), {
    state: 'released',
    openRevision: null,
    approvedRevision: 1,
  });
});

test('an ExitPlanMode result approves the newest revision only when its plan is the one stored', () => {
  const released = { state: 'released', openRevision: null, approvedRevision: null } satisfies PlanReviewProgress;
  const newest = entry({ revision: 4, chars: 12 });
  assert.deepEqual(progressAfterPlanToolResult(released, newest, null), {
    state: 'closed',
    openRevision: null,
    approvedRevision: 4,
  });
  assert.deepEqual(progressAfterPlanToolResult(released, newest, 'x'.repeat(12)), {
    state: 'closed',
    openRevision: null,
    approvedRevision: 4,
  });
  assert.deepEqual(progressAfterPlanToolResult(released, newest, 'x'.repeat(13)), {
    state: 'closed',
    openRevision: null,
    approvedRevision: null,
  });
});

test('only an ExitPlanMode tool result closes a review', () => {
  assert.equal(isPlanToolResult({ tool_name: 'ExitPlanMode' }), true);
  assert.equal(isPlanToolResult({ tool_name: 'Read' }), false);
  assert.equal(isPlanToolResult(null), false);
});
