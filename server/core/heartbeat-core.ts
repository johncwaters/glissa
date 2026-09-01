/*
 * Protocol-level liveness for both WebSocket channels, decided purely (2026-08 review, section 1).
 *
 * WHY it matters beyond tidiness: PRESENCE LIES without it. Per-connection focus suppression and the
 * Telegram zero-connections gate both count open control connections, and a half-open socket - one
 * TCP has not noticed is gone - stays counted until the OS timeout, which can be hours. Focus
 * suppression fails open there (the notification is delivered anyway), but the Telegram gate fails
 * CLOSED: a zombie connection silently blocks the channel of last resort, the one that exists for
 * exactly the case where nobody is looking at a dashboard.
 *
 * The client's own reconnect does not mask it: the client closes ITS half over the dead path and
 * reconnects, while the server half stays in the count. Only the server pinging and giving up on
 * silence removes it.
 */

const DEFAULT_INTERVAL_MS = 30_000;
// Two missed rounds. One is a hiccup (a suspended laptop, a GC pause); two is a socket that is gone.
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
    // Strictly greater: a deadline of exactly zero elapsed is not silence.
    if (now - lastSeenAt > deadlineMs) {
      terminate.push(entry.key);
      continue;
    }
    ping.push(entry.key);
  }
  return { terminate, ping };
}

export { planHeartbeatSweep, DEFAULT_INTERVAL_MS, DEFAULT_DEADLINE_MS };
