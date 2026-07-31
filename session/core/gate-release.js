"use strict";

// Pure decision for the DEFERRED COMPLETION path: whether a gate-held `ready` may finally
// fire (see sessions.js _stashGateHeldReady / _evaluateGateHeldReady). No IO, no Session import.
//
// The invariant: firing a hold is a completion claim made minutes after the Stop that produced
// it, so it must be re-validated against live evidence at release time, never against a drained
// count and an unchanged state alone. This is the ONLY judge of whether a hold may fire; callers
// stash, feed it evidence, and act on the verdict, they never separately decide a hold is stale.
// Full rationale (mailbox wakes, the title kind-edge latch, why the quiet window exists):
// AGENTS.md, Background sub-agents / completion gate.

const DEFAULT_GATE_RELEASE_SETTLE_MS = 10 * 1000;

// Decisions (the caller owns the side effects):
//   "cancel"  drop the hold - it no longer describes the session
//   "gated"   background work is still live - keep holding, re-check on the next drain or TTL tick
//   "wait"    eligible, but the quiet window has not elapsed - re-check in `waitMs`
//   "release" fire the deferred completion now
function decideGateRelease({
  heldState,
  currentState,
  activeAgents = 0,
  stashSeq = 0,
  lastActivitySeq = 0,
  stashTs = 0,
  quietSince = 0,
  now = 0,
  settleMs = DEFAULT_GATE_RELEASE_SETTLE_MS,
} = {}) {
  // Any transition since the stash already answered the question the held ready was asking.
  if (currentState !== heldState) return { decision: "cancel", waitMs: 0 };
  // Live evidence beats a drained count: activity after the stash means the main agent opened a
  // NEW turn, so the Stop being held describes a turn that is over and gone. Checked before the
  // count, because a new turn invalidates the hold whether or not background work is still live.
  // Sequence numbers, not timestamps: signals routinely share a millisecond, and what matters
  // is strictly which one arrived last.
  if (lastActivitySeq > stashSeq) return { decision: "cancel", waitMs: 0 };
  if (activeAgents > 0) return { decision: "gated", waitMs: 0 };
  const quietFor = now - Math.max(quietSince, stashTs);
  if (quietFor < settleMs) return { decision: "wait", waitMs: settleMs - quietFor };
  return { decision: "release", waitMs: 0 };
}

module.exports = { decideGateRelease, DEFAULT_GATE_RELEASE_SETTLE_MS };
