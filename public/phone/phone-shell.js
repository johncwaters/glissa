// The phone layout's shell: nine screens, one visible at a time, behind a bottom nav.
//
// This is a first-class layout, not a narrowed desktop. The desktop DOM (header, focus view, docked
// sidebar) is not rendered at all under [data-layout="phone"]; the shell is only built the first time
// the browser is actually in that layout, so a desktop session never pays for a line of it.
//
// The screens map to the phone job described in PRODUCT.md - scan, open, act, go back:
//   Board    - the landing screen: which session needs a carbon unit (see board-screen.js)
//   Terminal - the selected session's live terminal, full bleed (see terminal-screen.js)
//   Review   - the real review sidebar, re-parented in as a full screen
//   Radar    - the real Radar panel, re-parented in as a full screen
//   PRs      - the real PRs panel, re-parented in as a full screen
//   Usage    - the real Usage panel, re-parented in as a full screen
//   Mill     - the real Mill panel, re-parented in as a full screen
//   Visions - the real Visions panel, re-parented in as a full screen
//   Settings - the real Settings panel, re-parented in as a full screen
//
// Eight elements are BORROWED from the desktop DOM rather than rebuilt: the review sidebar, the Radar,
// PRs, Usage, Mill, Visions and Settings panels, and the header controls the Board top bar adopts. Rebuilding any
// of them would mean a second state pipeline for the same facts.

import { STATES } from '/shared/states.mjs';
import { sendControlMsg } from '../control-ws.js';
import { adoptElement, el, releaseElement } from '../dom-helpers.js';
import { sessionUIs } from '../session-card/card-registry.js';
import { reparentReviewPanel } from '../sidebar/review-sidebar.js';
import { setSelectedId } from '../sidebar/selection.js';
import { closeSettingsSectionPicker } from '../settings-panel.js';
import { getLastFocusedSessionId, setLastFocusedSessionId } from '../ui-prefs.js';
import { createBoardScreen } from './board-screen.js';
import { createTerminalScreen } from './terminal-screen.js';

// Screen ids, in bottom-nav order. Board is the base screen: it is what the phone opens on, and the
// only one the back gesture never has to leave. Nested screens do not get their own nav item: they
// live in the More sheet, so the nav row stays four thumb-sized destinations plus one overflow.
const BOARD = 'board';
const SCREENS = Object.freeze([
  // Geometric glyphs from the same family as the state vocabulary; no emoji, no icon font.
  { id: BOARD, label: 'Board', glyph: '▤' },       // square with horizontal fill: the roster list
  { id: 'terminal', label: 'Terminal', glyph: '▸' }, // the brand forward marker: live output
  { id: 'review', label: 'Review', glyph: '◫' },     // square bisected vertically: a diff
  { id: 'radar', label: 'Radar', glyph: '◎', nested: true }, // ringed circle: a scan sweep
  { id: 'prs', label: 'PRs', glyph: '⇅', nested: true },     // opposed arrows: push and pull
  { id: 'usage', label: 'Usage', glyph: '◔', nested: true }, // part-filled circle: a consumption gauge
  { id: 'mill', label: 'Mill', glyph: '▦', nested: true }, // square with quadrants: assembled parts
  { id: 'visions', label: 'Visions', glyph: '◇', nested: true },
  { id: 'settings', label: 'Settings', glyph: '@', nested: true },
]);
let shellEl = null;
const navButtonById = new Map();
const screenElById = new Map();
const screenAttentionById = new Map();
let boardScreen = null;
let terminalScreen = null;
let reviewMountEl = null;
let radarMountEl = null;
let radarPanelEl = null;
let prsMountEl = null;
let prsPanelEl = null;
let usageMountEl = null;
let usagePanelEl = null;
let millMountEl = null;
let millPanelEl = null;
let visionsMountEl = null;
let visionsPanelEl = null;
let settingsMountEl = null;
let settingsPanelEl = null;
let moreButtonEl = null;
let moreMenuEl = null;
const menuButtonById = new Map();
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
// surface - a live terminal, a diff panel, the Radar board - rather than alternate content for one
// region. Tabs also imply Left/Right roving focus within a single composite control, which is wrong for
// a bottom nav a thumb taps. So it is a plain <nav> of buttons with aria-current on the active one:
// each button announces as a button, and half-implemented tab semantics (role=tab with no
// aria-controls and no roving) are worse for a screen reader than no roles at all.
function appendGlyphAndLabel(btn, glyph, label) {
  const glyphEl = el('span', 'phone-nav-glyph');
  glyphEl.setAttribute('aria-hidden', 'true');
  glyphEl.textContent = glyph;
  const labelEl = el('span', 'phone-nav-label');
  labelEl.textContent = label;
  btn.append(glyphEl, labelEl);
}

