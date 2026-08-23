// Pure rule behind the card's agent chip: which agent id is worth a badge, and what it reads as.
// The default agent is the whole dashboard's assumption, so naming it on every card would be noise;
// anything else is standing identity the operator needs before reading a status (M2 of
// docs/plan-agent-adapters.md). The id is rendered as-is: the wire carries no display label, and
// inventing one here would drift from the adapter that owns it.

export const DEFAULT_AGENT_ID = 'claude-code';

export function agentBadgeText(agent) {
  if (typeof agent !== 'string') return '';
  const id = agent.trim();
  if (!id || id === DEFAULT_AGENT_ID) return '';
  return id;
}
