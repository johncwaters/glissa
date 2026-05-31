// ── Glissa Dashboard — Boot ───────────────────────────────────
// Thin entry point: wires modules together and boots the app.

import '@xterm/xterm/css/xterm.css';
import './tailwind.css';

import { STATES } from '/shared/states.mjs';
import { connectControl, disableReconnect, onControlMessage, sendControlMsg, sendControlRequest, setConnectionStateCallback } from './control-ws.js';
import { createAddSessionDialog, createConfirmDialog, createSettingsDialog } from './dialogs.js';
import { applyHealthSnapshot, mountHealthMonitor } from './health-monitor.js';
import {
  applyState, applyTerminalSettings, createSessionCard, exitMaximizeMode, focusSessionCard,
  getSessionCount, handleDebugStateRefresh, handleDebugStateResponse, handleSessionsReordered, hasSession, isMaximizeActive,
  reconnectDataWs, removeSessionCard, renameSessionCard, setLayoutMode, showErrorToast, updateAggregateStatus,
} from './session-card.js';
import { handleTeamMessage, mountTeamsView, setTabActivityCallback } from './teams-panel.js';
import { applyTheme } from './theme.js';
import { getThemeId, isSoundEnabled, pruneStale, setSoundEnabled } from './ui-prefs.js';

// ── Apply saved theme ─────────────────────────────────────────

applyTheme(getThemeId());

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
    sendFocusState();
    // Fetch terminal settings on initial connect to apply scrollback/cursorBlink
    sendControlRequest('get-settings', {})
      .then((msg) => { if (msg.settings) applyTerminalSettings(msg.settings); })
      .catch(() => {});
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

function clearEmptyPlaceholder() {
  const empty = document.getElementById('sessions-container').querySelector('.sessions-empty');
  if (empty) empty.remove();
}

// Real projects (id -> name) for the Teams panel project picker. Ephemeral team-stage sessions
// (id like "team:<run>:<stage>") are excluded — they are transient run cards, not run targets.
const knownProjects = new Map();
function getKnownProjects() {
  return [...knownProjects].map(([id, name]) => ({ id, name }));
}

function handleSnapshot(sessions) {
  const container = document.getElementById('sessions-container');
  clearEmptyPlaceholder();

  knownProjects.clear();
  for (const s of (sessions || [])) {
    if (!s.ephemeral) knownProjects.set(s.id, s.name);
  }

  if (!sessions || sessions.length === 0) {
    const el = document.createElement('div');
    el.className = 'sessions-empty';
    el.innerHTML = `
      <div class="sessions-empty-inner">
        <div class="sessions-empty-mark">\u25b8</div>
        <h2 class="sessions-empty-title">No sessions running</h2>
        <p class="sessions-empty-desc">Glissa monitors Claude Code agent sessions. Add a project to begin.</p>
        <button type="button" class="sessions-empty-cta" id="sessions-empty-cta">+ New Session</button>
        <p class="sessions-empty-hint">Configure repository roots in <kbd>Settings</kbd> if no projects appear.</p>
      </div>
    `;
    container.appendChild(el);
    const cta = el.querySelector('#sessions-empty-cta');
    cta.addEventListener('click', () => {
      document.getElementById('btn-add-session')?.click();
    });
    updateAggregateStatus();
  } else {
    for (const s of sessions) {
      if (hasSession(s.id)) {
        applyState(s.id, s.state);
      } else {
        createSessionCard(s.id, s.name, s.state, { skipPerms: !!s.dangerouslySkipPermissions });
      }
    }

    pruneStale(sessions.map(s => s.id));
    updateAggregateStatus();
  }

  autoLayout();
}

function handleStateChange(msg) {
  if (!hasSession(msg.id)) {
    clearEmptyPlaceholder();
    createSessionCard(msg.id, msg.session, msg.to, { skipPerms: !!msg.skipPerms });
    autoLayout();
    return;
  }

  applyState(msg.id, msg.to);

  // Live-update debug overlay on state change
  handleDebugStateRefresh(msg.id);

  // On restart (INITIALIZING after DONE/FAILED), reconnect data WS for fresh PTY
  if (msg.to === STATES.INITIALIZING && (msg.from === STATES.DONE || msg.from === STATES.FAILED)) {
    reconnectDataWs(msg.id);
  }
}

