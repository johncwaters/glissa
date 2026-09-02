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
export const TRAIL_DETAIL_MAX_CHARS = 160;
export const TRAIL_TOOL_MAX_CHARS = 64;

const DETAIL_FIELD_BY_TOOL: Record<string, string> = {
  Bash: 'command',
  Read: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
  Grep: 'pattern',
  Glob: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
  Task: 'description',
  Agent: 'description',
  Skill: 'skill',
};

function firstLineOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  const line = value.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (line.length <= TRAIL_DETAIL_MAX_CHARS) return line;
  return line.slice(0, TRAIL_DETAIL_MAX_CHARS);
}

export function describeToolStep(toolName: unknown, toolInput: unknown): { tool: string; detail: string } | null {
  const trimmed = typeof toolName === 'string' ? toolName.trim() : '';
  if (!trimmed) return null;
  const tool = trimmed.slice(0, TRAIL_TOOL_MAX_CHARS);
  const input = toolInput && typeof toolInput === 'object' ? toolInput as Record<string, unknown> : {};
  const field = DETAIL_FIELD_BY_TOOL[tool];
  if (!field) return { tool, detail: '' };
  return { tool, detail: firstLineOf(input[field]) };
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