function buildNavButton(label, glyph, itemClass = 'phone-nav-item', dotClass = 'phone-nav-dot') {
  const btn = el('button', itemClass);
  btn.type = 'button';
  appendGlyphAndLabel(btn, glyph, label);
  const dot = el('span', dotClass);
  dot.setAttribute('aria-hidden', 'true');
  dot.hidden = true;
  btn.appendChild(dot);
  return btn;
}

function dotOf(button) {
  return button?.querySelector('.phone-nav-dot') || null;
}

function syncMoreAttention() {
  let hasNestedAttention = false;
  for (const screen of SCREENS) {
    if (!screen.nested) continue;
    const hasAttention = screenAttentionById.get(screen.id) === true;
    if (hasAttention) hasNestedAttention = true;
    const dot = dotOf(menuButtonById.get(screen.id));
    if (dot) dot.hidden = !hasAttention;
  }
  const moreDot = dotOf(moreButtonEl);
  if (moreDot) moreDot.hidden = !hasNestedAttention;
}

// The More sheet: nested screens' entries, floated above the nav from the More item. It is a plain
// popover of buttons (no menu roles for the same reason the nav has no tab roles), dismissed by
// choosing an entry, tapping anywhere else, or Escape.
function buildMoreMenu() {
  const menu = el('div', 'phone-nav-more-menu');
  menu.hidden = true;
  for (const screen of SCREENS) {
    if (!screen.nested) continue;
    const btn = buildNavButton(screen.label, screen.glyph, 'phone-nav-menu-item', 'phone-nav-dot phone-nav-menu-dot');
    btn.dataset.screen = screen.id;
    btn.addEventListener('click', () => {
      setMoreMenuOpen(false);
      showScreen(screen.id);
    });
    menuButtonById.set(screen.id, btn);
    menu.appendChild(btn);
  }
  return menu;
}

function setMoreMenuOpen(isOpen) {
  if (!moreMenuEl) return;
  moreMenuEl.hidden = !isOpen;
  moreButtonEl.setAttribute('aria-expanded', String(isOpen));
}

function isMoreMenuOpen() {
  return !!moreMenuEl && !moreMenuEl.hidden;
}

function buildNav() {
  const nav = el('nav', 'phone-nav');
  nav.setAttribute('aria-label', 'Screens');
  for (const screen of SCREENS) {
    if (screen.nested) continue;
    const btn = buildNavButton(screen.label, screen.glyph);
    btn.dataset.screen = screen.id;
    btn.addEventListener('click', () => showScreen(screen.id));
    navButtonById.set(screen.id, btn);
    nav.appendChild(btn);
  }
  moreButtonEl = buildNavButton('More', String.fromCharCode(0x22ef)); // midline horizontal ellipsis
  moreButtonEl.setAttribute('aria-expanded', 'false');
  moreButtonEl.addEventListener('click', () => setMoreMenuOpen(!isMoreMenuOpen()));
  nav.appendChild(moreButtonEl);
  moreMenuEl = buildMoreMenu();
  nav.appendChild(moreMenuEl);
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
  radarMountEl = el('div', 'phone-radar');
  prsMountEl = el('div', 'phone-prs');
  usageMountEl = el('div', 'phone-usage');
  millMountEl = el('div', 'phone-mill');
  visionsMountEl = el('div', 'phone-visions');
  settingsMountEl = el('div', 'phone-settings');

  const screens = el('div', 'phone-screens');
  const contentByScreenId = {
    [BOARD]: boardScreen.el,
    terminal: terminalScreen.el,
    review: reviewMountEl,
    radar: radarMountEl,
    prs: prsMountEl,
    usage: usageMountEl,
    mill: millMountEl,
    visions: visionsMountEl,
    settings: settingsMountEl,
  };
  for (const screen of SCREENS) {
    screens.appendChild(wrapScreen(screen.id, screen.label, contentByScreenId[screen.id]));
  }

  shellEl = el('div', 'phone-shell');
  shellEl.id = 'phone-shell';
  shellEl.append(screens, buildNav());
  document.body.appendChild(shellEl);
  syncMoreAttention();

  window.visualViewport?.addEventListener('resize', syncVisualViewport);
  window.visualViewport?.addEventListener('scroll', syncVisualViewport);
  window.addEventListener('popstate', onPopState);
  // A tap anywhere outside the sheet (or Escape) dismisses it; the More button's own tap already
  // toggled by the time this bubbles up, so it is excluded to avoid an instant reopen-close.
  document.addEventListener('click', (event) => {
    if (!isMoreMenuOpen()) return;
    if (moreMenuEl.contains(event.target) || moreButtonEl.contains(event.target)) return;
    setMoreMenuOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isMoreMenuOpen()) setMoreMenuOpen(false);
  });
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

