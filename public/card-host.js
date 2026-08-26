// THE re-parenting seam for a live session card. A session owns exactly one xterm, so the
// single-borrower invariant is GLOBAL, not per-surface: borrowCard releases whoever holds a card before
// taking one, which is what lets a layout flip hand the card across without coordination. The borrowed
// id lives in the cross-cutting UI store, so the WebGL pool can read it without an injected provider.

import { adoptElement, releaseElement } from './dom-helpers.js';
import { container, sessionUIs } from './session-card/card-registry.js';
import { activateTerminalViewer } from './session-card/terminal.js';
import { uiState } from './ui-state-core.mjs';

export function getBorrowedCardId() {
  return uiState.snapshot().borrowedCardId;
}

// Move `ui.card` into `slotEl` and make its terminal live and correctly sized there. `className` is the
// surface's own marker class (the Focus center and the phone Terminal screen style the borrowed card
// differently); it is removed again on release, and swapping surfaces swaps the class.
/**
 * @param {{ card?: HTMLElement & { _cardHostClass?: string }, _unviewTerminal?: () => void }} ui
 * @param {string} sessionId
 * @param {HTMLElement} slotEl
 * @param {{ className?: string }} [options]
 */
export function borrowCard(ui, sessionId, slotEl, { className } = {}) {
  if (!ui?.card || !slotEl) return;
  const borrowedId = getBorrowedCardId();
  if (borrowedId && borrowedId !== sessionId) releaseCard();

  const card = ui.card;
  if (card._cardHostClass && card._cardHostClass !== className) card.classList.remove(card._cardHostClass);
  card._cardHostClass = className || '';
  if (className) card.classList.add(className);

  adoptElement(card, slotEl);
  uiState.dispatch('borrowCard', sessionId);

  activateTerminalViewer(ui, sessionId);
}

// Return the borrowed card to its home slot. Safe to call when nothing is borrowed. Returns the id that
// was released (or null), so a caller can reconcile its own bookkeeping.
export function releaseCard() {
  const releasedId = getBorrowedCardId();
  uiState.dispatch('borrowCard', null);
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
  return releasedId;
}
