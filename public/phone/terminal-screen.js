// The phone Terminal screen: one session's live terminal, full bleed, the way the phone actually wants
// it. The terminal is the product, so it gets the whole screen between a thin top bar and the touch key
// strip; there is no rail and no docked panel competing with it.
//
// Nothing here duplicates a card affordance. The session's real card is borrowed through the shared
// card-host seam, and the card's own action cluster (the kebab holding Rename / Restart / Resume /
// Remove, plus the debug button) is ADOPTED into the top bar, so every action the desktop card offers
// is reachable here with the wiring it already had. Two desktop mechanisms have no touch meaning and
// are replaced rather than left dead: double-click-to-rename becomes the kebab's Rename (retargeted at
// the top bar's name, since the card header does not render on this screen), and the hover-revealed
// remove "x" is the kebab's Remove.

import { STATES } from '/shared/states.mjs';
import { borrowCard, getBorrowedCardId, releaseCard } from '../card-host.js';
import { adoptElement, el, releaseElement, stateChip } from '../dom-helpers.js';
import { isRenameInProgress } from '../session-card/card-dom.js';
import { sessionUIs } from '../session-card/card-registry.js';
import { onSessionTick, sessionElapsedText } from '../session-card/session-tick.js';
import { forceTerminalRepaint, sendTerminalInput } from '../session-card/terminal.js';
import { showErrorToast } from '../session-card/toast.js';
import { reacquireWebglIfEvicted } from '../session-card/webgl-pool.js';
import { createMobileKeyStrip } from './mobile-key-strip.js';

const BACK_GLYPH = String.fromCharCode(0x2039); // single left-pointing angle quotation mark

