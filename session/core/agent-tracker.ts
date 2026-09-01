
const DEFAULT_AGENT_TTL_MS = 30 * 60 * 1000;

type TimestampMap = Map<string, number>;

function addAgent(map: TimestampMap, agentId: string | null | undefined, ts: number): boolean {
  if (!agentId) return false;
  const had = map.has(agentId);
  map.set(agentId, ts);
  return !had;
}

function removeAgent(map: TimestampMap, agentId: string | null | undefined): boolean {
  if (!agentId) return false;
  return map.delete(agentId);
}

function pruneAgents(map: TimestampMap, now: number, ttlMs = DEFAULT_AGENT_TTL_MS): number {
  let removed = 0;
  for (const [id, ts] of map) {
    if (now - ts >= ttlMs) {
      map.delete(id);
      removed++;
    }
  }
  return removed;
}

const SETTLED_TASK_STATUSES = new Set([
  'completed', 'complete', 'done', 'finished', 'failed', 'error',
  'killed', 'cancelled', 'canceled', 'exited', 'idle', 'success',
]);

function extractBackgroundTasks(payload: unknown): DeclaredEntry[] | null {
  if (!payload) return null;
  const v = (payload as { background_tasks?: unknown }).background_tasks;
  if (!Array.isArray(v)) return null;
  const entries: DeclaredEntry[] = [];
  for (const raw of v) {
    const t = raw as { status?: unknown; id?: unknown; type?: unknown } | null;
    const status = t && typeof t.status === 'string' ? t.status.toLowerCase() : null;
    if (status && SETTLED_TASK_STATUSES.has(status)) continue;
    entries.push({
      id: t && typeof t.id === 'string' && t.id ? t.id : null,
      type: t && typeof t.type === 'string' && t.type ? t.type : null,
    });
  }
  return entries;
}

const WEAK_TASK_TYPES = new Set<string | null | undefined>(['shell', 'monitor']);

const NON_GATING_TASK_TYPES = new Set<string | null | undefined>(['dream']);

const DEFAULT_SHELL_TASK_TTL_MS = 60 * 60 * 1000;

interface DeclaredEntry {
  id?: string | null;
  type?: string | null;
}

const DEFAULT_TEAMMATE_TASK_TTL_MS = 90 * 1000;

function declaredActiveCount(
  entries: readonly DeclaredEntry[] | null,
  idleIds: ReadonlySet<string> | null,
  ageMs = 0, weakTtlMs = DEFAULT_SHELL_TASK_TTL_MS, idleNameCount = 0,
  teammateTtlMs = DEFAULT_TEAMMATE_TASK_TTL_MS, agentTtlMs = DEFAULT_AGENT_TTL_MS,
): number {
  if (!entries) return 0;
  let n = 0;
  let teammateCount = 0;
  for (const e of entries) {
    if (e.id && idleIds && idleIds.has(e.id)) continue;
    if (WEAK_TASK_TYPES.has(e.type) && ageMs >= weakTtlMs) continue;
    if (NON_GATING_TASK_TYPES.has(e.type)) continue;
    if (e.type === 'teammate' && ageMs >= teammateTtlMs) continue;
    if (!WEAK_TASK_TYPES.has(e.type) && e.type !== 'teammate' && ageMs >= agentTtlMs) continue;
    n++;
    if (e.type === 'teammate') teammateCount++;
  }
  return n - Math.min(idleNameCount, teammateCount);
}

function declaredEntryTtlMs(
  type: string | null | undefined,
  weakTtlMs: number,
  teammateTtlMs: number,
  agentTtlMs: number,
): number {
  if (WEAK_TASK_TYPES.has(type)) return weakTtlMs;
  if (type === 'teammate') return teammateTtlMs;
  return agentTtlMs;
}

interface NextDrainInputs {
  countedAgents?: TimestampMap | null;
  declaredEntries?: readonly DeclaredEntry[] | null;
  declaredTs?: number;
  idleIds?: ReadonlySet<string> | null;
  now?: number;
  agentTtlMs?: number;
  weakTtlMs?: number;
  teammateTtlMs?: number;
}

