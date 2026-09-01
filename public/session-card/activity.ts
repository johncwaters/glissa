// Working-session heartbeat: turns the live PTY output stream into an honest "what is this
// agent doing right now" signal WITHOUT reading a single byte of content (the data path stays
// a dumb pipe; see AGENTS.md "Status Detection"). Two structural facts surface on the focus
// ROSTER RAIL pill (the left sidebar) - and ONLY there, never on the centered terminal, where it
// would just be redundant:
//
//   - Liveness (motion): every time output actually arrives we ping the pill glyph (throttled),
//     so a streaming agent visibly beats while a thinking one settles to a calm breath. The
//     cadence is the message; nothing about the content is inspected.
//   - Quiet (settle + word): after QUIET_AFTER_MS with no output the pill flips to
//     data-activity="quiet"; CSS slows and dims the breath and reveals a muted "quiet" eyebrow.
//     This is the 2am triage tell - is it churning, or stalled on a long step?
//
// Quiet is DERIVED, not scheduled: output arrival just stamps ui._lastOutputAt, and the shared
// 1s session tick (session-tick.js) calls refreshSessionActivity to compare it against now. So there is
// no per-session timer to churn on every chunk or to cancel on teardown - the timestamp is the
// single source of truth, and the flag (ui._activity) is a pure function of (now - lastOutput,
// state). The responsive direction (silence -> output) is flipped eagerly here so resume feels
// instant; the poll handles the only direction that can't be event-driven (output -> silence).
//
// Only the cadence is inferred, never the cause: we report "output stopped", not "thinking"
// (honesty over reassurance, PRODUCT.md).
//
// View-agnostic by design: this module owns the COMPUTE (stamp / throttle / derive) and parks the
// flag on the ui; the focus view registers a RENDERER (setActivityRenderer) that paints the rail
// pill. So the heartbeat's DOM home lives entirely in focus-view.js and this module never touches
// a card. Leaf module: terminal.js calls noteSessionOutput per inbound PTY chunk; lifecycle.js
// drives setRunningActivity on transitions; session-tick.js's tick calls refreshSessionActivity.

import { STATES } from '#shared/states.ts';
import type { SessionUi } from './card-registry.ts';

const BEAT_THROTTLE_MS = 320;  // cap beats at ~3/s so an output flood can't thrash the glyph
const QUIET_AFTER_MS = 8000;   // silence past this reads as "gone quiet" (thinking / long tool)

// The rail owns the heartbeat's DOM. The focus view registers a renderer here; we call it with
// 'beat' (one liveness ping on the glyph) or 'flag' (the active/quiet flag on ui._activity
// changed). With no renderer registered yet the compute still runs and the flag stays on the ui,
// so a later paint picks up the current state without a missed signal.
export type ActivityRenderKind = 'beat' | 'flag';
export type ActivityRenderer = (ui: SessionUi, kind: ActivityRenderKind) => void;

let renderer: ActivityRenderer | null = null;
export function setActivityRenderer(fn: ActivityRenderer | null) { renderer = fn; }

// Per inbound PTY chunk: stamp the arrival (the source of truth for "is it streaming") and,
// throttled, beat the glyph and eagerly clear a stale quiet flag so resume reads instantly.
// Content-blind: it only times the arrival, never inspects the bytes.
export function noteSessionOutput(ui: SessionUi | null | undefined) {
  if (!ui || ui.currentState !== STATES.RUNNING) return;
  const now = performance.now();
  ui._lastOutputAt = now;
  if (now - (ui._activityGate || 0) < BEAT_THROTTLE_MS) return;
  ui._activityGate = now;
  if (ui._activity === 'quiet') { ui._activity = 'active'; renderer?.(ui, 'flag'); }
  renderer?.(ui, 'beat');
}

// Called once per session on the shared 1s tick. Derives the quiet flag from elapsed silence -
// no timer - and repaints only on change so a steady state never churns.
export function refreshSessionActivity(ui: SessionUi | null | undefined) {
  if (!ui || ui.currentState !== STATES.RUNNING) return;
  const next = performance.now() - (ui._lastOutputAt || 0) >= QUIET_AFTER_MS ? 'quiet' : 'active';
  if (ui._activity !== next) { ui._activity = next; renderer?.(ui, 'flag'); }
}

// Enter/leave RUNNING. On entry, stamp now so the silence countdown starts fresh and mark active;
// the tick takes over from there. On exit, drop the flag. Either way repaint the pill so the
// breathe starts / stops with the state (no timer to cancel - the flag leaves with the ui).
export function setRunningActivity(ui: SessionUi | null | undefined, running: boolean) {
  if (!ui) return;
  if (running) {
    ui._lastOutputAt = performance.now();
    ui._activityGate = 0; // let the first chunk after entry beat immediately
    ui._activity = 'active';
  }
  if (!running) ui._activity = undefined;
  renderer?.(ui, 'flag');
}
