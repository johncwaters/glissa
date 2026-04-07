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

// Terminal defaults — updated from server settings on connect
let _terminalScrollback = 5000;
let _terminalCursorBlink = false;

// ── State ────────────────────────────────────────────────────

const sessionUIs = new Map();

// ── DOM refs ─────────────────────────────────────────────────

const container = document.getElementById('sessions-container');
const minimizedBar = document.getElementById('minimized-bar');
const aggregateEl = document.getElementById('aggregate-status');

let _maximizedSession = null;
const _preMaximizeSessions = new Set(); // sessions auto-minimized by maximize

let _currentLayout = 'default';
const _preSplitSessions = new Set(); // sessions auto-minimized by split layout

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
  const canRestart = KILLABLE_STATES.includes(state) || RESTARTABLE_STATES.includes(state);
  ui.btnRestart.classList.toggle('visible', canRestart);
  // Rename and Remove are always available
  ui.btnRename.classList.add('visible');
  ui.btnRemove.classList.add('visible');
}

function connectDataWs(sessionId, ui, term) {
  const url = `ws://${location.host}/terminals/${encodeURIComponent(sessionId)}`;
  const ws = new WebSocket(url);
  ui.dataWs = ws;

  // Batch incoming WS messages and flush to xterm once per animation frame.
  // Without this, high-frequency PTY output (hundreds of small chunks/sec)
  // triggers a separate term.write() + render pass per message, starving
  // keyboard input processing and causing visible typing lag.
  let pendingData = '';
  let writeRafId = null;

  function flushWrites() {
    writeRafId = null;
    if (pendingData.length === 0) return;
    const data = pendingData;
    pendingData = '';
    term.write(data);
  }

  ws.addEventListener('message', (event) => {
    pendingData += event.data;
    if (writeRafId === null) {
      writeRafId = requestAnimationFrame(flushWrites);
    }
  });

  ws.addEventListener('close', () => {
    if (writeRafId !== null) {
      cancelAnimationFrame(writeRafId);
      writeRafId = null;
    }
    pendingData = '';
    // Only auto-reconnect if this ws is still the current one (not replaced by rename)
    if (ui.dataWs === ws) {
      ui.dataWs = null;
      setTimeout(() => {
        if (sessionUIs.has(sessionId)) {
          connectDataWs(sessionId, ui, term);
        }
      }, RECONNECT_DELAY_MS);
    }
  });

  ws.addEventListener('open', () => {
    // Clear terminal before replay to prevent duplicate content accumulation
    term.clear();
    const { cols, rows } = term;
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  });
}

let _localReorderPending = false;

function sendReorder() {
  _localReorderPending = true;
  const gridCards = [...container.querySelectorAll('.session-card')].map(c => c.dataset.id);
  const minCards = [...minimizedBar.querySelectorAll('.session-card')].map(c => c.dataset.id);
  const order = [...gridCards, ...minCards].filter(Boolean);
  sendControlMsg({ type: 'reorder-sessions', order });
}

// ── Card DOM builder ─────────────────────────────────────────

function buildCardDOM(sessionId, sessionName, initialState, options = {}) {
  const state = initialState || STATES.INITIALIZING;
  const card = el('div', 'session-card');
  card.dataset.id = sessionId;
  card.dataset.session = sessionName;
  card.dataset.state = state;
  if (options.skipPerms) card.dataset.skipPerms = '';

  // Header
  const header = el('div', 'session-card-header');

  const btnMinimize = el('span', 'btn-minimize', '\u25bc');
  btnMinimize.title = 'Collapse';

  const nameEl = el('span', 'session-name', sessionName);
  const badge = makeBadge(state);
  badge.classList.add('session-badge');
  const permsBadge = options.skipPerms ? el('span', 'perms-badge', 'YOLO') : null;
  if (permsBadge) permsBadge.title = 'Running with --dangerously-skip-permissions';
  const spacer = el('span', 'session-header-spacer');

  // Action buttons
  const actions = el('div', 'session-actions');

  const btnMaximize = el('button', 'btn-action btn-maximize visible', '\u26F6');
  btnMaximize.title = 'Enter full screen';

  // Overflow menu (Restart + Remove tucked away to prevent accidental clicks)
  const overflow = el('div', 'session-overflow');
  const btnOverflow = el('button', 'btn-action btn-overflow visible', '\u22ee');
  btnOverflow.title = 'More actions';
  const overflowMenu = el('div', 'session-overflow-menu');

  const btnRename = el('button', 'overflow-item overflow-rename', 'Rename');
  const btnRestart = el('button', 'overflow-item overflow-restart', 'Restart');
  const btnRemove = el('button', 'overflow-item overflow-remove', 'Remove');
  overflowMenu.append(btnRename, btnRestart, btnRemove);
  overflow.append(btnOverflow, overflowMenu);

  actions.append(btnMaximize, overflow);
  const headerChildren = [btnMinimize, nameEl, badge];
  if (permsBadge) headerChildren.push(permsBadge);
  headerChildren.push(spacer, actions);
  header.append(...headerChildren);

  const termWrap = el('div', 'terminal-wrap');

  card.append(header, termWrap);

  return { card, header, badge, nameEl, btnRename, btnRestart, btnRemove, btnMinimize, btnMaximize, btnOverflow, overflowMenu, termWrap };
}

