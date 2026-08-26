'use strict';

/*
 * Pure rules for the Telegram outbox (2026-08 review, section 5).
 *
 * The operator's ruling narrowed durability to ONE channel: a lost browser notification on restart is
 * acceptable, a lost phone ping is not, because Telegram is the channel of last resort. So this is not
 * a persisted entry store - it is a small at-least-once queue for pings that have been decided on but
 * not yet confirmed delivered, replayed at the next boot.
 *
 * Three bounds keep it from becoming a liability of its own. A ping older than maxAgeMs is dropped
 * rather than sent: "a session finished" is news for minutes, and a queue that replays yesterday's
 * work on boot trains the operator to ignore the channel. A ping that has failed maxAttempts times is
 * dropped for the same reason. And the queue itself is capped, oldest first, so a Telegram outage
 * plus a busy machine cannot grow a file without limit.
 */

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** @typedef {{ id: string, text: string, queuedAt: number, attempts: number }} OutboxEntry */

function isEntry(value) {
  return Boolean(value)
    && typeof value === 'object'
    && typeof value.id === 'string'
    && value.id !== ''
    && typeof value.text === 'string'
    && value.text !== '';
}

/** A file written by an older build, a truncated file, or garbage all normalize to a usable queue. */
/** @param {unknown} raw @returns {OutboxEntry[]} */
function normalizeOutbox(raw) {
  if (!raw || typeof raw !== 'object' || !('entries' in raw)) return [];
  const list = Array.isArray(raw.entries) ? raw.entries : [];
  return list.filter(isEntry).map((entry) => ({
    id: entry.id,
    text: entry.text,
    queuedAt: Number.isFinite(entry.queuedAt) ? entry.queuedAt : 0,
    attempts: Number.isFinite(entry.attempts) && entry.attempts > 0 ? entry.attempts : 0,
  }));
}

/** Newest wins on overflow: an old ping is the one whose loss matters least. */
/** @param {OutboxEntry[]} entries @param {OutboxEntry} entry */
function planEnqueue(entries, entry, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const next = [...entries, entry];
  if (next.length <= maxEntries) return next;
  return next.slice(next.length - maxEntries);
}

/** @param {OutboxEntry[]} entries @param {string} id */
function removeEntry(entries, id) {
  return entries.filter((entry) => entry.id !== id);
}

/**
 * A failed send. Past maxAttempts the entry is dropped rather than retried forever: something is
 * wrong with the credentials or the network, and holding a stale ping cannot fix either.
 */
/** @param {OutboxEntry[]} entries @param {string} id */
function recordFailure(entries, id, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  const next = [];
  let dropped = false;
  for (const entry of entries) {
    if (entry.id !== id) {
      next.push(entry);
      continue;
    }
    const attempts = entry.attempts + 1;
    if (attempts >= maxAttempts) {
      dropped = true;
      continue;
    }
    next.push({ ...entry, attempts });
  }
  return { entries: next, dropped };
}

/**
 * What a boot replay should do with what it found.
 * @param {OutboxEntry[]} entries
 * @returns {{ send: OutboxEntry[], expired: OutboxEntry[] }}
 */
function planReplay(entries, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  const send = [];
  const expired = [];
  for (const entry of entries) {
    if (entry.attempts >= maxAttempts) {
      expired.push(entry);
      continue;
    }
    if (now - entry.queuedAt > maxAgeMs) {
      expired.push(entry);
      continue;
    }
    send.push(entry);
  }
  return { send, expired };
}

module.exports = {
  normalizeOutbox, planEnqueue, planReplay, recordFailure, removeEntry,
  DEFAULT_MAX_AGE_MS, DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_ENTRIES,
};
