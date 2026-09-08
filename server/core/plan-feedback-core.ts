import { PLAN_HOOK_OUTPUT_MAX_CHARS } from '../../shared/contracts/plan-review.ts';
import type { PlanSectionComment } from '../../shared/contracts/plan-review.ts';

interface PlanFeedbackInput {
  revision: number;
  comments?: readonly PlanSectionComment[];
  feedback?: string;
}

const NO_DETAIL = 'No detail was given.';
const REVISE_TAIL = 'Revise the plan and present it again.';
const FEEDBACK_OVER_HOOK_LIMIT =
  `This feedback composes a message over the ${PLAN_HOOK_OUTPUT_MAX_CHARS} character limit the hook reply carries`;

function commentBlock({ heading, comment }: PlanSectionComment): string | null {
  const text = comment.trim();
  if (text.length === 0) return null;
  if (heading === null) return `On the plan as a whole:\n${text}`;
  return `On the section "${heading}":\n${text}`;
}

function composePlanFeedback({ revision, comments = [], feedback = '' }: PlanFeedbackInput): string {
  const blocks: string[] = [];
  for (const comment of comments) {
    const block = commentBlock(comment);
    if (block) blocks.push(block);
  }
  const general = feedback.trim();
  if (general.length > 0) blocks.push(general);
  if (blocks.length === 0) blocks.push(NO_DETAIL);
  return [`Feedback on plan revision ${revision}:`, ...blocks, REVISE_TAIL].join('\n\n');
}

function planFeedbackRefusal(input: PlanFeedbackInput): string | null {
  if (composePlanFeedback(input).length <= PLAN_HOOK_OUTPUT_MAX_CHARS) return null;
  return FEEDBACK_OVER_HOOK_LIMIT;
}

export { FEEDBACK_OVER_HOOK_LIMIT, composePlanFeedback, planFeedbackRefusal };
