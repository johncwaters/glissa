// ── Session card module ───────────────────────────────────────
// Owns session card DOM lifecycle, terminal setup, and per-session state.

import { Terminal } from '/xterm/xterm.mjs';
import { FitAddon } from '/xterm/addon-fit.mjs';
import { WebglAddon } from '/xterm/addon-webgl.mjs';
import { STATES, BADGE_LABELS, KILLABLE_STATES, RESTARTABLE_STATES, DISMISSABLE_STATES } from '/shared/states.mjs';
import { sendControlMsg } from './control-ws.js';

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

// Map<sessionName, { term, fitAddon, dataWs, card, badge, btnKill, btnRestart, idleLabel, auditLog, auditContainer, auditToggle, idleStart, idleInterval }>
const sessionUIs = new Map();

// ── DOM refs ─────────────────────────────────────────────────

const container = document.getElementById('sessions-container');
const aggregateEl = document.getElementById('aggregate-status');

// ── Helpers (private) ────────────────────────────────────────

function formatTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
}

function formatIdleDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return m + 'm ' + s + 's';
  return s + 's';
}

function makeBadge(state) {
  const el = document.createElement('span');
  el.className = 'state-badge';
  el.dataset.state = state;
  el.textContent = BADGE_LABELS[state] || state;
  return el;
}

function reloadWebGL(ui) {
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
  } catch (_) {
    // canvas renderer fallback is fine
    ui.webglAddon = null;
    ui.needsWebGLReload = false;
  }
}

function updateButtonVisibility(ui) {
  const state = ui.currentState;
  const showKill = KILLABLE_STATES.includes(state);
  const showRestart = RESTARTABLE_STATES.includes(state);
  const showDismiss = DISMISSABLE_STATES.includes(state);

  ui.btnKill.classList.toggle('visible', showKill);
  ui.btnDismiss.classList.toggle('visible', showDismiss);
  ui.btnRestart.classList.toggle('visible', showRestart);
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
  const elapsed = Date.now() - ui.idleStart;
  ui.idleLabel.textContent = 'Idle ' + formatIdleDuration(elapsed);
}

function appendAuditEntry(ui, entry) {
  ui.auditLog.push(entry);

  const el = document.createElement('div');
  el.className = 'audit-entry';

  const time = document.createElement('span');
  time.className = 'audit-time';
  time.textContent = formatTime(entry.timestamp);

  const from = document.createElement('span');
  from.className = 'audit-from';
  from.textContent = entry.from;

  const arrow = document.createElement('span');
  arrow.className = 'audit-arrow';
  arrow.textContent = '\u2192';

  const to = document.createElement('span');
  to.className = 'audit-to';
  to.textContent = entry.to;

  const evt = document.createElement('span');
  evt.className = 'audit-event';
  evt.textContent = '(' + entry.event + ')';

  el.appendChild(time);
  el.appendChild(from);
  el.appendChild(arrow);
  el.appendChild(to);
  el.appendChild(evt);

  ui.auditContainer.appendChild(el);

  // Auto-scroll to bottom
  ui.auditContainer.scrollTop = ui.auditContainer.scrollHeight;
}

function connectDataWs(sessionName, ui, term) {
  const url = `ws://${location.host}/terminals/${encodeURIComponent(sessionName)}`;
  const ws = new WebSocket(url);
  ui.dataWs = ws;

  ws.addEventListener('message', (event) => {
    term.write(event.data);
  });

  ws.addEventListener('close', () => {
    ui.dataWs = null;
    // Retry after delay
    setTimeout(() => {
      if (sessionUIs.has(sessionName)) {
        connectDataWs(sessionName, ui, term);
      }
    }, RECONNECT_DELAY_MS);
  });

  ws.addEventListener('error', () => {
    // close event will fire next and trigger retry
  });

  ws.addEventListener('open', () => {
    // Send initial resize so PTY matches what xterm rendered
    const { cols, rows } = term;
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  });
}

