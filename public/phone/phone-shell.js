// The phone layout's shell: six screens, one visible at a time, behind a bottom nav.
//
// This is a first-class layout, not a narrowed desktop. The desktop DOM (header, focus view, docked
// sidebar) is not rendered at all under [data-layout="phone"]; the shell is only built the first time
// the browser is actually in that layout, so a desktop session never pays for a line of it.
//
// The screens map to the phone job described in PRODUCT.md - scan, open, act, go back:
//   Board    - the landing screen: which session needs a carbon unit (see board-screen.js)
//   Terminal - the selected session's live terminal, full bleed (see terminal-screen.js)
//   Review   - the real review sidebar, re-parented in as a full screen
//   Teams    - the real Teams panel, re-parented in as a full screen
//   Radar    - the real Radar panel, re-parented in as a full screen
//   PRs      - the real PRs panel, re-parented in as a full screen
//
// Five elements are BORROWED from the desktop DOM rather than rebuilt: the review sidebar, the Teams,
// Radar and PRs panels, and the header controls the Board top bar adopts. Rebuilding any of them would
// mean a second state pipeline for the same facts.

import { STATES } from '/shared/states.mjs';
import { sendControlMsg } from '../control-ws.js';
import { adoptElement, el, releaseElement } from '../dom-helpers.js';
import { sessionUIs } from '../session-card/card-registry.js';
import { reparentReviewPanel } from '../sidebar/review-sidebar.js';
import { setSelectedId } from '../sidebar/selection.js';
import { getLastFocusedSessionId, setLastFocusedSessionId } from '../ui-prefs.js';
import { createBoardScreen } from './board-screen.js';
import { createTerminalScreen } from './terminal-screen.js';

// Screen ids, in bottom-nav order. Board is the base screen: it is what the phone opens on, and the
// only one the back gesture never has to leave.
const BOARD = 'board';
const SCREENS = Object.freeze([
  // Geometric glyphs from the same family as the state vocabulary; no emoji, no icon font.
  { id: BOARD, label: 'Board', glyph: '▤' },       // square with horizontal fill: the roster list
  { id: 'terminal', label: 'Terminal', glyph: '▸' }, // the brand forward marker: live output
  { id: 'review', label: 'Review', glyph: '◫' },     // square bisected vertically: a diff
  { id: 'teams', label: 'Teams', glyph: '◈' },       // diamond in a diamond: a staged pipeline
  { id: 'radar', label: 'Radar', glyph: '◎' },       // ringed circle: a scan sweep
  { id: 'prs', label: 'PRs', glyph: '⇅' },           // opposed arrows: push and pull
]);

let shellEl = null;
const navButtonById = new Map();
const screenElById = new Map();
let boardScreen = null;
let terminalScreen = null;
let reviewMountEl = null;
let teamsMountEl = null;
let teamsPanelEl = null;
let radarMountEl = null;
let radarPanelEl = null;
let prsMountEl = null;
let prsPanelEl = null;
let hooks = {};
let activeScreen = BOARD;
let active = false;
const SOFT_KEYBOARD_OPEN_DELTA_PX = 120;
// Tallest visual viewport seen at the current width, which is by construction its keyboard-closed
// height. Zero until the first measurement.
let keyboardClosedBaselineHeightPx = 0;
let baselineViewportWidthPx = 0;
// Whether we have pushed our one history entry above the Board. At most one entry is ever pushed, so
// the browser back gesture always lands on the Board rather than walking a stack of screen visits.
let pushedHistoryEntry = false;

// ── Soft keyboard ──
// The visual viewport is the only honest measure of what the operator can see once a soft keyboard is
// up: the layout viewport does not shrink, so a 100dvh shell keeps its bottom nav and the terminal's
// last rows underneath the keyboard. Sizing the shell to visualViewport.height instead makes the
// keyboard RESIZE the terminal, and the terminal's existing ResizeObserver then refits cols/rows.
//
// "Keyboard open" is measured against the tallest viewport seen, NOT against window.innerHeight: the
// visual viewport also excludes collapsing browser chrome (iOS Safari's URL bar is ~90-110px), so on
// some devices innerHeight - viewport.height clears the threshold with no keyboard up at all and
// data-keyboard="open" latches forever, hiding the bottom nav for the rest of the session.
function resetSoftKeyboardBaseline() {
  keyboardClosedBaselineHeightPx = 0;
  baselineViewportWidthPx = 0;
}

