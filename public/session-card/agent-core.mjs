// Pure rules behind the agent chip and Add Session picker (M2/M6 of docs/plan-agent-adapters.md).

export const DEFAULT_AGENT_ID = 'claude-code';

// Short badge labels; wire carries only id (M2), unmapped ids render as-is.
const BADGE_LABELS = { codex: 'Codex', grok: 'Grok' };

export function agentBadgeText(agent) {
  if (typeof agent !== 'string') return '';
  const id = agent.trim();
  if (!id || id === DEFAULT_AGENT_ID) return '';
  return BADGE_LABELS[id] || id;
}

// Filters to resolvable agents; hides picker for a single option; defaults to defaultId or first resolvable.
export function decideAgentPicker(agents, { defaultId = DEFAULT_AGENT_ID } = {}) {
  const resolvable = (Array.isArray(agents) ? agents : []).filter(
    (a) => a?.resolvable && typeof a.id === 'string' && a.id,
  );
  const options = resolvable.map((a) => ({ id: a.id, label: typeof a.label === 'string' && a.label ? a.label : a.id }));
  const hasDefault = options.some((o) => o.id === defaultId);
  const selectedId = hasDefault ? defaultId : options.length > 0 ? options[0].id : defaultId;
  return { show: options.length > 1, options, selectedId };
}
