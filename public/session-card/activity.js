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
// Quiet is DERIVED, not scheduled: output arrival just stamps ui._lastOutputAt, and the shared
// 1s session tick (rail.js) calls refreshSessionActivity to compare it against now. So there is
// no per-session timer to churn on every chunk or to cancel on teardown - the timestamp is the
// single source of truth, and the flag is a pure function of (now - lastOutput, state). The
// responsive direction (silence -> output) is flipped eagerly here so resume feels instant; the
// poll handles the only direction that can't be event-driven (output -> silence).
//
// Only the cadence is inferred, never the cause: we report "output stopped", not "thinking"
// (honesty over reassurance, PRODUCT.md).
//
// Leaf module: terminal.js calls noteSessionOutput per inbound PTY chunk; lifecycle.js drives
// setRunningActivity on transitions; rail.js's tick calls refreshSessionActivity.

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

// Per inbound PTY chunk: stamp the arrival (the source of truth for "is it streaming") and,
// throttled, beat the glyph and eagerly clear a stale quiet flag so resume reads instantly.
// Content-blind: it only times the arrival, never inspects the bytes.
export function noteSessionOutput(ui) {
  if (!ui || ui.currentState !== STATES.RUNNING) return;
  const now = performance.now();
  ui._lastOutputAt = now;
  if (now - (ui._activityGate || 0) < BEAT_THROTTLE_MS) return;
  ui._activityGate = now;
  if (ui.card.dataset.activity === 'quiet') ui.card.dataset.activity = 'active';
  beat(ui);
}

// Called once per session on the shared 1s tick. Derives the quiet flag from elapsed silence -
// no timer - and writes only on change so a steady state never churns the attribute.
export function refreshSessionActivity(ui) {
  if (!ui || ui.currentState !== STATES.RUNNING) return;
  const next = performance.now() - (ui._lastOutputAt || 0) >= QUIET_AFTER_MS ? 'quiet' : 'active';
  if (ui.card.dataset.activity !== next) ui.card.dataset.activity = next;
}

// Enter/leave RUNNING. On entry, stamp now so the silence countdown starts fresh and mark the
// badge active; the tick takes over from there. On exit, drop the flag (no timer to cancel, so
// teardown is just this - removeSessionCard needs nothing, the attr leaves with the DOM).
export function setRunningActivity(ui, running) {
  if (!ui) return;
  if (running) {
    ui._lastOutputAt = performance.now();
    ui._activityGate = 0; // let the first chunk after entry beat immediately
    ui.card.dataset.activity = 'active';
  } else {
    delete ui.card.dataset.activity;
  }
}