function syncVisualViewport() {
  const viewport = window.visualViewport;
  if (!shellEl) return;
  if (!active) {
    shellEl.removeAttribute('data-keyboard');
    return;
  }
  if (!viewport) {
    shellEl.removeAttribute('data-keyboard');
    return;
  }
  shellEl.style.setProperty('--phone-vh', `${viewport.height}px`);
  shellEl.style.setProperty('--phone-vv-top', `${viewport.offsetTop}px`);
  // An orientation flip changes the width and invalidates the height baseline with it.
  if (viewport.width !== baselineViewportWidthPx) {
    baselineViewportWidthPx = viewport.width;
    keyboardClosedBaselineHeightPx = 0;
  }
  keyboardClosedBaselineHeightPx = Math.max(keyboardClosedBaselineHeightPx, viewport.height);
  if (keyboardClosedBaselineHeightPx - viewport.height > SOFT_KEYBOARD_OPEN_DELTA_PX) {
    shellEl.dataset.keyboard = 'open';
    return;
  }
  shellEl.removeAttribute('data-keyboard');
}

// Deliberately NOT the ARIA tabs pattern. These screens are DESTINATIONS, not panels of one document:
// each pushes browser history (the back gesture returns to the Board), and each holds an independent
// surface - a live terminal, a diff panel, the Teams panel - rather than alternate content for one
// region. Tabs also imply Left/Right roving focus within a single composite control, which is wrong for
// a bottom nav a thumb taps. So it is a plain <nav> of buttons with aria-current on the active one:
// each button announces as a button, and half-implemented tab semantics (role=tab with no
// aria-controls and no roving) are worse for a screen reader than no roles at all.
function buildNav() {
  const nav = el('nav', 'phone-nav');
  nav.setAttribute('aria-label', 'Screens');
  for (const screen of SCREENS) {
    const btn = el('button', 'phone-nav-item');
    btn.type = 'button';
    btn.dataset.screen = screen.id;
    btn.innerHTML = '<span class="phone-nav-glyph" aria-hidden="true"></span>'
      + '<span class="phone-nav-label"></span>'
      + '<span class="phone-nav-dot" aria-hidden="true"></span>';
    btn.querySelector('.phone-nav-glyph').textContent = screen.glyph;
    btn.querySelector('.phone-nav-label').textContent = screen.label;
    // Dots start hidden; the Board's is driven by refreshPhoneBoard, Radar/PRs by setPhoneNavActivity.
    btn.querySelector('.phone-nav-dot').hidden = true;
    btn.addEventListener('click', () => showScreen(screen.id));
    navButtonById.set(screen.id, btn);
    nav.appendChild(btn);
  }
  return nav;
}

function wrapScreen(id, label, contentEl) {
  const section = el('section', 'phone-screen');
  section.dataset.screen = id;
  section.setAttribute('aria-label', label);
  // Every screen starts hidden; activation reveals exactly one. Without this the screens stack visibly
  // for a frame between build() and the first applyScreen.
  section.hidden = true;
  if (contentEl) section.appendChild(contentEl);
  screenElById.set(id, section);
  return section;
}

// Build the shell once. Everything below is idempotent so a layout flip back and forth reuses it.
function build() {
  if (shellEl) return;

  boardScreen = createBoardScreen({ onSelectSession: (id) => openSession(id) });
  terminalScreen = createTerminalScreen({ onBack: () => showScreen(BOARD) });
  reviewMountEl = el('div', 'phone-review');
  teamsMountEl = el('div', 'phone-teams');
  radarMountEl = el('div', 'phone-radar');
  prsMountEl = el('div', 'phone-prs');

  const screens = el('div', 'phone-screens');
  const contentByScreenId = {
    [BOARD]: boardScreen.el,
    terminal: terminalScreen.el,
    review: reviewMountEl,
    teams: teamsMountEl,
    radar: radarMountEl,
    prs: prsMountEl,
  };
  for (const screen of SCREENS) {
    screens.appendChild(wrapScreen(screen.id, screen.label, contentByScreenId[screen.id]));
  }

  shellEl = el('div', 'phone-shell');
  shellEl.id = 'phone-shell';
  shellEl.append(screens, buildNav());
  document.body.appendChild(shellEl);

  window.visualViewport?.addEventListener('resize', syncVisualViewport);
  window.visualViewport?.addEventListener('scroll', syncVisualViewport);
  window.addEventListener('popstate', onPopState);
}

