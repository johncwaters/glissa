import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EDITED_PLAN_TOO_LARGE,
  NO_OPEN_REVIEW,
  PASS_THROUGH_REPLY,
  agentIdsIn,
  agentKey,
  closedProgress,
  decisionRefusal,
  decisionReply,
  editedPlanRefusal,
  entriesForAgent,
  indexEntryFor,
  isPlanHookEvent,
  isPlanToolResult,
  newestEntry,
  nextReviewState,
  nextRevisionNumber,
  planChangedPayload,
  progressAfterDecision,
  progressAfterEvent,
  progressAfterPlanToolResult,
  progressAfterRevision,
  reviewFrom,
  revisionRecord,
  selectEntry,
} from '../server/core/plan-review-core.ts';
import type { PlanReviewProgress, PlanRevisionIndexEntry } from '../server/core/plan-review-core.ts';
import { composePlanFeedback } from '../server/core/plan-feedback-core.ts';
import { PLAN_BODY_CAP_BYTES, PlanReview as PlanReviewSchema } from '../shared/contracts/plan-review.ts';

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
    planFilePath: '/plans/a.md',
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
    planFilePath: '/plans/a.md',
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
  const main = reviewFrom(entries, null, { state: 'open', openRevision: { revision: 2, since: 500 }, approvedRevision: null, lastDecision: null });
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
    lastDecision: 'terminal',
  }, true);
  assert.deepEqual(payload, {
    id: 'session-1',
    agentId: 'sub-1',
    agentType: 'Explore',
    revision: 3,
    receivedAt: 1234,
    state: 'released',
    lastDecision: 'terminal',
    approvedRevision: null,
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

test('a new revision reopens a closed review on that revision, keeping any earlier approval', () => {
  assert.deepEqual(progressAfterRevision(closedProgress(), { revision: 1, since: 5 }), {
    state: 'open',
    openRevision: { revision: 1, since: 5 },
    approvedRevision: null,
    lastDecision: null,
  });
  const decided = { state: 'decided', openRevision: null, approvedRevision: 1, lastDecision: 'revise' } satisfies PlanReviewProgress;
  assert.deepEqual(progressAfterRevision(decided, { revision: 2, since: 9 }), {
    state: 'open',
    openRevision: { revision: 2, since: 9 },
    approvedRevision: 1,
    lastDecision: null,
  });
});

test('an ExitPlanMode result approves the newest revision only when its plan is the one stored', () => {
  const released = { state: 'released', openRevision: null, approvedRevision: null, lastDecision: null } satisfies PlanReviewProgress;
  const newest = entry({ revision: 4, chars: 12 });
  assert.deepEqual(progressAfterPlanToolResult(released, newest, null), {
    state: 'closed',
    openRevision: null,
    approvedRevision: 4,
    lastDecision: null,
  });
  assert.deepEqual(progressAfterPlanToolResult(released, newest, 'x'.repeat(12)), {
    state: 'closed',
    openRevision: null,
    approvedRevision: 4,
    lastDecision: null,
  });
  assert.deepEqual(progressAfterPlanToolResult(released, newest, 'x'.repeat(13)), {
    state: 'closed',
    openRevision: null,
    approvedRevision: null,
    lastDecision: null,
  });
});

test('only an ExitPlanMode tool result closes a review', () => {
  assert.equal(isPlanToolResult({ tool_name: 'ExitPlanMode' }), true);
  assert.equal(isPlanToolResult({ tool_name: 'Read' }), false);
  assert.equal(isPlanToolResult(null), false);
});

function openProgress(revision: number): PlanReviewProgress {
  return { state: 'open', openRevision: { revision, since: 5 }, approvedRevision: null, lastDecision: null };
}

test('an allow decides the review and a terminal pass-through only releases it', () => {
  assert.deepEqual(progressAfterDecision(openProgress(2), 'approve'), {
    state: 'decided',
    openRevision: null,
    approvedRevision: null,
    lastDecision: 'approve',
  });
  assert.deepEqual(progressAfterDecision(openProgress(2), 'revise'), {
    state: 'decided',
    openRevision: null,
    approvedRevision: null,
    lastDecision: 'revise',
  });
  assert.deepEqual(progressAfterDecision(openProgress(2), 'terminal'), {
    state: 'released',
    openRevision: null,
    approvedRevision: null,
    lastDecision: 'terminal',
  });
});

test('every release path clears the open revision and keeps the earlier approval', () => {
  const open = { state: 'open', openRevision: { revision: 3, since: 5 }, approvedRevision: 2, lastDecision: null } satisfies PlanReviewProgress;
  assert.deepEqual(progressAfterEvent(open, 'release'), {
    state: 'released',
    openRevision: null,
    approvedRevision: 2,
    lastDecision: null,
  });
  assert.deepEqual(progressAfterEvent(open, 'close'), {
    state: 'closed',
    openRevision: null,
    approvedRevision: 2,
    lastDecision: null,
  });
});

test('a decision is refused unless it names the revision of an open review', () => {
  assert.equal(decisionRefusal(openProgress(2), 2), null);
  assert.equal(decisionRefusal(openProgress(2), 1), 'This decision names revision 1, but revision 2 is open');
  assert.equal(decisionRefusal(closedProgress(), 1), NO_OPEN_REVIEW);
  assert.equal(decisionRefusal(null, 1), NO_OPEN_REVIEW);
  assert.equal(
    decisionRefusal({ state: 'decided', openRevision: null, approvedRevision: null, lastDecision: 'approve' }, 1),
    NO_OPEN_REVIEW,
  );
});

test('each decision composes the hook reply the spike measured, echoing the bytes as received', () => {
  const held = { plan: '# Ship it\n', planFilePath: '/plans/a.md', revision: 2 };
  assert.deepEqual(decisionReply('approve', held, {}), {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { plan: '# Ship it\n', planFilePath: '/plans/a.md' } },
    },
  });
  assert.deepEqual(decisionReply('approve-accept-edits', held, {}), {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        updatedInput: { plan: '# Ship it\n', planFilePath: '/plans/a.md' },
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      },
    },
  });
  assert.deepEqual(decisionReply('revise', held, { feedback: 'drop step 2' }), {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: composePlanFeedback({ revision: 2, feedback: 'drop step 2' }) },
    },
  });
  assert.deepEqual(decisionReply('terminal', held, {}), PASS_THROUGH_REPLY);
  assert.deepEqual(PASS_THROUGH_REPLY, {});
});

