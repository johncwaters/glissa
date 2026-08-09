// THE re-parenting seam for a live session card, shared by every surface that shows one.
//
// A session owns exactly one xterm, so its card is MOVED into whichever surface is displaying it and
// returned to its off-screen grid home afterwards. There are two such surfaces now (the desktop Focus
// center and the phone Terminal screen) and the borrow logic must exist once: two copies would drift,
// and a layout flip between them would leave a live terminal parented into a hidden subtree, where
// xterm's fit computes garbage and the operator sees a blank box.
//
// The single-borrower invariant is GLOBAL, not per-surface. borrowCard releases whoever currently holds
// a card before taking one, so a phone rotating into desktop width (or the reverse) hands the card
// across cleanly with no coordination between the two surfaces.

import { adoptElement, releaseElement } from './dom-helpers.js';
import { container, sessionUIs } from './session-card/card-registry.js';
import { ensureTerminalSetup, forceTerminalRepaint } from './session-card/terminal.js';

let borrowedId = null;

export function getBorrowedCardId() {
  return borrowedId;
}

// Move `ui.card` into `slotEl` and make its terminal live and correctly sized there. `className` is the
// surface's own marker class (the Focus center and the phone Terminal screen style the borrowed card
// differently); it is removed again on release, and swapping surfaces swaps the class.
export function borrowCard(ui, sessionId, slotEl, { className } = {}) {
  if (!ui?.card || !slotEl) return;
  if (borrowedId && borrowedId !== sessionId) releaseCard();

  const card = ui.card;
  if (card._cardHostClass && card._cardHostClass !== className) card.classList.remove(card._cardHostClass);
  card._cardHostClass = className || '';
  if (className) card.classList.add(className);

  adoptElement(card, slotEl);
  borrowedId = sessionId;

  // A dormant card has no terminal yet - build one so the surface is not a blank box. This does NOT
  // spawn a PTY; it only constructs the xterm.
  if (!ui.term) ensureTerminalSetup(ui, sessionId);
  // Deterministic fit to the new (usually much larger) slot rather than waiting on the ResizeObserver.
  ui._applyFit?.();
  forceTerminalRepaint(ui);
}

// Return the borrowed card to its home slot. Safe to call when nothing is borrowed. Returns the id that
// was released (or null), so a caller can reconcile its own bookkeeping.
export function releaseCard() {
  const releasedId = borrowedId;
  borrowedId = null;
  if (!releasedId) return null;

  const ui = sessionUIs.get(releasedId);
  const card = ui?.card;
  if (!card) return releasedId;

  if (card._cardHostClass) card.classList.remove(card._cardHostClass);
  delete card._cardHostClass;
  releaseElement(card, container);
  ui._applyFit?.();
  forceTerminalRepaint(ui);
  return releasedId;
}