// ── Minimize toggle ──────────────────────────────────────────

function toggleMinimize(sessionId) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  const isCurrentlyMinimized = ui.card.classList.contains('minimized');

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
  if (nowMinimized) {
    minimizedBar.appendChild(ui.card);
  } else {
    container.appendChild(ui.card);
    if (ui.needsWebGLReload) tryLoadWebGL(ui);
    requestAnimationFrame(() => ui.fitAddon.fit());
  }
  setMinimized(sessionId, nowMinimized);
}

// ── Minimize helpers (no toggle, no localStorage) ───────────

function _performMinimize(id, ui) {
  ui.card.classList.add('minimized');
  ui.btnMinimize.textContent = '\u25b2';
  ui.btnMinimize.title = 'Expand';
  minimizedBar.appendChild(ui.card);
  setMinimized(id, true);
}

function _performExpand(id, ui) {
  ui.card.classList.remove('minimized');
  ui.btnMinimize.textContent = '\u25bc';
  ui.btnMinimize.title = 'Collapse';
  container.appendChild(ui.card);
  setMinimized(id, false);
  if (ui.needsWebGLReload) tryLoadWebGL(ui);
  requestAnimationFrame(() => ui.fitAddon.fit());
}

// ── Maximize mode ───────────────────────────────────────────

function _applyMaximized(ui, sessionId) {
  ui.card.classList.add('maximized');
  ui.btnMaximize.textContent = '\u2716';
  ui.btnMaximize.title = 'Exit full screen mode';
  _maximizedSession = sessionId;
  requestAnimationFrame(() => ui.fitAddon.fit());
}

function _swapMaximized(sessionId) {
  const oldUi = sessionUIs.get(_maximizedSession);
  const newUi = sessionUIs.get(sessionId);
  if (!newUi) return;

  if (oldUi && !oldUi.card.classList.contains('minimized')) {
    oldUi.card.classList.remove('maximized');
    oldUi.btnMaximize.textContent = 'Full Screen';
    oldUi.btnMaximize.title = 'Enter full screen';
    _performMinimize(_maximizedSession, oldUi);
    _preMaximizeSessions.add(_maximizedSession);
  }

  if (newUi.card.classList.contains('minimized')) {
    _performExpand(sessionId, newUi);
    _preMaximizeSessions.delete(sessionId);
  }

  _applyMaximized(newUi, sessionId);
}