test('an approve carrying an edited plan echoes the edit, and an unedited one echoes the received bytes', () => {
  const held = { plan: '# Ship it\n', planFilePath: '/plans/a.md', revision: 2 };
  const edited = decisionReply('approve', held, { plan: '# Ship it later\n' });
  assert.deepEqual(edited, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { plan: '# Ship it later\n', planFilePath: '/plans/a.md' } },
    },
  });
  const acceptingEdits = decisionReply('approve-accept-edits', held, { plan: '# Ship it later\n' });
  assert.deepEqual(acceptingEdits, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        updatedInput: { plan: '# Ship it later\n', planFilePath: '/plans/a.md' },
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      },
    },
  });
  assert.equal(decisionReply('revise', held, { plan: '# ignored\n', feedback: 'no' }).hookSpecificOutput !== undefined, true);
});

test('an edited plan over the hook body cap is refused rather than written into the reply', () => {
  assert.equal(editedPlanRefusal(null), null);
  assert.equal(editedPlanRefusal('# Ship it'), null);
  assert.equal(editedPlanRefusal('x'.repeat(PLAN_BODY_CAP_BYTES)), null);
  assert.equal(editedPlanRefusal('x'.repeat(PLAN_BODY_CAP_BYTES + 1)), EDITED_PLAN_TOO_LARGE);
  const multibyte = String.fromCharCode(0x4e2d).repeat(PLAN_BODY_CAP_BYTES / 2);
  assert.equal(editedPlanRefusal(multibyte), EDITED_PLAN_TOO_LARGE, 'the cap counts bytes, never characters');
});
