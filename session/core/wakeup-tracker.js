'use strict';

// Pure pending-wakeup bookkeeping, the same seam pattern as agent-tracker.js. A Session keeps a
// Map<key, entry> of scheduled self-revivals it has seen via PostToolUse hooks (ScheduleWakeup /
// CronCreate / CronDelete) and drives it through these helpers. The map is ADVISORY metadata only:
// a Stop with a pending wakeup is a genuinely finished turn, so this never gates a transition
// (unlike the activeAgents completion gate). Entries are self-expiring because cancellation is
// invisible: pressing Esc clears a pending ScheduleWakeup with no hook fired (claude-code#58235),
// so a one-shot ages out at fireAt + grace and a cron entry at a hard TTL (tasks expire server-side
// after 7 days and die with the PTY anyway). Helpers mutate the passed Map and return whether the
// set changed, exactly like agent-tracker. No Session import, no I/O.

// Grace past the scheduled fire time before a one-shot entry is considered stale. The fire itself
// produces a resume (prompt enqueued), so a healthy wakeup clears the chip by state change long
// before the prune; the grace only bounds the invisible-cancel case.
const DEFAULT_WAKEUP_GRACE_MS = 5 * 60 * 1000;

// Hard bound for cron entries whose next fire time we do not compute (no cron parsing in v1).
// Matches the platform's own 7-day task expiry.
const DEFAULT_CRON_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Hard cap on the live set: the prune is lazy and one-shots with far-future fire times are not
// otherwise bounded, so a flood of ScheduleWakeup calls (local self-DoS at worst, already inside
// the PTY trust boundary) evicts the oldest entry instead of growing without limit.
const MAX_WAKEUPS = 64;

// entry: { kind: 'wakeup'|'cron', fireAt: number|null, reason: string|null, ts: number }
function addWakeup(map, key, entry) {
  if (!key || !entry) return false;
  const had = map.has(key);
  if (!had && map.size >= MAX_WAKEUPS) {
    map.delete(map.keys().next().value); // insertion-ordered: drop the oldest
  }
  map.set(key, entry);
  return !had;
}

function removeWakeup(map, key) {
  if (!key) return false;
  return map.delete(key);
}

// Drop stale entries: one-shots past fireAt + grace, cron entries past the hard TTL. Lazy: the
// caller runs this at read time (snapshot / chip refresh), so there is no per-session timer.
function pruneWakeups(map, now, { graceMs = DEFAULT_WAKEUP_GRACE_MS, cronTtlMs = DEFAULT_CRON_TTL_MS } = {}) {
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

// The entry to surface on the card: the soonest timed one, falling back to any cron entry
// (which has no computed fire time in v1).
function earliestWakeup(map) {
  let best = null;
  for (const e of map.values()) {
    if (e.fireAt == null) {
      if (!best) best = e;
      continue;
    }
    if (!best || best.fireAt == null || e.fireAt < best.fireAt) best = e;
  }
  return best;
}

// Defensive task-id extraction from a PostToolUse payload (CronCreate carries the 8-char id in
// tool_response; CronDelete names it in tool_input). Field names are probed across the plausible
// spellings because they are not yet pinned against a live recording (plan WS2 step 0 open item).
function extractCronTaskId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  for (const c of [payload.tool_input, payload.tool_response]) {
    if (!c || typeof c !== 'object') continue;
    const id = c.task_id || c.taskId || c.id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

module.exports = {
  addWakeup,
  removeWakeup,
  pruneWakeups,
  earliestWakeup,
  extractCronTaskId,
  MAX_WAKEUPS,
  DEFAULT_WAKEUP_GRACE_MS,
};
