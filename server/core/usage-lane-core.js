'use strict';

/*
 * Pure rules for LANE ATTRIBUTION: which of Glissa's own automation lanes a Claude session belonged to.
 *
 * This is the one thing a usage tool that only reads transcripts cannot do. Glissa SPAWNS its sessions, so
 * it knows that a given Claude session id was the PR-review lane rather than someone typing, and can answer
 * "what did the review lane cost this week".
 *
 * The join is exact, never inferred: a session id is attributed only because Glissa recorded spawning it.
 * Anything not in the ledger is `other` (a terminal session, a direct claude run, a session from before the
 * ledger existed). Guessing from a cwd or a project directory would silently mis-bill a lane.
 */

const { safeNumber, stringOrNull } = require('./usage-number-core');

// The lane ids are the names the lanes already call themselves (registerEphemeralSession's logPrefix), so
// there is no mapping table here to drift out of step with the code that spawns them.
const INTERACTIVE_LANE = 'interactive';
const OTHER_LANE = 'other';

function normalizeLedgerEntry(entry) {
  const claudeSessionId = stringOrNull(entry?.claudeSessionId);
  const lane = stringOrNull(entry?.lane);
  if (!claudeSessionId || !lane) return null;
  const ts = safeNumber(entry.ts);
  return { claudeSessionId, lane, ts: ts > 0 ? ts : 0 };
}

function normalizeLedger(entries) {
  const byId = new Map();
  for (const raw of entries || []) {
    const entry = normalizeLedgerEntry(raw);
    if (!entry) continue;
    // Last write wins per id: a session id belongs to exactly one lane, and the newest record is the one
    // that observed the spawn.
    const existing = byId.get(entry.claudeSessionId);
    if (existing && existing.ts > entry.ts) continue;
    byId.set(entry.claudeSessionId, entry);
  }
  return Array.from(byId.values()).sort(compareEntries);
}

// Retention matches the warehouse's, so a lane row can still be explained for as long as the day it came
// from is still on the daily series.
function pruneLedger(entries, { now, retainDays } = {}) {
  const normalized = normalizeLedger(entries);
  const days = Number.isInteger(retainDays) && retainDays > 0 ? retainDays : null;
  const nowMs = safeNumber(now);
  if (days === null || nowMs <= 0) return normalized;
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  // A ts of 0 means an entry from a writer that did not stamp one; keep it rather than drop history on a
  // technicality, since losing an attribution is worse than keeping a stale one.
  return normalized.filter((entry) => entry.ts === 0 || entry.ts >= cutoff);
}

function laneMapFromLedger(entries) {
  const laneById = new Map();
  for (const entry of normalizeLedger(entries)) laneById.set(entry.claudeSessionId, entry.lane);
  return laneById;
}

function isClaudeEntry(entry) {
  const vendor = stringOrNull(entry?.vendor);
  return vendor === null || vendor === 'claude';
}

/*
 * Rows for the report, biggest spend first. Only CLAUDE entries participate: Codex and Grok runs are
 * dispatched outside the Session class, so Glissa never spawned them and cannot attribute them to a lane.
 * `sessions` counts DISTINCT session ids, which is what makes a lane row comparable over time (one long
 * review costs more than three short ones, and the count says which shape it was).
 */
function laneRollup(entries, laneById) {
  const map = laneById instanceof Map ? laneById : new Map();
  const byLane = new Map();
  for (const entry of entries || []) {
    if (!isClaudeEntry(entry)) continue;
    const sessionId = stringOrNull(entry.sessionId);
    const lane = (sessionId && map.get(sessionId)) || OTHER_LANE;
    const bucket = byLane.get(lane) || { lane, tokens: 0, costUSD: 0, sessionIds: new Set() };
    bucket.tokens += totalTokensOf(entry);
    bucket.costUSD += safeNumber(entry.costUSD);
    if (sessionId) bucket.sessionIds.add(sessionId);
    byLane.set(lane, bucket);
  }
  return Array.from(byLane.values())
    .map((bucket) => ({ lane: bucket.lane, tokens: bucket.tokens, costUSD: bucket.costUSD, sessions: bucket.sessionIds.size }))
    .sort((a, b) => b.costUSD - a.costUSD || b.tokens - a.tokens || a.lane.localeCompare(b.lane));
}

// Local rather than imported from usage-entry-core: that module owns transcript parsing, and this one only
// needs the sum, so importing it would couple lane attribution to the parser.
function totalTokensOf(entry) {
  return safeNumber(entry?.input) + safeNumber(entry?.output) + safeNumber(entry?.cacheCreate) + safeNumber(entry?.cacheRead);
}

function compareEntries(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.claudeSessionId.localeCompare(b.claudeSessionId);
}

module.exports = {
  INTERACTIVE_LANE,
  OTHER_LANE,
  laneMapFromLedger,
  laneRollup,
  normalizeLedger,
  pruneLedger,
};
