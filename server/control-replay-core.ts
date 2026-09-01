type ControlMessageRecord = Record<string, unknown> & { type?: unknown; seq?: number };

interface ReplayEntry {
  seq: number;
  ts: number;
  msg: ControlMessageRecord;
}

interface ReplayLog {
  stamp(msg: ControlMessageRecord, now?: number): ControlMessageRecord;
  entriesSince(since: number, now?: number): { entries: ControlMessageRecord[]; evicted: boolean };
  currentSeq(): number;
}

const REPLAYABLE_EXACT = new Set(['notify', 'session-error', 'post-turn-result']);

function isReplayable(type: unknown): boolean {
  return typeof type === 'string' && REPLAYABLE_EXACT.has(type);
}

function createReplayLog({ maxEntries = 500, maxAgeMs = 5 * 60_000 }: {
  maxEntries?: number;
  maxAgeMs?: number;
} = {}): ReplayLog {
  const ring: ReplayEntry[] = [];
  let seq = 0;

  let evictedUpTo = 0;

  function evictStale(now: number): void {
    while (ring.length && now - ring[0].ts > maxAgeMs) {
      evictedUpTo = ring[0].seq;
      ring.shift();
    }
    while (ring.length > maxEntries) {
      evictedUpTo = ring[0].seq;
      ring.shift();
    }
  }

  function stamp(msg: ControlMessageRecord, now: number = Date.now()): ControlMessageRecord {
    seq += 1;
    msg.seq = seq;
    if (!isReplayable(msg.type)) return msg;
    ring.push({ seq, ts: now, msg });
    evictStale(now);
    return msg;
  }

  function entriesSince(since: number, now: number = Date.now()): { entries: ControlMessageRecord[]; evicted: boolean } {
    evictStale(now);
    if (!Number.isFinite(since) || since < 0) return { entries: [], evicted: false };
    const entries = ring.filter((e) => e.seq > since).map((e) => e.msg);
    return { entries, evicted: since < evictedUpTo };
  }

  function currentSeq(): number {
    return seq;
  }

  return { stamp, entriesSince, currentSeq };
}

export { REPLAYABLE_EXACT, createReplayLog, isReplayable };
export type { ControlMessageRecord, ReplayLog };
