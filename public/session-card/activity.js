// Working-session heartbeat: turns the live PTY output stream into an honest "what is this
// agent doing right now" signal WITHOUT reading a single byte of content (the data path stays
// a dumb pipe; see CLAUDE.md "Status Detection"). Two structural facts surface on the RUNNING
// badge:
//
//   - Liveness (motion): every time output actually arrives we ping the badge glyph (throttled),
//     so a streaming agent visibly beats while a thinking one settles to a calm breath. The
//     cadence is the message; nothing about the content is inspected.
//   - Quiet (settle + word): after QUIET_AFTER_MS with no output the card flips to
//     data-activity="quiet"; CSS slows and dims the breath and reveals a muted "quiet" eyebrow.
//     This is the 2am triage tell - is it churning, or stalled on a long step?
//
// Only the cadence is inferred, never the cause: we report "output stopped", not "thinking"
// (honesty over reassurance, PRODUCT.md). Cleared on the next chunk and on any exit from RUNNING.
//
// Leaf module: terminal.js calls noteSessionOutput per inbound PTY chunk; lifecycle.js drives
// setRunningActivity on transitions and clearSessionActivity on teardown.

import { STATES } from '/shared/states.mjs';

const BEAT_THROTTLE_MS = 320;  // cap beats at ~3/s so an output flood can't thrash the glyph
const QUIET_AFTER_MS = 8000;   // silence past this reads as "gone quiet" (thinking / long tool)

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

// One quick GPU-only ping on the glyph: transform + opacity, fire-and-forget WAAPI so there is
// no class bookkeeping and it never reflows the dimensionally rigid header. The CSS ambient
// breath animates opacity only, so this scale composes on top of it instead of fighting it.
function beat(ui) {
  if (reducedMotion?.matches || document.hidden) return;
  if (ui.card.classList.contains('minimized')) return; // the rail stays calm; grid only
  const glyph = ui.badge?.querySelector('.state-glyph');
  if (!glyph?.animate) return;
  glyph.animate(
    [
      { transform: 'scale(1)', opacity: 0.65 },
      { transform: 'scale(1.35)', opacity: 1, offset: 0.3 },
      { transform: 'scale(1)', opacity: 0.9 },
    ],
    { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
}

function armQuietTimer(ui) {
  clearTimeout(ui._quietTimer);
  ui._quietTimer = setTimeout(() => {
    if (ui.currentState === STATES.RUNNING) ui.card.dataset.activity = 'quiet';
  }, QUIET_AFTER_MS);
}

// Called per inbound PTY chunk. O(1) and content-blind: it only times the arrival.
export function noteSessionOutput(ui) {
  if (!ui || ui.currentState !== STATES.RUNNING) return;
  const now = performance.now();
  ui._lastOutputAt = now;
  // Throttle the DOM/animation work; the bare timestamp above is enough for everything else.
  if (now - (ui._activityGate || 0) < BEAT_THROTTLE_MS) return;
  ui._activityGate = now;
  if (ui.card.dataset.activity === 'quiet') ui.card.dataset.activity = 'active';
  beat(ui);
  armQuietTimer(ui);
}

// Enter/leave RUNNING. Arming the quiet timer on entry covers a session that starts RUNNING and
// never emits (it correctly goes quiet); leaving RUNNING tears the whole thing down.
export function setRunningActivity(ui, running) {
  if (!ui) return;
  if (running) {
    ui._activityGate = 0;
    ui._lastOutputAt = performance.now();
    delete ui.card.dataset.activity;
    armQuietTimer(ui);
  } else {
    clearSessionActivity(ui);
  }
}

export function clearSessionActivity(ui) {
  if (!ui) return;
  clearTimeout(ui._quietTimer);
  ui._quietTimer = null;
  delete ui.card.dataset.activity;
}
