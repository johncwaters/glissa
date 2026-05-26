// ── Session card module ───────────────────────────────────────
// Owns session card DOM lifecycle, terminal setup, and per-session state.

import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
// Vite alias — resolves to shared/states.esm.js
import { BADGE_LABELS, KILLABLE_STATES, RESTARTABLE_STATES, STATE_GLYPHS, STATES } from '/shared/states.mjs';
import { playAlertSound } from './alert-sound.js';
import { sendControlMsg } from './control-ws.js';
import { el, escapeHtml } from './dom-helpers.js';
import { getTerminalTheme } from './theme.js';
import { getSoundId, isMinimized, isSoundEnabled, setMinimized } from './ui-prefs.js';

// ── Constants ────────────────────────────────────────────────

const RECONNECT_DELAY_MS = 500;
const INPUT_QUEUE_MAX = 1024;
const SLEEP_ELIGIBLE = [STATES.IDLE, STATES.COMPLETE, STATES.DONE, STATES.FAILED];

// Terminal defaults — updated from server settings on connect
let _terminalScrollback = 5000;
let _terminalCursorBlink = false;
let _debugMode = false;

// ── State ────────────────────────────────────────────────────

const sessionUIs = new Map();

// ── DOM refs ─────────────────────────────────────────────────

const container = document.getElementById('sessions-container');
const minimizedBar = document.getElementById('minimized-bar');
const aggregateEl = document.getElementById('aggregate-status');

let _maximizedSession = null;
const _preMaximizeSessions = new Set();
let _preMaximizeOrder = [];

let _currentLayout = 'default';
const _preSplitSessions = new Set(); // sessions auto-minimized by split layout

// ── Helpers (private) ────────────────────────────────────────

