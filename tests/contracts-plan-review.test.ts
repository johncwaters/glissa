import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  ExitPlanModeInput,
  parseExitPlanModeHookPayload,
  PLAN_BODY_CAP_BYTES,
  PLAN_COMMENT_MAX_CHARS,
  PLAN_COMMENTS_MAX,
  PLAN_DECISION_KINDS,
  PLAN_DRAFT_REVISION,
  PLAN_FEEDBACK_MAX_CHARS,
  PLAN_REVIEW_STATE_VALUES,
  PLAN_TITLE_MAX_CHARS,
  PlanDecision,
  PlanReview,
  PlanReviewState,
  PlanRevision,
  PlanRevisionBody,
  PlanSectionComment,
  planTitle,
} from '../shared/contracts/plan-review.ts';

const PLAN_BODY = '# Shrink the large owned files\n\n## Context\n\nA size sweep found three files.\n';
const PLAN_FILE_PATH = '/home/u/.claude/plans/recursive-drifting-grove.md';

function hookPayload(overrides: Record<string, unknown> = {}, inputOverrides: Record<string, unknown> = {}) {
  return {
    session_id: 'vendor-1',
    transcript_path: '/home/u/.claude/projects/a.jsonl',
    cwd: '/repo/glimmervoid',
    permission_mode: 'plan',
    hook_event_name: 'PermissionRequest',
    tool_name: 'ExitPlanMode',
    tool_input: { plan: PLAN_BODY, planFilePath: PLAN_FILE_PATH, ...inputOverrides },
    ...overrides,
  };
}

test('a main-agent ExitPlanMode request parses into a plan with null agent fields', () => {
  assert.deepEqual(parseExitPlanModeHookPayload(hookPayload()), {
    plan: PLAN_BODY,
    planFilePath: PLAN_FILE_PATH,
    agentId: null,
    agentType: null,
  });
});

test('a subagent ExitPlanMode request carries the agent that raised it', () => {
  const parsed = parseExitPlanModeHookPayload(hookPayload({ agent_id: 'agent-9', agent_type: 'general-purpose' }));
  assert.equal(parsed?.agentId, 'agent-9');
  assert.equal(parsed?.agentType, 'general-purpose');
});

test('the parse fails closed on every shape the lane must not store', () => {
  assert.equal(parseExitPlanModeHookPayload(hookPayload({ tool_input: { planFilePath: PLAN_FILE_PATH } })), null);
  assert.equal(parseExitPlanModeHookPayload(hookPayload({}, { planFilePath: 7 })), null);
  assert.equal(parseExitPlanModeHookPayload(hookPayload({}, { plan: '' })), null);
  assert.equal(parseExitPlanModeHookPayload(hookPayload({ tool_name: 'Bash' })), null);
  assert.equal(parseExitPlanModeHookPayload(hookPayload({ tool_input: undefined })), null);
  assert.equal(parseExitPlanModeHookPayload(hookPayload({ agent_id: 7 })), null);
  assert.equal(parseExitPlanModeHookPayload(null), null);
  assert.equal(parseExitPlanModeHookPayload('# a plan'), null);
});

test('the recorded ExitPlanMode request from a live session parses', () => {
  const fixture = path.join(import.meta.dirname, 'fixtures', 'v2-waiting-plan.jsonl');
  const record = fs.readFileSync(fixture, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.type === 'hook' && entry.payload?.tool_name === 'ExitPlanMode');
  const parsed = parseExitPlanModeHookPayload(record.payload);
  assert.ok(parsed);
  assert.equal(parsed.planFilePath, '/home/u/.claude/plans/recursive-drifting-grove.md');
  assert.equal(planTitle(parsed.plan), 'Shrink the large owned files');
});

test('ExitPlanModeInput keeps unknown tool input fields instead of rejecting them', () => {
  const parsed = ExitPlanModeInput.parse({ plan: PLAN_BODY, planFilePath: PLAN_FILE_PATH, futureField: true });
  assert.equal(parsed.futureField, true);
});

