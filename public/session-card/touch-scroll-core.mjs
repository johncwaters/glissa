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

// One touchmove of a fast flick can cover dozens of rows. In the alternate buffer every row costs the
// application a synthesized wheel notch (a mouse report, or an arrow key when the app tracks neither),
// and a TUI redraws its whole screen per notch, so a single frame must not hand it a burst that large.
export const MAX_ROWS_PER_STEP = 8;

// Has the finger moved far enough, and vertically enough, to mean "scroll"? Deltas are measured from
// the touch's start point, not from the previous move, so an early diagonal wobble cannot latch the
// gesture on by itself.
export function isScrollGesture(deltaXPx, deltaYPx) {
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
export function scrollLinesForDrag(pendingPx, cellHeightPx) {
  if (!(cellHeightPx > 0)) return { scrollLines: 0, remainderPx: pendingPx };
  const rows = Math.trunc(pendingPx / cellHeightPx);
  const capped = Math.max(-MAX_ROWS_PER_STEP, Math.min(MAX_ROWS_PER_STEP, rows));
  // Only the rows actually delivered are consumed; a capped flick keeps the rest as remainder so the
  // next move event continues where this one stopped rather than losing the travel.
  return {
    // Spelled out rather than -capped so a sub-row move reports 0 instead of the -0 that negation
    // produces, which callers would have to know not to compare against.
    scrollLines: capped === 0 ? 0 : -capped,
    remainderPx: pendingPx - capped * cellHeightPx,
  };
}

// Which of the two mechanisms a drag gets: a synthetic wheel notch the application decides the meaning
// of, or a local scrollback move. Either condition alone routes to the wheel, matching xterm's own
// native touch policy: the alternate buffer has no scrollback to move, and an application that has
// asked for wheel/mouse tracking must be told about the scroll even on the PRIMARY buffer (a pager or
// vim run without the alternate screen), where scrolling our own scrollback instead would move the
// wrong thing and starve the application of the event entirely.
export function shouldSendWheelReport(bufferType, mouseTrackingMode) {
  if (bufferType === 'alternate') return true;
  return Boolean(mouseTrackingMode) && mouseTrackingMode !== 'none';
}

// Row height, from the public surface only (term.element / term.rows) rather than the render service's
// private dimensions. Returns 0 when the terminal has no measurable box, which scrollLinesForDrag
// treats as "cannot scroll yet" and banks the travel instead of dividing by zero.
export function cellHeightFromElement(elementHeightPx, rows) {
  if (!(elementHeightPx > 0) || !(rows > 0)) return 0;
  return elementHeightPx / rows;
}
