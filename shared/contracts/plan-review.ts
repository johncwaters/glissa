import { z } from 'zod';

export const PLAN_TITLE_MAX_CHARS = 120;
export const PLAN_FEEDBACK_MAX_CHARS = 20000;
export const PLAN_COMMENT_MAX_CHARS = 4000;
export const PLAN_COMMENTS_MAX = 40;
export const PLAN_BODY_CAP_BYTES = 512 * 1024;
export const PLAN_HOOK_OUTPUT_MAX_CHARS = 10000;
export const PLAN_DRAFT_REVISION = 0;
export const PLAN_HOOK_EVENT = 'permissionrequest-plan';
export const PLAN_RESULT_HOOK_EVENT = 'posttooluse-plan';
export const PLAN_TOOL_NAME = 'ExitPlanMode';

const HEADING_SCAN_MAX_CHARS = 4096;
const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.*)$/;

function capPlanTitle(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PLAN_TITLE_MAX_CHARS) return trimmed;
  return trimmed.slice(0, PLAN_TITLE_MAX_CHARS);
}

function withoutClosingHeadingMarks(text: string): string {
  const trimmed = text.trimEnd();
  let textEnd = trimmed.length;
  while (textEnd > 0 && trimmed[textEnd - 1] === '#') textEnd--;
  if (textEnd === trimmed.length || textEnd === 0) return trimmed;
  const charBeforeMarks = trimmed[textEnd - 1];
  if (charBeforeMarks !== ' ' && charBeforeMarks !== '\t') return trimmed;
  return trimmed.slice(0, textEnd).trimEnd();
}

function headingTitle(line: string): string {
  const heading = ATX_HEADING.exec(line.slice(0, HEADING_SCAN_MAX_CHARS));
  if (!heading) return '';
  return withoutClosingHeadingMarks(heading[1]);
}

export function planTitle(plan: unknown): string {
  const lines = typeof plan === 'string' ? plan.split(/\r?\n/) : [];
  for (const line of lines) {
    const title = headingTitle(line);
    if (title.length > 0) return capPlanTitle(title);
  }
  const firstNonEmptyLine = lines.find((line) => line.trim().length > 0);
  return capPlanTitle(firstNonEmptyLine ?? '');
}

export const ExitPlanModeInput = z.object({
  plan: z.string().min(1),
  planFilePath: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  agent_type: z.string().min(1).optional(),
}).passthrough();

const ExitPlanModeHookPayload = z.object({
  tool_name: z.literal(PLAN_TOOL_NAME),
  tool_input: ExitPlanModeInput,
  agent_id: z.string().min(1).optional(),
  agent_type: z.string().min(1).optional(),
}).passthrough();

export const ExitPlanModeRequest = z.object({
  plan: z.string(),
  planFilePath: z.string(),
  agentId: z.string().nullable(),
  agentType: z.string().nullable(),
});

export function parseExitPlanModeHookPayload(body: unknown): ExitPlanModeRequest | null {
  const parsed = ExitPlanModeHookPayload.safeParse(body);
  if (!parsed.success) return null;
  const input = parsed.data.tool_input;
  return {
    plan: input.plan,
    planFilePath: input.planFilePath,
    agentId: parsed.data.agent_id ?? input.agent_id ?? null,
    agentType: parsed.data.agent_type ?? input.agent_type ?? null,
  };
}

export const PlanRevision = ExitPlanModeRequest.extend({
  sessionId: z.string().min(1),
  revision: z.number().int().positive(),
  receivedAt: z.number().finite(),
});

export const PLAN_REVIEW_STATE_VALUES = Object.freeze(['open', 'released', 'decided', 'closed'] as const);
export const PlanReviewStateValue = z.enum(PLAN_REVIEW_STATE_VALUES);

export const PLAN_DECISION_KINDS = Object.freeze(['approve', 'approve-accept-edits', 'revise', 'terminal'] as const);
export const PlanDecisionKind = z.enum(PLAN_DECISION_KINDS);

export const PlanSectionComment = z.object({
  heading: z.string().max(PLAN_COMMENT_MAX_CHARS).nullable(),
  comment: z.string().min(1).max(PLAN_COMMENT_MAX_CHARS),
});

export const PlanDecision = z.object({
  id: z.string().min(1),
  agentId: z.string().nullable(),
  revision: z.number().int().positive(),
  decision: PlanDecisionKind,
  feedback: z.string().max(PLAN_FEEDBACK_MAX_CHARS).optional(),
  comments: z.array(PlanSectionComment).max(PLAN_COMMENTS_MAX).optional(),
  plan: z.string().min(1).max(PLAN_BODY_CAP_BYTES).optional(),
});

export const PlanRevisionSummary = z.object({
  revision: z.number().int().positive(),
  receivedAt: z.number().finite(),
  chars: z.number().int().nonnegative(),
  title: z.string(),
});

export const PlanReviewOpenRevision = z.object({
  revision: z.number().int().positive(),
  since: z.number().finite(),
});

export const PlanReview = z.object({
  agentId: z.string().nullable(),
  agentType: z.string().nullable(),
  revisions: z.array(PlanRevisionSummary),
  state: PlanReviewStateValue,
  openRevision: PlanReviewOpenRevision.nullable(),
  approvedRevision: z.number().int().positive().nullable(),
  lastDecision: PlanDecisionKind.nullable(),
});

export const PlanReviewState = z.object({
  reviews: z.array(PlanReview),
});

export const PlanRevisionBody = z.object({
  agentId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  plan: z.string(),
  planFilePath: z.string(),
  receivedAt: z.number().finite(),
});

export const PlanChangedPush = z.object({
  id: z.string(),
  agentId: z.string().nullable(),
  agentType: z.string().nullable(),
  revision: z.number().int().positive(),
  receivedAt: z.number().finite(),
  state: PlanReviewStateValue,
  lastDecision: PlanDecisionKind.nullable(),
  approvedRevision: z.number().int().positive().nullable(),
  chars: z.number().int().nonnegative(),
  title: z.string(),
  hasPlan: z.boolean(),
});

export const PlanDraftPush = z.object({
  id: z.string(),
  agentId: z.string().nullable(),
  planFilePath: z.string(),
  changedAt: z.number().finite(),
});

export const PlanResponseFrame = z.object({
  id: z.string(),
  reviews: z.array(PlanReview),
  body: PlanRevisionBody.nullable(),
});

export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInput>;
export type ExitPlanModeRequest = z.infer<typeof ExitPlanModeRequest>;
export type PlanRevision = z.infer<typeof PlanRevision>;
export type PlanReviewStateValue = z.infer<typeof PlanReviewStateValue>;
export type PlanDecisionKind = z.infer<typeof PlanDecisionKind>;
export type PlanSectionComment = z.infer<typeof PlanSectionComment>;
export type PlanDecision = z.infer<typeof PlanDecision>;
export type PlanDecisionRequest = Omit<PlanDecision, 'id'>;
export type PlanRevisionSummary = z.infer<typeof PlanRevisionSummary>;
export type PlanReviewOpenRevision = z.infer<typeof PlanReviewOpenRevision>;
export type PlanReview = z.infer<typeof PlanReview>;
export type PlanReviewState = z.infer<typeof PlanReviewState>;
export type PlanRevisionBody = z.infer<typeof PlanRevisionBody>;
export type PlanChangedPush = z.infer<typeof PlanChangedPush>;
export type PlanDraftPush = z.infer<typeof PlanDraftPush>;
export type PlanResponseFrame = z.infer<typeof PlanResponseFrame>;