const messageHandlers = {
  'snapshot':           (msg) => handleSnapshot(msg.sessions),
  'state-change':       (msg) => handleStateChange(msg),
  'session-added':      (msg) => { if (!msg.ephemeral) knownProjects.set(msg.id, msg.session); if (!hasSession(msg.id)) { clearEmptyPlaceholder(); createSessionCard(msg.id, msg.session, msg.state, { skipPerms: !!msg.skipPerms }); } autoLayout(); },
  'session-removed':    (msg) => { knownProjects.delete(msg.id); removeSessionCard(msg.id); autoLayout(); },
  'session-renamed':    (msg) => { if (knownProjects.has(msg.id)) knownProjects.set(msg.id, msg.newName); renameSessionCard(msg.id, msg.newName); },
  'session-modified':   (msg) => { if (!msg.ephemeral) knownProjects.set(msg.id, msg.session); removeSessionCard(msg.id); clearEmptyPlaceholder(); createSessionCard(msg.id, msg.session, msg.state, { skipPerms: !!msg.skipPerms }); autoLayout(); },
  'sessions-reordered': (msg) => handleSessionsReordered(msg.order),
  'debug-state-response': (msg) => handleDebugStateResponse(msg),
  'error':              (msg) => showErrorToast(msg.message),
  'session-error':      (msg) => showErrorToast(`${msg.session}: ${msg.message}`),
  'settings-updated':   (msg) => { if (msg.settings) applyTerminalSettings(msg.settings); },
  'health-snapshot':    (msg) => { if (msg.stats) applyHealthSnapshot(msg.stats); },
  'team-run-accepted':  (msg) => handleTeamMessage(msg),
  'team-run-started':   (msg) => handleTeamMessage(msg),
  'team-stage-started': (msg) => handleTeamMessage(msg),
  'team-stage-complete': (msg) => handleTeamMessage(msg),
  'team-run-complete':  (msg) => handleTeamMessage(msg),
  'team-run-failed':    (msg) => handleTeamMessage(msg),
  'team-run-skipped':   (msg) => handleTeamMessage(msg),
  'team-run-needs-setup': (msg) => handleTeamMessage(msg),
  'team-instance-added':   (msg) => handleTeamMessage(msg),
  'team-instance-removed': (msg) => handleTeamMessage(msg),
  'team-schedule-updated': (msg) => handleTeamMessage(msg),
  'setup-team-pack-started': (msg) => {
    handleTeamMessage(msg);
    // The guided-setup session is an interactive terminal under the Sessions view; jump there and
    // focus it so the operator can answer the interview instead of the click appearing to do nothing.
    if (msg.sessionId) {
      activateView('sessions'); // synchronous; focusSessionCard's own double-rAF lets it settle
      focusSessionCard(msg.sessionId);
    }
  },
  'team-pack-updated':     (msg) => handleTeamMessage(msg),
  'artifact-opened':    (msg) => { if (!msg.ok) showErrorToast(`Could not open ${msg.artifact || 'artifact'}${msg.error ? `: ${msg.error}` : ''}`); },
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

// ── Toolbar buttons ──────────────────────────────────────────

document.getElementById('btn-add-session').addEventListener('click', createAddSessionDialog);

// ── Header menu ──────────────────────────────────────────────

const headerMenu = document.getElementById('header-menu');
const btnMenu = document.getElementById('btn-menu');

function syncMenuAria() {
  btnMenu.setAttribute('aria-expanded', headerMenu.classList.contains('open') ? 'true' : 'false');
}

btnMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  headerMenu.classList.toggle('open');
  syncMenuAria();
});

// Close menu on outside click
document.addEventListener('click', (e) => {
  if (!headerMenu.contains(e.target)) {
    headerMenu.classList.remove('open');
    syncMenuAria();
  }
});

document.getElementById('btn-settings').addEventListener('click', () => {
  headerMenu.classList.remove('open');
  syncMenuAria();
  createSettingsDialog();
});

// ── Primary view tabs (Sessions / Teams) ─────────────────────

const viewTeamsEl = document.getElementById('view-teams');
const tabSessions = document.getElementById('tab-sessions');
const tabTeams = document.getElementById('tab-teams');
const tabActivityEl = document.getElementById('tab-teams-activity');

