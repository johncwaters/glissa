'use strict';

// Pure background sub-agent bookkeeping, extracted from Session (the seam pattern used by
// status-mapper.js / state-machine.js). A Session keeps a Map<agentId, lastSeenTs> of the
// background sub-agents that are still running, and drives it through these helpers. The map is
// the structural truth behind "is background work still running": a SubagentStart adds an id, a
// SubagentStop removes it, and a TTL prune bounds the rare dropped-SubagentStop leak so a card
// can never be pinned out of COMPLETE forever. No Session import, no I/O.
//
// These helpers MUTATE the Map argument (that is the whole point: the Map is the live state the
// Session owns); they are "pure" only in the sense of no hidden state and no side effects beyond
// the passed Map. addAgent/removeAgent return whether the live set actually changed, so the
// caller can decide when to emit an 'agents-change' delta.

// Default time-to-live for a tracked agent id. Bounds a dropped-SubagentStop leak: a real
// background sub-agent reports its stop, so this only matters when that stop is lost. Biased long
// so a legitimately long-running sub-agent is never pruned out from under a still-open turn.
const DEFAULT_AGENT_TTL_MS = 30 * 60 * 1000;

// Add (or refresh) a live agent id. Refreshing the timestamp on a duplicate SubagentStart keeps
// the entry from aging out mid-life and makes repeated starts idempotent. Returns true only when
// the id was newly added (the live count went up).
function addAgent(map, agentId, ts) {
  if (!agentId) return false;
  const had = map.has(agentId);
  map.set(agentId, ts);
  return !had;
}

// Remove a finished agent id. Removing an unknown id (out-of-order or duplicate stop) is a no-op.
// Returns true only when an entry was actually removed (the live count went down).
function removeAgent(map, agentId) {
  if (!agentId) return false;
  return map.delete(agentId);
}

// Drop entries older than ttlMs. Returns the number removed. Lazy: the caller runs this at read
// time, so there is no per-session timer (consistent with the heartbeat's timestamp-derived design).
function pruneAgents(map, now, ttlMs = DEFAULT_AGENT_TTL_MS) {
  let removed = 0;
  for (const [id, ts] of map) {
    if (now - ts >= ttlMs) {
      map.delete(id);
      removed++;
    }
  }
  return removed;
}

// Authoritative live-background-work count carried on a Stop/SubagentStop hook payload
// (Claude Code v2.1.145+ `background_tasks`). This covers work the SubagentStart/Stop
// counting can NOT see: background Bash tasks (run_in_background) and native-team
// teammates. Returns the count, or null when the field is absent/unrecognized (older
// Claude versions) so the caller falls back to the counted map. Defensive on shape:
// an array counts its entries, a finite non-negative number is taken as-is.
function extractBackgroundTaskCount(payload) {
  if (!payload) return null;
  const v = payload.background_tasks;
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return null;
}

module.exports = { addAgent, removeAgent, pruneAgents, extractBackgroundTaskCount, DEFAULT_AGENT_TTL_MS };
