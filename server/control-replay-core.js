'use strict';

/*
 * Pure core for control-WS sequencing + replay of transient broadcasts.
 *
 * The dashboard's control-WS reconnects on a jittered backoff (public/reconnect-backoff.mjs).
 * The fresh `snapshot` sent on reconnect repairs all per-session state, but one-shot
 * broadcasts fired during the gap (notify, session-error, post-turn-result)
 * are otherwise lost forever. `stamp` gives every broadcast a monotonic `seq`; `entriesSince`
 * lets a reconnecting client (which declares its own last-seen seq, since the server holds
 * no per-connection state across a reconnect) recover exactly the replayable ones it missed.
 *
 * No IO, no timers - `now` is passed in by the caller so this stays synchronously testable.
 */

const REPLAYABLE_EXACT = new Set(['notify', 'session-error', 'post-turn-result']);

function isReplayable(type) {
  return REPLAYABLE_EXACT.has(type);
}

function createReplayLog({ maxEntries = 500, maxAgeMs = 5 * 60_000 } = {}) {
  const ring = [];
  let seq = 0;
  // Highest seq of any replayable entry ever evicted from the ring (by count or age).
  // Monotonic because eviction only ever removes from the front (oldest first), so the
  // last-removed seq is always the highest evicted so far. `since < evictedUpTo` means a
  // replayable entry the client hasn't seen existed and is now gone forever - it does NOT mean
  // nothing can be replayed: entries newer than the evicted ones are still retained and still
  // returned. `evicted` is purely advisory (the caller logs it), not a gate on `entries`.
  let evictedUpTo = 0;

  function evictStale(now) {
    while (ring.length && now - ring[0].ts > maxAgeMs) {
      evictedUpTo = ring[0].seq;
      ring.shift();
    }
    while (ring.length > maxEntries) {
      evictedUpTo = ring[0].seq;
      ring.shift();
    }
  }

  function stamp(msg, now = Date.now()) {
    seq += 1;
    msg.seq = seq;
    if (!isReplayable(msg.type)) return msg;
    ring.push({ seq, ts: now, msg });
    evictStale(now);
    return msg;
  }

  function entriesSince(since, now = Date.now()) {
    evictStale(now);
    if (!Number.isFinite(since) || since < 0) return { entries: [], evicted: false };
    const entries = ring.filter((e) => e.seq > since).map((e) => e.msg);
    return { entries, evicted: since < evictedUpTo };
  }

  function currentSeq() {
    return seq;
  }

  return { stamp, entriesSince, currentSeq };
}

module.exports = { createReplayLog, isReplayable, REPLAYABLE_EXACT };
