// Touch-drag scrollback for the phone layout. xterm 6.0.0 ships no touch scrolling: its viewport is a
// VS Code SmoothScrollableElement driven by wheel and mouse events, and nothing in that path listens
// for touch, so a finger drag over a terminal moves nothing on any device.
//
// Two mechanisms, chosen by shouldSendWheelReport (mouse protocol first, then buffer):
//   wheel report - the drag is re-emitted as synthetic wheel notches on term.element and xterm's own
//                  wheel listeners decide what they mean. That is deliberately not a hand-rolled arrow
//                  key: an application that has asked for mouse tracking must get a wheel button
//                  report, and only one that has not gets the ESC[A / ESC[B fallback
//                  (CoreBrowserTerminal.bindMouse). Reimplementing that choice here would drift from
//                  xterm's the first time it changes.
//   scrollback   - term.scrollLines(), the same call xterm's own wheel path makes.
//
// Phone only. On desktop a wheel already works, and claiming touchmove there would break a coarse
// pointer device that is still on the desktop layout (a tablet), where the drag may belong to the page.

// A released flick coasts, on the scrollback path only. The physics is the VS Code Gesture inertia
// vendored into xterm (see touch-scroll-core.mjs), driven here by requestAnimationFrame. The wheel path
// never coasts: every coasted row there would cost the application another mouse report or arrow key
// plus a full-screen redraw, for motion the operator's finger already stopped asking for.

import {
  beginInertia,
  cellHeightFromElement,
  isScrollGesture,
  MAX_WHEEL_ROWS_PER_STEP,
  pushVelocitySample,
  releaseVelocity,
  scrollLinesForDrag,
  shouldSendWheelReport,
  stepInertia,
} from './touch-scroll-core.mjs';

const DOM_DELTA_LINE = 1;

// xterm master (unreleased, post-6.0.0) grew its own touch path (Gesture.addTarget on the screen
// element, Viewport.handleTouchScroll). On an xterm that has it, both handlers would fire and every
// drag would scroll twice, so this module stands down and defers to the upstream one. Delete this
// module, its core and its tests once the installed xterm ships native touch. 6.0.0 exposes no such
// method, so the probe is false today.
function hasNativeTouchScroll(term) {
  return typeof term._core?._viewport?.handleTouchScroll === 'function';
}

function findTouch(touchList, identifier) {
  for (const touch of touchList) {
    if (touch.identifier === identifier) return touch;
  }
  return null;
}