function toggleMaximize(sessionId) {
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
    ui.btnMaximize.textContent = '\u26F6';
    ui.btnMaximize.title = 'Enter full screen';
  }
  _maximizedSession = null;

  // Restore all auto-minimized sessions
  for (const id of _preMaximizeSessions) {
    const otherUi = sessionUIs.get(id);
    if (otherUi?.card.classList.contains('minimized')) {
      _performExpand(id, otherUi);
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

// ── Split layout enforcement ─────────────────────────────────

const SPLIT_MAX_VISIBLE = 2;

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

  const sessionId = _dragSource.card.dataset.id;
  _dragSource.card.classList.remove('minimized');
  _dragSource.btnMinimize.textContent = '\u25bc';
  _dragSource.btnMinimize.title = 'Collapse';
  container.appendChild(_dragSource.card);
  setMinimized(sessionId, false);
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
  const sessionId = _dragSource.card.dataset.id;
  _dragSource.card.classList.remove('minimized');
  _dragSource.btnMinimize.textContent = '\u25bc';
  _dragSource.btnMinimize.title = 'Collapse';

  if (target && target !== _dragSource.card) {
    container.insertBefore(_dragSource.card, before ? target : target.nextSibling);
  } else {
    container.appendChild(_dragSource.card);
  }

  setMinimized(sessionId, false);
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

function setupDragAndDrop(card, header, btnMinimize, sessionId) {
  card.draggable = false;
  let didDrag = false;

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('.session-actions')) return;
    if (_maximizedSession) return;
    didDrag = false;
    card.draggable = true;
  });

  header.addEventListener('mouseup', () => {
    if (!didDrag) card.draggable = false;
  });

  btnMinimize.addEventListener('click', () => {
    if (!didDrag) toggleMinimize(sessionId);
  });

  card.addEventListener('dragstart', (e) => {
    didDrag = true;
    _droppedOnZone = false;
    _dragSource = sessionUIs.get(sessionId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sessionId);
    card.classList.add('dragging');
    container.classList.add('drag-active');
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
    cursorBlink: _terminalCursorBlink,
    fontSize: 14,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Menlo', monospace",
    theme: getTerminalTheme(),
    scrollback: _terminalScrollback,
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

  // Clipboard: Ctrl+C copies selection; Ctrl+V lets browser paste flow through
  // xterm's paste event → onData (returning false skips xterm's key processing
  // so it won't emit a raw \x16, but the browser paste event still fires)
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (ctrl && ev.key === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      term.clearSelection();
      return false;
    }
    if (ctrl && ev.key === 'v') {
      return false;
    }
    // Ctrl+Backspace: send ESC+DEL so readline/bash deletes the previous word
    if (ctrl && ev.key === 'Backspace') {
      if (ui.dataWs?.readyState === WebSocket.OPEN) {
        ui.dataWs.send(JSON.stringify({ type: 'input', data: '\x1b\x7f' }));
      }
      return false;
    }
    return true;
  });

  requestAnimationFrame(() => fitAddon.fit());
}

// ── Card event wiring ────────────────────────────────────────

function startInlineRename(ui, sessionId) {
  // Guard: prevent double-invoke
  if (ui.nameEl.querySelector('.session-rename-input')) return;

  const nameEl = ui.nameEl;
  const oldName = nameEl.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = oldName;
  input.maxLength = 64;

  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const newName = input.value.trim();
    cleanup();
    if (!newName || newName === oldName) {
      nameEl.textContent = oldName;
      return;
    }
    // Check for duplicate name (not id — names are display labels)
    for (const [, other] of sessionUIs) {
      if (other !== ui && other.card.dataset.session === newName) {
        nameEl.textContent = oldName;
        showErrorToast(`Session "${newName}" already exists.`);
        return;
      }
    }
    sendControlMsg({ type: 'rename-session', id: sessionId, newName });
    nameEl.textContent = oldName; // server broadcast will apply the actual rename
  }

  function cancel() {
    cleanup();
    nameEl.textContent = oldName;
  }

  function cleanup() {
    input.removeEventListener('blur', commit);
    input.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', onKey);
}

// All closures capture sessionId (stable UUID). For mutable display name,
// read ui.card.dataset.session which is updated on rename.
function wireCardEvents(ui, sessionId) {
  ui.btnRename.addEventListener('click', () => {
    ui.overflowMenu.classList.remove('open');
    startInlineRename(ui, sessionId);
  });

  ui.nameEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    startInlineRename(ui, sessionId);
  });

  ui.btnRestart.addEventListener('click', () => {
    ui.overflowMenu.classList.remove('open');
    const type = KILLABLE_STATES.includes(ui.currentState) ? 'force-restart' : 'restart';
    sendControlMsg({ type, id: sessionId });
  });

  ui.btnRemove.addEventListener('click', () => {
    ui.overflowMenu.classList.remove('open');
    if (!confirm(`Remove session "${ui.card.dataset.session}"?`)) return;
    sendControlMsg({ type: 'remove-session', id: sessionId });
  });

  ui.btnOverflow.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const [, other] of sessionUIs) {
      if (other !== ui) other.overflowMenu.classList.remove('open');
    }
    ui.overflowMenu.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (!ui.overflowMenu.contains(e.target) && e.target !== ui.btnOverflow) {
      ui.overflowMenu.classList.remove('open');
    }
  }, { signal: ui.abortController.signal });

  ui.termWrap.addEventListener('mousedown', () => {
    if (ui.currentState === STATES.WAITING || ui.currentState === STATES.COMPLETE) {
      sendControlMsg({ type: 'dismiss', id: sessionId });
    }
  });

  ui.btnMaximize.addEventListener('click', () => {
    toggleMaximize(sessionId);
  });
}

