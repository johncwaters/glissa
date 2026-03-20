// ── Session card module ───────────────────────────────────────
// Owns session card DOM lifecycle, terminal setup, and per-session state.

import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
// Vite alias — resolves to shared/states.esm.js
import { BADGE_LABELS, KILLABLE_STATES, RESTARTABLE_STATES, STATES } from '/shared/states.mjs';
import { playAlertSound } from './alert-sound.js';
import { sendControlMsg } from './control-ws.js';
import { el } from './dom-helpers.js';
import { getTerminalTheme } from './theme.js';
import { getSoundId, isMinimized, isSoundEnabled, setMinimized } from './ui-prefs.js';

// ── Constants ────────────────────────────────────────────────

const RECONNECT_DELAY_MS = 3000;

// ── State ────────────────────────────────────────────────────

const sessionUIs = new Map();

// ── DOM refs ─────────────────────────────────────────────────

const container = document.getElementById('sessions-container');
const minimizedBar = document.getElementById('minimized-bar');
const aggregateEl = document.getElementById('aggregate-status');

let _maximizedSession = null;
let _preMaximizeSessions = new Set(); // sessions auto-minimized by maximize

// ── Helpers (private) ────────────────────────────────────────

function makeBadge(state) {
  const badge = el('span', 'state-badge');
  badge.dataset.state = state;
  badge.textContent = BADGE_LABELS[state] || state;
  return badge;
}

function tryLoadWebGL(ui) {
  try {
    if (ui.webglAddon) {
      ui.webglAddon.dispose();
      ui.webglAddon = null;
    }
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      ui.webglAddon = null;
      ui.needsWebGLReload = true;
    });
    ui.term.loadAddon(addon);
    ui.webglAddon = addon;
    ui.needsWebGLReload = false;
  } catch {
    ui.webglAddon = null;
    ui.needsWebGLReload = false;
  }
}

function updateButtonVisibility(ui) {
  const state = ui.currentState;
  ui.btnRestart.classList.toggle('visible', KILLABLE_STATES.includes(state) || RESTARTABLE_STATES.includes(state));
}

function connectDataWs(sessionName, ui, term) {
  const url = `ws://${location.host}/terminals/${encodeURIComponent(sessionName)}`;
  const ws = new WebSocket(url);
  ui.dataWs = ws;

  ws.addEventListener('message', (event) => term.write(event.data));

  ws.addEventListener('close', () => {
    ui.dataWs = null;
    setTimeout(() => {
      if (sessionUIs.has(sessionName)) {
        connectDataWs(sessionName, ui, term);
      }
    }, RECONNECT_DELAY_MS);
  });

  ws.addEventListener('open', () => {
    const { cols, rows } = term;
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  });
}

let _localReorderPending = false;

function sendReorder() {
  _localReorderPending = true;
  const gridCards = [...container.querySelectorAll('.session-card')].map(c => c.dataset.session);
  const minCards = [...minimizedBar.querySelectorAll('.session-card')].map(c => c.dataset.session);
  const order = [...gridCards, ...minCards].filter(Boolean);
  sendControlMsg({ type: 'reorder-sessions', order });
}

// ── Card DOM builder ─────────────────────────────────────────

function buildCardDOM(sessionName, initialState) {
  const state = initialState || STATES.INITIALIZING;
  const card = el('div', 'session-card');
  card.dataset.session = sessionName;
  card.dataset.state = state;

  // Header
  const header = el('div', 'session-card-header');

  const btnMinimize = el('span', 'btn-minimize', '\u25bc');
  btnMinimize.title = 'Minimize / Expand';

  const nameEl = el('span', 'session-name', sessionName);
  const badge = makeBadge(state);
  badge.classList.add('session-badge');
  const spacer = el('span', 'session-header-spacer');

  // Action buttons
  const actions = el('div', 'session-actions');

  const btnMaximize = el('button', 'btn-action btn-maximize visible', 'Maximize');
  btnMaximize.title = 'Maximize this session';

  const btnRestart = el('button', 'btn-action btn-restart', 'Restart');
  btnRestart.title = 'Restart this session';

  const btnRemove = el('button', 'btn-action btn-remove visible', 'Remove');
  btnRemove.title = 'Remove this session';

  actions.append(btnMaximize, btnRestart, btnRemove);
  header.append(btnMinimize, nameEl, badge, spacer, actions);

  const termWrap = el('div', 'terminal-wrap');

  card.append(header, termWrap);

  return { card, header, badge, nameEl, btnRestart, btnRemove, btnMinimize, btnMaximize, termWrap };
}

