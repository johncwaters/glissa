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

import {
  cellHeightFromElement,
  isScrollGesture,
  scrollLinesForDrag,
  shouldSendWheelReport,
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

  const endGesture = () => {
    activeTouchId = null;
    isScrolling = false;
    pendingPx = 0;
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

  const applyScroll = (scrollLines, clientX, clientY) => {
    if (shouldSendWheelReport(term.buffer.active.type, term.modes?.mouseTrackingMode)) {
      dispatchWheelNotches(scrollLines, clientX, clientY);
      return;
    }
    term.scrollLines(scrollLines);
  };

  termWrap.addEventListener('touchstart', (event) => {
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
    }

    // Claimed only once the gesture is a scroll: up to that point the touch still belongs to the
    // browser, which is what leaves long-press selection and a plain tap working. preventDefault is
    // guarded because a move the browser has already committed to is non-cancelable.
    if (event.cancelable) event.preventDefault();

    pendingPx += touch.clientY - lastY;
    lastY = touch.clientY;

    const cellHeight = cellHeightFromElement(term.element?.clientHeight || 0, term.rows);
    const { scrollLines, remainderPx } = scrollLinesForDrag(pendingPx, cellHeight);
    pendingPx = remainderPx;
    if (scrollLines === 0) return;
    applyScroll(scrollLines, touch.clientX, touch.clientY);
  }, { passive: false });

  termWrap.addEventListener('touchend', endGesture, { passive: true });
  termWrap.addEventListener('touchcancel', endGesture, { passive: true });
}