function wireTerminalIO(ui, sessionId) {
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

  connectDataWs(sessionId, ui, ui.term);
}

// ── Public API ────────────────────────────────────────────────
// All public functions accept session `id` (stable UUID).

export function hasSession(id) {
  return sessionUIs.has(id);
}

export function hasSessionByName(name) {
  for (const [, ui] of sessionUIs) {
    if (ui.card.dataset.session === name) return true;
  }
  return false;
}

export function getSessionCount() {
  return sessionUIs.size;
}

export function reconnectDataWs(id) {
  const ui = sessionUIs.get(id);
  if (ui?.dataWs) {
    ui.dataWs.close(); // close triggers auto-reconnect via the close handler
  }
}

export function applyTerminalSettings(settings) {
  if (settings.scrollback != null) _terminalScrollback = settings.scrollback;
  if (settings.cursorBlink != null) _terminalCursorBlink = settings.cursorBlink;
  for (const [, ui] of sessionUIs) {
    if (!ui.term) continue;
    if (settings.scrollback != null) ui.term.options.scrollback = settings.scrollback;
    if (settings.cursorBlink != null) ui.term.options.cursorBlink = settings.cursorBlink;
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

export function createSessionCard(sessionId, sessionName, initialState, options = {}) {
  const dom = buildCardDOM(sessionId, sessionName, initialState, options);
  setupDragAndDrop(dom.card, dom.header, dom.btnMinimize, sessionId);
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
    btnOverflow: dom.btnOverflow,
    overflowMenu: dom.overflowMenu,
    termWrap: dom.termWrap,
    btnRename: dom.btnRename,
    btnRestart: dom.btnRestart,
    btnRemove: dom.btnRemove,
    abortController: new AbortController(),
    currentState: initialState || STATES.INITIALIZING,
  };
  sessionUIs.set(sessionId, ui);

  setupTerminal(dom.termWrap, ui);

  wireCardEvents(ui, sessionId);
  updateButtonVisibility(ui);

  wireTerminalIO(ui, sessionId);

  // Restore minimized state from localStorage
  if (isMinimized(sessionId)) toggleMinimize(sessionId);

  // In split mode, auto-minimize if already at limit
  if (_currentLayout === 'split' && _getVisibleSessions().length > SPLIT_MAX_VISIBLE) {
    _performMinimize(sessionId, ui);
    _preSplitSessions.add(sessionId);
  }

  updateAggregateStatus();
  return ui;
}

export function renameSessionCard(sessionId, newName) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  // Only update the display name — id stays the same, no re-keying needed
  ui.card.dataset.session = newName;
  ui.nameEl.textContent = newName;
}

export function removeSessionCard(sessionId) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;

  sessionUIs.delete(sessionId);
  if (_maximizedSession === sessionId) exitMaximizeMode();
  _preMaximizeSessions.delete(sessionId);
  _preSplitSessions.delete(sessionId);

  if (ui.abortController) ui.abortController.abort();
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

export function applyState(sessionId, state) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;

  const prevState = ui.currentState;
  ui.currentState = state;

  ui.badge.textContent = BADGE_LABELS[state] || state;
  ui.badge.dataset.state = state;
  ui.card.dataset.state = state;

  updateButtonVisibility(ui);

  if (state === STATES.WAITING && prevState !== STATES.WAITING) {
    if (isSoundEnabled()) playAlertSound(getSoundId());
  }

  const isEnding = state === STATES.DONE || state === STATES.FAILED;
  const wasActive = prevState !== STATES.DONE && prevState !== STATES.FAILED && prevState !== STATES.INITIALIZING;
  if (isEnding && wasActive) {
    ui.card.classList.remove('completion-flash');
    ui.card.offsetWidth;
    ui.card.classList.add('completion-flash');
    ui.card.addEventListener('animationend', () => ui.card.classList.remove('completion-flash'), { once: true });
    if (isSoundEnabled()) playAlertSound(getSoundId());
  }

  if (state === STATES.DONE || state === STATES.FAILED) {
    _handleEndedTransition(ui, wasActive, state);
  }

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

  for (const id of order) {
    const ui = sessionUIs.get(id);
    if (!ui?.card) continue;
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
