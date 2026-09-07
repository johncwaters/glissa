import { TOOL_DETAIL_MAX_CHARS, toolDetailLine } from '../../shared/tool-detail.ts';

export interface TrailStep {
  at: number;
  tool: string;
  detail: string;
}

export interface InvestigationTrail {
  startedAt: number;
  steps: TrailStep[];
}

export const TRAIL_MAX_STEPS = 80;
export const TRAIL_DETAIL_MAX_CHARS = TOOL_DETAIL_MAX_CHARS;
export const TRAIL_TOOL_MAX_CHARS = 64;

export function describeToolStep(toolName: unknown, toolInput: unknown): { tool: string; detail: string } | null {
  const trimmed = typeof toolName === 'string' ? toolName.trim() : '';
  if (!trimmed) return null;
  const tool = trimmed.slice(0, TRAIL_TOOL_MAX_CHARS);
  return { tool, detail: toolDetailLine(tool, toolInput) };
}

export function trailStepFromHook(event: string, payload: Record<string, unknown>): { tool: string; detail: string } | null {
  if (String(event ?? '').toLowerCase() !== 'pretooluse') return null;
  return describeToolStep(payload.tool_name, payload.tool_input);
}

export function createInvestigationTrail(startedAt: number): InvestigationTrail {
  return { startedAt, steps: [] };
}

export function appendTrailStep(
  trail: InvestigationTrail,
  step: TrailStep,
  maxSteps: number = TRAIL_MAX_STEPS,
): InvestigationTrail {
  const steps = [...trail.steps, step];
  return { startedAt: trail.startedAt, steps: steps.slice(Math.max(0, steps.length - maxSteps)) };
}