// Inline confirm dialog — avoids circular dep with dialogs.js.
function showConfirmDialog({ title, message, confirmLabel = 'Confirm', onConfirm }) {
  const opener = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog';

  const titleId = 'sc-confirm-' + Math.random().toString(36).slice(2);

  const titleEl = document.createElement('h3');
  titleEl.id = titleId;
  titleEl.className = 'dialog-title';
  titleEl.textContent = title;

  const msgEl = document.createElement('p');
  msgEl.className = 'dialog-message';
  msgEl.textContent = message;

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';

  const btnCancel = document.createElement('button');
  btnCancel.className = 'btn-dialog btn-dialog-cancel';
  btnCancel.textContent = 'Cancel';

  const btnConfirm = document.createElement('button');
  btnConfirm.className = 'btn-dialog btn-dialog-confirm';
  btnConfirm.textContent = confirmLabel;

  actions.append(btnCancel, btnConfirm);
  dialog.append(titleEl, msgEl, actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);

  // Focus trap
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  function close() {
    overlay.remove();
    opener?.focus?.();
  }

  btnCancel.addEventListener('click', close);
  btnConfirm.addEventListener('click', () => { close(); onConfirm?.(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
  });

  requestAnimationFrame(() => btnCancel.focus());
}

function makeBadge(state) {
  const badge = el('span', 'state-badge');
  badge.dataset.state = state;
  badge.classList.add('has-glyph');
  const glyph = STATE_GLYPHS[state] || '';
  badge.innerHTML = '';
  const glyphSpan = document.createElement('span');
  glyphSpan.className = 'state-glyph';
  glyphSpan.setAttribute('aria-hidden', 'true');
  glyphSpan.textContent = glyph;
  badge.appendChild(glyphSpan);
  badge.appendChild(document.createTextNode(BADGE_LABELS[state] || state));
  return badge;
}

// atob returns a binary string; walk the bytes through TextDecoder so
// non-ASCII payloads survive the OSC 52 round-trip.
function decodeOsc52Payload(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function reportClipboardFailure(source, err) {
  const msg = err?.message || String(err);
  console.error(`[clipboard:${source}]`, err);
  showErrorToast(`Clipboard ${source} failed: ${msg}`);
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

  // Flush PTY output to xterm via microtask (near-zero delay for keystroke
  // echoes) with a circuit breaker that escalates to RAF during heavy
  // output bursts to prevent main-thread starvation.
  let pendingData = '';
  let flushScheduled = false;
  let writeRafId = null;

  // Circuit breaker: after 8 writes within 16ms, escalate to RAF.
  const WRITE_RATE_LIMIT = 8;
  let writeCount = 0;
  let rateLimited = false;
  let rateResetTimer = null;

  function flushWrites() {
    flushScheduled = false;
    writeRafId = null;
    if (pendingData.length === 0) return;

    const data = pendingData;
    pendingData = '';

    writeCount++;
    if (rateResetTimer === null) {
      rateResetTimer = setTimeout(() => { writeCount = 0; rateResetTimer = null; }, 16);
    }
    if (writeCount >= WRITE_RATE_LIMIT) {
      rateLimited = true;
    }

    term.write(data);
  }

  function flushViaRaf() {
    rateLimited = false;
    flushWrites();
  }

  ws.addEventListener('message', (event) => {
    pendingData += event.data;
    if (flushScheduled || writeRafId !== null) return;

    // Small messages are likely keystroke echoes (1-3 bytes); microtask keeps echo latency low.
    const isSmallWrite = pendingData.length <= 8;
    if (rateLimited && !isSmallWrite) {
      writeRafId = requestAnimationFrame(flushViaRaf);
    } else {
      flushScheduled = true;
      queueMicrotask(flushWrites);
    }
  });

  ws.addEventListener('close', () => {
    if (writeRafId !== null) {
      cancelAnimationFrame(writeRafId);
      writeRafId = null;
    }
    if (rateResetTimer !== null) {
      clearTimeout(rateResetTimer);
      rateResetTimer = null;
    }
    flushScheduled = false;
    rateLimited = false;
    writeCount = 0;
    pendingData = '';
    // Only auto-reconnect if this ws is still the current one (not replaced by rename)
    // Skip reconnect when sleeping — wakeSession() will reconnect on expand
    if (ui.dataWs === ws) {
      ui.dataWs = null;
      if (!ui.sleeping) {
        setTimeout(() => {
          if (sessionUIs.has(sessionId)) {
            connectDataWs(sessionId, ui, term);
          }
        }, RECONNECT_DELAY_MS);
      }
    }
  });

  ws.addEventListener('open', () => {
    // Clear terminal before replay to prevent duplicate content accumulation
    term.clear();
    // Push the current size to the PTY on every (re)connect so it can't
    // drift out of sync with the browser after a disconnect. Reset the cache
    // first so the send isn't skipped when cols/rows match the last value.
    ui._resetResizeCache?.();
    ui._applyFit?.();

    // Flush any keystrokes queued during disconnect.
    // Delay 50ms to let the server replay buffer arrive first.
    if (ui._inputQueue && ui._inputQueue.length > 0) {
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (const data of ui._inputQueue) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
        ui._inputQueue.length = 0;
      }, 50);
    }
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
  btnMinimize.setAttribute('aria-label', 'Collapse');

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
  btnMaximize.setAttribute('aria-label', 'Enter full screen');

  // Overflow menu (Restart + Remove tucked away to prevent accidental clicks)
  const overflow = el('div', 'session-overflow');
  const btnOverflow = el('button', 'btn-action btn-overflow visible', '\u22ee');
  btnOverflow.title = 'More actions';
  btnOverflow.setAttribute('aria-label', 'More actions');
  btnOverflow.setAttribute('aria-haspopup', 'menu');
  btnOverflow.setAttribute('aria-expanded', 'false');
  const overflowMenu = el('div', 'session-overflow-menu');
  overflowMenu.setAttribute('role', 'menu');

  const btnRename = el('button', 'overflow-item overflow-rename', 'Rename');
  btnRename.setAttribute('role', 'menuitem');
  const btnRestart = el('button', 'overflow-item overflow-restart', 'Restart');
  btnRestart.setAttribute('role', 'menuitem');
  const btnRemove = el('button', 'overflow-item overflow-remove', 'Remove');
  btnRemove.setAttribute('role', 'menuitem');
  overflowMenu.append(btnRename, btnRestart, btnRemove);
  overflow.append(btnOverflow, overflowMenu);

  const btnDebug = el('button', 'btn-action btn-debug', '\u2699');
  btnDebug.title = 'Debug state';
  btnDebug.setAttribute('aria-label', 'Debug session state');

  actions.append(btnDebug, btnMaximize, overflow);
  const headerChildren = [btnMinimize, nameEl, badge];
  if (permsBadge) headerChildren.push(permsBadge);
  headerChildren.push(spacer, actions);
  header.append(...headerChildren);

  const termWrap = el('div', 'terminal-wrap');

  card.append(header, termWrap);

  return { card, header, badge, nameEl, btnRename, btnRestart, btnRemove, btnMinimize, btnMaximize, btnDebug, btnOverflow, overflowMenu, termWrap };
}

// ── Minimize toggle ──────────────────────────────────────────

function toggleMinimize(sessionId) {
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

function _applyExpandState(id, ui) {
  ui.card.classList.remove('minimized');
  if (ui.sleeping) wakeSession(id);
  ui.btnMinimize.textContent = '\u25bc';
  ui.btnMinimize.title = 'Collapse';
  ui.btnMinimize.setAttribute('aria-label', 'Collapse');
  setMinimized(id, false);
  if (ui.needsWebGLReload) tryLoadWebGL(ui);
}

function _performExpand(id, ui) {
  container.appendChild(ui.card);
  _applyExpandState(id, ui);
}

// ── Sleep mode ──────────────────────────────────────────────

function sleepSession(sessionId) {
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

  // Dispose WebGL addon
  if (ui.webglAddon) {
    ui.webglAddon.dispose();
    ui.webglAddon = null;
  }

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

function wakeSession(sessionId) {
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

// Cached card rects for drag operations — avoids layout thrashing on every dragover
let _dragRectCache = null;

function snapshotDragRects() {
  const allCards = [...container.querySelectorAll('.session-card')];
  _dragRectCache = allCards.map(card => ({ card, rect: card.getBoundingClientRect() }));
}

function invalidateDragRects() {
  _dragRectCache = null;
}

function findDropTarget(x, y) {
  if (!_dragRectCache) snapshotDragRects();
  const sourceCard = _dragSource ? _dragSource.card : null;

  let closest = null;
  let closestDist = Infinity;
  let sourceIdx = -1;
  let targetIdx = -1;

  for (let i = 0; i < _dragRectCache.length; i++) {
    const { card, rect } = _dragRectCache[i];
    if (card === sourceCard) { sourceIdx = i; continue; }
    if (card === _dropZone) continue;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < closestDist) {
      closestDist = dist;
      closest = card;
      targetIdx = i;
    }
  }

  if (!closest) return { card: null, before: true };
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
  if (!_dropZone.parentNode) {
    container.appendChild(_dropZone);
    invalidateDragRects();
  }
}

function hideDropZone() {
  if (_dropZone.parentNode) {
    _dropZone.remove();
    invalidateDragRects();
  }
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
  container.appendChild(_dragSource.card);
  _applyExpandState(sessionId, _dragSource);
  sendReorder();
});

let _dragoverRafId = null;

container.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (_dragoverRafId !== null) return;
  const cx = e.clientX, cy = e.clientY;
  _dragoverRafId = requestAnimationFrame(() => {
    _dragoverRafId = null;
    clearDropIndicators();
    if (isFromMinimizedBar()) showDropZone();
    _dropZone.classList.remove('drop-zone-active');
    const { card, before } = findDropTarget(cx, cy);
    if (card) card.classList.add(before ? 'drop-above' : 'drop-below');
  });
});

container.addEventListener('dragleave', (e) => {
  if (!container.contains(e.relatedTarget)) {
    clearDropIndicators();
    hideDropZone();
  }
});

function restoreFromMinimizedBar(target, before) {
  const sessionId = _dragSource.card.dataset.id;

  if (target && target !== _dragSource.card) {
    container.insertBefore(_dragSource.card, before ? target : target.nextSibling);
  } else {
    container.appendChild(_dragSource.card);
  }

  _applyExpandState(sessionId, _dragSource);
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
    snapshotDragRects();
    if (card.classList.contains('minimized')) showDropZone();
  });

  card.addEventListener('dragend', () => {
    card.draggable = false;
    card.classList.remove('dragging');
    container.classList.remove('drag-active');
    if (_dragoverRafId !== null) {
      cancelAnimationFrame(_dragoverRafId);
      _dragoverRafId = null;
    }
    clearDropIndicators();
    hideDropZone();
    _dragSource = null;
    invalidateDragRects();
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

  // termWrap size → fit → push resize to PTY. RAF-coalesces burst fires
  // (window drag, maximize transition). The explicit send below the fit
  // covers the case where fit() proposes the same cols/rows xterm already
  // has (no onResize event) but the PTY hasn't caught up yet — most often
  // on first connect, where term starts at the default 80x24.
  let fitRafId = null;
  let lastSentCols = 0;
  let lastSentRows = 0;
  let lastFittedCols = 0;
  let lastFittedRows = 0;
  function applyFit() {
    fitRafId = null;
    if (!ui.fitAddon || !ui.term) return;
    if (ui.card.classList.contains('minimized')) return;
    ui.fitAddon.fit();
    const { cols, rows } = ui.term;
    // When the buffer reflows after a dimension change, the WebGL renderer
    // can leave stale glyphs in cells that shifted (visible as ghost text
    // fragments at the left edge after window resize). clearTextureAtlas
    // invalidates the cached glyph atlas and triggers a full redraw.
    if (cols !== lastFittedCols || rows !== lastFittedRows) {
      ui.webglAddon?.clearTextureAtlas?.();
      lastFittedCols = cols;
      lastFittedRows = rows;
    }
    if (cols === lastSentCols && rows === lastSentRows) return;
    if (ui.dataWs?.readyState !== WebSocket.OPEN) return;
    ui.dataWs.send(JSON.stringify({ type: 'resize', cols, rows }));
    lastSentCols = cols;
    lastSentRows = rows;
  }
  const resizeObserver = new ResizeObserver(() => {
    if (fitRafId !== null) return;
    fitRafId = requestAnimationFrame(applyFit);
  });
  resizeObserver.observe(termWrap);
  ui.resizeObserver = resizeObserver;
  ui._applyFit = applyFit;
  // Reset the lastSent cache so the next _applyFit unconditionally pushes —
  // used on data-WS (re)connect, where the server-side PTY may have just
  // respawned and needs the current size even if the browser-side cols/rows
  // haven't changed.
  ui._resetResizeCache = () => { lastSentCols = 0; lastSentRows = 0; };

  // First-render fit: xterm's FitAddon silently no-ops if it's called before
  // the renderer has measured a cell, so the initial ResizeObserver fire can
  // leave the terminal stuck at the default 80×24. Re-fit once on first
  // render when the cell dimensions are guaranteed to be measurable.
  const firstRender = term.onRender(() => {
    firstRender.dispose();
    applyFit();
  });

  // Try WebGL — fall back to canvas silently
  tryLoadWebGL(ui);

  // Redraw all visible rows on scroll. RAF-coalesced so a burst of wheel
  // events still costs one refresh per frame.
  let scrollRafId = null;
  term.onScroll(() => {
    if (scrollRafId !== null) return;
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      if (!ui.term) return;
      ui.term.refresh(0, ui.term.rows - 1);
    });
  });

  // OSC 52: programs inside the terminal (e.g. Claude CLI) request the
  // emulator to write to the system clipboard via \x1b]52;c;<base64>\x07.
  // xterm.js has no built-in handler, so register one here. Payload format
  // is "<targets>;<base64>" where targets is "c" (clipboard) or "p"
  // (primary X11 selection) etc. — we accept any target and write once.
  term.parser.registerOscHandler(52, (data) => {
    const semi = data.indexOf(';');
    if (semi < 0) return true;
    const payload = data.slice(semi + 1);
    if (payload === '' || payload === '?') return true; // ignore read queries
    let text;
    try {
      text = decodeOsc52Payload(payload);
    } catch (err) {
      reportClipboardFailure('osc52 decode', err);
      return true;
    }
    navigator.clipboard.writeText(text).catch((err) => {
      reportClipboardFailure('osc52 write', err);
    });
    return true;
  });

  // Clipboard: Ctrl+C copies selection; Ctrl+V lets browser paste flow through
  // xterm's paste event → onData (returning false skips xterm's key processing
  // so it won't emit a raw \x16, but the browser paste event still fires)
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (ctrl && ev.key === 'c' && term.hasSelection()) {
      const selection = term.getSelection();
      term.clearSelection();
      navigator.clipboard.writeText(selection).catch((err) => {
        reportClipboardFailure('copy', err);
      });
      return false;
    }
    if (ctrl && ev.key === 'v') {
      return false;
    }
    // Ctrl+Backspace: send ESC+DEL so readline/bash deletes the previous word
    if (ctrl && ev.key === 'Backspace') {
      if (ui.dataWs?.readyState === WebSocket.OPEN) {
        ui.dataWs.send(JSON.stringify({ type: 'input', data: '\x1b\x7f' }));
      } else if (ui._inputQueue && ui._inputQueue.length < INPUT_QUEUE_MAX) {
        ui._inputQueue.push('\x1b\x7f');
      }
      return false;
    }
    return true;
  });

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