function msUntilNextDrain({
  countedAgents = null,
  declaredEntries = null,
  declaredTs = 0,
  idleIds = null,
  now = 0,
  agentTtlMs = DEFAULT_AGENT_TTL_MS,
  weakTtlMs = DEFAULT_SHELL_TASK_TTL_MS,
  teammateTtlMs = DEFAULT_TEAMMATE_TASK_TTL_MS,
}: NextDrainInputs = {}): number | null {
  let earliestExpiry: number | null = null;
  const consider = (expiresAt: number): void => {
    if (expiresAt <= now) return;
    if (earliestExpiry === null || expiresAt < earliestExpiry) earliestExpiry = expiresAt;
  };
  if (countedAgents) {
    for (const ts of countedAgents.values()) consider(ts + agentTtlMs);
  }
  if (declaredEntries) {
    for (const e of declaredEntries) {
      if (e.id && idleIds && idleIds.has(e.id)) continue;
      if (e.type && NON_GATING_TASK_TYPES.has(e.type)) continue;
      consider(declaredTs + declaredEntryTtlMs(e.type, weakTtlMs, teammateTtlMs, agentTtlMs));
    }
  }
  if (earliestExpiry === null) return null;
  return earliestExpiry - now;
}

function evictDepartedTeammateNames(
  idleTeammateNames: TimestampMap,
  declaredTeammateIds: ReadonlySet<string>,
  currentEntries: readonly DeclaredEntry[],
): Set<string> {
  const currentTeammateIds = new Set<string>(
    currentEntries.flatMap((e) => (e.type === 'teammate' && e.id ? [e.id] : [])),
  );
  let departedCount = 0;
  for (const id of declaredTeammateIds) {
    if (!currentTeammateIds.has(id)) departedCount++;
  }
  for (const name of idleTeammateNames.keys()) {
    if (departedCount <= 0) break;
    idleTeammateNames.delete(name);
    departedCount--;
  }
  return currentTeammateIds;
}

interface TaskRegistryOptions {
  agentTtlMs?: number;
  shellTaskTtlMs?: number;
  teammateTaskTtlMs?: number;
  now?: () => number;
}

interface TaskRegistryBreakdown {
  counted: number;
  declared: number;
  idleNames: number;
  idleTasks: number;
}

interface TaskRegistryInspection {
  counted: TimestampMap;
  observedAgentIdsThisTurn: Set<string>;
  orphanAgentStops: TimestampMap;
  declared: DeclaredEntry[] | null;
  declaredTs: number;
  idleTaskIds: Set<string>;
  idleTeammateNames: TimestampMap;
  declaredTeammateIds: Set<string>;
}

interface TaskRegistry {
  noteAgentStart(agentId: string | null | undefined, ts: number): boolean;
  noteAgentStop(agentId: string | null | undefined): boolean;
  hasOrphanStopEvidence(): boolean;
  resetTurnEvidence(): void;
  reconcileDeclared(entries: DeclaredEntry[]): void;
  clearDeclared(): boolean;
  hasDeclared(): boolean;
  noteTaskCreated(options: { taskId?: string | null; name?: string | null }): void;
  noteTaskCompleted(options: { taskId?: string | null; name?: string | null }): void;
  noteTeammateIdle(name: string, ts: number): void;
  regateByAgentId(agentId: unknown): void;
  activeCount(): number;
  getBreakdown(): TaskRegistryBreakdown;
  msUntilNextDrain(at: number): number | null;
  clear(): void;
  inspect(): TaskRegistryInspection;
}

