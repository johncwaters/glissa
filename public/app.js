// ── Glissa Dashboard — Boot ───────────────────────────────────
// Thin entry point: wires modules together and boots the app.

import { STATES } from '/shared/states.mjs';
import { connectControl, setConnectionStateCallback, onControlMessage } from './control-ws.js';
import {
  createSessionCard, removeSessionCard, applyState,
  getSessionUIs, updateAggregateStatus, showErrorToast,
  appendAuditEntry, handleSessionsReordered,
} from './session-card.js';
import { createAddSessionDialog, createSettingsDialog } from './dialogs.js';

// ── Connection status UI ─────────────────────────────────────

const connectionEl = document.getElementById('connection-status');
const connectionLabel = connectionEl.querySelector('.connection-label');

setConnectionStateCallback((state, label) => {
  connectionEl.dataset.state = state;
  connectionLabel.textContent = label;
});

// ── Control message handlers ─────────────────────────────────

function handleSnapshot(sessions) {
  const container = document.getElementById('sessions-container');
  const empty = container.querySelector('.sessions-empty');
  if (empty) empty.remove();

  if (!sessions || sessions.length === 0) {
    const el = document.createElement('p');
    el.className = 'sessions-empty';
    el.textContent = 'No sessions.';
    container.appendChild(el);
    updateAggregateStatus();
    return;
  }

  const sessionUIs = getSessionUIs();
  for (const s of sessions) {
    if (!sessionUIs.has(s.name)) {
      createSessionCard(s.name, s.state, s.auditLog);
    } else {
      applyState(s.name, s.state);
    }
  }

  updateAggregateStatus();
}

function handleStateChange(msg) {
  const sessionUIs = getSessionUIs();
  const ui = sessionUIs.get(msg.session);

  // If card doesn't exist yet, create it
  if (!ui) {
    createSessionCard(msg.session, msg.to, []);
    const newUi = sessionUIs.get(msg.session);
    if (newUi) {
      appendAuditEntry(newUi, {
        from: msg.from,
        to: msg.to,
        event: msg.event,
        timestamp: msg.timestamp,
      });
    }
    return;
  }

  applyState(msg.session, msg.to);

  // Add to audit log
  appendAuditEntry(ui, {
    from: msg.from,
    to: msg.to,
    event: msg.event,
    timestamp: msg.timestamp,
  });

  // On restart (INITIALIZING after DONE/FAILED), reconnect data WS for fresh PTY
  if (msg.to === STATES.INITIALIZING && (msg.from === STATES.DONE || msg.from === STATES.FAILED)) {
    ui.term.clear();
    if (ui.dataWs) {
      ui.dataWs.close();
    }
  }
}

const messageHandlers = {
  'snapshot':           (msg) => handleSnapshot(msg.sessions),
  'state-change':       (msg) => handleStateChange(msg),
  'session-added':      (msg) => { if (!getSessionUIs().has(msg.session)) createSessionCard(msg.session, msg.state, []); },
  'session-removed':    (msg) => removeSessionCard(msg.session),
  'session-modified':   (msg) => { removeSessionCard(msg.session); createSessionCard(msg.session, msg.state, []); },
  'sessions-reordered': (msg) => handleSessionsReordered(msg.order),
  'error':              (msg) => showErrorToast(msg.message),
  'settings-updated':   () => {},
};

onControlMessage((msg) => {
  const handler = messageHandlers[msg.type];
  if (handler) handler(msg);
});

// ── Window resize: fit all terminals (debounced) ────────────

let resizeTimer = null;

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const [, ui] of getSessionUIs()) {
      if (!ui.card.classList.contains('minimized')) {
        ui.fitAddon.fit();
      }
    }
  }, 100);
});

// ── Toolbar buttons ──────────────────────────────────────────

document.getElementById('btn-add-session').addEventListener('click', createAddSessionDialog);
document.getElementById('btn-settings').addEventListener('click', createSettingsDialog);

// ── Boot ─────────────────────────────────────────────────────

connectControl();