// Open a session from the Board. Same semantics as tapping its desktop rail pill: a DORMANT session is
// started so the screen is not a dead box, and a finished turn is acknowledged server-side so the card
// leaves COMPLETE. WAITING is deliberately NOT dismissed - opening a blocked prompt is looking at it,
// not answering it.
function openSession(sessionId) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  const state = ui.currentState || STATES.DORMANT;
  if (state === STATES.DORMANT) sendControlMsg({ type: 'start-session', id: sessionId });
  if (state === STATES.COMPLETE) sendControlMsg({ type: 'dismiss', id: sessionId });
  // Opening a session is reading it: drop it from the Board's unseen set so the attention count stops
  // counting it, the peer of focusSession clearing a rail pill's data-unseen.
  boardScreen.acknowledge(sessionId);
  // One shared selection with the review surface, so the Review screen is already pointed at this
  // session by the time the operator taps over to it.
  setSelectedId(sessionId);
  // Persisted the same way the desktop Focus center persists its selection, so a layout flip (a phone
  // rotated into landscape) lands the desktop center on the session the operator was just watching.
  setLastFocusedSessionId(sessionId);
  terminalScreen.show(sessionId);
  showScreen('terminal');
}

// ── History ──
// Board is the base of the stack. Entering any other screen pushes exactly ONE entry, and moving
// between non-Board screens replaces it, so the back gesture always means "return to the Board" rather
// than walking back through every screen the operator touched. Back from the Board is the browser's
// business.
//
// The entry must never outlive the phone layout, and must never be double-counted across activations.
// Three rules keep that true: deactivate POPS an entry we own (a leftover would silently swallow one
// browser Back press on desktop, where onPopState is inert); activate ADOPTS an inherited entry rather
// than clearing the flag blind (history.state survives a reload, and clearing the flag would let the
// next screen change push a duplicate); and an inherited state naming a screen we do not have is
// normalized away instead of left unhonorable.
function pushHistoryFor(screenId) {
  if (screenId === BOARD) {
    if (!pushedHistoryEntry) return;
    pushedHistoryEntry = false;
    history.back();
    return;
  }
  const state = { glissaScreen: screenId };
  if (pushedHistoryEntry) {
    history.replaceState(state, '');
    return;
  }
  history.pushState(state, '');
  pushedHistoryEntry = true;
}

// Reconcile whatever history state this activation inherits, and return the screen to open on. A reload
// on a non-Board screen therefore comes back to that screen with a stack that still holds exactly one
// entry above the base, which is the same shape the operator navigated into.
function adoptInheritedHistory() {
  const inherited = history.state?.glissaScreen;
  if (inherited && screenElById.has(inherited)) {
    pushedHistoryEntry = true;
    return inherited;
  }
  // A state naming a screen this build no longer has: normalize the entry so the flag and the stack
  // agree, rather than leaving a state nothing can honor.
  if (inherited) history.replaceState(null, '');
  pushedHistoryEntry = false;
  return BOARD;
}

// Give back an entry we own. back() (not replaceState) because the entry has to leave the stack: a
// replaced entry still costs the operator one Back press that does nothing. We only ever call this
// having pushed, so there is guaranteed to be a prior entry to land on and this can never leave the
// site. The resulting popstate arrives after `active` is false and is correctly ignored.
function surrenderHistoryEntry() {
  if (!pushedHistoryEntry) return;
  pushedHistoryEntry = false;
  history.back();
}

function onPopState(event) {
  if (!active) return;
  const target = event.state?.glissaScreen;
  // Whatever we popped to, our pushed entry is no longer ahead of us.
  pushedHistoryEntry = !!target;
  applyScreen(target && screenElById.has(target) ? target : BOARD);
}

function applyScreen(screenId) {
  activeScreen = screenId;
  for (const [id, section] of screenElById) {
    section.hidden = id !== screenId;
  }
  for (const [id, btn] of navButtonById) {
    if (id === screenId) {
      btn.setAttribute('aria-current', 'page');
      continue;
    }
    btn.removeAttribute('aria-current');
  }
  if (screenId === 'teams') hooks.onTeamsShown?.(teamsPanelEl);
  // A hidden terminal had no measurable box, and one that never left the slot has unchanged dimensions
  // that make applyFit early-return; reveal() forces the fit + repaint either way.
  if (screenId === 'terminal') {
    terminalScreen.reveal();
    return;
  }
  // The card is still borrowed by the hidden Terminal screen, so releaseCard's hand-back never runs.
  terminalScreen.unview();
}

function showScreen(screenId) {
  if (!shellEl || !screenElById.has(screenId)) return;
  if (screenId !== activeScreen) pushHistoryFor(screenId);
  applyScreen(screenId);
}

// ── Activation ──
// mountPhoneShell wires the shell to the app once; activatePhoneShell / deactivatePhoneShell run on
// every layout flip and are what hand the borrowed DOM (review sidebar, Teams panel, the focused card)
// between the two layouts.
export function mountPhoneShell(options) {
  hooks = options || {};
  teamsPanelEl = hooks.teamsPanelEl || null;
  radarPanelEl = hooks.radarPanelEl || null;
  prsPanelEl = hooks.prsPanelEl || null;
}