// ── Minimize toggle ──────────────────────────────────────────

function toggleMinimize(sessionName) {
  const ui = sessionUIs.get(sessionName);
  if (!ui) return;
  const isCurrentlyMinimized = ui.card.classList.contains('minimized');

  // In maximize mode: expanding a minimized session switches the maximized target
  if (_maximizedSession && isCurrentlyMinimized && sessionName !== _maximizedSession) {
    toggleMaximize(sessionName);
    return;
  }

  // Minimizing the maximized session exits maximize mode
  if (_maximizedSession && sessionName === _maximizedSession && !isCurrentlyMinimized) {
    exitMaximizeMode();
    return;
  }

  // Normal minimize/expand toggle
  const nowMinimized = ui.card.classList.toggle('minimized');
  ui.btnMinimize.textContent = nowMinimized ? '\u25b2' : '\u25bc';
  ui.btnMinimize.title = nowMinimized ? 'Expand' : 'Minimize';
  if (nowMinimized) {
    minimizedBar.appendChild(ui.card);
  } else {
    container.appendChild(ui.card);
    if (ui.needsWebGLReload) tryLoadWebGL(ui);
    requestAnimationFrame(() => ui.fitAddon.fit());
  }
  setMinimized(sessionName, nowMinimized);
}

// ── Minimize helpers (no toggle, no localStorage) ───────────

function _performMinimize(name, ui) {
  ui.card.classList.add('minimized');
  ui.btnMinimize.textContent = '\u25b2';
  ui.btnMinimize.title = 'Expand';
  minimizedBar.appendChild(ui.card);
  setMinimized(name, true);
}

function _performExpand(name, ui) {
  ui.card.classList.remove('minimized');
  ui.btnMinimize.textContent = '\u25bc';
  ui.btnMinimize.title = 'Minimize';
  container.appendChild(ui.card);
  setMinimized(name, false);
  if (ui.needsWebGLReload) tryLoadWebGL(ui);
  requestAnimationFrame(() => ui.fitAddon.fit());
}

// ── Maximize mode ───────────────────────────────────────────

function toggleMaximize(sessionName) {
  // Toggle off if already maximized on this session
  if (_maximizedSession === sessionName) {
    exitMaximizeMode();
    return;
  }

  // Swap: already maximized on a different session
  if (_maximizedSession) {
    const oldUi = sessionUIs.get(_maximizedSession);
    const newUi = sessionUIs.get(sessionName);
    if (!newUi) return;

    // Minimize old maximized session
    if (oldUi && !oldUi.card.classList.contains('minimized')) {
      oldUi.card.classList.remove('maximized');
      oldUi.btnMaximize.textContent = 'Maximize';
      oldUi.btnMaximize.title = 'Maximize this session';
      _performMinimize(_maximizedSession, oldUi);
      _preMaximizeSessions.add(_maximizedSession);
    }

    // Expand new session
    if (newUi.card.classList.contains('minimized')) {
      _performExpand(sessionName, newUi);
      _preMaximizeSessions.delete(sessionName);
    }

    newUi.card.classList.add('maximized');
    newUi.btnMaximize.textContent = 'Minimize';
    newUi.btnMaximize.title = 'Minimize all sessions';
    _maximizedSession = sessionName;
    requestAnimationFrame(() => newUi.fitAddon.fit());
    return;
  }

  // Enter maximize mode
  const ui = sessionUIs.get(sessionName);
  if (!ui) return;

  _maximizedSession = sessionName;
  _preMaximizeSessions.clear();

  // Expand the target if it's currently minimized
  if (ui.card.classList.contains('minimized')) {
    _performExpand(sessionName, ui);
  }

  // Minimize all other non-minimized sessions
  for (const [name, otherUi] of sessionUIs) {
    if (name === sessionName) continue;
    if (!otherUi.card.classList.contains('minimized')) {
      _performMinimize(name, otherUi);
      _preMaximizeSessions.add(name);
    }
  }

  ui.card.classList.add('maximized');
  ui.btnMaximize.textContent = 'Minimize';
  ui.btnMaximize.title = 'Minimize all sessions';
  requestAnimationFrame(() => ui.fitAddon.fit());
}