export function wireTouchScroll(termWrap, term) {
  if (hasNativeTouchScroll(term)) return;

  const isPhoneLayout = () => document.documentElement.dataset.layout === 'phone';

  let activeTouchId = null;
  let startX = 0;
  let startY = 0;
  let lastY = 0;
  let isScrolling = false;
  let pendingPx = 0;
  let velocitySamples = [];
  /** @type {{ velocityPxPerMs: number, lastMs: number, cellHeightPx: number, pendingPx: number }|null} */
  let inertiaState = null;
  /** @type {number|null} */
  let inertiaFrame = null;

  const cancelInertia = () => {
    if (inertiaFrame !== null) cancelAnimationFrame(inertiaFrame);
    inertiaFrame = null;
    inertiaState = null;
  };

  const routesToApplication = () =>
    shouldSendWheelReport(term.buffer?.active?.type, term.modes?.mouseTrackingMode);

  // The rows box, not term.element: .xterm is stretched to the wrap's full height on the phone
  // (.terminal-wrap .xterm { height: 100% }), which includes the partial row below the last full one,
  // and dividing that box by term.rows overstates the row height, so the buffer would travel slightly
  // less than the finger for the whole drag.
  const measureCellHeight = () => {
    const screen = term.element?.querySelector('.xterm-screen');
    return cellHeightFromElement(screen?.clientHeight || term.element?.clientHeight || 0, term.rows);
  };

  const endGesture = () => {
    activeTouchId = null;
    isScrolling = false;
    pendingPx = 0;
    velocitySamples = [];
  };

  // One notch per row, so a burst reaches the application as the wheel events it would have got from a
  // real scroll wheel rather than as one oversized delta it has no rule for. DOM_DELTA_LINE keeps
  // CoreMouseService.consumeWheelEvent on its line-mode branch, where one unit is exactly one row and
  // the trackpad damping it applies to pixel deltas never comes into play.
  const dispatchWheelNotches = (scrollLines, clientX, clientY) => {
    const deltaY = scrollLines < 0 ? -1 : 1;
    for (let notch = 0; notch < Math.abs(scrollLines); notch++) {
      term.element?.dispatchEvent(new WheelEvent('wheel', {
        deltaY,
        deltaMode: DOM_DELTA_LINE,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      }));
    }
  };

  // One coasting frame. The coast ends by itself when the velocity decays away, and is abandoned early
  // whenever the surface it was scrolling stops being the one the operator flicked: the card was torn
  // down or re-parented out of the document, the layout flipped off phone, the application turned mouse
  // tracking on or switched to the alternate buffer, or the scrollback hit its end (a stuck viewport
  // would otherwise spin frames against a boundary until the friction ran out).
  const runInertiaFrame = () => {
    inertiaFrame = null;
    if (!inertiaState) return;
    if (!termWrap.isConnected || !isPhoneLayout() || routesToApplication()) {
      cancelInertia();
      return;
    }

    const viewportBefore = term.buffer?.active?.viewportY;
    const { scrollLines, state } = stepInertia(inertiaState, performance.now());
    inertiaState = state;
    if (scrollLines !== 0) term.scrollLines(scrollLines);
    if (!inertiaState) return;
    if (scrollLines !== 0 && term.buffer?.active?.viewportY === viewportBefore) {
      cancelInertia();
      return;
    }
    inertiaFrame = requestAnimationFrame(runInertiaFrame);
  };

  const startInertia = (velocityPxPerMs, startedAtMs, carriedPx) => {
    inertiaState = beginInertia({
      velocityPxPerMs,
      startedAtMs,
      cellHeightPx: measureCellHeight(),
      pendingPx: carriedPx,
    });
    if (!inertiaState) return;
    inertiaFrame = requestAnimationFrame(runInertiaFrame);
  };

  termWrap.addEventListener('touchstart', (event) => {
    // A finger landing during a coast stops it where it is, the way every native scroll surface
    // behaves: the touch is a catch, not a request to keep moving underneath it.
    cancelInertia();

    // A second finger is a pinch or a two-finger pan; hand the whole gesture back rather than
    // scrolling off whichever touch happens to be first.
    if (!isPhoneLayout() || event.touches.length !== 1) {
      endGesture();
      return;
    }
    const touch = event.touches[0];
    activeTouchId = touch.identifier;
    startX = touch.clientX;
    startY = touch.clientY;
    lastY = touch.clientY;
    isScrolling = false;
    pendingPx = 0;
    velocitySamples = [];
  }, { passive: true });

  termWrap.addEventListener('touchmove', (event) => {
    if (activeTouchId === null || !isPhoneLayout()) return;
    const touch = findTouch(event.touches, activeTouchId);
    if (!touch) return;

    if (!isScrolling) {
      if (!isScrollGesture(touch.clientX - startX, touch.clientY - startY)) return;
      isScrolling = true;
      // Measure from here, so the threshold travel is spent claiming the gesture and does not also
      // jump the buffer.
      lastY = touch.clientY;
      pendingPx = 0;
      velocitySamples = pushVelocitySample([], touch.clientY, event.timeStamp);
    }

    // Claimed only once the gesture is a scroll: up to that point the touch still belongs to the
    // browser, which is what leaves long-press selection and a plain tap working. preventDefault is
    // guarded because a move the browser has already committed to is non-cancelable.
    if (event.cancelable) event.preventDefault();

    pendingPx += touch.clientY - lastY;
    lastY = touch.clientY;
    velocitySamples = pushVelocitySample(velocitySamples, touch.clientY, event.timeStamp);

    const sendsToApplication = routesToApplication();
    const { scrollLines, remainderPx } = scrollLinesForDrag(
      pendingPx,
      measureCellHeight(),
      sendsToApplication ? MAX_WHEEL_ROWS_PER_STEP : undefined,
    );
    pendingPx = remainderPx;
    if (scrollLines === 0) return;
    if (sendsToApplication) {
      dispatchWheelNotches(scrollLines, touch.clientX, touch.clientY);
      return;
    }
    term.scrollLines(scrollLines);
  }, { passive: false });

  termWrap.addEventListener('touchend', (event) => {
    if (!isScrolling || routesToApplication()) {
      endGesture();
      return;
    }
    // The lift position closes the window: a finger held still fires no touchmove, so without this the
    // samples would still describe the flick that preceded the pause and the buffer would coast after
    // the operator had already stopped it.
    velocitySamples = pushVelocitySample(velocitySamples, lastY, event.timeStamp);
    const velocityPxPerMs = releaseVelocity(velocitySamples);
    const carriedPx = pendingPx;
    endGesture();
    if (velocityPxPerMs === 0) return;
    // Seeded with performance.now(), the clock the rAF frames advance on. Seeding from event.timeStamp
    // assumes the two share an origin; where they did not, the first frame's elapsedMs <= 0 would
    // reschedule without advancing lastMs and the loop would spin without ever scrolling.
    startInertia(velocityPxPerMs, performance.now(), carriedPx);
  }, { passive: true });

  termWrap.addEventListener('touchcancel', () => {
    cancelInertia();
    endGesture();
  }, { passive: true });
}
