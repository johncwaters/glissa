"use strict";

// Pure gate for the EAGER worktree auto-rebase: may this session's worktree be replayed onto a moved
// integration branch right now, unattended and with nobody watching? Every input is a fact the caller
// already holds (the cheap worktree signature, the session state, the merge gate), so there is no IO,
// no clock and no Session import here. The guard ORDER is pinned by tests/rebase-gate.test.js rather
// than described here, so the tests stay the single statement of it.

const { STATES } = require("../../shared/states");

// A worktree may only be rewritten while nothing is running inside it: IDLE and COMPLETE sit between
// turns, DONE and FAILED have no PTY at all, DORMANT never started one. WAITING is deliberately absent
// even though the merge gate accepts it (MERGEABLE_LIVE_STATES): "Needs Input" is a permission prompt
// PAUSING a turn, and the agent resumes into the very files a rebase would have rewritten underneath it.
const AUTO_REBASE_STATES = Object.freeze([
  STATES.IDLE,
  STATES.COMPLETE,
  STATES.DONE,
  STATES.FAILED,
  STATES.DORMANT,
]);

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
function decideAutoRebase({
  enabled,
  state,
  mergeStatus,
  dirty,
  behind,
  rebaseInProgress,
  teardownPending,
  currentKey,
  lastConflictKey,
} = {}) {
  if (!enabled) return skip("disabled");
  if (teardownPending) return skip("teardown");
  if (mergeStatus === "merging") return skip("merging");
  if (mergeStatus === "parked") return skip("parked");
  if (!AUTO_REBASE_STATES.includes(state)) return skip("busy");
  if (rebaseInProgress) return skip("rebase-in-progress");
  if (dirty) return skip("dirty");
  if (isZeroCount(behind)) return skip("current");
  if (currentKey && currentKey === lastConflictKey) return skip("conflict-cooldown");
  return { action: "rebase" };
}

module.exports = { decideAutoRebase, AUTO_REBASE_STATES };