export function exitMaximizeMode() {
  if (!_maximizedSession) return;

  const ui = sessionUIs.get(_maximizedSession);
  if (ui) {
    ui.card.classList.remove('maximized');
    ui.btnMaximize.textContent = 'Maximize';
    ui.btnMaximize.title = 'Maximize this session';
  }
  _maximizedSession = null;

  // Restore all auto-minimized sessions
  for (const name of _preMaximizeSessions) {
    const otherUi = sessionUIs.get(name);
    if (otherUi && otherUi.card.classList.contains('minimized')) {
      _performExpand(name, otherUi);
    }
  }
  _preMaximizeSessions.clear();

  // Refit all visible terminals
  for (const [, u] of sessionUIs) {
    if (!u.card.classList.contains('minimized')) {
      requestAnimationFrame(() => { try { u.fitAddon.fit(); } catch {} });
    }
  }
}

export function isMaximizeActive() {
  return _maximizedSession !== null;
}

// ── Container-level drag-and-drop ────────────────────────────

let _dragSource = null;

function findDropTarget(x, y) {
  const allCards = [...container.querySelectorAll('.session-card')];
  const sourceCard = _dragSource ? _dragSource.card : null;

  let closest = null;
  let closestDist = Infinity;

  for (const card of allCards) {
    if (card === sourceCard || card === _dropZone) continue;
    const rect = card.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < closestDist) {
      closestDist = dist;
      closest = card;
    }
  }

  if (!closest) return { card: null, before: true };

  // DOM order = visual position in CSS grid.
  // When source is before target, removing source shifts target up,
  // so insert after target. When source is after, insert before.
  const sourceIdx = sourceCard ? allCards.indexOf(sourceCard) : -1;
  const targetIdx = allCards.indexOf(closest);
  return { card: closest, before: sourceIdx > targetIdx };
}

function clearDropIndicators() {
  for (const [, ui] of sessionUIs) {
    ui.card.classList.remove('drop-above', 'drop-below');
  }
}

// Drop-zone placeholder shown at the end of the grid when dragging from minimized bar
const _dropZone = document.createElement('div');
_dropZone.className = 'session-card drop-zone-placeholder';
_dropZone.innerHTML = '<div class="drop-zone-label">Drop here to expand</div>';
let _droppedOnZone = false;

function isFromMinimizedBar() {
  return _dragSource?.card.classList.contains('minimized');
}

function showDropZone() {
  if (!_dropZone.parentNode) container.appendChild(_dropZone);
}

function hideDropZone() {
  if (_dropZone.parentNode) _dropZone.remove();
}

// Track when hovering over the drop zone itself
_dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  clearDropIndicators();
  _dropZone.classList.add('drop-zone-active');
});

_dropZone.addEventListener('dragleave', () => {
  _dropZone.classList.remove('drop-zone-active');
});

_dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  _dropZone.classList.remove('drop-zone-active');
  _droppedOnZone = true;
  clearDropIndicators();
  hideDropZone();
  if (!_dragSource) return;

  const sessionName = _dragSource.card.dataset.session;
  _dragSource.card.classList.remove('minimized');
  _dragSource.btnMinimize.textContent = '\u25bc';
  _dragSource.btnMinimize.title = 'Minimize';
  container.appendChild(_dragSource.card);
  setMinimized(sessionName, false);
  if (_dragSource.needsWebGLReload) tryLoadWebGL(_dragSource);
  requestAnimationFrame(() => _dragSource.fitAddon.fit());
  sendReorder();
});

