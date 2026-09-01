import { adoptElement, releaseElement } from './dom-helpers.ts';
import type { SessionUi } from './session-card/card-registry.ts';
import { container, sessionUIs } from './session-card/card-registry.ts';
import { activateTerminalViewer } from './session-card/terminal.ts';
import { uiState } from './ui-state-core.ts';

export function getBorrowedCardId() {
  return uiState.snapshot().borrowedCardId;
}

export function borrowCard(ui: SessionUi | null | undefined, sessionId: string, slotEl: HTMLElement | null | undefined, { className }: { className?: string } = {}) {
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

export function releaseCard() {
  const releasedId = getBorrowedCardId();
  uiState.dispatch('borrowCard', null);
  if (!releasedId) return null;

  const ui = sessionUIs.get(releasedId);

  ui?._unviewTerminal?.();
  const card = ui?.card;
  if (!card) return releasedId;

  if (card._cardHostClass) card.classList.remove(card._cardHostClass);
  delete card._cardHostClass;
  releaseElement(card, container);
  return releasedId;
}