test('planTitle prefers the first ATX heading over the first line', () => {
  assert.equal(planTitle('Some preamble\n\n# The real title\n\nbody'), 'The real title');
  assert.equal(planTitle('   ### Indented heading ###\nbody'), 'Indented heading');
  assert.equal(planTitle('#NoSpace is not a heading\nsecond line'), '#NoSpace is not a heading');
});

test('planTitle falls back to the first non-empty line and caps its length', () => {
  assert.equal(planTitle('\n\n  Just a paragraph  \nmore'), 'Just a paragraph');
  assert.equal(planTitle(''), '');
  assert.equal(planTitle('\n\n'), '');
  assert.equal(planTitle(null), '');
  assert.equal(planTitle('# '), '#');
  const long = `# ${'a'.repeat(400)}`;
  assert.equal(planTitle(long).length, PLAN_TITLE_MAX_CHARS);
  assert.equal(planTitle(`${'b'.repeat(400)}`).length, PLAN_TITLE_MAX_CHARS);
});

test('planTitle stays linear on a heading line of spaces, hashes and spaces', () => {
  const runLength = 34 * 1024;
  const adversarial = `# ${' '.repeat(runLength)}${'#'.repeat(runLength)}${' '.repeat(runLength)}x`;
  assert.ok(adversarial.length > 100 * 1024, 'the crafted heading line is over 100 KB');
  const startedAt = Date.now();
  const title = planTitle(`${adversarial}\nbody`);
  assert.ok(Date.now() - startedAt < 50, 'a 100 KB heading line never backtracks');
  assert.ok(title.length <= PLAN_TITLE_MAX_CHARS);
});

test('planTitle reads a CRLF plan the same as an LF plan', () => {
  assert.equal(planTitle('# Title\r\n\r\nbody'), 'Title');
});

test('a revision records the agent at receive time and rejects a zero revision', () => {
  const revision = PlanRevision.parse({
    sessionId: 'session-1',
    revision: 1,
    plan: PLAN_BODY,
    planFilePath: PLAN_FILE_PATH,
    receivedAt: 1_777_000_000_000,
    agentId: null,
    agentType: null,
  });
  assert.equal(revision.revision, 1);
  assert.equal(PlanRevision.safeParse({ ...revision, revision: 0 }).success, false);
  assert.equal(PlanRevision.safeParse({ ...revision, agentId: undefined }).success, false);
});

test('a review summarizes its revisions without ever carrying a body', () => {
  const review = PlanReview.parse({
    agentId: null,
    agentType: null,
    revisions: [{ revision: 1, receivedAt: 1, chars: 8454, title: 'Shrink the large owned files' }],
    state: 'open',
    openRevision: { revision: 1, since: 2 },
    approvedRevision: null,
    lastDecision: null,
  });
  assert.deepEqual(Object.keys(review.revisions[0]).includes('plan'), false);
  assert.equal(PlanReviewState.parse({ reviews: [review] }).reviews.length, 1);
  assert.equal(PlanReview.safeParse({ ...review, state: 'holding' }).success, false);
});

test('the enumeration pins the four review states', () => {
  assert.deepEqual([...PLAN_REVIEW_STATE_VALUES], ['open', 'released', 'decided', 'closed']);
});

