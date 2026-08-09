// Shared 1s session tick. Two load-bearing readouts ride this single interval so nothing needs a
// per-session timer:
//
//   - Elapsed clock: "time in current state", rendered on each card's header readout (ui.elapsedEl).
//     Visible in the Focus center, where the focused card keeps its full header.
//   - Working heartbeat: refreshSessionActivity derives each RUNNING session's quiet flag from its
//     last-output timestamp; the flag paints on the Focus rail pill (activity.js -> focus-view.js).
//
// Extracted verbatim from the former rail.js (which also owned the now-removed minimized-bar UI) so
// the tick survives that module's deletion. Imported for-effect by lifecycle.js to install the
// interval at module load; refreshElapsed is also called directly on state changes (lifecycle.applyState)
// so the clock resets immediately instead of waiting up to a second for the next tick.

import { STATES } from '/shared/states.mjs';
import { refreshSessionActivity } from './activity.js';
import { sessionUIs } from './card-registry.js';

// States where a ticking "time in state" reads as meaningful: only while the session is actively
// progressing. IDLE / COMPLETE / DONE / FAILED / DORMANT are settled, so a stopwatch there is just
// noise (per operator feedback).
const ELAPSED_STATES = new Set([STATES.RUNNING, STATES.WAITING, STATES.STARTING, STATES.INITIALIZING]);
const showsElapsed = (state) => ELAPSED_STATES.has(state);

function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// The time-in-state text, or '' for settled states (which show no timer; :empty hides it). Exported
// because the phone Board row and the phone Terminal top bar render the same readout outside the card
// header, and a second formatter would be a second definition of "how long has this been working".
export function sessionElapsedText(ui) {
  return showsElapsed(ui.currentState) ? fmtElapsed(Date.now() - (ui.stateSince || Date.now())) : '';
}

// Refresh a single card's elapsed readout. Called by lifecycle.applyState so a state change reflects
// immediately, and by the interval tick for the running clock.
export function refreshElapsed(ui) {
  if (ui.elapsedEl) ui.elapsedEl.textContent = sessionElapsedText(ui);
}

// Extra per-tick subscribers (the phone Board's row clocks, the phone Terminal top bar). They ride this
// SAME interval rather than starting their own: a second timer per surface is exactly what this module
// exists to avoid. Returns an unsubscribe function.
const tickSubscribers = new Set();

export function onSessionTick(notify) {
  tickSubscribers.add(notify);
  return () => tickSubscribers.delete(notify);
}

// The shared 1s tick: advance every card's elapsed clock and derive each working session's quiet flag.
// Cheap: a handful of sessions, a couple of writes each, both no-ops when nothing changed.
setInterval(() => {
  for (const [, ui] of sessionUIs) {
    refreshElapsed(ui);
    refreshSessionActivity(ui);
  }
  for (const notify of tickSubscribers) {
    // A subscriber that throws must not stop the clock for every other session.
    try { notify(); } catch { /* ignore */ }
  }
}, 1000);