container.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropIndicators();
  if (isFromMinimizedBar()) showDropZone();
  _dropZone.classList.remove('drop-zone-active');
  const { card, before } = findDropTarget(e.clientX, e.clientY);
  if (card) card.classList.add(before ? 'drop-above' : 'drop-below');
});

container.addEventListener('dragleave', (e) => {
  if (!container.contains(e.relatedTarget)) {
    clearDropIndicators();
    hideDropZone();
  }
});

function restoreFromMinimizedBar(target, before) {
  const sessionName = _dragSource.card.dataset.session;
  _dragSource.card.classList.remove('minimized');
  _dragSource.btnMinimize.textContent = '\u25bc';
  _dragSource.btnMinimize.title = 'Minimize';

  if (target && target !== _dragSource.card) {
    container.insertBefore(_dragSource.card, before ? target : target.nextSibling);
  } else {
    container.appendChild(_dragSource.card);
  }

  setMinimized(sessionName, false);
  if (_dragSource.needsWebGLReload) tryLoadWebGL(_dragSource);
  requestAnimationFrame(() => _dragSource.fitAddon.fit());
}

container.addEventListener('drop', (e) => {
  e.preventDefault();
  clearDropIndicators();
  hideDropZone();
  if (!_dragSource || _droppedOnZone) { _droppedOnZone = false; return; }

  const { card, before } = findDropTarget(e.clientX, e.clientY);

  if (isFromMinimizedBar()) {
    restoreFromMinimizedBar(card, before);
  } else {
    if (!card || card === _dragSource.card) return;
    container.insertBefore(_dragSource.card, before ? card : card.nextSibling);
  }

  sendReorder();
});

function setupDragAndDrop(card, header, btnMinimize, sessionName) {
  card.draggable = false;
  let didDrag = false;

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('.session-actions')) return;
    if (_maximizedSession) return; // Disable drag during maximize mode
    didDrag = false;
    card.draggable = true;
  });

  header.addEventListener('mouseup', () => {
    if (!didDrag) card.draggable = false;
  });

  btnMinimize.addEventListener('click', () => {
    if (!didDrag) toggleMinimize(sessionName);
  });

  card.addEventListener('dragstart', (e) => {
    didDrag = true;
    _droppedOnZone = false;
    _dragSource = sessionUIs.get(sessionName);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sessionName);
    card.classList.add('dragging');
    container.classList.add('drag-active');
    // Show drop zone immediately when dragging from minimized bar
    if (card.classList.contains('minimized')) showDropZone();
  });

  card.addEventListener('dragend', () => {
    card.draggable = false;
    card.classList.remove('dragging');
    container.classList.remove('drag-active');
    clearDropIndicators();
    hideDropZone();
    _dragSource = null;
    for (const [, ui] of sessionUIs) {
      if (!ui.card.classList.contains('minimized')) {
        try { ui.fitAddon.fit(); } catch {}
      }
    }
  });
}

// ── Terminal setup ───────────────────────────────────────────

function setupTerminal(termWrap, ui) {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Menlo', monospace",
    theme: getTerminalTheme(),
    scrollback: 5000,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(termWrap);

  ui.term = term;
  ui.fitAddon = fitAddon;
  ui.webglAddon = null;
  ui.needsWebGLReload = false;

  // Try WebGL — fall back to canvas silently
  tryLoadWebGL(ui);

  // Clipboard: Ctrl+C (copy selection) / Ctrl+V (paste)
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (ctrl && ev.key === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      term.clearSelection();
      return false;
    }
    if (ctrl && ev.key === 'v') {
      navigator.clipboard.readText().then((text) => {
        if (text && ui.dataWs?.readyState === WebSocket.OPEN) {
          ui.dataWs.send(JSON.stringify({ type: 'input', data: text }));
        }
      }).catch(() => {});
      return false;
    }
    return true;
  });

  requestAnimationFrame(() => fitAddon.fit());
}

