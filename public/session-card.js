// ── Session card module ───────────────────────────────────────
// Owns session card DOM lifecycle, terminal setup, and per-session state.

import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { sendControlMsg } from './control-ws.js';
// Vite alias — resolves to shared/states.esm.js
import { STATES, BADGE_LABELS, KILLABLE_STATES, RESTARTABLE_STATES, DISMISSABLE_STATES } from '/shared/states.mjs';

// ── Constants ────────────────────────────────────────────────

const RECONNECT_DELAY_MS = 3000;

const TERM_THEME = {
  background:  '#0a0a1a',
  foreground:  '#c8c8e0',
  cursor:      '#4f6ef7',
  cursorAccent:'#0a0a1a',
  black:       '#1a1a2e',
  brightBlack: '#3a3a5c',
  red:         '#ef4444',
  brightRed:   '#f87171',
  green:       '#22c55e',
  brightGreen: '#4ade80',
  yellow:      '#eab308',
  brightYellow:'#facc15',
  blue:        '#3b82f6',
  brightBlue:  '#60a5fa',
  magenta:     '#a855f7',
  brightMagenta:'#c084fc',
  cyan:        '#06b6d4',
  brightCyan:  '#22d3ee',
  white:       '#c8c8e0',
  brightWhite: '#e8e8ff',
};

// ── State ────────────────────────────────────────────────────

const sessionUIs = new Map();

// ── DOM refs ─────────────────────────────────────────────────

const container = document.getElementById('sessions-container');
const aggregateEl = document.getElementById('aggregate-status');

// ── Helpers (private) ────────────────────────────────────────

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

function formatIdleDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

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
  ui.btnDismiss.classList.toggle('visible', DISMISSABLE_STATES.includes(state));
  ui.btnRestart.classList.toggle('visible', KILLABLE_STATES.includes(state) || RESTARTABLE_STATES.includes(state));
}

function startIdleCounter(ui) {
  ui.idleStart = Date.now();
  ui.idleLabel.classList.add('visible');
  updateIdleLabel(ui);
  ui.idleInterval = setInterval(() => updateIdleLabel(ui), 1000);
}

function stopIdleCounter(ui) {
  ui.idleStart = null;
  ui.idleLabel.classList.remove('visible');
  ui.idleLabel.textContent = '';
  if (ui.idleInterval) {
    clearInterval(ui.idleInterval);
    ui.idleInterval = null;
  }
}

function updateIdleLabel(ui) {
  if (ui.idleStart === null) return;
  ui.idleLabel.textContent = `Idle ${formatIdleDuration(Date.now() - ui.idleStart)}`;
}

function appendAuditEntry(ui, entry) {
  ui.auditLog.push(entry);

  const row = el('div', 'audit-entry');
  row.appendChild(el('span', 'audit-time', formatTime(entry.timestamp)));
  row.appendChild(el('span', 'audit-from', entry.from));
  row.appendChild(el('span', 'audit-arrow', '\u2192'));
  row.appendChild(el('span', 'audit-to', entry.to));
  row.appendChild(el('span', 'audit-event', `(${entry.event})`));
  ui.auditContainer.appendChild(row);
  ui.auditContainer.scrollTop = ui.auditContainer.scrollHeight;
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
  const order = [...container.querySelectorAll('.session-card')]
    .map(c => c.dataset.session)
    .filter(Boolean);
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

  const dragHandle = el('span', 'drag-handle', '\u25bc');
  dragHandle.title = 'Minimize / Expand';

  const nameEl = el('span', 'session-name', sessionName);
  const badge = makeBadge(state);
  badge.classList.add('session-badge');
  const spacer = el('span', 'session-header-spacer');
  const idleLabel = el('span', 'session-idle-label');

  // Action buttons
  const actions = el('div', 'session-actions');

  const btnDismiss = el('button', 'btn-action btn-dismiss', 'Dismiss');
  btnDismiss.title = 'Dismiss false waiting detection';

  const btnRestart = el('button', 'btn-action btn-restart', 'Restart');
  btnRestart.title = 'Restart this session';

  const btnRemove = el('button', 'btn-action btn-remove visible', 'Remove');
  btnRemove.title = 'Remove this session';

  actions.append(btnDismiss, btnRestart, btnRemove);
  header.append(dragHandle, nameEl, badge, spacer, idleLabel, actions);

  // Terminal + audit
  const termWrap = el('div', 'terminal-wrap');

  const auditToggle = el('div', 'audit-toggle');
  auditToggle.innerHTML = '<span class="audit-toggle-arrow">\u25b6</span> Audit log';

  const auditContainer = el('div', 'audit-timeline');

  card.append(header, termWrap, auditToggle, auditContainer);

  return { card, header, badge, idleLabel, btnDismiss, btnRestart, btnRemove, dragHandle, termWrap, auditToggle, auditContainer };
}

