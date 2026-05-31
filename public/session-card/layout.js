// Minimize / maximize / split / sleep — mutually recursive cluster. All five
// layout-private state variables live here; callers outside this module route
// through the exported accessors (isMaximizeActive, getMaximizedSession) and
// the action exports (exitMaximizeMode, enforceSplitOnCreate, forgetSessionLayout).
//
// C1: Two semantically distinct reads of the maximized-session state are
// separated into isMaximizeActive() (boolean) and getMaximizedSession() (id|null)
// so callers cannot confuse a truthy-id-check with a null-check.
//
// C2: The split-on-create enforcement branch that was inline in createSessionCard
// is encapsulated in enforceSplitOnCreate() so _currentLayout/_preSplitSessions
// stay private to this module.

import { STATES } from '/shared/states.mjs';
import { sendControlMsg } from '../control-ws.js';
import { setMinimized } from '../ui-prefs.js';
import { container, minimizedBar, sessionUIs } from './card-registry.js';
import { ensureTerminalSetup, setupTerminal, wireTerminalIO } from './terminal.js';
import { releaseWebgl, tryLoadWebGL } from './webgl-pool.js';

// ── Layout-private state ─────────────────────────────────────

let _maximizedSession = null;
const _preMaximizeSessions = new Set();
let _preMaximizeOrder = [];

let _currentLayout = 'default';
const _preSplitSessions = new Set(); // sessions auto-minimized by split layout

// ── Constants ────────────────────────────────────────────────

export const SLEEP_ELIGIBLE = [STATES.IDLE, STATES.COMPLETE, STATES.DONE, STATES.FAILED];

const SPLIT_MAX_VISIBLE = 2;

// ── C1 accessors ─────────────────────────────────────────────

export function isMaximizeActive() {
  return _maximizedSession !== null;
}

export function getMaximizedSession() {
  return _maximizedSession;
}

// ── Minimize toggle ──────────────────────────────────────────

export function toggleMinimize(sessionId) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  const isCurrentlyMinimized = ui.card.classList.contains('minimized');

  // Dormant card: clicking expand spawns the PTY. Optimistically set up the
  // terminal and promote the card out of the minimized bar; the server's
  // DORMANT -> INITIALIZING state-change will arrive moments later.
  if (ui.currentState === STATES.DORMANT && isCurrentlyMinimized) {
    sendControlMsg({ type: 'start-session', id: sessionId });
    ensureTerminalSetup(ui, sessionId);
    _performExpand(sessionId, ui);
    return;
  }

  // In maximize mode: expanding a minimized session switches the maximized target
  if (_maximizedSession && isCurrentlyMinimized && sessionId !== _maximizedSession) {
    toggleMaximize(sessionId);
    return;
  }

  // Minimizing the maximized session exits maximize mode
  if (_maximizedSession && sessionId === _maximizedSession && !isCurrentlyMinimized) {
    exitMaximizeMode();
    return;
  }

  // In split mode: expanding swaps with a visible session instead of exceeding limit
  if (_currentLayout === 'split' && isCurrentlyMinimized) {
    const visible = _getVisibleSessions();
    if (visible.length >= SPLIT_MAX_VISIBLE) {
      const evictId = visible[visible.length - 1];
      const evictUi = sessionUIs.get(evictId);
      if (evictUi) {
        _performMinimize(evictId, evictUi);
        _preSplitSessions.add(evictId);
      }
    }
    _preSplitSessions.delete(sessionId);
  }

  // Normal minimize/expand toggle
  const nowMinimized = ui.card.classList.toggle('minimized');
  ui.btnMinimize.textContent = nowMinimized ? '\u25b2' : '\u25bc';
  ui.btnMinimize.title = nowMinimized ? 'Expand' : 'Collapse';
  ui.btnMinimize.setAttribute('aria-label', nowMinimized ? 'Expand' : 'Collapse');
  if (nowMinimized) {
    minimizedBar.appendChild(ui.card);
    if (SLEEP_ELIGIBLE.includes(ui.currentState)) {
      sleepSession(sessionId);
    }
  } else {
    container.appendChild(ui.card);
    if (ui.sleeping) wakeSession(sessionId);
    if (ui.needsWebGLReload) tryLoadWebGL(ui);
  }
  setMinimized(sessionId, nowMinimized);
}

