// ── Glissa Dashboard — Boot ───────────────────────────────────
// Thin entry point: wires modules together and boots the app.

import '@xterm/xterm/css/xterm.css';
import './tailwind.css';

import { STATES } from '/shared/states.mjs';
import { connectControl, disableReconnect, onControlMessage, sendControlMsg, sendControlRequest, setConnectionStateCallback } from './control-ws.js';
import { createAddSessionDialog, createConfirmDialog, createSettingsDialog } from './dialogs.js';
import { applyHealthSnapshot, mountHealthMonitor } from './health-monitor.js';
import { initNotifications, showDesktopNotification } from './notifications.js';
import { handleDebugStateRefresh, handleDebugStateResponse } from './session-card/card-dom.js';
import { exitMaximizeMode, isMaximizeActive, setLayoutMode } from './session-card/layout.js';
import { applyState, applyTerminalSettings, createSessionCard, focusNextWaiting, focusSessionCard, getSessionCount, handleSessionsReordered, hasSession, removeSessionCard, renameSessionCard, setSessionDiff, setSessionMergeStatus, setSessionPostTurn, setSessionWorktree, updateAggregateStatus } from './session-card/lifecycle.js';
import { reconnectDataWs } from './session-card/terminal.js';
import { showErrorToast } from './session-card/toast.js';
import { handleTeamMessage, mountTeamsView, setTabActivityCallback } from './teams-panel.js';
import { activateFocusView, deactivateFocusView, isFocusActive, mountFocusView, refreshFocusRoster, setFocusMergeStatus } from './focus-view/focus-view.js';
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
    // Fetch terminal settings on initial connect to apply cursorBlink/debugMode
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
      document.getElementById('btn-add-session-header')?.click();
    });
    updateAggregateStatus();
  } else {
    for (const s of sessions) {
      if (hasSession(s.id)) {
        applyState(s.id, s.state);
      } else {
        createSessionCard(s.id, s.name, s.state, { skipPerms: !!s.dangerouslySkipPermissions, worktree: !!s.isWorktree });
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
  if (isFocusActive()) refreshFocusRoster();

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
  'session-added':      (msg) => { if (!msg.ephemeral) knownProjects.set(msg.id, msg.session); if (!hasSession(msg.id)) { clearEmptyPlaceholder(); createSessionCard(msg.id, msg.session, msg.state, { skipPerms: !!msg.skipPerms, worktree: !!msg.worktree }); } autoLayout(); if (isFocusActive()) refreshFocusRoster(); },
  'session-removed':    (msg) => { knownProjects.delete(msg.id); removeSessionCard(msg.id); autoLayout(); if (isFocusActive()) refreshFocusRoster(); },
  'session-renamed':    (msg) => { if (knownProjects.has(msg.id)) knownProjects.set(msg.id, msg.newName); renameSessionCard(msg.id, msg.newName); },
  'session-modified':   (msg) => { if (!msg.ephemeral) knownProjects.set(msg.id, msg.session); removeSessionCard(msg.id); clearEmptyPlaceholder(); createSessionCard(msg.id, msg.session, msg.state, { skipPerms: !!msg.skipPerms, worktree: !!msg.worktree }); autoLayout(); if (isFocusActive()) refreshFocusRoster(); },
  'session-git':        (msg) => setSessionWorktree(msg.id, !!msg.worktree),
  'session-merge-status': (msg) => { setSessionMergeStatus(msg.id, msg.mergeStatus); setFocusMergeStatus(msg.id, msg.mergeStatus); },
  'session-worktree-blocked': (msg) => { showErrorToast(`${msg.session}: ${msg.notice || 'integration branch not found'}`); },
  'session-worktree-ready': () => {},
  'session-diff':       (msg) => { setSessionDiff(msg.id, msg.stat, msg.diff); },
  'post-turn-result':   (msg) => setSessionPostTurn(msg.id, msg),
  'sessions-reordered': (msg) => handleSessionsReordered(msg.order),
  'debug-state-response': (msg) => handleDebugStateResponse(msg),
  'notify':             (msg) => showDesktopNotification(msg),
  'error':              (msg) => showErrorToast(msg.message),
  'session-error':      (msg) => showErrorToast(`${msg.session}: ${msg.message}`),
  'settings-updated':   (msg) => { if (msg.settings) applyTerminalSettings(msg.settings); },
  'health-snapshot':    (msg) => { if (msg.stats) applyHealthSnapshot(msg.stats); },
  'team-run-accepted':  (msg) => handleTeamMessage(msg),
  'team-run-started':   (msg) => handleTeamMessage(msg),
  'team-stage-started': (msg) => handleTeamMessage(msg),
  'team-stage-complete': (msg) => handleTeamMessage(msg),
  'team-run-cancelling': (msg) => handleTeamMessage(msg),
  'team-run-complete':  (msg) => handleTeamMessage(msg),
  'team-run-failed':    (msg) => handleTeamMessage(msg),
  'team-run-skipped':   (msg) => handleTeamMessage(msg),
  'team-run-needs-setup': (msg) => handleTeamMessage(msg),
  'team-chat-message':  (msg) => handleTeamMessage(msg),
  'team-run-awaiting-input': (msg) => handleTeamMessage(msg),
  'team-run-resumed':   (msg) => handleTeamMessage(msg),
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

document.getElementById('btn-add-session-header').addEventListener('click', createAddSessionDialog);

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
const viewFocusEl = document.getElementById('view-focus');
const tabSessions = document.getElementById('tab-sessions');
const tabTeams = document.getElementById('tab-teams');
const tabFocus = document.getElementById('tab-focus');
const tabActivityEl = document.getElementById('tab-teams-activity');

setTabActivityCallback((active) => { tabActivityEl.classList.toggle('active', active); });

mountFocusView({
  rail: document.getElementById('focus-rail'),
  center: document.getElementById('focus-center'),
});

// Primary views in tab-strip order. Adding a view = adding an entry here (N-way, not a boolean).
const VIEW_TABS = [
  { view: 'sessions', tab: tabSessions, el: null },
  { view: 'teams',    tab: tabTeams,    el: viewTeamsEl },
  { view: 'focus',    tab: tabFocus,    el: viewFocusEl },
];

let _activeView = 'sessions';

function activateView(view) {
  const prev = _activeView;
  _activeView = view;
  document.body.dataset.activeView = view;
  for (const v of VIEW_TABS) {
    const selected = v.view === view;
    if (v.el) v.el.hidden = !selected;
    v.tab.setAttribute('aria-selected', String(selected));
    v.tab.tabIndex = selected ? 0 : -1;
  }
  // Leaving Focus returns the borrowed card to the grid BEFORE we re-layout the Sessions view.
  if (prev === 'focus' && view !== 'focus') deactivateFocusView();
  if (view === 'teams') {
    mountTeamsView(viewTeamsEl, getKnownProjects());
  } else if (view === 'focus') {
    // Clear any Sessions-view maximize so its module-global state doesn't dangle while Focus borrows
    // a card into the center (otherwise the Sessions view returns in a half-maximized layout).
    exitMaximizeMode();
    activateFocusView();
  } else {
    // Session terminals were display:none under another tab — re-fit on return.
    autoLayout();
  }
}

for (let i = 0; i < VIEW_TABS.length; i++) {
  const { view, tab } = VIEW_TABS[i];
  tab.addEventListener('click', () => activateView(view));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = (i + dir + VIEW_TABS.length) % VIEW_TABS.length;
    activateView(VIEW_TABS[next].view);
    VIEW_TABS[next].tab.focus();
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

// ── Layout (always auto) ──────────────────────────────────
// The arrangement always follows the live session count: exactly two sessions
// sit side-by-side (split), any other count is a grid. No operator toggle.

const sessionsContainer = document.getElementById('sessions-container');

function applyLayout(layoutId) {
  sessionsContainer.classList.toggle('layout-split', layoutId === 'split');
  setLayoutMode(layoutId);
}

function autoLayout() {
  applyLayout(getSessionCount() === 2 ? 'split' : 'default');
}

// ── Keyboard shortcuts (chrome-level) ─────────────────────────
// Alt+0 opens a new session; Alt+1..9 jumps to the Nth session card; Alt+W jumps
// to the next session that needs input (triage). The Alt+<key> namespace is used
// on purpose: it collides with neither browser shortcuts (which switch tabs on
// Ctrl+digit, not Alt) nor VS Code defaults (which are Ctrl / Ctrl+Shift / F-key /
// chord based, and use Ctrl+1..3 for editor groups). Guarded so they never reach a
// focused xterm — its key handling lives in terminal.js and forwards most keys to
// the PTY — so these fire only when the operator is on the dashboard chrome.
function isTypingContext() {
  const a = document.activeElement;
  if (!a) return false;
  if (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable) return true;
  return !!(a.closest && a.closest('.terminal-wrap'));
}

document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (isTypingContext()) return;

  if (e.key === '0') {
    e.preventDefault();
    document.getElementById('btn-add-session-header')?.click();
    return;
  }
  if (e.key === 'w' || e.key === 'W') {
    e.preventDefault();
    focusNextWaiting();
    return;
  }
  if (e.key >= '1' && e.key <= '9') {
    const cards = [...sessionsContainer.querySelectorAll('.session-card')]
      .filter((c) => !c.classList.contains('drop-zone-placeholder'));
    const card = cards[Number(e.key) - 1];
    if (card) {
      e.preventDefault();
      focusSessionCard(card.dataset.id);
    }
  }
});

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

// ── Desktop notifications ────────────────────────────────────

initNotifications();

// ── Boot ─────────────────────────────────────────────────────

connectControl();