function syncCurrent(buttonById, screenId) {
  for (const [id, btn] of buttonById) {
    if (id === screenId) {
      btn.setAttribute('aria-current', 'page');
      continue;
    }
    btn.removeAttribute('aria-current');
  }
}

function applyScreen(screenId) {
  activeScreen = screenId;
  setMoreMenuOpen(false);
  // A screen that pulls its own data (Usage requests a report) is told it became visible; every other
  // screen is fed by broadcasts and ignores this.
  hooks.onScreenShown?.(screenId);
  for (const [id, section] of screenElById) {
    section.hidden = id !== screenId;
  }
  syncCurrent(navButtonById, screenId);
  // A nested screen lights the More item, since it has no nav item of its own.
  const isNestedActive = menuButtonById.has(screenId);
  if (isNestedActive) moreButtonEl.setAttribute('aria-current', 'page');
  if (!isNestedActive) moreButtonEl.removeAttribute('aria-current');
  syncCurrent(menuButtonById, screenId);
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
// every layout flip and are what hand the borrowed DOM (review sidebar, Radar and PRs panels, the
// focused card) between the two layouts.
export function mountPhoneShell(options) {
  hooks = options || {};
  radarPanelEl = hooks.radarPanelEl || null;
  prsPanelEl = hooks.prsPanelEl || null;
  usagePanelEl = hooks.usagePanelEl || null;
  millPanelEl = hooks.millPanelEl || null;
  visionsPanelEl = hooks.visionsPanelEl || null;
  settingsPanelEl = hooks.settingsPanelEl || null;
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
  // The desktop tabpanel moves in whole, so the eagerly-mounted panel keeps its state, and hidden (set
  // by the desktop tab strip) is lifted while the phone owns it. deactivate gives it back and
  // activateView re-applies desktop visibility.
  adoptElement(radarPanelEl, radarMountEl);
  if (radarPanelEl) radarPanelEl.hidden = false;
  adoptElement(prsPanelEl, prsMountEl);
  if (prsPanelEl) prsPanelEl.hidden = false;
  adoptElement(usagePanelEl, usageMountEl);
  if (usagePanelEl) usagePanelEl.hidden = false;
  adoptElement(millPanelEl, millMountEl);
  if (millPanelEl) millPanelEl.hidden = false;
  adoptElement(visionsPanelEl, visionsMountEl);
  if (visionsPanelEl) visionsPanelEl.hidden = false;
  adoptElement(settingsPanelEl, settingsMountEl);
  if (settingsPanelEl) settingsPanelEl.hidden = false;
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
  closeSettingsSectionPicker({ returnFocus: false });
  // Give every borrowed element back BEFORE hiding the shell, so nothing live is left inside a hidden
  // subtree where its terminal cannot measure itself.
  terminalScreen.clear();
  reparentReviewPanel(null);
  releaseElement(radarPanelEl);
  releaseElement(prsPanelEl);
  releaseElement(usagePanelEl);
  releaseElement(millPanelEl);
  releaseElement(visionsPanelEl);
  releaseElement(settingsPanelEl);
  for (const control of (hooks.headerControls || [])) releaseElement(control);
  setMoreMenuOpen(false);
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

// Whether a given screen is the one on display. The peer of the desktop's active-view check, for a
// panel that only fetches while the operator is actually looking at it.
export function isPhoneScreenActive(screenId) {
  return active && activeScreen === screenId;
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
  // A session removed while its terminal is on screen leaves the Terminal screen holding nothing
  // (refresh() above already cleared it). Staring at that empty state helps nobody: the session is
  // gone, so the screen's job is over; hand the operator back to the Board. Keyed on the ACTIVE
  // screen so a removal never yanks the operator off Review/Radar/etc, where the Terminal screen is
  // hidden and its empty state costs nothing.
  if (activeScreen === 'terminal' && !terminalScreen.getSessionId()) showScreen(BOARD);
  const dot = dotOf(navButtonById.get(BOARD));
  if (dot) dot.hidden = boardScreen.getAttentionCount() === 0;
}

// Navigation seam for panels that point at another screen (Radar's PR rows). Returns false when the
// phone layout is not up or the screen is unknown, which is the caller's signal to use the desktop
// tab strip instead.
export function showPhoneScreen(screenId) {
  if (!active) return false;
  if (!screenElById.has(screenId)) return false;
  showScreen(screenId);
  return true;
}

export function setPhoneScreenAttention(screenId, hasAttention) {
  screenAttentionById.set(screenId, hasAttention === true);
  syncMoreAttention();
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