// ── Minimize helpers (no toggle, no localStorage) ───────────

function _performMinimize(id, ui) {
  ui.card.classList.add('minimized');
  ui.btnMinimize.textContent = '\u25b2';
  ui.btnMinimize.title = 'Expand';
  ui.btnMinimize.setAttribute('aria-label', 'Expand');
  minimizedBar.appendChild(ui.card);
  setMinimized(id, true);
  if (SLEEP_ELIGIBLE.includes(ui.currentState)) {
    sleepSession(id);
  }
}

export function _applyExpandState(id, ui) {
  ui.card.classList.remove('minimized');
  if (ui.sleeping) wakeSession(id);
  ui.btnMinimize.textContent = '\u25bc';
  ui.btnMinimize.title = 'Collapse';
  ui.btnMinimize.setAttribute('aria-label', 'Collapse');
  setMinimized(id, false);
  if (ui.needsWebGLReload) tryLoadWebGL(ui);
}

export function _performExpand(id, ui) {
  container.appendChild(ui.card);
  _applyExpandState(id, ui);
}

// ── Sleep mode ──────────────────────────────────────────────

export function sleepSession(sessionId) {
  const ui = sessionUIs.get(sessionId);
  if (!ui || ui.sleeping) return;
  ui.sleeping = true;

  // Close data WebSocket — null ref BEFORE close so close handler skips reconnect
  if (ui.dataWs) {
    const ws = ui.dataWs;
    ui.dataWs = null;
    ws.close();
  }

  // Disconnect ResizeObserver
  if (ui.resizeObserver) {
    ui.resizeObserver.disconnect();
    ui.resizeObserver = null;
  }

  // Dispose WebGL addon (and drop it from the LRU so the cap frees a slot)
  releaseWebgl(ui);

  // Dispose xterm terminal
  if (ui.term) {
    ui.term.dispose();
    ui.term = null;
  }
  ui.fitAddon = null;
  ui.needsWebGLReload = false;

  // Clear input queue
  ui._inputQueue = [];

  // Tell server to pause pattern detection
  sendControlMsg({ type: 'sleep', id: sessionId });
}

export function wakeSession(sessionId) {
  const ui = sessionUIs.get(sessionId);
  if (!ui || !ui.sleeping) return;
  ui.sleeping = false;

  // Tell server to resume
  sendControlMsg({ type: 'wake', id: sessionId });

  // Recreate terminal
  setupTerminal(ui.termWrap, ui);

  // Rewire terminal I/O and connect data WS (triggers ring buffer replay)
  wireTerminalIO(ui, sessionId);
}

// ── Maximize mode ───────────────────────────────────────────

function _onOneShotAnim(card, animationName, cleanup) {
  const onEnd = (e) => {
    if (e.animationName !== animationName) return;
    card.removeEventListener('animationend', onEnd);
    cleanup();
  };
  card.addEventListener('animationend', onEnd);
}

function _applyMaximized(ui, sessionId) {
  ui.card.classList.add('maximized', 'entering');
  // Strip one-shot flourish class after it plays — keeps .maximized free of
  // animation property so continuous states (e.g. waiting-pulse) can resume.
  _onOneShotAnim(ui.card, 'maximize-in', () => ui.card.classList.remove('entering'));
  _setMaximizeButton(ui, true);
  _maximizedSession = sessionId;
}

function _setMaximizeButton(ui, maximized) {
  ui.btnMaximize.textContent = maximized ? '\u2716' : '\u26f6';
  ui.btnMaximize.title = maximized ? 'Exit full screen mode' : 'Enter full screen';
  ui.btnMaximize.setAttribute('aria-label', maximized ? 'Exit full screen' : 'Enter full screen');
}

function _swapMaximized(sessionId) {
  const oldUi = sessionUIs.get(_maximizedSession);
  const newUi = sessionUIs.get(sessionId);
  if (!newUi) return;

  if (oldUi && !oldUi.card.classList.contains('minimized')) {
    oldUi.card.classList.remove('maximized');
    _setMaximizeButton(oldUi, false);
    _performMinimize(_maximizedSession, oldUi);
    _preMaximizeSessions.add(_maximizedSession);
  }

  if (newUi.card.classList.contains('minimized')) {
    _performExpand(sessionId, newUi);
    _preMaximizeSessions.delete(sessionId);
  }

  _applyMaximized(newUi, sessionId);
}