// ── Debug overlay ────────────────────────────────────────────

const DEBUG_CLOSE_BTN = '<button type="button" class="debug-close" aria-label="Close debug overlay" title="Close">×</button>';

function formatTimestamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderDebugOverlay(ui, payload) {
  if (!ui.debugOverlay) return;
  const p = payload;

  let html = DEBUG_CLOSE_BTN;
  html += `<div class="debug-section"><div class="debug-section-title">State</div>`;
  html += `<div class="debug-field"><span class="debug-label">Current:</span> <span class="debug-value">${escapeHtml(p.state)}</span></div>`;
  html += `</div>`;

  // Transitions
  html += `<div class="debug-section"><div class="debug-section-title">Transitions (last ${p.transitions.length})</div>`;
  if (p.transitions.length === 0) {
    html += `<div class="debug-field debug-dim">No transitions recorded</div>`;
  } else {
    for (const t of p.transitions) {
      const detail = t.detail ? ` <span class="debug-dim">${typeof t.detail === 'object' ? (t.detail.layer ? `L${t.detail.layer}` : '') : ''}</span>` : '';
      html += `<div class="debug-field"><span class="debug-dim">${formatTimestamp(t.timestamp)}</span> ${escapeHtml(t.from)} → ${escapeHtml(t.to)} <span class="debug-label">${escapeHtml(t.event)}</span>${detail}</div>`;
    }
  }
  html += `</div>`;

  // Pattern detector
  const pd = p.patternDetector;
  html += `<div class="debug-section"><div class="debug-section-title">Pattern Detector</div>`;
  html += `<div class="debug-field"><span class="debug-label">Last layer:</span> <span class="debug-value">${pd.lastLayer ?? 'none'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Last match:</span> <span class="debug-value debug-mono">${pd.lastMatchedLine ? escapeHtml(truncate(pd.lastMatchedLine, 60)) : 'none'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Armed:</span> <span class="debug-value">${pd.armed ? `L${pd.armed.layer}` : 'no'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Confirm timer:</span> <span class="debug-value">${pd.confirmTimerActive ? 'active' : 'off'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Silence timer:</span> <span class="debug-value">${pd.silenceTimerActive ? 'active' : 'off'}</span></div>`;
  if (pd.pendingLine) {
    html += `<div class="debug-field"><span class="debug-label">Pending:</span> <span class="debug-value debug-mono">${escapeHtml(truncate(pd.pendingLine, 60))}</span></div>`;
  }
  html += `</div>`;

  // Timers
  const tm = p.timers;
  html += `<div class="debug-section"><div class="debug-section-title">Timers</div>`;
  html += `<div class="debug-field"><span class="debug-label">Auto-recover count:</span> <span class="debug-value">${tm.autoRecoverDataCount}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Auto-recover timer:</span> <span class="debug-value">${tm.autoRecoverTimerActive ? 'active' : 'off'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Idle timer:</span> <span class="debug-value">${tm.idleTimerActive ? 'active' : 'off'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Startup grace:</span> <span class="debug-value">${tm.startupGraceActive ? 'active' : 'off'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Sleeping:</span> <span class="debug-value">${tm.sleeping ? 'yes' : 'no'}</span></div>`;
  html += `</div>`;

  ui.debugOverlay.innerHTML = html;
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function openDebugOverlay(ui, sessionId) {
  if (ui.debugOpen) { closeDebugOverlay(ui); return; }

  const overlay = document.createElement('div');
  overlay.className = 'debug-overlay';
  overlay.innerHTML = DEBUG_CLOSE_BTN + '<div class="debug-field debug-dim">Loading...</div>';
  ui.card.appendChild(overlay);
  ui.debugOverlay = overlay;
  ui.debugOpen = true;

  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('.debug-close')) closeDebugOverlay(ui);
  });

  sendControlMsg({ type: 'debug-state', id: sessionId });
}

