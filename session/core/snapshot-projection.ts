interface SnapshotSource {
  id: string;
  name: string;
  path: string;
  agent: string;
  state: string;
  stateSince: number;
  sleeping: boolean;
  dangerouslySkipPermissions: boolean;
  ephemeral: boolean;
  isWorktree: boolean;
  resumeSessionId: string | null;
  activeAgents: number;
  packs: { name: string; version: string }[];
  pendingWakeup: Record<string, unknown> | null;
  pendingPromptKind: string | null;
  mergeStatus: string;
  mergeReason: string | null;
  worktreeNotice: string | null;
  effectiveBase: string | null;
  auditLog: Record<string, unknown>[];
  detection: Record<string, unknown>;
  decisions: Record<string, unknown>[];
}

function projectSessionSnapshots(source: SnapshotSource) {
  const wire = {
    id: source.id,
    name: source.name,
    path: source.path,
    agent: source.agent,
    state: source.state,
    stateSince: source.stateSince,
    sleeping: source.sleeping,
    dangerouslySkipPermissions: source.dangerouslySkipPermissions,
    ephemeral: source.ephemeral,
    isWorktree: source.isWorktree,
    resumeSessionId: source.resumeSessionId,
    activeAgents: source.activeAgents,
    packs: source.packs.map(({ name, version }) => ({ name, version })),
    pendingWakeup: source.pendingWakeup,
    pendingPromptKind: source.pendingPromptKind,
    mergeStatus: source.mergeStatus,
    mergeReason: source.mergeReason,
    worktreeNotice: source.worktreeNotice,
    effectiveBase: source.effectiveBase ?? null,
    auditLog: source.auditLog.slice(-100),
  };
  const debug = {
    state: wire.state,
    transitions: wire.auditLog.slice(-5).map((entry) => ({
      from: entry.from,
      to: entry.to,
      event: entry.event,
      timestamp: entry.timestamp,
      detail: entry.detail,
    })),
    detection: source.detection,
    packs: wire.packs,
    decisions: source.decisions.slice(-15),
  };
  return { wire, debug };
}

export { projectSessionSnapshots };
export type { SnapshotSource };