function sendReorder() {
  const order = [...container.querySelectorAll('.session-card')]
    .map(el => el.dataset.session)
    .filter(Boolean);
  sendControlMsg({ type: 'reorder-sessions', order });
}

// ── createSessionCard internal helpers ────────────────────────

function buildCardDOM(sessionName, initialState) {
  const card = document.createElement('div');
  card.className = 'session-card';
  card.dataset.session = sessionName;
  card.dataset.state = initialState || STATES.INITIALIZING;

  // Header row
  const header = document.createElement('div');
  header.className = 'session-card-header';

  const nameEl = document.createElement('span');
  nameEl.className = 'session-name';
  nameEl.textContent = sessionName;

  const badge = makeBadge(initialState || STATES.INITIALIZING);
  badge.classList.add('session-badge');

  const spacer = document.createElement('span');
  spacer.className = 'session-header-spacer';

  const idleLabel = document.createElement('span');
  idleLabel.className = 'session-idle-label';

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'session-actions';

  const btnKill = document.createElement('button');
  btnKill.className = 'btn-action btn-kill';
  btnKill.textContent = 'Kill';
  btnKill.title = 'Kill this session';

  const btnDismiss = document.createElement('button');
  btnDismiss.className = 'btn-action btn-dismiss';
  btnDismiss.textContent = 'Dismiss';
  btnDismiss.title = 'Dismiss false waiting detection';

  const btnRestart = document.createElement('button');
  btnRestart.className = 'btn-action btn-restart';
  btnRestart.textContent = 'Restart';
  btnRestart.title = 'Restart this session';

  const btnRemove = document.createElement('button');
  btnRemove.className = 'btn-action btn-remove visible';
  btnRemove.textContent = 'Remove';
  btnRemove.title = 'Remove this session';

  const btnMinimize = document.createElement('button');
  btnMinimize.className = 'btn-action btn-minimize visible';
  btnMinimize.textContent = 'Min';
  btnMinimize.title = 'Minimize this session';

  actions.appendChild(btnMinimize);
  actions.appendChild(btnKill);
  actions.appendChild(btnDismiss);
  actions.appendChild(btnRestart);
  actions.appendChild(btnRemove);

  // Drag handle
  const dragHandle = document.createElement('span');
  dragHandle.className = 'drag-handle';
  dragHandle.textContent = '\u2630'; // hamburger icon
  dragHandle.title = 'Drag to reorder';
  header.appendChild(dragHandle);

  header.appendChild(nameEl);
  header.appendChild(badge);
  header.appendChild(spacer);
  header.appendChild(idleLabel);
  header.appendChild(actions);

  // Terminal
  const termWrap = document.createElement('div');
  termWrap.className = 'terminal-wrap';

  // Audit toggle
  const auditToggle = document.createElement('div');
  auditToggle.className = 'audit-toggle';
  auditToggle.innerHTML = '<span class="audit-toggle-arrow">\u25b6</span> Audit log';

  // Audit timeline container
  const auditContainer = document.createElement('div');
  auditContainer.className = 'audit-timeline';

  card.appendChild(header);
  card.appendChild(termWrap);
  card.appendChild(auditToggle);
  card.appendChild(auditContainer);

  return { card, badge, idleLabel, btnKill, btnDismiss, btnRestart, btnRemove, btnMinimize, dragHandle, termWrap, auditToggle, auditContainer };
}

