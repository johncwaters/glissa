import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_COMMENT_MAX_CHARS, PLAN_HOOK_OUTPUT_MAX_CHARS } from '../shared/contracts/plan-review.ts';
import { composePlanFeedback, planFeedbackRefusal } from '../server/core/plan-feedback-core.ts';

test('the composed deny message names the revision and carries the operator text verbatim', () => {
  assert.equal(
    composePlanFeedback({ revision: 3, feedback: '  step 2 must print the file  ' }),
    'Feedback on plan revision 3:\n\nstep 2 must print the file\n\nRevise the plan and present it again.',
  );
});

test('a revise with nothing typed still tells the agent what to do next', () => {
  assert.equal(
    composePlanFeedback({ revision: 1, feedback: '   ', comments: [] }),
    'Feedback on plan revision 1:\n\nNo detail was given.\n\nRevise the plan and present it again.',
  );
  assert.equal(composePlanFeedback({ revision: 1 }), composePlanFeedback({ revision: 1, feedback: '' }));
});

test('section comments keep document order, each quoting the heading it hangs under', () => {
  const message = composePlanFeedback({
    revision: 2,
    comments: [
      { heading: 'Rollout', comment: 'stage it behind the flag' },
      { heading: 'Rollback', comment: '  name the owner  ' },
    ],
    feedback: 'the whole thing is too long',
  });
  assert.equal(message, [
    'Feedback on plan revision 2:',
    'On the section "Rollout":\nstage it behind the flag',
    'On the section "Rollback":\nname the owner',
    'the whole thing is too long',
    'Revise the plan and present it again.',
  ].join('\n\n'));
});

test('a comment with no heading is a comment on the whole plan', () => {
  assert.equal(
    composePlanFeedback({ revision: 4, comments: [{ heading: null, comment: 'no rollback story anywhere' }] }),
    'Feedback on plan revision 4:\n\nOn the plan as a whole:\nno rollback story anywhere\n\nRevise the plan and present it again.',
  );
});

test('a comment that is only whitespace is dropped rather than sent as an empty block', () => {
  assert.equal(
    composePlanFeedback({
      revision: 5,
      comments: [{ heading: 'Rollout', comment: '   ' }, { heading: 'Rollback', comment: 'own it' }],
    }),
    'Feedback on plan revision 5:\n\nOn the section "Rollback":\nown it\n\nRevise the plan and present it again.',
  );
  assert.equal(
    composePlanFeedback({ revision: 5, comments: [{ heading: 'Rollout', comment: '   ' }] }),
    'Feedback on plan revision 5:\n\nNo detail was given.\n\nRevise the plan and present it again.',
  );
});

test('a message over the hook output limit is refused, since a longer reply reaches the agent as a preview', () => {
  const comments = [0, 1, 2].map((index) => ({
    heading: `Section ${index}`,
    comment: 'x'.repeat(PLAN_COMMENT_MAX_CHARS),
  }));
  assert.ok(composePlanFeedback({ revision: 1, comments }).length > PLAN_HOOK_OUTPUT_MAX_CHARS);
  const refusal = planFeedbackRefusal({ revision: 1, comments });
  assert.ok(refusal);
  assert.match(refusal, new RegExp(String(PLAN_HOOK_OUTPUT_MAX_CHARS)));
});

test('a message at the hook output limit is composed rather than refused', () => {
  const filled = { revision: 1, feedback: 'y'.repeat(PLAN_HOOK_OUTPUT_MAX_CHARS - 100) };
  assert.ok(composePlanFeedback(filled).length <= PLAN_HOOK_OUTPUT_MAX_CHARS);
  assert.equal(planFeedbackRefusal(filled), null);
  assert.equal(planFeedbackRefusal({ revision: 1 }), null);
});
