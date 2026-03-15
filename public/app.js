// ── Glissa Dashboard — Boot ───────────────────────────────────
// Thin entry point: wires modules together and boots the app.

import '@xterm/xterm/css/xterm.css';
import './tailwind.css';

import { STATES } from '/shared/states.mjs';
import { connectControl, setConnectionStateCallback, onControlMessage, sendControlMsg, disableReconnect } from './control-ws.js';
import {
  createSessionCard, removeSessionCard, applyState,
  getSessionUIs, updateAggregateStatus, showErrorToast,
  appendAuditEntry, handleSessionsReordered,
  exitFocusMode, isFocusActive,
} from './session-card.js';
import { createAddSessionDialog, createSettingsDialog } from './dialogs.js';
import { pruneStale, isSoundEnabled, setSoundEnabled } from './ui-prefs.js';
import { registerGuide, checkAndStartGuides, isFirstOpen } from './guide.js';

// ── Guided tutorials ──────────────────────────────────────────

registerGuide('welcome', {
  condition: isFirstOpen,
  steps: [
    {
      target: '#btn-add-session',
      title: 'Create a Session',
      body: 'Click here to add a new Claude Code session. Pick a project or enter a path manually.',
      position: 'top',
    },
    {
      target: '#btn-menu',
      title: 'Settings & Controls',
      body: 'Open the menu to configure timeouts, alert sounds, repository roots, or restart the server.',
      position: 'bottom',
    },
    {
      target: '#connection-status',
      title: 'Connection Status',
      body: 'This indicator shows whether the dashboard is connected to the backend server.',
      position: 'bottom',
    },
    {
      target: '#sessions-container .session-card .session-card-header',
      title: 'Drag to Reorder',
      body: 'Grab a session card by its header and drag it to rearrange the dashboard layout.',
      position: 'bottom',
    },
    {
      target: '#sessions-container .session-card .btn-minimize',
      title: 'Minimize Sessions',
      body: 'Click the arrow to collapse a session into the bottom bar. Click again to expand it back.',
      position: 'right',
    },
    {
      target: '#sessions-container .session-card .session-name',
      title: 'Focus Mode',
      body: 'Double-click a session name to enter full-screen focus mode. Press ESC to exit.',
      position: 'bottom',
    },
  ],
});

let _guidesChecked = false;

// ── Connection status UI ─────────────────────────────────────

const connectionEl = document.getElementById('connection-status');
const connectionLabel = connectionEl.querySelector('.connection-label');

const loadingScreen = document.getElementById('loading-screen');
const loadingStatus = document.getElementById('loading-status');
const shutdownScreen = document.getElementById('shutdown-screen');
const shutdownStatus = document.getElementById('shutdown-status');
let appRevealed = false;

function revealApp() {
  if (appRevealed) return;
  appRevealed = true;
  document.body.classList.add('app-ready');
  loadingScreen.classList.add('fade-out');
  loadingScreen.addEventListener('transitionend', () => loadingScreen.remove());
}

function showShutdownOverlay(message) {
  if (message) shutdownStatus.textContent = message;
  shutdownScreen.classList.add('active');
}

setConnectionStateCallback((state, label) => {
  connectionEl.dataset.state = state;
  connectionLabel.textContent = label;

  if (state === 'connected') {
    if (shutdownScreen.classList.contains('active')) {
      // Reconnected after restart — reload for fresh state
      location.reload();
      return;
    }
    revealApp();
  } else if (state === 'shutdown') {
    if (appRevealed) {
      shutdownStatus.textContent = 'Server shut down';
      shutdownScreen.classList.add('done');
    } else {
      loadingStatus.textContent = 'Server shut down';
    }
  } else if (state === 'disconnected' && shutdownScreen.classList.contains('active')) {
    // Restart: server dropped connection, waiting for it to come back
    shutdownStatus.textContent = 'Waiting for server...';
  } else if (!appRevealed) {
    loadingStatus.textContent = 'Reconnecting to server...';
  }
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

  pruneStale(sessions.map(s => s.name));
  updateAggregateStatus();

  if (!_guidesChecked) {
    _guidesChecked = true;
    // Delay briefly so DOM is settled before positioning tooltips
    requestAnimationFrame(() => checkAndStartGuides());
  }
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
  'shutting-down':      () => {
    disableReconnect();
    connectionEl.dataset.state = 'shutdown';
    connectionLabel.textContent = 'Shutting down...';
    document.getElementById('btn-menu').disabled = true;
    showShutdownOverlay('Shutting down sessions...');
  },
  'restarting':         () => {
    connectionEl.dataset.state = 'shutdown';
    connectionLabel.textContent = 'Restarting...';
    document.getElementById('btn-menu').disabled = true;
    showShutdownOverlay('Restarting server...');
  },
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

// ── Header menu ──────────────────────────────────────────────

const headerMenu = document.getElementById('header-menu');
const btnMenu = document.getElementById('btn-menu');

btnMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  headerMenu.classList.toggle('open');
});

// Close menu on outside click
document.addEventListener('click', (e) => {
  if (!headerMenu.contains(e.target)) {
    headerMenu.classList.remove('open');
  }
});

document.getElementById('btn-settings').addEventListener('click', () => {
  headerMenu.classList.remove('open');
  createSettingsDialog();
});

document.getElementById('btn-restart').addEventListener('click', () => {
  headerMenu.classList.remove('open');
  const count = getSessionUIs().size;
  const msg = count > 0
    ? `Kill ${count} session${count > 1 ? 's' : ''} and restart the server?`
    : 'Restart the server?';
  if (!confirm(msg)) return;
  sendControlMsg({ type: 'restart-server' });
});

document.getElementById('btn-shutdown').addEventListener('click', () => {
  headerMenu.classList.remove('open');
  const count = getSessionUIs().size;
  const msg = count > 0
    ? `Kill ${count} session${count > 1 ? 's' : ''} and shut down the server?`
    : 'Shut down the server?';
  if (!confirm(msg)) return;
  sendControlMsg({ type: 'shutdown' });
});

// ── Focus mode: ESC to exit ──────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isFocusActive()) {
    if (document.querySelector('.dialog-overlay')) return;
    exitFocusMode();
  }
});

// ── Sound controls ──────────────────────────────────────────

const btnMute = document.getElementById('btn-mute');

function updateMuteButton() {
  const muted = !isSoundEnabled();
  btnMute.textContent = muted ? '\uD83D\uDD07 Unmute Alerts' : '\uD83D\uDD0A Mute Alerts';
}
updateMuteButton();

btnMute.addEventListener('click', (e) => {
  e.stopPropagation();
  setSoundEnabled(!isSoundEnabled());
  updateMuteButton();
});

// ── Boot ─────────────────────────────────────────────────────

connectControl();