// Attention dot on a nav item (Radar / PRs activity). Safe before build and on desktop: with no shell
// yet there is no button, and the toggle re-applies on the next activation via the stored flag.
const navActivityByScreenId = new Map();
export function setPhoneNavActivity(screenId, isActive) {
  navActivityByScreenId.set(screenId, !!isActive);
  const dot = navButtonById.get(screenId)?.querySelector('.phone-nav-dot');
  if (dot) dot.hidden = !isActive;
}

function applyStoredNavActivity() {
  for (const [screenId, isActive] of navActivityByScreenId) {
    const dot = navButtonById.get(screenId)?.querySelector('.phone-nav-dot');
    if (dot) dot.hidden = !isActive;
  }
}

// `sessionId` is the session the desktop Focus center was holding, if any. It is pre-loaded into the
// Terminal screen but does NOT change which screen opens: a phone's job is triage, so it always lands
// on the Board and the operator taps through.
export function activatePhoneShell({ sessionId } = {}) {
  if (active) return;
  build();
  active = true;
  shellEl.hidden = false;
  for (const control of (hooks.headerControls || [])) adoptElement(control, boardScreen.topBarEl);
  reparentReviewPanel(reviewMountEl);
  adoptElement(teamsPanelEl, teamsMountEl);
  if (teamsPanelEl) teamsPanelEl.hidden = false;
  // Radar and PRs are adopted the same way as Teams: the desktop tabpanel moves in whole, so the
  // eagerly-mounted panel keeps its state, and hidden (set by the desktop tab strip) is lifted while
  // the phone owns it. deactivate gives it back and activateView re-applies desktop visibility.
  adoptElement(radarPanelEl, radarMountEl);
  if (radarPanelEl) radarPanelEl.hidden = false;
  adoptElement(prsPanelEl, prsMountEl);
  if (prsPanelEl) prsPanelEl.hidden = false;
  applyStoredNavActivity();
  syncVisualViewport();
  if (sessionId) terminalScreen.show(sessionId);
  // Reconcile history BEFORE opening a screen, so the flag and the stack agree from the first tap.
  const startScreen = adoptInheritedHistory();
  refreshPhoneBoard();
  applyScreen(startScreen);
}

export function deactivatePhoneShell() {
  if (!active) return;
  active = false;
  // Give every borrowed element back BEFORE hiding the shell, so nothing live is left inside a hidden
  // subtree where its terminal cannot measure itself.
  terminalScreen.clear();
  reparentReviewPanel(null);
  releaseElement(teamsPanelEl);
  releaseElement(radarPanelEl);
  releaseElement(prsPanelEl);
  for (const control of (hooks.headerControls || [])) releaseElement(control);
  shellEl.hidden = true;
  shellEl.removeAttribute('data-keyboard');
  resetSoftKeyboardBaseline();
  // The desktop layout must not inherit our history entry: nothing there listens for it, so it would
  // cost the operator one dead Back press.
  surrenderHistoryEntry();
}

export function isPhoneShellActive() {
  return active;
}

// The session the Terminal screen is showing, so the app can keep the desktop Focus center pointed at
// the same session across a layout flip.
export function getPhoneSessionId() {
  return active && terminalScreen ? terminalScreen.getSessionId() : null;
}

// Re-render from the shared session registry. Called from the same app.js control-WS handlers that
// refresh the desktop rail; a no-op unless the phone layout is up.
export function refreshPhoneBoard() {
  if (!active) return;
  restoreShownSession();
  boardScreen.refresh();
  terminalScreen.refresh();
  const dot = navButtonById.get(BOARD)?.querySelector('.phone-nav-dot');
  if (dot) dot.hidden = boardScreen.getAttentionCount() === 0;
}

// The phone peer of the desktop's restoreFocusedSession, and what makes a reload that lands back on the
// Terminal screen coherent instead of an empty state. On the boot/reload race the roster is empty when
// the shell activates, so the Terminal screen has nothing to show until the first snapshot arrives;
// re-attempt the restore from each refresh until it lands. DORMANT is refused for the same reason the
// desktop refuses it: after a server restart every session loads DORMANT and none is worth returning
// to. This NEVER starts or dismisses anything - it is a restore, not an operator selection.
function restoreShownSession() {
  if (terminalScreen.getSessionId()) return;
  const id = getLastFocusedSessionId();
  const ui = id ? sessionUIs.get(id) : null;
  if (!ui) return;
  if ((ui.currentState || STATES.DORMANT) === STATES.DORMANT) return;
  terminalScreen.show(id);
  setSelectedId(id);
}
