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

// Statuses that mean an entry is settled and must not gate completion. GROUND TRUTH
// (extracted from the Claude Code 2.1.199 binary, memory: background-tasks-ground-truth):
// the emitter pre-filters background_tasks to status running|pending, so settled statuses
// should never arrive; this deny-list is belt-and-braces against a future emitter change.
// An unknown/absent status still counts as running, erring toward suppressing completion
// (the failure the gate exists to prevent) rather than completing early.
const SETTLED_TASK_STATUSES = new Set([
  'completed', 'complete', 'done', 'finished', 'failed', 'error',
  'killed', 'cancelled', 'canceled', 'exited', 'idle', 'success',
]);

// Authoritative in-flight background work declared on a Stop/SubagentStop hook payload
// (`background_tasks`, Claude Code v2.1.145+). It sees work the SubagentStart/Stop counting
// can NOT see: background Bash tasks (run_in_background) and native-team teammates. Shape
// per the 2.1.199 binary schema: an ARRAY of { id, type, status, description, ... } holding
// only running|pending backgrounded entries ("Empty array when nothing is in flight"). The
// `{ count, tasks }` object shape from claude-code#33310 belongs to a different surface
// (statusLine metadata) and never reaches hooks, so it is deliberately not parsed.
// Returns the non-settled entries as [{ id, type }] (id/type null when absent), or null
// when the field is missing/unrecognized (older Claude) so the caller falls back to the
// counted map alone.
function extractBackgroundTasks(payload) {
  if (!payload) return null;
  const v = payload.background_tasks;
  if (!Array.isArray(v)) return null;
  const entries = [];
  for (const t of v) {
    const status = t && typeof t.status === 'string' ? t.status.toLowerCase() : null;
    if (status && SETTLED_TASK_STATUSES.has(status)) continue;
    entries.push({
      id: t && typeof t.id === 'string' && t.id ? t.id : null,
      type: t && typeof t.type === 'string' && t.type ? t.type : null,
    });
  }
  return entries;
}

// background_tasks entry types that have NO completion hook at all (no SubagentStop, no
// TaskCompleted/TeammateIdle ever fires for them), so counting-until-drained would pin a
// card WORKING forever. Bounded instead by a TTL off the age of the declaring snapshot.
const WEAK_TASK_TYPES = new Set(['shell', 'monitor']);

// Default time a weak-typed entry (shell/monitor) keeps gating after the Stop that declared
// it. Shorter than DEFAULT_AGENT_TTL_MS because there is no dropped-hook story here to bias
// long for: the entry NEVER gets a completion hook, this TTL is the only way it ever drains.
const DEFAULT_SHELL_TASK_TTL_MS = 5 * 60 * 1000;

// How many declared entries still gate completion, given the set of task ids known settled
// out-of-band (TaskCompleted / TeammateIdle hooks). An id-less entry can never be drained
// individually, so it always counts (suppression-safe). ageMs is how long ago the snapshot
// was declared; a weak-typed entry (no completion hook) stops counting past weakTtlMs.
function declaredActiveCount(entries, idleIds, ageMs = 0, weakTtlMs = DEFAULT_SHELL_TASK_TTL_MS) {
  if (!entries) return 0;
  let n = 0;
  for (const e of entries) {
    if (e.id && idleIds && idleIds.has(e.id)) continue;
    if (WEAK_TASK_TYPES.has(e.type) && ageMs >= weakTtlMs) continue;
    n++;
  }
  return n;
}

// The declared entry an id-less TeammateIdle can safely drain: exactly one non-idle
// teammate-type entry with an id. Ambiguity (several live teammates) returns null so the
// signal is dropped rather than guessed. Used when the TaskCreated name->id mapping is
// unavailable (e.g. Glissa attached after the teammate was spawned).
function soleActiveTeammateId(entries, idleIds) {
  if (!entries) return null;
  let found = null;
  for (const e of entries) {
    if (e.type !== 'teammate' || !e.id) continue;
    if (idleIds && idleIds.has(e.id)) continue;
    if (found) return null;
    found = e.id;
  }
  return found;
}

// Default time a pending, unresolved TeammateIdle stays retryable against later
// background_tasks snapshots. Bounds a name that never resolves (e.g. a stale/duplicate
// signal) so it cannot drain some unrelated future teammate.
const DEFAULT_PENDING_IDLE_TTL_MS = 5 * 60 * 1000;

// Retry TeammateIdle signals that could not be resolved to a declared id at the time they
// arrived (e.g. a resume just cleared the declared snapshot). pendingMap is
// Map<pendingKey, tsReceived>, insertion-ordered so the oldest pending entry drains first.
// Expires entries past ttlMs before attempting any drain. Drains at most one id per pending
// entry per call, stopping at the first ambiguous/unresolvable snapshot (soleActiveTeammateId
// returning null) since later entries would only apply to a different snapshot. Mutates
// idleIds and pendingMap in place; returns the number drained.
function drainPendingTeammateIdles(entries, idleIds, pendingMap, now, ttlMs = DEFAULT_PENDING_IDLE_TTL_MS) {
  for (const [key, ts] of pendingMap) {
    if (now - ts >= ttlMs) pendingMap.delete(key);
  }
  let drained = 0;
  while (pendingMap.size > 0) {
    const id = soleActiveTeammateId(entries, idleIds);
    if (!id) break;
    idleIds.add(id);
    const oldestKey = pendingMap.keys().next().value;
    pendingMap.delete(oldestKey);
    drained++;
  }
  return drained;
}

module.exports = {
  addAgent,
  removeAgent,
  pruneAgents,
  extractBackgroundTasks,
  declaredActiveCount,
  soleActiveTeammateId,
  drainPendingTeammateIdles,
  DEFAULT_AGENT_TTL_MS,
  DEFAULT_SHELL_TASK_TTL_MS,
};