// ── Minimize toggle ──────────────────────────────────────────

function toggleMinimize(sessionName) {
  const ui = sessionUIs.get(sessionName);
  if (!ui) return;
  const isMinimized = ui.card.classList.toggle('minimized');
  ui.dragHandle.textContent = isMinimized ? '\u25b6' : '\u25bc';
  ui.dragHandle.title = isMinimized ? 'Expand' : 'Minimize';
  if (!isMinimized) {
    if (ui.needsWebGLReload) tryLoadWebGL(ui);
    requestAnimationFrame(() => ui.fitAddon.fit());
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
    if (card === sourceCard) continue;
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

container.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropIndicators();
  const { card, before } = findDropTarget(e.clientX, e.clientY);
  if (card) card.classList.add(before ? 'drop-above' : 'drop-below');
});

container.addEventListener('dragleave', (e) => {
  if (!container.contains(e.relatedTarget)) clearDropIndicators();
});

container.addEventListener('drop', (e) => {
  e.preventDefault();
  clearDropIndicators();
  if (!_dragSource) return;
  const { card, before } = findDropTarget(e.clientX, e.clientY);
  if (!card || card === _dragSource.card) return;
  container.insertBefore(_dragSource.card, before ? card : card.nextSibling);
  sendReorder();
});

