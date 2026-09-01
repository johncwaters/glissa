
import { STATES } from '#shared/states.ts';
import { sendControlMsg } from '../control-ws.ts';
import type { AdoptableElement } from '../dom-helpers.ts';
import { adoptElement, el, releaseElement } from '../dom-helpers.ts';
import { pickStrongestAttention } from '../focus-view/attention-core.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { reparentReviewPanel } from '../sidebar/review-sidebar.ts';
import { setSelectedId } from '../sidebar/selection.ts';
import { uiState } from '../ui-state-core.ts';
import { closeSettingsSectionPicker } from '../settings-panel.ts';
import { getLastFocusedSessionId, setLastFocusedSessionId } from '../ui-prefs.ts';
import { createBoardScreen } from './board-screen.ts';
import { createTerminalScreen } from './terminal-screen.ts';

const BOARD = 'board';

interface PhoneScreenSpec {
  id: string;
  label: string;
  glyph: string;
  nested?: boolean;
}

export interface PhoneShellHooks {
  headerControls?: AdoptableElement[];
  radarPanelEl?: HTMLElement | null;
  prsPanelEl?: HTMLElement | null;
  usagePanelEl?: HTMLElement | null;
  millPanelEl?: HTMLElement | null;
  visionsPanelEl?: HTMLElement | null;
  hooksPanelEl?: HTMLElement | null;
  settingsPanelEl?: HTMLElement | null;
  onScreenShown?: (screenId: string) => void;
}

const SCREENS: readonly PhoneScreenSpec[] = Object.freeze([
  { id: BOARD, label: 'Board', glyph: '▤' },
  { id: 'terminal', label: 'Terminal', glyph: '▸' },
  { id: 'review', label: 'Review', glyph: '◫' },
  { id: 'radar', label: 'Radar', glyph: '◎', nested: true },
  { id: 'prs', label: 'PRs', glyph: '⇅', nested: true },
  { id: 'usage', label: 'Usage', glyph: '◔', nested: true },
  { id: 'mill', label: 'Mill', glyph: '▦', nested: true },
  { id: 'visions', label: 'Visions', glyph: '◇', nested: true },
  { id: 'hooks', label: 'Hooks', glyph: '◈', nested: true },
  { id: 'settings', label: 'Settings', glyph: '@', nested: true },
]);
let shellEl: HTMLDivElement | null = null;
const navButtonById = new Map<string, HTMLButtonElement>();
const screenElById = new Map<string, HTMLElement>();
const screenAttentionById = new Map<string, string | boolean>();
let boardScreen: ReturnType<typeof createBoardScreen> | null = null;
let terminalScreen: ReturnType<typeof createTerminalScreen> | null = null;
let reviewMountEl: HTMLDivElement | null = null;
let radarMountEl: HTMLDivElement | null = null;
let radarPanelEl: AdoptableElement | null = null;
let prsMountEl: HTMLDivElement | null = null;
let prsPanelEl: AdoptableElement | null = null;
let usageMountEl: HTMLDivElement | null = null;
let usagePanelEl: AdoptableElement | null = null;
let millMountEl: HTMLDivElement | null = null;
let millPanelEl: AdoptableElement | null = null;
let visionsMountEl: HTMLDivElement | null = null;
let hooksMountEl: HTMLDivElement | null = null;
let visionsPanelEl: AdoptableElement | null = null;
let hooksPanelEl: AdoptableElement | null = null;
let settingsMountEl: HTMLDivElement | null = null;
let settingsPanelEl: AdoptableElement | null = null;
let moreButtonEl: HTMLButtonElement | null = null;
let moreMenuEl: HTMLDivElement | null = null;
const menuButtonById = new Map<string, HTMLButtonElement>();
let hooks: PhoneShellHooks = {};
let active = false;
const SOFT_KEYBOARD_OPEN_DELTA_PX = 120;
let keyboardClosedBaselineHeightPx = 0;
let baselineViewportWidthPx = 0;
let pushedHistoryEntry = false;

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

function appendGlyphAndLabel(btn: HTMLButtonElement, glyph: string, label: string) {
  const glyphEl = el('span', 'phone-nav-glyph');
  glyphEl.setAttribute('aria-hidden', 'true');
  glyphEl.textContent = glyph;
  const labelEl = el('span', 'phone-nav-label');
  labelEl.textContent = label;
  btn.append(glyphEl, labelEl);
}

function buildNavButton(label: string, glyph: string, itemClass = 'phone-nav-item', dotClass = 'phone-nav-dot') {
  const btn = el('button', itemClass);
  btn.type = 'button';
  appendGlyphAndLabel(btn, glyph, label);
  const dot = el('span', dotClass);
  dot.setAttribute('aria-hidden', 'true');
  dot.hidden = true;
  btn.appendChild(dot);
  return btn;
}

