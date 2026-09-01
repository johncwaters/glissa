const DEFAULT_INTERVAL_MS = 30_000;

const DEFAULT_DEADLINE_MS = 75_000;

export interface HeartbeatConnection<TKey> {
  key: TKey;
  lastSeenAt?: number;
}

export interface HeartbeatSweepPlan<TKey> {
  terminate: TKey[];
  ping: TKey[];
}

function planHeartbeatSweep<TKey>(
  connections: (HeartbeatConnection<TKey> | null | undefined)[],
  { now = Date.now(), deadlineMs = DEFAULT_DEADLINE_MS }: { now?: number; deadlineMs?: number } = {},
): HeartbeatSweepPlan<TKey> {
  const terminate: TKey[] = [];
  const ping: TKey[] = [];
  for (const entry of Array.isArray(connections) ? connections : []) {
    if (!entry) continue;
    const seen = entry.lastSeenAt;
    const lastSeenAt = typeof seen === 'number' && Number.isFinite(seen) ? seen : now;

    if (now - lastSeenAt > deadlineMs) {
      terminate.push(entry.key);
      continue;
    }
    ping.push(entry.key);
  }
  return { terminate, ping };
}

export { planHeartbeatSweep, DEFAULT_INTERVAL_MS, DEFAULT_DEADLINE_MS };