function closeDebugOverlay(ui) {
  if (ui.debugOverlay) {
    ui.debugOverlay.remove();
    ui.debugOverlay = null;
  }
  ui.debugOpen = false;
}

function updateDebugVisibility() {
  for (const [, ui] of sessionUIs) {
    ui.btnDebug.classList.toggle('visible', _debugMode);
    if (!_debugMode && ui.debugOpen) closeDebugOverlay(ui);
  }
}

// ── Card event wiring ────────────────────────────────────────

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
    showConfirmDialog({
      title: 'Remove Session',
      message: `Remove session "${ui.card.dataset.session}"?`,
      confirmLabel: 'Remove',
      onConfirm: () => sendControlMsg({ type: 'remove-session', id: sessionId }),
    });
  });

  ui.btnOverflow.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const [, other] of sessionUIs) {
      if (other !== ui) {
        other.overflowMenu.classList.remove('open');
        other.btnOverflow.setAttribute('aria-expanded', 'false');
      }
    }
    const nowOpen = ui.overflowMenu.classList.toggle('open');
    ui.btnOverflow.setAttribute('aria-expanded', String(nowOpen));
  });

  document.addEventListener('click', (e) => {
    if (!ui.overflowMenu.contains(e.target) && e.target !== ui.btnOverflow) {
      ui.overflowMenu.classList.remove('open');
      ui.btnOverflow.setAttribute('aria-expanded', 'false');
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

  ui.btnDebug.addEventListener('click', (e) => {
    e.stopPropagation();
    openDebugOverlay(ui, sessionId);
  });

  // Close debug overlay on click outside the card
  document.addEventListener('click', (e) => {
    if (ui.debugOpen && !ui.card.contains(e.target)) {
      closeDebugOverlay(ui);
    }
  }, { signal: ui.abortController.signal });
}

function wireTerminalIO(ui, sessionId) {
  // Queue keystrokes during WebSocket disconnection for replay on reconnect
  ui._inputQueue = [];

  ui.term.onData((data) => {
    if (ui.dataWs?.readyState === WebSocket.OPEN) {
      ui.dataWs.send(JSON.stringify({ type: 'input', data }));
    } else if (ui._inputQueue.length < INPUT_QUEUE_MAX) {
      ui._inputQueue.push(data);
    }
  });

  // Note: term.onResize is intentionally not wired — the ResizeObserver
  // path in setupTerminal owns all "fit and notify server" duties via
  // ui._applyFit, which both fits and pushes cols/rows to the PTY.

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

/**
 * True when `name` is exactly `baseName` or matches `baseName (N)` where N
 * is a positive integer suffix produced by `suggestSessionName`. Excludes
 * unrelated parenthetical names like `Foo (legacy)`.
 */
function isAutoNameOf(name, baseName) {
  if (name === baseName) return true;
  const prefix = `${baseName} (`;
  if (!name.startsWith(prefix) || !name.endsWith(')')) return false;
  const inner = name.slice(prefix.length, -1);
  return /^\d+$/.test(inner);
}

/** Count sessions whose display name is `baseName` or `baseName (N)`. */
export function countSessionsByName(baseName) {
  let n = 0;
  for (const [, ui] of sessionUIs) {
    if (isAutoNameOf(ui.card.dataset.session, baseName)) n++;
  }
  return n;
}

/**
 * Return the first free name in the sequence `baseName`, `baseName (2)`,
 * `baseName (3)`, ... so users can spawn multiple terminals on one project.
 * Bounded by 999 to keep the suffix within the 64-char server name limit.
 */
export function suggestSessionName(baseName) {
  if (!hasSessionByName(baseName)) return baseName;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${baseName} (${i})`;
    if (!hasSessionByName(candidate)) return candidate;
  }
  return `${baseName} (${Date.now()})`;
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
  if (settings.debugMode != null) {
    _debugMode = !!settings.debugMode;
    updateDebugVisibility();
  }
  for (const [, ui] of sessionUIs) {
    if (!ui.term) continue;
    if (settings.scrollback != null) ui.term.options.scrollback = settings.scrollback;
    if (settings.cursorBlink != null) ui.term.options.cursorBlink = settings.cursorBlink;
  }
}

export function handleDebugStateResponse(msg) {
  const ui = sessionUIs.get(msg.id);
  if (!ui || !ui.debugOpen) return;
  renderDebugOverlay(ui, msg.payload);
}

export function handleDebugStateRefresh(sessionId) {
  const ui = sessionUIs.get(sessionId);
  if (!ui || !ui.debugOpen) return;
  sendControlMsg({ type: 'debug-state', id: sessionId });
}

export function updateAggregateStatus() {
  let waiting = 0, failed = 0, done = 0, complete = 0, dormant = 0, total = 0;

  for (const [, ui] of sessionUIs) {
    total++;
    const state = ui.currentState;
    if (state === STATES.WAITING) waiting++;
    else if (state === STATES.FAILED) failed++;
    else if (state === STATES.DONE) done++;
    else if (state === STATES.COMPLETE) complete++;
    else if (state === STATES.DORMANT) dormant++;
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
  } else if (total > 0 && dormant === total) {
    text = `${dormant} session${pl(dormant)} dormant`;
    severity = '';
  } else if (total > 0) {
    const active = total - done - dormant;
    text = `${active} session${pl(active)} running`;
    severity = 'success';
  }

  aggregateEl.textContent = text;
  aggregateEl.dataset.severity = severity;
  const alertCount = waiting + failed + complete;
  document.title = alertCount > 0 ? `(${alertCount}) Glissa` : 'Glissa';
}

export function createSessionCard(sessionId, sessionName, initialState, options = {}) {
  const state = initialState || STATES.DORMANT;
  const dom = buildCardDOM(sessionId, sessionName, state, options);
  setupDragAndDrop(dom.card, dom.header, dom.btnMinimize, sessionId);

  const isDormant = state === STATES.DORMANT;

  // Dormant cards live in the minimized bar with no terminal and no data WS
  // until the user expands them, which sends start-session and triggers spawn.
  if (isDormant) {
    dom.card.classList.add('minimized');
    dom.btnMinimize.textContent = '▲';
    dom.btnMinimize.title = 'Start session';
    dom.btnMinimize.setAttribute('aria-label', 'Start session');
    minimizedBar.appendChild(dom.card);
  } else {
    container.appendChild(dom.card);
  }

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
    btnDebug: dom.btnDebug,
    btnRename: dom.btnRename,
    btnRestart: dom.btnRestart,
    btnRemove: dom.btnRemove,
    debugOverlay: null,
    debugOpen: false,
    abortController: new AbortController(),
    currentState: state,
    sleeping: false,
  };
  sessionUIs.set(sessionId, ui);

  wireCardEvents(ui, sessionId);
  updateButtonVisibility(ui);

  if (!isDormant) {
    setupTerminal(dom.termWrap, ui);
    wireTerminalIO(ui, sessionId);

    // Restore minimized state from localStorage
    if (isMinimized(sessionId)) toggleMinimize(sessionId);

    // In split mode, auto-minimize if already at limit
    if (_currentLayout === 'split' && _getVisibleSessions().length > SPLIT_MAX_VISIBLE) {
      _performMinimize(sessionId, ui);
      _preSplitSessions.add(sessionId);
    }
  }

  updateAggregateStatus();
  return ui;
}

// First-time terminal setup for cards that started life as DORMANT.
function ensureTerminalSetup(ui, sessionId) {
  if (ui.term) return;
  setupTerminal(ui.termWrap, ui);
  wireTerminalIO(ui, sessionId);
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

  closeDebugOverlay(ui);
  sessionUIs.delete(sessionId);
  if (_maximizedSession === sessionId) exitMaximizeMode();
  _preMaximizeSessions.delete(sessionId);
  _preSplitSessions.delete(sessionId);

  if (ui.resizeObserver) ui.resizeObserver.disconnect();
  if (ui.abortController) ui.abortController.abort();
  if (ui.dataWs?.readyState <= WebSocket.OPEN) ui.dataWs.close();
  if (ui.term) ui.term.dispose();
  if (ui.card) ui.card.remove();
  updateAggregateStatus();
}

function _handleEndedTransition(ui, wasActive, state) {
  if (!wasActive || !ui.term) return;
  ui.term.clear();
  ui.term.reset();
  const label = state === STATES.DONE ? 'Session complete' : 'Session failed';
  const color = state === STATES.DONE ? '\x1b[34m' : '\x1b[31m';
  ui.term.write(`\r\n\x1b[2m${color}  ${label}\x1b[0m\r\n\r\n\x1b[2m  Press Restart to start a new session.\x1b[0m\r\n`);
}

function _handleRestartTransition(ui, prevState) {
  if (!ui.term) return;
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

  // Leaving DORMANT: lazy-set up the terminal and promote the card from
  // the minimized bar to the main grid (if not already done optimistically).
  if (prevState === STATES.DORMANT && state !== STATES.DORMANT) {
    ensureTerminalSetup(ui, sessionId);
    if (ui.card.classList.contains('minimized')) {
      _performExpand(sessionId, ui);
    }
  }

  // Preserve the glyph span; only update its text and the sibling label text node.
  ui.badge.dataset.state = state;
  const glyphSpan = ui.badge.querySelector('.state-glyph');
  if (glyphSpan) {
    glyphSpan.textContent = STATE_GLYPHS[state] || '';
    const labelNode = glyphSpan.nextSibling;
    if (labelNode && labelNode.nodeType === Node.TEXT_NODE) {
      labelNode.nodeValue = BADGE_LABELS[state] || state;
    } else {
      ui.badge.appendChild(document.createTextNode(BADGE_LABELS[state] || state));
    }
  } else {
    // Fallback: no glyph present (unexpected) — rebuild in place preserving classes
    const fresh = makeBadge(state);
    fresh.classList.add('session-badge');
    ui.badge.replaceWith(fresh);
    ui.badge = fresh;
  }
  ui.card.dataset.state = state;

  updateButtonVisibility(ui);

  if (state === STATES.WAITING && prevState !== STATES.WAITING) {
    if (isSoundEnabled()) playAlertSound(getSoundId());
  }

  const isEnding = state === STATES.DONE || state === STATES.FAILED;
  const wasActive = prevState !== STATES.DONE && prevState !== STATES.FAILED && prevState !== STATES.INITIALIZING;
  if (isEnding && wasActive) {
    ui.card.classList.remove('completion-flash');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ui.card.classList.add('completion-flash');
        ui.card.addEventListener('animationend', () => ui.card.classList.remove('completion-flash'), { once: true });
      });
    });
    if (isSoundEnabled()) playAlertSound(getSoundId());
  }

  if (state === STATES.DONE || state === STATES.FAILED) {
    _handleEndedTransition(ui, wasActive, state);
  }

  if (state === STATES.INITIALIZING) {
    _handleRestartTransition(ui, prevState);
  }

  updateAggregateStatus();

  // Auto-wake: sleeping session received a non-sleep-eligible state (server
  // rejected sleep or transitioned back to active before sleep arrived).
  // Resync client by recreating terminal + data WS.
  if (ui.sleeping && !SLEEP_ELIGIBLE.includes(state)) {
    wakeSession(sessionId);
  }

  // Auto-sleep: minimized session just entered a sleep-eligible state
  if (!ui.sleeping
      && ui.card.classList.contains('minimized')
      && SLEEP_ELIGIBLE.includes(state)) {
    sleepSession(sessionId);
  }
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