// createTerminalScreen({ onBack }) -> { el, show, clear, refresh, getSessionId }
export function createTerminalScreen({ onBack }) {
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
  const glyphEl = badgeEl.querySelector('.phone-terminal-glyph');
  const labelEl = badgeEl.querySelector('.phone-terminal-label');
  const elapsedEl = badgeEl.querySelector('.phone-terminal-elapsed');
  identity.append(nameEl, badgeEl);

  // Where the card's adopted action cluster lands. Empty (and collapsed) with no session shown.
  const actionSlot = el('div', 'phone-terminal-actions');

  topBar.append(backBtn, identity, actionSlot);

  const cardSlot = el('div', 'phone-card-slot');

  const emptyEl = el('div', 'phone-empty');
  emptyEl.innerHTML = '<p class="phone-empty-title">No session selected</p>'
    + '<p class="phone-empty-desc">Select a session from the board to watch it here.</p>';

  const keyStrip = createMobileKeyStrip({ send: sendToShownTerminal, getSessionId: () => shownId });

  screen.append(topBar, cardSlot, emptyEl, keyStrip);

  let shownId = null;
  // The card action cluster currently adopted into the top bar, and the ui whose Rename we retargeted.
  // Tracked as their own references (not derived from shownId) so a card REBUILT under the same id
  // cannot leave either one dangling.
  let adoptedActions = null;
  let renameTargetUi = null;

  // Bytes from the key strip go to whichever session this screen is showing, over the same data WS
  // xterm's own keystrokes use. The strip never takes DOM focus (mobile-key-strip.js), so the keyboard
  // survives an Esc or arrow press. A refused send (socket down and the replay queue full) is reported -
  // a Ctrl+C tap that silently vanishes reads as a wedged session.
  function sendToShownTerminal(data) {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    if (!ui) return;
    if (sendTerminalInput(ui, data)) return;
    showErrorToast('Session is not connected; key press was dropped');
  }

  // Typing on a phone goes through xterm's hidden 0x0 helper textarea, and its own synthetic focus on
  // mousedown does not reliably raise a soft keyboard, so the tap focuses the terminal explicitly. Click
  // rather than pointerdown: a scroll drag fires no click, and a click still counts as the user gesture
  // iOS demands before it will open the keyboard.
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
    // NEVER overwrite the name while the inline rename field is open inside it. This element IS the
    // rename target (ui.renameTargetEl), and paint runs on every board refresh - a state change on ANY
    // session, a snapshot, a merge-status delta - so an unguarded write would replace the focused input
    // mid-edit and lose what the operator typed. The predicate belongs to the rename seam that owns the
    // field's lifecycle (card-dom.js), not to a class name spelled out again here.
    if (!isRenameInProgress(nameEl)) nameEl.textContent = ui.card?.dataset.session || shownId;
    const { glyph, label } = stateChip(state);
    glyphEl.textContent = glyph;
    labelEl.textContent = label;
    elapsedEl.textContent = sessionElapsedText(ui);
  }

  // Hand the card's action cluster back to its header and stop retargeting Rename. Called before
  // showing a different session and on clear, so exactly one card is ever borrowed from.
  function releaseBorrowedChrome() {
    if (renameTargetUi) {
      delete renameTargetUi.renameTargetEl;
      renameTargetUi = null;
    }
    // An open rename field belongs to the session being let go of, so it goes with it. This is what
    // keeps the paint guard honest: an orphaned input left in this element would make isRenameInProgress
    // true forever and permanently pin a stale name. Abandoning the edit is the right outcome here - the
    // session is being swapped out or removed, so committing its half-typed name would be worse.
    nameEl.replaceChildren();
    if (!adoptedActions) return;
    releaseElement(adoptedActions);
    // A card rebuilt while its actions were up here leaves an orphan whose home no longer exists, so
    // releaseElement has nowhere to put it. Drop it rather than stacking it behind the new cluster.
    if (adoptedActions.parentElement === actionSlot) adoptedActions.remove();
    adoptedActions = null;
  }

  function show(sessionId) {
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
    adoptedActions = ui.card.querySelector('.session-actions');
    adoptElement(adoptedActions, actionSlot);
    // The card header does not render on this screen, so the inline rename must edit the name the
    // operator can actually see. card-dom.js reads this seam and falls back to ui.nameEl.
    ui.renameTargetEl = nameEl;
    renameTargetUi = ui;
    paint();
  }

  // Give the card and its actions back. Used when the screen loses its session (removed, or the layout
  // flipped back to desktop and the Focus center wants the card).
  function clear() {
    releaseBorrowedChrome();
    if (getBorrowedCardId() === shownId) releaseCard();
    shownId = null;
    paint();
  }

  // Re-paint from the live registry (a state change, a rename, a removal, a rebuild). A session that
  // vanished drops the screen back to its empty state rather than showing a stale name over a dead
  // terminal; a session whose card was REBUILT under the same id (the DORMANT close-out and the
  // session-modified round trip both replace the element) is re-borrowed, exactly as the Focus center
  // re-borrows a displaced card on its own refresh.
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

  // The screen was navigated away from. The card stays borrowed (its bytes keep flowing) but it is no
  // longer on screen, so it stops speaking for the PTY's size and a desktop watching the same session
  // gets its own dimensions back. reveal() re-asserts on the way in.
  function unview() {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    ui?._unviewTerminal?.();
  }

  // The screen just became visible. A card that never left the slot keeps its exact dimensions, so
  // applyFit's cols/rows comparison early-returns and the WebGL texture atlas is never cleared - which
  // can leave the frame from before the screen was hidden painted over the live buffer. Force the fit
  // and repaint here, mirroring what card-host.borrowCard does on a fresh borrow, so a
  // Board -> Terminal -> Board -> Terminal round trip is deterministic rather than dimension-dependent.
  //
  // The repaint is FORCED because the ordering makes a plain one a no-op on the path that matters:
  // phone-shell.openSession borrows the card while this section is still hidden, so borrowCard's fit
  // early-returned on a card with no offsetParent and armed a repaint against that stale geometry.
  // Only the fit below runs against the real box, so the repaint that follows it has to be the one
  // that lands rather than collapsing into the pending, worse-informed one.
  function reveal() {
    refresh();
    const ui = shownId ? sessionUIs.get(shownId) : null;
    if (!ui) return;
    reacquireWebglIfEvicted(ui);
    ui._applyFit?.();
    forceTerminalRepaint(ui, { force: true });
    // Deliberately NOT focusing the terminal here: focus raises the soft keyboard, and entering this
    // screen is usually READING, not typing. The keyboard comes up on an explicit tap on the terminal
    // (the cardSlot click handler), which is also the gesture iOS requires anyway.
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