setTabActivityCallback((active) => { tabActivityEl.classList.toggle('active', active); });

function activateView(view) {
  const teams = view === 'teams';
  document.body.dataset.activeView = view;
  viewTeamsEl.hidden = !teams;
  tabSessions.setAttribute('aria-selected', String(!teams));
  tabSessions.tabIndex = teams ? -1 : 0;
  tabTeams.setAttribute('aria-selected', String(teams));
  tabTeams.tabIndex = teams ? 0 : -1;
  if (teams) {
    mountTeamsView(viewTeamsEl, getKnownProjects());
  } else {
    // Session terminals were display:none under the Teams tab — re-fit on return.
    autoLayout();
  }
}

tabSessions.addEventListener('click', () => activateView('sessions'));
tabTeams.addEventListener('click', () => activateView('teams'));
for (const tab of [tabSessions, tabTeams]) {
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const toTeams = tab === tabSessions;
    activateView(toTeams ? 'teams' : 'sessions');
    (toTeams ? tabTeams : tabSessions).focus();
  });
}

document.body.dataset.activeView = 'sessions';

document.getElementById('btn-restart').addEventListener('click', () => {
  headerMenu.classList.remove('open');
  syncMenuAria();
  const count = getSessionCount();
  const suffix = count > 1 ? 's' : '';
  const message = count > 0
    ? `Kill ${count} session${suffix} and restart the server?`
    : 'Restart the server?';
  createConfirmDialog({
    title: 'Restart Server',
    message,
    confirmLabel: 'Restart',
    danger: false,
    onConfirm: () => sendControlMsg({ type: 'restart-server' }),
  });
});

document.getElementById('btn-shutdown').addEventListener('click', () => {
  headerMenu.classList.remove('open');
  syncMenuAria();
  const count = getSessionCount();
  const suffix = count > 1 ? 's' : '';
  const message = count > 0
    ? `Kill ${count} session${suffix} and shut down the server?`
    : 'Shut down the server?';
  createConfirmDialog({
    title: 'Shut Down Server',
    message,
    confirmLabel: 'Shut Down',
    danger: true,
    onConfirm: () => sendControlMsg({ type: 'shutdown' }),
  });
});

// ── Maximize mode: ESC to exit ───────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isMaximizeActive()) {
    if (document.querySelector('.dialog-overlay')) return;
    exitMaximizeMode();
  }
});

// ── Sound controls ──────────────────────────────────────────

const btnMute = document.getElementById('btn-mute');

function updateMuteButton() {
  const muted = !isSoundEnabled();
  const label = muted ? 'Unmute Alerts' : 'Mute Alerts';
  const glyphClass = muted ? 'menu-item-glyph menu-item-glyph-muted' : 'menu-item-glyph';
  btnMute.innerHTML = `<span class="${glyphClass}">\u266A</span>${label}`;
}
updateMuteButton();

btnMute.addEventListener('click', (e) => {
  e.stopPropagation();
  setSoundEnabled(!isSoundEnabled());
  updateMuteButton();
});

// ── Layout toggle ─────────────────────────────────────────

const sessionsContainer = document.getElementById('sessions-container');

function applyLayout(layoutId) {
  sessionsContainer.classList.toggle('layout-split', layoutId === 'split');
  setLayoutMode(layoutId);
}

// Auto-switch layout based on session count: split for exactly 2, default otherwise
function autoLayout() {
  applyLayout(getSessionCount() === 2 ? 'split' : 'default');
}

// ── Window focus tracking (suppress server notifications when dashboard is visible) ──

let _focusDebounce = null;

function sendFocusState() {
  clearTimeout(_focusDebounce);
  _focusDebounce = setTimeout(() => {
    sendControlMsg({ type: 'focus-change', focused: document.hasFocus() });
  }, 150);
}

window.addEventListener('focus', sendFocusState);
window.addEventListener('blur', sendFocusState);
document.addEventListener('visibilitychange', sendFocusState);

// ── Health monitor ──────────────────────────────────────────

mountHealthMonitor(document.getElementById('health-footer-mount'));

// ── Boot ─────────────────────────────────────────────────────

connectControl();
