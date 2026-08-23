'use strict';

// Notification lifecycle states - single source of truth.
// Mirrors the table-driven pattern used by shared/states.js for session states.

const NOTIFICATION_STATES = Object.freeze({
  IDLE:         'IDLE',         // No active notification for this session
  PENDING:      'PENDING',      // Transient: auto-transitions in ENTRY_HOOK, never observable externally.
                                // Exists to centralize the suppress/debounce/deliver decision.
  SUPPRESSED:   'SUPPRESSED',   // Held while the dashboard is focused; delivered on blur (unsuppress)
                                // or discarded when the session leaves the trigger state (acknowledge).
                                // Deferral, not a drop: a completion that fired while the window was
                                // focused-but-unwatched still surfaces once the user is away.
  DELIVERED:    'DELIVERED',    // Notification sent via channel(s); escalation timer running (waiting only)
  ESCALATED:    'ESCALATED',   // Escalation timer fired, re-delivered via channels
  ESCALATED_PHONE: 'ESCALATED_PHONE', // Still unacknowledged past the ladder's delay: re-delivered to
                                // the OFF-DASHBOARD channels only, ignoring their usual
                                // nobody-is-watching gate. The last rung: an operator who did not
                                // react to the browser notification is reached on their phone even
                                // with a dashboard open somewhere.
  ACKNOWLEDGED: 'ACKNOWLEDGED', // User interacted (dismissed, responded, or session left trigger state)
});

// Ping-pong pattern: ESCALATED + escalation_tick -> DELIVERED (not self-transition)
// because the session state machine's transition() skips entry/exit hooks on
// self-transitions. The ping-pong ensures both ENTRY_HOOKs fire every cycle.
//
// `trigger` is legal from DELIVERED/ESCALATED/SUPPRESSED (back through PENDING): a new
// trigger REPLACES a live notification (fresh category/message, timers cleared on exit).
// Without those edges a re-trigger on an un-acknowledged entry is silently lost - e.g.
// a team's second run could never notify after the first run's entry stayed DELIVERED.
const NOTIFICATION_TRANSITIONS = Object.freeze({
  [NOTIFICATION_STATES.IDLE]: {
    trigger:           NOTIFICATION_STATES.PENDING,
  },
  [NOTIFICATION_STATES.PENDING]: {
    suppressed:        NOTIFICATION_STATES.SUPPRESSED,
    debounced:         NOTIFICATION_STATES.IDLE,
    deliver:           NOTIFICATION_STATES.DELIVERED,
    acknowledge:       NOTIFICATION_STATES.IDLE,       // Race: user acted before delivery
    session_destroyed: NOTIFICATION_STATES.IDLE,
  },
  [NOTIFICATION_STATES.SUPPRESSED]: {
    trigger:           NOTIFICATION_STATES.PENDING,
    unsuppress:        NOTIFICATION_STATES.PENDING,     // Re-runs the deliver decision on blur
    acknowledge:       NOTIFICATION_STATES.IDLE,
    session_destroyed: NOTIFICATION_STATES.IDLE,
  },
  [NOTIFICATION_STATES.DELIVERED]: {
    trigger:           NOTIFICATION_STATES.PENDING,
    escalation_tick:   NOTIFICATION_STATES.ESCALATED,
    phone_escalation:  NOTIFICATION_STATES.ESCALATED_PHONE,
    acknowledge:       NOTIFICATION_STATES.ACKNOWLEDGED,
    session_destroyed: NOTIFICATION_STATES.IDLE,
  },
  [NOTIFICATION_STATES.ESCALATED]: {
    trigger:           NOTIFICATION_STATES.PENDING,
    escalation_tick:   NOTIFICATION_STATES.DELIVERED,   // Ping-pong back to DELIVERED
    phone_escalation:  NOTIFICATION_STATES.ESCALATED_PHONE,
    acknowledge:       NOTIFICATION_STATES.ACKNOWLEDGED,
    session_destroyed: NOTIFICATION_STATES.IDLE,
  },
  // The phone rung fires ONCE per entry (the manager latches it), so there is no edge back to itself.
  // escalation_tick returns a 'waiting' entry to its browser ping-pong: being reached on the phone
  // does not end an escalation that exists because the agent is still blocked.
  [NOTIFICATION_STATES.ESCALATED_PHONE]: {
    trigger:           NOTIFICATION_STATES.PENDING,
    escalation_tick:   NOTIFICATION_STATES.DELIVERED,
    acknowledge:       NOTIFICATION_STATES.ACKNOWLEDGED,
    session_destroyed: NOTIFICATION_STATES.IDLE,
  },
  [NOTIFICATION_STATES.ACKNOWLEDGED]: {
    reset:             NOTIFICATION_STATES.IDLE,
    session_destroyed: NOTIFICATION_STATES.IDLE,
  },
});

module.exports = { NOTIFICATION_STATES, NOTIFICATION_TRANSITIONS };