function createTaskRegistry({
  agentTtlMs = DEFAULT_AGENT_TTL_MS,
  shellTaskTtlMs = DEFAULT_SHELL_TASK_TTL_MS,
  teammateTaskTtlMs = DEFAULT_TEAMMATE_TASK_TTL_MS,
  now = Date.now,
}: TaskRegistryOptions = {}): TaskRegistry {
  const countedAgents: TimestampMap = new Map();
  const observedAgentIdsThisTurn = new Set<string>();
  const orphanAgentStops: TimestampMap = new Map();
  let declaredEntries: DeclaredEntry[] | null = null;
  let declaredTs = 0;
  const idleTaskIds = new Set<string>();
  const idleTeammateNames: TimestampMap = new Map();
  let declaredTeammateIds = new Set<string>();
  let breakdown: TaskRegistryBreakdown = { counted: 0, declared: 0, idleNames: 0, idleTasks: 0 };

  function reap(at: number): void {
    pruneAgents(countedAgents, at, agentTtlMs);
    pruneAgents(orphanAgentStops, at, agentTtlMs);
    pruneAgents(idleTeammateNames, at, agentTtlMs);
    if (declaredEntries === null) return;
    const declaredTtlMs = declaredEntries.reduce((maxTtlMs, entry) => Math.max(
      maxTtlMs,
      declaredEntryTtlMs(entry.type, shellTaskTtlMs, teammateTaskTtlMs, agentTtlMs),
    ), agentTtlMs);
    if (at - declaredTs < declaredTtlMs) return;
    declaredEntries = null;
    declaredTs = 0;
  }

  return {
    noteAgentStart(agentId, ts) {
      if (agentId) {
        idleTaskIds.delete(agentId);
        observedAgentIdsThisTurn.add(agentId);
      }
      return addAgent(countedAgents, agentId, ts);
    },

    noteAgentStop(agentId) {
      if (!agentId) return false;
      const changed = removeAgent(countedAgents, agentId);
      if (changed) {
        observedAgentIdsThisTurn.add(agentId);
        return true;
      }
      if (observedAgentIdsThisTurn.has(agentId)) return false;
      observedAgentIdsThisTurn.add(agentId);
      orphanAgentStops.set(agentId, now());
      return false;
    },

    hasOrphanStopEvidence() {
      reap(now());
      return orphanAgentStops.size > 0;
    },

    resetTurnEvidence() {
      observedAgentIdsThisTurn.clear();
      orphanAgentStops.clear();
    },

    reconcileDeclared(entries) {
      declaredEntries = entries;
      declaredTs = now();
      const declaredIds = new Set<string>(entries.flatMap((e) => (e.id ? [e.id] : [])));
      for (const id of idleTaskIds) {
        if (!declaredIds.has(id)) idleTaskIds.delete(id);
      }
      declaredTeammateIds = evictDepartedTeammateNames(idleTeammateNames, declaredTeammateIds, entries);
      const rawDeclaredActive = declaredActiveCount(entries, idleTaskIds);
      if (rawDeclaredActive === 0 && countedAgents.size > 0) countedAgents.clear();
    },

    clearDeclared() {
      if (declaredEntries === null) return false;
      declaredEntries = null;
      declaredTs = 0;
      return true;
    },

    hasDeclared() {
      return declaredEntries !== null;
    },

    noteTaskCreated({ taskId, name }) {
      if (name) idleTeammateNames.delete(name);
      if (taskId) idleTaskIds.delete(taskId);
    },

    noteTaskCompleted({ taskId, name }) {
      if (!taskId) return;
      idleTaskIds.add(taskId);
      removeAgent(countedAgents, taskId);
      if (name) idleTeammateNames.delete(name);
    },

    noteTeammateIdle(name, ts) {
      idleTeammateNames.set(name, ts);
    },

    regateByAgentId(agentId: unknown) {
      if (typeof agentId !== 'string') return;
      for (const name of idleTeammateNames.keys()) {
        const prefix = `a${name}-`;
        if (agentId.startsWith(prefix) && /^[0-9a-f]+$/i.test(agentId.slice(prefix.length))) {
          idleTeammateNames.delete(name);
        }
      }
    },

    activeCount() {
      const at = now();
      reap(at);
      const declared = declaredActiveCount(
        declaredEntries, idleTaskIds, declaredEntries ? at - declaredTs : 0,
        shellTaskTtlMs, idleTeammateNames.size, teammateTaskTtlMs, agentTtlMs,
      );
      breakdown = {
        counted: countedAgents.size,
        declared,
        idleNames: idleTeammateNames.size,
        idleTasks: idleTaskIds.size,
      };
      return Math.max(countedAgents.size, declared);
    },

    getBreakdown() {
      return breakdown;
    },

    msUntilNextDrain(at) {
      return msUntilNextDrain({
        countedAgents,
        declaredEntries,
        declaredTs,
        idleIds: idleTaskIds,
        now: at,
        agentTtlMs,
        weakTtlMs: shellTaskTtlMs,
        teammateTtlMs: teammateTaskTtlMs,
      });
    },

    clear() {
      countedAgents.clear();
      observedAgentIdsThisTurn.clear();
      orphanAgentStops.clear();
      declaredEntries = null;
      declaredTs = 0;
      idleTaskIds.clear();
      idleTeammateNames.clear();
      declaredTeammateIds.clear();
    },

    inspect() {
      return {
        counted: new Map(countedAgents),
        observedAgentIdsThisTurn: new Set(observedAgentIdsThisTurn),
        orphanAgentStops: new Map(orphanAgentStops),
        declared: declaredEntries,
        declaredTs,
        idleTaskIds: new Set(idleTaskIds),
        idleTeammateNames: new Map(idleTeammateNames),
        declaredTeammateIds: new Set(declaredTeammateIds),
      };
    },
  };
}

export {
  addAgent,
  removeAgent,
  pruneAgents,
  extractBackgroundTasks,
  declaredActiveCount,
  msUntilNextDrain,
  evictDepartedTeammateNames,
  createTaskRegistry,
  DEFAULT_AGENT_TTL_MS,
  DEFAULT_SHELL_TASK_TTL_MS,
  DEFAULT_TEAMMATE_TASK_TTL_MS,
};
export type {
  DeclaredEntry,
  NextDrainInputs,
  TaskRegistry,
  TaskRegistryBreakdown,
  TaskRegistryInspection,
  TaskRegistryOptions,
  TimestampMap,
};