function setupDragAndDrop(card, dragHandle, sessionName) {
  card.draggable = false;
  dragHandle.addEventListener('mousedown', () => { card.draggable = true; });
  card.addEventListener('dragend', () => { card.draggable = false; });

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sessionName);
    card.classList.add('dragging');
  });

  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    card.classList.toggle('drop-above', e.clientY < midY);
    card.classList.toggle('drop-below', e.clientY >= midY);
  });

  card.addEventListener('dragleave', () => {
    card.classList.remove('drop-above', 'drop-below');
  });

  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drop-above', 'drop-below');
    const sourceName = e.dataTransfer.getData('text/plain');
    const sourceUI = sessionUIs.get(sourceName);
    if (!sourceUI || sourceUI.card === card) return;

    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      container.insertBefore(sourceUI.card, card);
    } else {
      container.insertBefore(sourceUI.card, card.nextSibling);
    }

    sendReorder();
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    // Clean up any lingering indicators on all cards
    for (const [, ui] of sessionUIs) {
      ui.card.classList.remove('drop-above', 'drop-below');
    }
    // Recover WebGL on the dragged card (DOM move invalidates context)
    const draggedUI = sessionUIs.get(sessionName);
    if (draggedUI) {
      if (draggedUI.card.classList.contains('minimized')) {
        draggedUI.needsWebGLReload = true;
      } else {
        reloadWebGL(draggedUI);
      }
    }
    // Defensive fit on all terminals after layout change (skip minimized)
    for (const [, ui] of sessionUIs) {
      if (!ui.card.classList.contains('minimized')) {
        try { ui.fitAddon.fit(); } catch (_) {}
      }
    }
  });
}

function setupTerminal(termWrap) {
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

  // Try WebGL — fall back to canvas silently
  let webglAddon = null;
  try {
    webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
      webglAddon = null;
    });
    term.loadAddon(webglAddon);
  } catch (_) {
    // canvas renderer is fine
  }

  // Fit after open — defer one tick to let layout settle
  requestAnimationFrame(() => {
    fitAddon.fit();
  });

  return { term, fitAddon, webglAddon };
}

function wireButtonEvents(ui, sessionName) {
  ui.btnKill.addEventListener('click', () => {
    sendControlMsg({ type: 'kill', session: sessionName });
  });

  ui.btnRestart.addEventListener('click', () => {
    sendControlMsg({ type: 'restart', session: sessionName });
  });

  ui.btnDismiss.addEventListener('click', () => {
    sendControlMsg({ type: 'dismiss', session: sessionName });
  });

  ui.btnRemove.addEventListener('click', () => {
    if (!confirm(`Remove session "${sessionName}"?`)) return;
    sendControlMsg({ type: 'remove-session', session: sessionName });
  });

  // Wire minimize toggle
  ui.btnMinimize.addEventListener('click', () => {
    const isMinimized = ui.card.classList.toggle('minimized');
    ui.btnMinimize.textContent = isMinimized ? 'Max' : 'Min';
    ui.btnMinimize.title = isMinimized ? 'Restore this session' : 'Minimize this session';
    if (!isMinimized) {
      if (ui.needsWebGLReload) {
        reloadWebGL(ui);
      }
      requestAnimationFrame(() => ui.fitAddon.fit());
    }
  });

  // Wire audit toggle
  ui.auditToggle.addEventListener('click', () => {
    const isOpen = ui.auditToggle.classList.toggle('open');
    ui.auditContainer.classList.toggle('open', isOpen);
    // Refit terminal after collapse/expand
    requestAnimationFrame(() => ui.fitAddon.fit());
  });
}

// ── Public API ────────────────────────────────────────────────

export function getSessionUIs() {
  return sessionUIs;
}

export function updateAggregateStatus() {
  let waiting = 0;
  let failed = 0;
  let done = 0;
  let running = 0;
  let total = 0;

  for (const [, ui] of sessionUIs) {
    total++;
    const state = ui.currentState;
    if (state === STATES.WAITING) waiting++;
    else if (state === STATES.FAILED) failed++;
    else if (state === STATES.DONE) done++;
    else running++;
  }

  let text = '';
  let severity = '';

  if (waiting > 0) {
    text = waiting + ' session' + (waiting > 1 ? 's' : '') + ' need input';
    severity = 'warning';
  } else if (failed > 0) {
    text = failed + ' session' + (failed > 1 ? 's' : '') + ' failed';
    severity = 'critical';
  } else if (total > 0 && done === total) {
    text = 'All sessions complete';
    severity = 'done';
  } else if (total > 0) {
    const active = total - done;
    text = active + ' session' + (active > 1 ? 's' : '') + ' running';
    severity = 'success';
  }

  aggregateEl.textContent = text;
  aggregateEl.dataset.severity = severity;

  // Tab title
  const alertCount = waiting + failed;
  document.title = alertCount > 0 ? '(' + alertCount + ') Glissa' : 'Glissa';
}

