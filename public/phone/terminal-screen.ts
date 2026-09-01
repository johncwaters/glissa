import { STATES } from '#shared/states.ts';
import { borrowCard, getBorrowedCardId, releaseCard } from '../card-host.ts';
import { adoptElement, el, queryTag, releaseElement, stateChip } from '../dom-helpers.ts';
import { isRenameInProgress } from '../session-card/card-dom.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { onSessionTick, sessionElapsedText } from '../session-card/session-tick.ts';
import { activateTerminalViewer, sendTerminalInput } from '../session-card/terminal.ts';
import { showErrorToast } from '../session-card/toast.ts';
import { createMobileKeyStrip } from './mobile-key-strip.ts';

const BACK_GLYPH = String.fromCharCode(0x2039);

export function createTerminalScreen({ onBack }: { onBack?: () => void }) {
  const screen = el('div', 'phone-terminal');

  const topBar = el('header', 'phone-topbar phone-terminal-bar');
  const backBtn = el('button', 'phone-back', BACK_GLYPH);
  backBtn.type = 'button';
  backBtn.setAttribute('aria-label', 'Back to board');
  backBtn.addEventListener('click', () => onBack?.());

  const identity = el('div', 'phone-terminal-identity');
  const nameEl = el('span', 'phone-terminal-name');
  const badgeEl = el('span', 'phone-terminal-badge');
  badgeEl.innerHTML = '<span class="phone-terminal-glyph" aria-hidden="true"></span>'
    + '<span class="phone-terminal-label"></span>'
    + '<span class="phone-terminal-elapsed" aria-hidden="true"></span>';
  const glyphEl = queryTag(badgeEl, '.phone-terminal-glyph', 'span');
  const labelEl = queryTag(badgeEl, '.phone-terminal-label', 'span');
  const elapsedEl = queryTag(badgeEl, '.phone-terminal-elapsed', 'span');
  identity.append(nameEl, badgeEl);

  const actionSlot = el('div', 'phone-terminal-actions');

  topBar.append(backBtn, identity, actionSlot);

  const cardSlot = el('div', 'phone-card-slot');

  const emptyEl = el('div', 'phone-empty');
  emptyEl.innerHTML = '<p class="phone-empty-title">No session selected</p>'
    + '<p class="phone-empty-desc">Select a session from the board to watch it here.</p>';

  const keyStrip = createMobileKeyStrip({ send: sendToShownTerminal, getSessionId: () => shownId });

  screen.append(topBar, cardSlot, emptyEl, keyStrip);

  let shownId: string | null = null;

  let adoptedActions: HTMLDivElement | null = null;
  let renameTargetUi: SessionUi | null = null;

  function sendToShownTerminal(data: string | null | undefined) {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    if (!ui) return;
    if (sendTerminalInput(ui, data)) return;
    showErrorToast('Session is not connected; key press was dropped');
  }

  function focusShownTerminal() {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    if (!ui?.term) return;
    ui.term.focus();
  }

  cardSlot.addEventListener('click', focusShownTerminal);

  function paint() {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    const hasSession = !!ui;
    emptyEl.hidden = hasSession;
    cardSlot.hidden = !hasSession;
    keyStrip.hidden = !hasSession;
    identity.hidden = !hasSession;
    if (!hasSession) {
      topBar.removeAttribute('data-state');
      return;
    }
    const state = ui.currentState || STATES.DORMANT;
    topBar.dataset.state = state;

    if (!isRenameInProgress(nameEl)) nameEl.textContent = ui.card?.dataset.session || shownId;
    const { glyph, label } = stateChip(state);
    glyphEl.textContent = glyph;
    labelEl.textContent = label;
    elapsedEl.textContent = sessionElapsedText(ui);
  }

  function releaseBorrowedChrome() {
    if (renameTargetUi) {
      delete renameTargetUi.renameTargetEl;
      renameTargetUi = null;
    }

    nameEl.replaceChildren();
    if (!adoptedActions) return;
    releaseElement(adoptedActions);

    if (adoptedActions.parentElement === actionSlot) adoptedActions.remove();
    adoptedActions = null;
  }

  function show(sessionId: string) {
    const ui = sessionUIs.get(sessionId);
    if (!ui) return;
    const alreadyShown = shownId === sessionId
      && getBorrowedCardId() === sessionId
      && ui.card.parentElement === cardSlot;
    if (alreadyShown) {
      paint();
      return;
    }
    releaseBorrowedChrome();
    shownId = sessionId;
    borrowCard(ui, sessionId, cardSlot, { className: 'phone-centered' });
    adoptedActions = queryTag(ui.card, '.session-actions', 'div');
    adoptElement(adoptedActions, actionSlot);

    ui.renameTargetEl = nameEl;
    renameTargetUi = ui;
    paint();
  }

  function clear() {
    releaseBorrowedChrome();
    if (getBorrowedCardId() === shownId) releaseCard();
    shownId = null;
    paint();
  }

  function refresh() {
    if (!shownId) {
      paint();
      return;
    }
    const ui = sessionUIs.get(shownId);
    if (!ui) {
      clear();
      return;
    }
    if (ui.card.parentElement !== cardSlot) {
      show(shownId);
      return;
    }
    paint();
  }

  function unview() {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    ui?._unviewTerminal?.();
  }

  function reveal() {
    refresh();
    const currentId = shownId;
    if (!currentId) return;
    const ui = sessionUIs.get(currentId);
    if (!ui) return;
    activateTerminalViewer(ui, currentId);
  }

  onSessionTick(() => {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    if (ui) elapsedEl.textContent = sessionElapsedText(ui);
  });

  paint();

  return {
    el: screen,
    show,
    clear,
    refresh,
    reveal,
    unview,
    getSessionId: () => shownId,
  };
}
