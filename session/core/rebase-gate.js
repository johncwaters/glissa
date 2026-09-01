"use strict";

// Pure gate for the EAGER worktree auto-rebase: may this session's worktree be replayed onto a moved
// integration branch right now, unattended and with nobody watching? Every input is a fact the caller
// already holds (the cheap worktree signature, the session state, the merge gate), so there is no IO,
// no clock and no Session import here. The guard ORDER is pinned by tests/rebase-gate.test.js rather
// than described here, so the tests stay the single statement of it.

const { STATES } = require("../../shared/states.ts");

// A worktree may only be rewritten while nothing is running inside it: IDLE and COMPLETE sit between
// turns, DONE and FAILED have no PTY at all, DORMANT never started one. WAITING is deliberately absent
// even though the merge gate accepts it (MERGEABLE_LIVE_STATES): "Needs Input" is a permission prompt
// PAUSING a turn, and the agent resumes into the very files a rebase would have rewritten underneath it.
/** @type {ReadonlyArray<string>} */
const AUTO_REBASE_STATES = Object.freeze([
  STATES.IDLE,
  STATES.COMPLETE,
  STATES.DONE,
  STATES.FAILED,
  STATES.DORMANT,
]);

// The one caller that cannot prove quiescence from the session state. A FRESH restart runs in the spawn
// gap, after the old PTY is reaped and before the new one exists, where the state already reads whatever
// the restart transition set it to (STARTING) and so says nothing about what is running in the tree. It
// proves the same fact with the PTY itself, which is why the state guard above stays load-bearing for
// every other caller: this trigger substitutes a stronger proof, it does not waive the requirement.
const SPAWN_GAP_TRIGGER = "fresh-restart";

// The signature carries counts as trimmed git output (strings), while a caller with real numbers is just
// as valid; both spellings of "no commits" must read as zero.
function isZeroCount(count) {
  if (count === null || count === undefined) return true;
  return String(count).trim() === "" || Number(count) === 0;
}

function skip(reason) {
  return { action: "skip", reason };
}

// Verdict for one auto-rebase opportunity: { action: 'rebase' } or { action: 'skip', reason }.
// `currentKey` / `lastConflictKey` are opaque strings the caller builds from whatever it wants the
// cooldown keyed on; an equal, non-empty pair means the last attempt already hit this exact conflict.
/**
 * @param {{ enabled?: boolean, trigger?: string, state?: string, hasLivePty?: boolean,
 *   mergeStatus?: string, dirty?: boolean,
 *   behind?: string | number | null, rebaseInProgress?: boolean, teardownPending?: boolean,
 *   currentKey?: string | null, lastConflictKey?: string | null }} [options]
 */
function decideAutoRebase({
  enabled,
  trigger,
  state,
  hasLivePty,
  mergeStatus,
  dirty,
  behind,
  rebaseInProgress,
  teardownPending,
  currentKey,
  lastConflictKey,
} = {}) {
  const spawnGap = trigger === SPAWN_GAP_TRIGGER;
  if (!enabled) return skip("disabled");
  if (teardownPending) return skip("teardown");
  if (mergeStatus === "merging") return skip("merging");
  if (mergeStatus === "parked") return skip("parked");
  if (spawnGap && hasLivePty) return skip("live-pty");
  if (!spawnGap && (typeof state !== "string" || !AUTO_REBASE_STATES.includes(state))) return skip("busy");
  if (rebaseInProgress) return skip("rebase-in-progress");
  if (dirty) return skip("dirty");
  if (isZeroCount(behind)) return skip("current");
  if (currentKey && currentKey === lastConflictKey) return skip("conflict-cooldown");
  return { action: "rebase" };
}

/**
 * A resolution just landed in the shared rerere cache. Does that clear this session's conflict
 * cooldown?
 *
 * The cooldown is time-shaped where the trigger is information-shaped: it expires when a sha moves,
 * but the thing that makes a doomed rebase worth retrying is a RECORDED RESOLUTION, which a sibling
 * session can produce without anything about this worktree changing. Clearing on that event is what
 * lets the retry happen now instead of eventually.
 *
 * Nothing cooled down means nothing to clear: a resolution recorded while this session was never
 * blocked is not news, and re-nudging the change funnel for it would be noise on every merge anyone
 * in the repo performs.
 */
/** @param {{ enabled?: boolean, hasCooldown?: boolean, teardownPending?: boolean }} [options] */
function decideRerereCooldownClear({ enabled, hasCooldown, teardownPending } = {}) {
  if (!enabled) return { clear: false, reason: "disabled" };
  if (teardownPending) return { clear: false, reason: "teardown" };
  if (!hasCooldown) return { clear: false, reason: "no-cooldown" };
  return { clear: true, reason: "rerere-recorded" };
}

module.exports = { decideAutoRebase, decideRerereCooldownClear, AUTO_REBASE_STATES, SPAWN_GAP_TRIGGER };