export function createSessionCard(sessionName, initialState, auditLog) {
  const dom = buildCardDOM(sessionName, initialState);
  setupDragAndDrop(dom.card, dom.dragHandle, sessionName);
  container.appendChild(dom.card);

  const { term, fitAddon, webglAddon } = setupTerminal(dom.termWrap);

  const ui = {
    term,
    fitAddon,
    webglAddon,
    needsWebGLReload: false,
    dataWs: null,
    card: dom.card,
    badge: dom.badge,
    btnKill: dom.btnKill,
    btnDismiss: dom.btnDismiss,
    btnRestart: dom.btnRestart,
    btnMinimize: dom.btnMinimize,
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

  // Fix WebGL context loss callback to reference the ui object
  if (webglAddon) {
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
      ui.webglAddon = null;
      ui.needsWebGLReload = true;
    });
  }

  wireButtonEvents(ui, sessionName);
  updateButtonVisibility(ui);

  // Populate initial audit log from snapshot
  if (auditLog && auditLog.length > 0) {
    for (const entry of auditLog) {
      appendAuditEntry(ui, entry);
    }
  }

  // Wire terminal input/resize -> data WS
  term.onData((data) => {
    if (ui.dataWs && ui.dataWs.readyState === WebSocket.OPEN) {
      ui.dataWs.send(JSON.stringify({ type: 'input', data }));
    }
  });

  term.onResize(({ cols, rows }) => {
    if (ui.dataWs && ui.dataWs.readyState === WebSocket.OPEN) {
      ui.dataWs.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  connectDataWs(sessionName, ui, term);
  updateAggregateStatus();

  return ui;
}

export function removeSessionCard(sessionName) {
  const ui = sessionUIs.get(sessionName);
  if (!ui) return;

  // 1. Delete from sessionUIs Map FIRST — breaks the data WS reconnect loop
  sessionUIs.delete(sessionName);

  // 2. Close data WebSocket
  if (ui.dataWs && ui.dataWs.readyState <= WebSocket.OPEN) {
    ui.dataWs.close();
  }

  // 3. Dispose xterm Terminal to free resources
  if (ui.term) {
    ui.term.dispose();
  }

  // 4. Clear idle interval if running
  if (ui.idleInterval) {
    clearInterval(ui.idleInterval);
  }

  // 5. Remove DOM node last
  if (ui.card) {
    ui.card.remove();
  }

  // 6. Update aggregate status
  updateAggregateStatus();
}

export function applyState(sessionName, state) {
  const ui = sessionUIs.get(sessionName);
  if (!ui) return;

  const prevState = ui.currentState;
  ui.currentState = state;

  // Update badge
  ui.badge.textContent = BADGE_LABELS[state] || state;
  ui.badge.dataset.state = state;

  // Update card data-state for border styling
  ui.card.dataset.state = state;

  // Button visibility
  updateButtonVisibility(ui);

  // Idle counter
  if (state === STATES.IDLE && prevState !== STATES.IDLE) {
    startIdleCounter(ui);
  } else if (state !== STATES.IDLE && prevState === STATES.IDLE) {
    stopIdleCounter(ui);
  }

  updateAggregateStatus();
}

export { appendAuditEntry };

export function handleSessionsReordered(order) {
  for (const name of order) {
    const ui = sessionUIs.get(name);
    if (ui && ui.card) {
      container.appendChild(ui.card); // moves node to end, building new order
    }
  }
  // Recover WebGL on all cards (DOM move invalidates context)
  for (const [, ui] of sessionUIs) {
    if (ui.card.classList.contains('minimized')) {
      ui.needsWebGLReload = true;
    } else {
      reloadWebGL(ui);
      try { ui.fitAddon.fit(); } catch (_) {}
    }
  }
}

export function showErrorToast(message) {
  const toast = document.createElement('div');
  toast.className = 'error-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('transitionend', () => toast.remove());
  }, 4000);
}
