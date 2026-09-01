const DEFAULT_WAKEUP_GRACE_MS = 5 * 60 * 1000;

const DEFAULT_CRON_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_WAKEUPS = 64;

interface WakeupEntry {
  kind: string;
  fireAt: number | null;
  reason: string | null;
  ts: number;
}

type WakeupMap = Map<string, WakeupEntry>;

function addWakeup(map: WakeupMap, key: string, entry: WakeupEntry | null | undefined): boolean {
  if (!key || !entry) return false;
  const had = map.has(key);
  if (!had && map.size >= MAX_WAKEUPS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, entry);
  return !had;
}

function removeWakeup(map: WakeupMap, key: string): boolean {
  if (!key) return false;
  return map.delete(key);
}

function pruneWakeups(
  map: WakeupMap,
  now: number,
  { graceMs = DEFAULT_WAKEUP_GRACE_MS, cronTtlMs = DEFAULT_CRON_TTL_MS }:
    { graceMs?: number; cronTtlMs?: number } = {},
): number {
  let removed = 0;
  for (const [key, e] of map) {
    const expired = e.kind === 'cron'
      ? now - e.ts >= cronTtlMs
      : e.fireAt != null && now >= e.fireAt + graceMs;
    if (!expired) continue;
    map.delete(key);
    removed++;
  }
  return removed;
}

function earliestWakeup(map: WakeupMap): WakeupEntry | null {
  let best: WakeupEntry | null = null;
  for (const e of map.values()) {
    if (e.fireAt == null) {
      if (!best) best = e;
      continue;
    }
    if (!best || best.fireAt == null || e.fireAt < best.fireAt) best = e;
  }
  return best;
}

function extractCronTaskId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as { tool_input?: unknown; tool_response?: unknown };
  for (const candidate of [record.tool_input, record.tool_response]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const c = candidate as { task_id?: unknown; taskId?: unknown; id?: unknown };
    const id = c.task_id || c.taskId || c.id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

export {
  addWakeup,
  removeWakeup,
  pruneWakeups,
  earliestWakeup,
  extractCronTaskId,
  MAX_WAKEUPS,
  DEFAULT_WAKEUP_GRACE_MS,
};
export type { WakeupEntry, WakeupMap };