test('a decision names one revision of one review and one of the four kinds', () => {
  assert.deepEqual([...PLAN_DECISION_KINDS], ['approve', 'approve-accept-edits', 'revise', 'terminal']);
  const decision = PlanDecision.parse({ id: 'session-1', agentId: null, revision: 2, decision: 'revise', feedback: 'no' });
  assert.deepEqual(decision, { id: 'session-1', agentId: null, revision: 2, decision: 'revise', feedback: 'no' });
  assert.equal(PlanDecision.safeParse({ id: 'session-1', agentId: null, revision: 2, decision: 'approve' }).success, true);
  assert.equal(PlanDecision.safeParse({ id: 'session-1', agentId: null, revision: 0, decision: 'approve' }).success, false);
  assert.equal(PlanDecision.safeParse({ id: 'session-1', agentId: null, revision: 2, decision: 'edit' }).success, false);
  assert.equal(PlanDecision.safeParse({ id: '', agentId: null, revision: 2, decision: 'approve' }).success, false);
  assert.equal(
    PlanDecision.safeParse({ id: 'session-1', agentId: null, revision: 2, decision: 'revise', feedback: 'x'.repeat(PLAN_FEEDBACK_MAX_CHARS + 1) }).success,
    false,
    'feedback is capped at the boundary, not truncated inside the lane',
  );
});

test('a section comment names the heading it hangs under, or none for the whole plan', () => {
  assert.deepEqual(
    PlanSectionComment.parse({ heading: 'Rollout', comment: 'stage it' }),
    { heading: 'Rollout', comment: 'stage it' },
  );
  assert.equal(PlanSectionComment.safeParse({ heading: null, comment: 'no rollback story' }).success, true);
  assert.equal(PlanSectionComment.safeParse({ heading: 'Rollout', comment: '' }).success, false);
  assert.equal(PlanSectionComment.safeParse({ comment: 'stage it' }).success, false, 'a missing heading is not a null one');
  assert.equal(
    PlanSectionComment.safeParse({ heading: null, comment: 'x'.repeat(PLAN_COMMENT_MAX_CHARS + 1) }).success,
    false,
    'a comment is capped at the boundary, not truncated inside the lane',
  );
});

test('a decision carries section comments and an edited plan, both capped where they cross the wire', () => {
  const decided = PlanDecision.parse({
    id: 'session-1',
    agentId: null,
    revision: 2,
    decision: 'revise',
    feedback: 'too long',
    comments: [{ heading: 'Rollout', comment: 'stage it' }],
  });
  assert.deepEqual(decided.comments, [{ heading: 'Rollout', comment: 'stage it' }]);

  const edited = PlanDecision.parse({
    id: 'session-1', agentId: null, revision: 2, decision: 'approve', plan: '# Ship it',
  });
  assert.equal(edited.plan, '# Ship it');

  const tooManyComments = Array.from({ length: PLAN_COMMENTS_MAX + 1 }, () => ({ heading: null, comment: 'x' }));
  assert.equal(
    PlanDecision.safeParse({ id: 'session-1', agentId: null, revision: 2, decision: 'revise', comments: tooManyComments }).success,
    false,
  );
  assert.equal(
    PlanDecision.safeParse({ id: 'session-1', agentId: null, revision: 2, decision: 'approve', plan: 'x'.repeat(PLAN_BODY_CAP_BYTES + 1) }).success,
    false,
  );
  assert.equal(
    PlanDecision.safeParse({ id: 'session-1', agentId: null, revision: 2, decision: 'approve', plan: '' }).success,
    false,
    'an empty edit is a mistake, never an approval of nothing',
  );
});

test('revision zero is what marks a body as a draft, and no stored revision may claim it', () => {
  assert.equal(PLAN_DRAFT_REVISION, 0);
  const draft = PlanRevisionBody.parse({
    agentId: null,
    revision: PLAN_DRAFT_REVISION,
    plan: '# Ship it',
    planFilePath: '/home/u/.claude/plans/a.md',
    receivedAt: 1_777_000_000_000,
  });
  assert.equal(draft.revision, 0);
  assert.equal(PlanRevisionBody.safeParse({ ...draft, revision: -1 }).success, false);
  assert.equal(
    PlanRevision.safeParse({
      sessionId: 'session-1',
      revision: PLAN_DRAFT_REVISION,
      plan: '# Ship it',
      planFilePath: '/home/u/.claude/plans/a.md',
      receivedAt: 1_777_000_000_000,
      agentId: null,
      agentType: null,
    }).success,
    false,
    'a draft is never appended to the revision store',
  );
});