// ── Card event wiring ────────────────────────────────────────

function wireCardEvents(ui, sessionName) {
  ui.btnRestart.addEventListener('click', () => {
    const type = KILLABLE_STATES.includes(ui.currentState) ? 'force-restart' : 'restart';
    sendControlMsg({ type, session: sessionName });
  });

  ui.btnRemove.addEventListener('click', () => {
    if (!confirm(`Remove session "${sessionName}"?`)) return;
    sendControlMsg({ type: 'remove-session', session: sessionName });
  });

  // Click inside terminal clears notification status when WAITING or COMPLETE
  ui.termWrap.addEventListener('mousedown', () => {
    if (ui.currentState === STATES.WAITING || ui.currentState === STATES.COMPLETE) {
      sendControlMsg({ type: 'dismiss', session: sessionName });
    }
  });

  // Maximize button
  ui.btnMaximize.addEventListener('click', () => {
    toggleMaximize(sessionName);
  });

}

function wireTerminalIO(ui, sessionName) {
  ui.term.onData((data) => {
    if (ui.dataWs?.readyState === WebSocket.OPEN) {
      ui.dataWs.send(JSON.stringify({ type: 'input', data }));
    }
  });

  ui.term.onResize(({ cols, rows }) => {
    if (ui.dataWs?.readyState === WebSocket.OPEN) {
      ui.dataWs.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  connectDataWs(sessionName, ui, ui.term);
}

// ── Public API ────────────────────────────────────────────────

export function hasSession(name) {
  return sessionUIs.has(name);
}

export function getSessionCount() {
  return sessionUIs.size;
}

export function reconnectDataWs(name) {
  const ui = sessionUIs.get(name);
  if (ui?.dataWs) {
    ui.dataWs.close(); // close triggers auto-reconnect via the close handler
  }
}

export function fitAllVisible() {
  for (const [, ui] of sessionUIs) {
    if (!ui.card.classList.contains('minimized')) {
      ui.fitAddon.fit();
    }
  }
}

export function updateAggregateStatus() {
  let waiting = 0, failed = 0, done = 0, complete = 0, total = 0;

  for (const [, ui] of sessionUIs) {
    total++;
    const state = ui.currentState;
    if (state === STATES.WAITING) waiting++;
    else if (state === STATES.FAILED) failed++;
    else if (state === STATES.DONE) done++;
    else if (state === STATES.COMPLETE) complete++;
  }

  let text = '';
  let severity = '';
  const pl = (n) => n > 1 ? 's' : '';

  if (waiting > 0) {
    text = `${waiting} session${pl(waiting)} need input`;
    severity = 'warning';
  } else if (failed > 0) {
    text = `${failed} session${pl(failed)} failed`;
    severity = 'critical';
  } else if (complete > 0) {
    text = `${complete} session${pl(complete)} finished`;
    severity = 'done';
  } else if (total > 0 && done === total) {
    text = 'All sessions exited';
    severity = 'done';
  } else if (total > 0) {
    const active = total - done;
    text = `${active} session${pl(active)} running`;
    severity = 'success';
  }

  aggregateEl.textContent = text;
  aggregateEl.dataset.severity = severity;
  const alertCount = waiting + failed + complete;
  document.title = alertCount > 0 ? `(${alertCount}) Glissa` : 'Glissa';
}

export function createSessionCard(sessionName, initialState) {
  const dom = buildCardDOM(sessionName, initialState);
  setupDragAndDrop(dom.card, dom.header, dom.btnMinimize, sessionName);
  container.appendChild(dom.card);

  const ui = {
    term: null,
    fitAddon: null,
    webglAddon: null,
    needsWebGLReload: false,
    dataWs: null,
    card: dom.card,
    badge: dom.badge,
    nameEl: dom.nameEl,
    btnMinimize: dom.btnMinimize,
    btnMaximize: dom.btnMaximize,
    termWrap: dom.termWrap,
    btnRestart: dom.btnRestart,
    btnRemove: dom.btnRemove,
    currentState: initialState || STATES.INITIALIZING,
  };
  sessionUIs.set(sessionName, ui);

  setupTerminal(dom.termWrap, ui);

  wireCardEvents(ui, sessionName);
  updateButtonVisibility(ui);

  wireTerminalIO(ui, sessionName);

  // Restore minimized state from localStorage
  if (isMinimized(sessionName)) toggleMinimize(sessionName);

  updateAggregateStatus();
  return ui;
}

export function removeSessionCard(sessionName) {
  const ui = sessionUIs.get(sessionName);
  if (!ui) return;

  sessionUIs.delete(sessionName);
  // Clear maximize if this session was maximized
  if (_maximizedSession === sessionName) exitMaximizeMode();
  _preMaximizeSessions.delete(sessionName);

  if (ui.dataWs?.readyState <= WebSocket.OPEN) ui.dataWs.close();
  if (ui.term) ui.term.dispose();
  if (ui.card) ui.card.remove();
  updateAggregateStatus();
}

function _handleEndedTransition(ui, wasActive, state) {
  if (!wasActive) return;
  ui.term.clear();
  ui.term.reset();
  const label = state === STATES.DONE ? 'Session complete' : 'Session failed';
  const color = state === STATES.DONE ? '\x1b[34m' : '\x1b[31m';
  ui.term.write(`\r\n\x1b[2m${color}  ${label}\x1b[0m\r\n\r\n\x1b[2m  Press Restart to start a new session.\x1b[0m\r\n`);
}

function _handleRestartTransition(ui, prevState) {
  if (prevState === STATES.DONE || prevState === STATES.FAILED) {
    ui.term.clear();
    ui.term.reset();
  }
}

export function applyState(sessionName, state) {
  const ui = sessionUIs.get(sessionName);
  if (!ui) return;

  const prevState = ui.currentState;
  ui.currentState = state;

  ui.badge.textContent = BADGE_LABELS[state] || state;
  ui.badge.dataset.state = state;
  ui.card.dataset.state = state;

  updateButtonVisibility(ui);

  // Sound alert on WAITING transition
  if (state === STATES.WAITING && prevState !== STATES.WAITING) {
    if (isSoundEnabled()) playAlertSound(getSoundId());
  }

  // Completion: flash animation, sound, and browser notification
  const isEnding = state === STATES.DONE || state === STATES.FAILED;
  const wasActive = prevState !== STATES.DONE && prevState !== STATES.FAILED && prevState !== STATES.INITIALIZING;
  if (isEnding && wasActive) {
    // Glow flash (CSS animation)
    ui.card.classList.remove('completion-flash');
    void ui.card.offsetWidth; // reflow to restart animation
    ui.card.classList.add('completion-flash');
    ui.card.addEventListener('animationend', () => ui.card.classList.remove('completion-flash'), { once: true });

    // Sound alert on completion
    if (isSoundEnabled()) playAlertSound(getSoundId());
  }

  // Clear terminal and show placeholder when session ends
  if (state === STATES.DONE || state === STATES.FAILED) {
    _handleEndedTransition(ui, wasActive, state);
  }

  // Clear placeholder on restart
  if (state === STATES.INITIALIZING) {
    _handleRestartTransition(ui, prevState);
  }

  updateAggregateStatus();
}

export function handleSessionsReordered(order) {
  if (_localReorderPending) {
    _localReorderPending = false;
    return;
  }

  for (const name of order) {
    const ui = sessionUIs.get(name);
    if (!ui?.card) continue;
    // Keep minimized cards in the minimized bar
    if (ui.card.classList.contains('minimized')) {
      minimizedBar.appendChild(ui.card);
    } else {
      container.appendChild(ui.card);
    }
  }
  for (const [, ui] of sessionUIs) {
    if (ui.card.classList.contains('minimized')) {
      ui.needsWebGLReload = true;
    } else {
      tryLoadWebGL(ui);
      try { ui.fitAddon.fit(); } catch {}
    }
  }
}

export function showErrorToast(message) {
  const toast = el('div', 'error-toast', message);
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('transitionend', () => toast.remove());
  }, 4000);
}
