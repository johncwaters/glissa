'use strict';

const { STATES } = require('../../shared/states');

// Pure once-per-work-cycle notification gate (the seam pattern used by agent-tracker.js /
// status-mapper.js). The backend's per-session state-change listener consults it before
// calling notificationManager.trigger for the terminal categories ('complete', 'failed'),
// so a single work cycle can never notify the same terminal category twice. This closes the
// duplicate-'complete' paths the per-state-entry trigger design allowed: the dismiss-opened
// IDLE window re-completed by a late authoritative ready, and the COMPLETE -> DONE exit pair
// beyond the manager's 3s debounce. 'waiting' is deliberately NOT routed through the gate (its
// escalation re-fire and a later real "needs input" raised from COMPLETE must keep working).
//
// A work cycle starts on INITIALIZING (restart), or on a USER-driven RUNNING entry: the user
// answering a prompt (event 'user_input') or an authoritative resume (an actual UserPromptSubmit
// hook, signal 'resume'). It deliberately does NOT start on a self-wake RUNNING entry (a lead
// agent's title flips to 'working' after it auto-resumes on a teammate's mailbox message, which
// fires no UserPromptSubmit): otherwise an orchestrator lead that wakes N times per user prompt
// could re-arm 'complete' and fire a fresh toast on every wake instead of once per prompt. A
// degraded, title-only session (no hook ever seen) has no resume signal to key off, so it keeps
// the legacy reset-on-every-RUNNING behavior.
//
// Invariants the wiring relies on:
// - Self-transitions never reach the listener (sessions.js transition() returns early
//   without emitting state-change), so the RUNNING reset is edge-triggered by construction.
// - DORMANT needs no reset entry: the only exit is user_start -> INITIALIZING
//   (session/core/state-machine.js), which resets transitively.
// - The gate is created inside the per-session wiring closure, so a config-reload
//   destroy + re-wire gives the new session a fresh gate; no destroy-time cleanup.
//
// No timers, no session knowledge, no I/O.

function createNotifyGate() {
  const fired = new Set(); // categories already notified this work cycle

  // Mark a new work cycle: every category may notify again.
  function reset() {
    fired.clear();
  }

  // Returns true exactly once per category per cycle; the caller triggers only on true.
  function fire(category) {
    if (!category) return false;
    if (fired.has(category)) return false;
    fired.add(category);
    return true;
  }

  return { reset, fire };
}

// The whole trigger decision for a state entry: which notification category (if any) fires for
// the entered state `to`, given the session's cycle gate. Lives here, not in backend.js, so the
// backend listener and the tests execute the SAME decision logic (no hand-mirrored copy to
// drift). Side effects on the gate are intentional: an INITIALIZING entry, or a USER-driven
// RUNNING entry, resets the cycle; a matching terminal entry spends its category via the
// short-circuited fire().
//
// opts is optional: { signal, hookSeen }. signal is the state-change detail's signal string (or
// undefined); hookSeen is whether the session has ever received a Claude Code hook. Omitted opts
// (or a session with hookSeen false) keeps the legacy reset-on-every-RUNNING behavior, since a
// degraded title-only session has no resume signal to key a user-driven reset off.
function decideNotification(to, gate, event, opts) {
  if (to === STATES.INITIALIZING) {
    gate.reset();
    return null;
  }
  if (to === STATES.RUNNING) {
    const userDriven = event === 'user_input'
      || (opts && opts.signal === 'resume')
      || !opts || !opts.hookSeen;
    if (userDriven) gate.reset();
    return null;
  }
  // The user killed it themselves: "finished working" would be a false toast. The
  // category is NOT spent (no gate.fire), deliberately: nothing real completed.
  if (event === 'user_kill') return null;
  if (to === STATES.WAITING) return 'waiting';
  if ((to === STATES.COMPLETE || to === STATES.DONE) && gate.fire('complete')) return 'complete';
  if (to === STATES.FAILED && gate.fire('failed')) return 'failed';
  return null;
}

module.exports = { createNotifyGate, decideNotification };
