"use strict";

// Pure decision for the DEFERRED COMPLETION path: whether a gate-held `ready` may finally
// fire (see sessions.js _stashGateHeldReady / _evaluateGateHeldReady). No IO, no Session import.
//
// A main-agent `ready` (Stop) suppressed by the background-agent gate is HELD rather than
// dropped, so the card can still complete when the background count later drains WITHOUT
// another Stop (idle teammate, dropped SubagentStop). Firing that hold is a completion claim
// made minutes after the Stop that produced it, so it must be re-validated against LIVE
// evidence at release time, not just against a drained count and an unchanged state: a lead
// that auto-resumes on a teammate mailbox message fires no UserPromptSubmit, so without this
// check the stale hold releases mid-turn and falsely COMPLETEs a working card.
//
// The evidence that the turn is NOT over is any non-ready signal observed AFTER the stash
// (`working`, `resume`, `awaiting-input`, ...). A spinner frame in the OSC-0 title is enough:
// sessions.js re-opens the title source's working-kind latch when it stashes, so a continuously
// spinning title (which otherwise reports `working` exactly once, on the kind edge) reports one
// again while the hold is pending.
//
// This is the ONLY judge of whether a hold may fire. Callers stash, feed it evidence, and act on
// the verdict; they never separately decide a hold is stale.

const DEFAULT_GATE_RELEASE_SETTLE_MS = 10 * 1000;

// Why a quiet window at all: a TeammateIdle/SubagentStop drain almost always precedes the lead
// auto-resuming on the teammate's mailbox message 1-3s later, so releasing the instant the count
// hits 0 fired a false COMPLETE + notification per orchestration round and then flipped straight
// back to WORKING. The window gives that wake time to arrive and cancel the hold.
//
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
