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

// background_tasks entry types that must NEVER gate completion, at any age. A `dream` entry
// is a pending ScheduleWakeup (see wakeup-tracker.js): by that module's own design a Stop with
// a pending wakeup IS a finished turn, surfaced as the advisory wakeup chip, not the completion
// gate. Counting it would pin a self-pacing loop session WORKING for its entire sleep.
const NON_GATING_TASK_TYPES = new Set(['dream']);

// Default time a weak-typed entry (shell/monitor) keeps gating after the Stop that declared
// it. Shorter than DEFAULT_AGENT_TTL_MS because there is no dropped-hook story here to bias
// long for: the entry NEVER gets a completion hook, this TTL is the only way it ever drains.
const DEFAULT_SHELL_TASK_TTL_MS = 5 * 60 * 1000;

// Default time a declared teammate entry keeps gating after the Stop that declared it. A
// teammate that is ACTUALLY working is already covered by the counted SubagentStart/Stop map;
// a declared teammate entry only matters for a dropped SubagentStart. But an idle-but-alive
// teammate stays status:running in Claude's task registry forever, and the drain heuristics
// (TeammateIdle by name, TaskCompleted by id) depend on hooks that sometimes never arrive, so
// without a short TTL a declared teammate can pin a card WORKING for the full agent TTL. This
// bounds that failure at seconds instead of 30 minutes.
//
// Accepted risk: unlike shell/monitor (WEAK_TASK_TYPES, which never get ANY completion hook,
// hence their own 5-minute TTL as the only drain they ever get), a teammate DOES fire
// SubagentStart/SubagentStop (live-verified against Claude Code 2.1.200). So this TTL only
// matters when a SubagentStart hook was dropped AND the teammate is still genuinely working
// past 90 seconds: the declared entry ages out and the card completes early while background
// work continues. That failure is self-correcting, the still-working teammate's next hook
// activity (or the lead resuming on its mailbox) flips the card back to WORKING. The failure
// this short TTL fixes instead, a card stuck WORKING on an idle-but-alive teammate, blocked
// operator actions (merge, restart) and never self-corrected on its own. Trading a rare,
// self-healing early completion for a common, non-self-healing stuck card is the accepted
// tradeoff; DEFAULT_TEAMMATE_TASK_TTL_MS stays 90s rather than growing toward DEFAULT_AGENT_TTL_MS.
const DEFAULT_TEAMMATE_TASK_TTL_MS = 90 * 1000;

// How many declared entries still gate completion, given the set of task ids known settled
// out-of-band (TaskCompleted / TeammateIdle hooks). An id-less entry can never be drained
// individually, so it always counts (suppression-safe). ageMs is how long ago the snapshot
// was declared; a weak-typed entry (no completion hook) stops counting past weakTtlMs.
//
// idleNameCount is the number of teammates known idle BY NAME (a TeammateIdle payload carries
// only teammate_name, and a declared teammate entry's `description` is the spawn prompt, not
// the name - live-verified - so a name can never be matched to a specific declared id). With
// several live teammates, an id-based drain leaves every TeammateIdle unresolvable forever.
// Instead this subtracts idleNameCount from the surviving teammate-type entries, clamped to
// that teammate count so a stale/extra idle name can never mask a shell or subagent entry.
function declaredActiveCount(
  entries, idleIds, ageMs = 0, weakTtlMs = DEFAULT_SHELL_TASK_TTL_MS, idleNameCount = 0,
  teammateTtlMs = DEFAULT_TEAMMATE_TASK_TTL_MS,
) {
  if (!entries) return 0;
  let n = 0;
  let teammateCount = 0;
  for (const e of entries) {
    if (e.id && idleIds && idleIds.has(e.id)) continue;
    if (WEAK_TASK_TYPES.has(e.type) && ageMs >= weakTtlMs) continue;
    if (NON_GATING_TASK_TYPES.has(e.type)) continue;
    if (e.type === 'teammate' && ageMs >= teammateTtlMs) continue;
    n++;
    if (e.type === 'teammate') teammateCount++;
  }
  return n - Math.min(idleNameCount, teammateCount);
}

// A teammate id declared last snapshot but missing from this one has departed (shut down); any
// name idled against it no longer means anything, and left in place it would wrongly offset a
// DIFFERENT teammate that happens to keep the surviving count the same. Evicts that many of the
// OLDEST entries from idleTeammateNames: names are anonymous bookkeeping (the arithmetic only
// cares about the count), so evicting the oldest is as correct as evicting the departed one and
// needs no name-to-id mapping. Mutates idleTeammateNames and returns the current declared
// teammate id set (the caller's new declaredTeammateIds).
function evictDepartedTeammateNames(idleTeammateNames, declaredTeammateIds, currentEntries) {
  const currentTeammateIds = new Set(
    currentEntries.filter((e) => e.type === 'teammate' && e.id).map((e) => e.id),
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

module.exports = {
  addAgent,
  removeAgent,
  pruneAgents,
  extractBackgroundTasks,
  declaredActiveCount,
  evictDepartedTeammateNames,
  DEFAULT_AGENT_TTL_MS,
  DEFAULT_SHELL_TASK_TTL_MS,
  DEFAULT_TEAMMATE_TASK_TTL_MS,
};