function dotOf(button: HTMLElement | null | undefined) {
  return button?.querySelector<HTMLElement>('.phone-nav-dot') || null;
}

function applyDotAttention(dot: HTMLElement | null, attention: string | boolean) {
  if (!dot) return;
  dot.hidden = !attention;
  if (typeof attention === 'string') dot.dataset.attention = attention;
  if (typeof attention !== 'string') delete dot.dataset.attention;
}

function syncMoreAttention() {
  const nestedLevels: (string | boolean)[] = [];
  for (const screen of SCREENS) {
    if (!screen.nested) continue;
    const attention = screenAttentionById.get(screen.id) || false;
    nestedLevels.push(attention);
    applyDotAttention(dotOf(menuButtonById.get(screen.id)), attention);
  }
  applyDotAttention(dotOf(moreButtonEl), pickStrongestAttention(nestedLevels));
}

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

function setMoreMenuOpen(isOpen: boolean) {
  if (!moreMenuEl || !moreButtonEl) return;
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
  moreButtonEl = buildNavButton('More', String.fromCharCode(0x22ef));
  moreButtonEl.setAttribute('aria-expanded', 'false');
  moreButtonEl.addEventListener('click', () => setMoreMenuOpen(!isMoreMenuOpen()));
  nav.appendChild(moreButtonEl);
  moreMenuEl = buildMoreMenu();
  nav.appendChild(moreMenuEl);
  return nav;
}

function wrapScreen(id: string, label: string, contentEl: HTMLElement | null | undefined) {
  const section = el('section', 'phone-screen');
  section.dataset.screen = id;
  section.setAttribute('aria-label', label);
  section.hidden = true;
  if (contentEl) section.appendChild(contentEl);
  screenElById.set(id, section);
  return section;
}

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
  hooksMountEl = el('div', 'phone-hooks');
  settingsMountEl = el('div', 'phone-settings');

  const screens = el('div', 'phone-screens');
  const contentByScreenId: Record<string, HTMLElement | null> = {
    [BOARD]: boardScreen.el,
    terminal: terminalScreen.el,
    review: reviewMountEl,
    radar: radarMountEl,
    prs: prsMountEl,
    usage: usageMountEl,
    mill: millMountEl,
    visions: visionsMountEl,
    hooks: hooksMountEl,
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
  document.addEventListener('click', (event) => {
    if (!isMoreMenuOpen()) return;
    if (!moreMenuEl || !moreButtonEl || !(event.target instanceof Node)) return;
    if (moreMenuEl.contains(event.target) || moreButtonEl.contains(event.target)) return;
    setMoreMenuOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isMoreMenuOpen()) setMoreMenuOpen(false);
  });
}

function openSession(sessionId: string) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  if (!boardScreen || !terminalScreen) throw new Error('Phone shell is not built');
  const state = ui.currentState || STATES.DORMANT;
  if (state === STATES.DORMANT) sendControlMsg({ type: 'start-session', id: sessionId });
  if (state === STATES.COMPLETE) sendControlMsg({ type: 'dismiss', id: sessionId });
  boardScreen.acknowledge(sessionId);
  setSelectedId(sessionId);
  setLastFocusedSessionId(sessionId);
  terminalScreen.show(sessionId);
  showScreen('terminal');
}

