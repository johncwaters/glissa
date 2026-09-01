// Pure gesture math for the phone's touch-drag scrollback. xterm 6.0.0 has no touch scrolling at all:
// its viewport is a VS Code SmoothScrollableElement wired to wheel and mouse only (there is not one
// touch listener under vs/base/browser/ui/scrollbar), so a finger drag over a terminal does nothing on
// any device. The IO shell in touch-scroll.js reads the touch stream; everything decidable without a
// DOM lives here.

// Below this the drag is a tap, or the opening millimetres of a long-press selection, so the gesture is
// not claimed and the browser keeps its own meaning for the touch.
export const TOUCH_SCROLL_THRESHOLD_PX = 10;

// A vertical drag has to dominate before it counts as a scroll, so a mostly-sideways swipe is left
// alone rather than yanking the buffer a row.
const VERTICAL_DOMINANCE = 1.2;

// One touchmove of a fast flick can cover dozens of rows. On the WHEEL path every row costs the
// application a synthesized notch (a mouse report, or an arrow key when the app tracks neither), and a
// TUI redraws its whole screen per notch, so a single frame must not hand it a burst that large. The
// local scrollback path pays none of that (one term.scrollLines call moves any number of rows), and
// capping it there was felt as a hard flick "sticking", so it runs uncapped.
export const MAX_WHEEL_ROWS_PER_STEP = 8;

// Velocity decay of a released flick, in px/ms per ms, copied from the VS Code Gesture machinery
// vendored into xterm (Gesture.SCROLL_FRICTION = -0.005) that xterm master's own touch path adopts.
// Matching it means this module coasts like the upstream one it will eventually be replaced by.
export const SCROLL_FRICTION_PX_PER_MS2 = 0.005;

// Release velocity is measured over the last few move samples, the same rolling window size Gesture
// keeps. Longer would average a flick together with the slow drag that preceded it.
export const VELOCITY_SAMPLE_LIMIT = 4;

// Under this a coast would travel well under one row, so the lift reads as a deliberate stop and
// inertia is skipped rather than adding a row of drift after the finger settled.
export const MIN_FLICK_VELOCITY_PX_PER_MS = 0.08;

// Ceiling on the release velocity, so one jumped touch sample (a finger re-entering the element, a
// dropped frame) cannot launch a coast of hundreds of rows. At the friction above this still coasts
// roughly 2500px, far past any real flick.
export const MAX_FLICK_VELOCITY_PX_PER_MS = 5;

// Has the finger moved far enough, and vertically enough, to mean "scroll"? Deltas are measured from
// the touch's start point, not from the previous move, so an early diagonal wobble cannot latch the
// gesture on by itself.
export function isScrollGesture(deltaXPx: number, deltaYPx: number) {
  const vertical = Math.abs(deltaYPx);
  if (vertical < TOUCH_SCROLL_THRESHOLD_PX) return false;
  return vertical > Math.abs(deltaXPx) * VERTICAL_DOMINANCE;
}

// Convert accumulated finger travel into whole rows of scroll, carrying the sub-row remainder so a
// slow drag still moves smoothly instead of quantizing every move event to zero.
//
// `pendingPx` is downward-positive finger travel. The returned `scrollLines` is what term.scrollLines
// wants, so it is NEGATIVE for a downward drag: pulling the content down reveals earlier output, the
// same direction a touch surface moves a document.
export function scrollLinesForDrag(pendingPx: number, cellHeightPx: number, maxRowsPerStep = Number.POSITIVE_INFINITY) {
  if (!(cellHeightPx > 0)) return { scrollLines: 0, remainderPx: pendingPx };
  const rows = Math.trunc(pendingPx / cellHeightPx);
  const capped = Math.max(-maxRowsPerStep, Math.min(maxRowsPerStep, rows));
  // Only the rows actually delivered are consumed; a capped flick keeps the rest as remainder so the
  // next move event continues where this one stopped rather than losing the travel.
  return {
    // Spelled out rather than -capped so a sub-row move reports 0 instead of the -0 that negation
    // produces, which callers would have to know not to compare against.
    scrollLines: capped === 0 ? 0 : -capped,
    remainderPx: pendingPx - capped * cellHeightPx,
  };
}

// Rolling window of recent finger positions, oldest first, kept at VELOCITY_SAMPLE_LIMIT entries.
// Returns a new array rather than mutating, so a caller cannot accidentally share a window across
// gestures. The shell pushes the lift position at touchend too: a finger that stops moving stops
// firing touchmove, and without that final sample the window would still describe the flick that
// happened before the pause and coast after a deliberate stop.
export interface VelocitySample {
  positionPx: number;
  timestampMs: number;
}

