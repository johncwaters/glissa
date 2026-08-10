// THE re-parenting seam for a live session card. A session owns exactly one xterm, so the
// single-borrower invariant is GLOBAL, not per-surface: borrowCard releases whoever holds a card before
// taking one, which is what lets a layout flip hand the card across without coordination.

import { adoptElement, releaseElement } from './dom-helpers.js';
import { container, sessionUIs } from './session-card/card-registry.js';
import { ensureTerminalSetup, forceTerminalRepaint } from './session-card/terminal.js';
import { reacquireWebglIfEvicted } from './session-card/webgl-pool.js';

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
  // Becoming visible is the moment a card evicted from the WebGL context pool gets its context back.
  // The pool caps contexts at 4 on a coarse pointer, so on a phone every session switch past the
  // fourth evicts someone; without this the flag the pool sets is never read and an evicted card is
  // stuck on the DOM renderer for the rest of the page's life. tryLoadWebGL is a no-op on a card that
  // already holds a healthy context, so this costs nothing on the common borrow.
  reacquireWebglIfEvicted(ui);
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
  // Back in the hidden home slot this card is nobody's viewer, so it gives its claim on the PTY size
  // back to whichever client is still looking at the session.
  ui?._unviewTerminal?.();
  const card = ui?.card;
  if (!card) return releasedId;

  if (card._cardHostClass) card.classList.remove(card._cardHostClass);
  delete card._cardHostClass;
  releaseElement(card, container);
  ui._applyFit?.();
  forceTerminalRepaint(ui);
  return releasedId;
}