export function toggleMaximize(sessionId) {
  if (_maximizedSession === sessionId) {
    exitMaximizeMode();
    return;
  }

  if (_maximizedSession) {
    _swapMaximized(sessionId);
    return;
  }

  const ui = sessionUIs.get(sessionId);
  if (!ui) return;

  _maximizedSession = sessionId;
  _preMaximizeSessions.clear();
  _preMaximizeOrder = Array.from(container.querySelectorAll('.session-card')).map(c => c.dataset.id);

  if (ui.card.classList.contains('minimized')) {
    _performExpand(sessionId, ui);
  }

  for (const [id, otherUi] of sessionUIs) {
    if (id === sessionId) continue;
    if (!otherUi.card.classList.contains('minimized')) {
      _performMinimize(id, otherUi);
      _preMaximizeSessions.add(id);
    }
  }

  _applyMaximized(ui, sessionId);
}

export function exitMaximizeMode() {
  if (!_maximizedSession) return;

  const ui = sessionUIs.get(_maximizedSession);
  if (ui) {
    ui.card.classList.remove('maximized');
    _setMaximizeButton(ui, false);
  }
  _maximizedSession = null;

  for (const id of _preMaximizeSessions) {
    const otherUi = sessionUIs.get(id);
    if (otherUi?.card.classList.contains('minimized')) {
      _performExpand(id, otherUi);
      otherUi.card.classList.add('restoring');
      _onOneShotAnim(otherUi.card, 'maximize-restore', () =>
        otherUi.card.classList.remove('restoring'),
      );
    }
  }
  _preMaximizeSessions.clear();

  for (const id of _preMaximizeOrder) {
    const otherUi = sessionUIs.get(id);
    if (otherUi && otherUi.card.parentElement === container) {
      container.appendChild(otherUi.card);
    }
  }
  _preMaximizeOrder = [];
}

// ── Split layout enforcement ─────────────────────────────────

function _getVisibleSessions() {
  const visible = [];
  for (const [id, ui] of sessionUIs) {
    if (!ui.card.classList.contains('minimized')) visible.push(id);
  }
  return visible;
}

function _enforceSplitLimit() {
  if (_currentLayout !== 'split') return;
  const visible = _getVisibleSessions();
  for (let i = SPLIT_MAX_VISIBLE; i < visible.length; i++) {
    const id = visible[i];
    const ui = sessionUIs.get(id);
    if (ui) {
      _performMinimize(id, ui);
      _preSplitSessions.add(id);
    }
  }
}

export function setLayoutMode(layout) {
  const prev = _currentLayout;
  _currentLayout = layout;

  if (layout === 'split' && prev !== 'split') {
    _preSplitSessions.clear();
    _enforceSplitLimit();
  } else if (layout !== 'split' && prev === 'split') {
    // Restore sessions that were auto-minimized by split mode
    for (const id of _preSplitSessions) {
      const ui = sessionUIs.get(id);
      if (ui?.card.classList.contains('minimized')) {
        _performExpand(id, ui);
      }
    }
    _preSplitSessions.clear();
  }
}

// ── C2: split-on-create encapsulation ───────────────────────
// Moves the inline split branch from createSessionCard so _currentLayout and
// _preSplitSessions stay private to this module.

export function enforceSplitOnCreate(sessionId, ui) {
  if (_currentLayout === 'split' && _getVisibleSessions().length > SPLIT_MAX_VISIBLE) {
    _performMinimize(sessionId, ui);
    _preSplitSessions.add(sessionId);
  }
}

// ── Session layout cleanup ───────────────────────────────────
// Called by removeSessionCard (lifecycle) so _preMaximizeSessions and
// _preSplitSessions stay private to this module.

export function forgetSessionLayout(sessionId) {
  _preMaximizeSessions.delete(sessionId);
  _preSplitSessions.delete(sessionId);
}