export function pushVelocitySample(samples: readonly VelocitySample[], positionPx: number, timestampMs: number): VelocitySample[] {
  const kept = samples.length >= VELOCITY_SAMPLE_LIMIT ? samples.slice(1) : samples.slice();
  kept.push({ positionPx, timestampMs });
  return kept;
}

// Signed px/ms across the whole retained window (Gesture measures the same way: last minus first over
// the window's own span, not a per-frame instantaneous rate, which is far noisier). Returns 0 for
// anything that does not read as a flick, which the caller treats as "no coast".
export function releaseVelocity(samples: readonly VelocitySample[] | null | undefined) {
  if (!samples || samples.length < 2) return 0;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const elapsedMs = newest.timestampMs - oldest.timestampMs;
  if (!(elapsedMs > 0)) return 0;
  const velocityPxPerMs = (newest.positionPx - oldest.positionPx) / elapsedMs;
  const speed = Math.abs(velocityPxPerMs);
  if (!(speed >= MIN_FLICK_VELOCITY_PX_PER_MS)) return 0;
  const clampedSpeed = Math.min(speed, MAX_FLICK_VELOCITY_PX_PER_MS);
  return velocityPxPerMs < 0 ? -clampedSpeed : clampedSpeed;
}

// The coast's initial state, or null when there is nothing to coast (no flick, or no measurable row
// height to convert the travel into rows with). `pendingPx` carries the drag's unspent sub-row
// remainder in, so the handoff from finger to inertia does not lose or repeat a fraction of a row.
export interface InertiaState {
  velocityPxPerMs: number;
  lastMs: number;
  cellHeightPx: number;
  pendingPx: number;
}

export function beginInertia({ velocityPxPerMs, startedAtMs, cellHeightPx, pendingPx = 0 }: {
  velocityPxPerMs: number;
  startedAtMs: number;
  cellHeightPx: number;
  pendingPx?: number;
}): InertiaState | null {
  if (!velocityPxPerMs || !(cellHeightPx > 0)) return null;
  return { velocityPxPerMs, lastMs: startedAtMs, cellHeightPx, pendingPx };
}

// One animation frame of coasting. Velocity decays by the friction over the frame's own elapsed time
// and the remaining velocity carries the frame's travel, so a dropped frame moves proportionally
// further instead of stalling, and a long gap (a backgrounded tab) decays straight past zero and ends
// the coast. A null `state` out means the coast is over and the caller stops scheduling frames.
export function stepInertia(state: InertiaState | null | undefined, nowMs: number): { scrollLines: number; state: InertiaState | null } {
  if (!state) return { scrollLines: 0, state: null };
  const elapsedMs = nowMs - state.lastMs;
  if (!(elapsedMs > 0)) return { scrollLines: 0, state };

  const decayedSpeed = Math.abs(state.velocityPxPerMs) - SCROLL_FRICTION_PX_PER_MS2 * elapsedMs;
  if (!(decayedSpeed > 0)) return { scrollLines: 0, state: null };

  const direction = state.velocityPxPerMs < 0 ? -1 : 1;
  const travelPx = direction * decayedSpeed * elapsedMs;
  const { scrollLines, remainderPx } = scrollLinesForDrag(state.pendingPx + travelPx, state.cellHeightPx);
  return {
    scrollLines,
    state: {
      velocityPxPerMs: direction * decayedSpeed,
      lastMs: nowMs,
      cellHeightPx: state.cellHeightPx,
      pendingPx: remainderPx,
    },
  };
}

// Which of the two mechanisms a drag gets: a synthetic wheel notch the application decides the meaning
// of, or a local scrollback move. Either condition alone routes to the wheel, matching xterm's own
// native touch policy: the alternate buffer has no scrollback to move, and an application that has
// asked for wheel/mouse tracking must be told about the scroll even on the PRIMARY buffer (a pager or
// vim run without the alternate screen), where scrolling our own scrollback instead would move the
// wrong thing and starve the application of the event entirely.
export function shouldSendWheelReport(bufferType: string | null | undefined, mouseTrackingMode: string | null | undefined) {
  if (bufferType === 'alternate') return true;
  return Boolean(mouseTrackingMode) && mouseTrackingMode !== 'none';
}

// Row height, from the public surface only (term.element / term.rows) rather than the render service's
// private dimensions. Returns 0 when the terminal has no measurable box, which scrollLinesForDrag
// treats as "cannot scroll yet" and banks the travel instead of dividing by zero.
export function cellHeightFromElement(elementHeightPx: number, rows: number) {
  if (!(elementHeightPx > 0) || !(rows > 0)) return 0;
  return elementHeightPx / rows;
}