function pushHistoryFor(screenId: string) {
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

function adoptInheritedHistory() {
  const inherited = screenIdFromHistoryState(history.state);
  if (inherited && screenElById.has(inherited)) {
    pushedHistoryEntry = true;
    return inherited;
  }
  if (inherited) history.replaceState(null, '');
  pushedHistoryEntry = false;
  return BOARD;
}

function surrenderHistoryEntry() {
  if (!pushedHistoryEntry) return;
  pushedHistoryEntry = false;
  history.back();
}

function screenIdFromHistoryState(state: unknown): string | null {
  const named = (state as { glissaScreen?: unknown } | null)?.glissaScreen;
  return typeof named === 'string' ? named : null;
}

function onPopState(event: PopStateEvent) {
  if (!active) return;
  const target = screenIdFromHistoryState(event.state);
  pushedHistoryEntry = !!target;
  applyScreen(target && screenElById.has(target) ? target : BOARD);
}

function syncCurrent(buttonById: Map<string, HTMLElement>, screenId: string) {
  for (const [id, btn] of buttonById) {
    if (id === screenId) {
      btn.setAttribute('aria-current', 'page');
      continue;
    }
    btn.removeAttribute('aria-current');
  }
}

function applyScreen(screenId: string) {
  if (!moreButtonEl || !terminalScreen) throw new Error('Phone shell is not built');
  uiState.dispatch('setPhoneScreen', screenId);
  setMoreMenuOpen(false);
  hooks.onScreenShown?.(screenId);
  for (const [id, section] of screenElById) {
    section.hidden = id !== screenId;
  }
  syncCurrent(navButtonById, screenId);
  const isNestedActive = menuButtonById.has(screenId);
  if (isNestedActive) moreButtonEl.setAttribute('aria-current', 'page');
  if (!isNestedActive) moreButtonEl.removeAttribute('aria-current');
  syncCurrent(menuButtonById, screenId);
  if (screenId === 'terminal') {
    terminalScreen.reveal();
    return;
  }
  terminalScreen.unview();
}

function showScreen(screenId: string) {
  if (!shellEl || !screenElById.has(screenId)) return;
  if (screenId !== uiState.snapshot().phoneScreen) pushHistoryFor(screenId);
  applyScreen(screenId);
}

export function mountPhoneShell(options?: PhoneShellHooks) {
  hooks = options || {};
  radarPanelEl = hooks.radarPanelEl || null;
  prsPanelEl = hooks.prsPanelEl || null;
  usagePanelEl = hooks.usagePanelEl || null;
  millPanelEl = hooks.millPanelEl || null;
  visionsPanelEl = hooks.visionsPanelEl || null;
  hooksPanelEl = hooks.hooksPanelEl || null;
  settingsPanelEl = hooks.settingsPanelEl || null;
}

export function activatePhoneShell({ sessionId }: { sessionId?: string } = {}) {
  if (active) return;
  build();
  if (!shellEl || !boardScreen || !terminalScreen) throw new Error('Phone shell is not built');
  active = true;
  shellEl.hidden = false;
  for (const control of (hooks.headerControls || [])) adoptElement(control, boardScreen.topBarEl);
  reparentReviewPanel(reviewMountEl);
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
  adoptElement(hooksPanelEl, hooksMountEl);
  if (hooksPanelEl) hooksPanelEl.hidden = false;
  adoptElement(settingsPanelEl, settingsMountEl);
  if (settingsPanelEl) settingsPanelEl.hidden = false;
  syncVisualViewport();
  if (sessionId) terminalScreen.show(sessionId);
  const startScreen = adoptInheritedHistory();
  refreshPhoneBoard();
  applyScreen(startScreen);
}

export function deactivatePhoneShell() {
  if (!active) return;
  if (!shellEl || !terminalScreen) throw new Error('Phone shell is not built');
  active = false;
  closeSettingsSectionPicker({ returnFocus: false });
  terminalScreen.clear();
  reparentReviewPanel(null);
  if (radarPanelEl) releaseElement(radarPanelEl);
  if (prsPanelEl) releaseElement(prsPanelEl);
  if (usagePanelEl) releaseElement(usagePanelEl);
  if (millPanelEl) releaseElement(millPanelEl);
  if (visionsPanelEl) releaseElement(visionsPanelEl);
  if (hooksPanelEl) releaseElement(hooksPanelEl);
  if (settingsPanelEl) releaseElement(settingsPanelEl);
  for (const control of (hooks.headerControls || [])) releaseElement(control);
  setMoreMenuOpen(false);
  shellEl.hidden = true;
  shellEl.removeAttribute('data-keyboard');
  resetSoftKeyboardBaseline();
  surrenderHistoryEntry();
}

export function isPhoneShellActive() {
  return active;
}

export function isPhoneScreenActive(screenId: string) {
  return active && uiState.snapshot().phoneScreen === screenId;
}

export function getPhoneSessionId() {
  return active && terminalScreen ? terminalScreen.getSessionId() : null;
}

export function refreshPhoneBoard() {
  if (!active) return;
  if (!boardScreen || !terminalScreen) throw new Error('Phone shell is not built');
  restoreShownSession();
  boardScreen.refresh();
  terminalScreen.refresh();
  if (uiState.snapshot().phoneScreen === 'terminal' && !terminalScreen.getSessionId()) showScreen(BOARD);
  const dot = dotOf(navButtonById.get(BOARD));
  if (dot) dot.hidden = boardScreen.getAttentionCount() === 0;
}

export function showPhoneScreen(screenId: string) {
  if (!active) return false;
  if (!screenElById.has(screenId)) return false;
  showScreen(screenId);
  return true;
}

export function setPhoneScreenAttention(screenId: string, attention: string | boolean | null) {
  screenAttentionById.set(screenId, typeof attention === 'string' && attention ? attention : attention === true);
  syncMoreAttention();
}

function restoreShownSession() {
  if (!terminalScreen) throw new Error('Phone shell is not built');
  if (terminalScreen.getSessionId()) return;
  const id = getLastFocusedSessionId();
  if (!id) return;
  const ui = sessionUIs.get(id);
  if (!ui) return;
  if ((ui.currentState || STATES.DORMANT) === STATES.DORMANT) return;
  terminalScreen.show(id);
  setSelectedId(id);
}