function setupDragAndDrop(card, header, dragHandle, sessionName) {
  card.draggable = false;
  let didDrag = false;

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('.session-actions')) return;
    didDrag = false;
    card.draggable = true;
  });

  header.addEventListener('mouseup', () => {
    if (!didDrag) card.draggable = false;
  });

  dragHandle.addEventListener('click', () => {
    if (!didDrag) toggleMinimize(sessionName);
  });

  card.addEventListener('dragstart', (e) => {
    didDrag = true;
    _dragSource = sessionUIs.get(sessionName);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sessionName);
    card.classList.add('dragging');
    container.classList.add('drag-active');
  });

  card.addEventListener('dragend', () => {
    card.draggable = false;
    card.classList.remove('dragging');
    container.classList.remove('drag-active');
    clearDropIndicators();
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
    theme: TERM_THEME,
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

  requestAnimationFrame(() => fitAddon.fit());
}

// ── Card event wiring ────────────────────────────────────────

function wireCardEvents(ui, sessionName) {
  ui.btnRestart.addEventListener('click', () => {
    const type = KILLABLE_STATES.includes(ui.currentState) ? 'force-restart' : 'restart';
    sendControlMsg({ type, session: sessionName });
  });

  ui.btnDismiss.addEventListener('click', () => {
    sendControlMsg({ type: 'dismiss', session: sessionName });
  });

  ui.btnRemove.addEventListener('click', () => {
    if (!confirm(`Remove session "${sessionName}"?`)) return;
    sendControlMsg({ type: 'remove-session', session: sessionName });
  });

  ui.auditToggle.addEventListener('click', () => {
    const isOpen = ui.auditToggle.classList.toggle('open');
    ui.auditContainer.classList.toggle('open', isOpen);
    requestAnimationFrame(() => ui.fitAddon.fit());
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

export function getSessionUIs() {
  return sessionUIs;
}

export function updateAggregateStatus() {
  let waiting = 0, failed = 0, done = 0, total = 0;

  for (const [, ui] of sessionUIs) {
    total++;
    const state = ui.currentState;
    if (state === STATES.WAITING) waiting++;
    else if (state === STATES.FAILED) failed++;
    else if (state === STATES.DONE) done++;
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
  } else if (total > 0 && done === total) {
    text = 'All sessions complete';
    severity = 'done';
  } else if (total > 0) {
    const active = total - done;
    text = `${active} session${pl(active)} running`;
    severity = 'success';
  }

  aggregateEl.textContent = text;
  aggregateEl.dataset.severity = severity;
  const alertCount = waiting + failed;
  document.title = alertCount > 0 ? `(${alertCount}) Glissa` : 'Glissa';
}

export function createSessionCard(sessionName, initialState, auditLog) {
  const dom = buildCardDOM(sessionName, initialState);
  setupDragAndDrop(dom.card, dom.header, dom.dragHandle, sessionName);
  container.appendChild(dom.card);

  const ui = {
    term: null,
    fitAddon: null,
    webglAddon: null,
    needsWebGLReload: false,
    dataWs: null,
    card: dom.card,
    badge: dom.badge,
    dragHandle: dom.dragHandle,
    btnDismiss: dom.btnDismiss,
    btnRestart: dom.btnRestart,
    btnRemove: dom.btnRemove,
    idleLabel: dom.idleLabel,
    auditLog: [],
    auditContainer: dom.auditContainer,
    auditToggle: dom.auditToggle,
    idleStart: null,
    idleInterval: null,
    currentState: initialState || STATES.INITIALIZING,
  };
  sessionUIs.set(sessionName, ui);

  setupTerminal(dom.termWrap, ui);

  wireCardEvents(ui, sessionName);
  updateButtonVisibility(ui);

  if (auditLog?.length > 0) {
    for (const entry of auditLog) appendAuditEntry(ui, entry);
  }

  wireTerminalIO(ui, sessionName);
  updateAggregateStatus();
  return ui;
}

export function removeSessionCard(sessionName) {
  const ui = sessionUIs.get(sessionName);
  if (!ui) return;

  sessionUIs.delete(sessionName);
  if (ui.dataWs?.readyState <= WebSocket.OPEN) ui.dataWs.close();
  if (ui.term) ui.term.dispose();
  if (ui.idleInterval) clearInterval(ui.idleInterval);
  if (ui.card) ui.card.remove();
  updateAggregateStatus();
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

  // Idle counter
  if (state === STATES.IDLE && prevState !== STATES.IDLE) {
    startIdleCounter(ui);
  } else if (state !== STATES.IDLE && prevState === STATES.IDLE) {
    stopIdleCounter(ui);
  }

  // Clear terminal and show placeholder when session ends
  const ended = state === STATES.DONE || state === STATES.FAILED;
  const wasActive = prevState !== STATES.DONE && prevState !== STATES.FAILED && prevState !== STATES.INITIALIZING;
  if (ended && wasActive) {
    ui.term.clear();
    ui.term.reset();
    const label = state === STATES.DONE ? 'Session complete' : 'Session failed';
    const color = state === STATES.DONE ? '\x1b[34m' : '\x1b[31m';
    ui.term.write(`\r\n\x1b[2m${color}  ${label}\x1b[0m\r\n\r\n\x1b[2m  Press Restart to start a new session.\x1b[0m\r\n`);
  }

  // Clear placeholder on restart
  if (state === STATES.INITIALIZING && (prevState === STATES.DONE || prevState === STATES.FAILED)) {
    ui.term.clear();
    ui.term.reset();
  }

  updateAggregateStatus();
}

export { appendAuditEntry };

export function handleSessionsReordered(order) {
  if (_localReorderPending) {
    _localReorderPending = false;
    return;
  }

  for (const name of order) {
    const ui = sessionUIs.get(name);
    if (ui?.card) container.appendChild(ui.card);
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
