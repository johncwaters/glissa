// ── Glissa Dashboard - Boot ───────────────────────────────────
// Thin entry point: wires modules together and boots the app.

import '@xterm/xterm/css/xterm.css';
import './tailwind.css';

import { STATES } from '/shared/states.mjs';
import { connectControl, disableReconnect, onControlMessage, sendControlMsg, sendControlRequest, setConnectionStateCallback } from './control-ws.js';
import { createAddSessionDialog, createConfirmDialog, createSettingsDialog } from './dialogs.js';
import { activateFocusView, deactivateFocusView, focusNextAttention, focusNthInRail, focusSessionInCenter, isFocusActive, mountFocusView, refreshFocusRoster, setFocusMergeStatus } from './focus-view/focus-view.js';
import { applyHealthSnapshot, mountHealthMonitor } from './health-monitor.js';
import { initNotifications, showDesktopNotification } from './notifications.js';
import { handleDebugStateRefresh, handleDebugStateResponse } from './session-card/card-dom.js';
import { applyState, applyTerminalSettings, createSessionCard, getSessionCount, hasSession, removeSessionCard, renameSessionCard, seedSessionMergeStatus, setSessionAgents, setSessionDiff, setSessionMergeStatus, setSessionPostTurn, setSessionWorktree, updateAggregateStatus } from './session-card/lifecycle.js';
import { reconnectDataWs } from './session-card/terminal.js';
import { showErrorToast } from './session-card/toast.js';
import { forgetReviewSession, mountReviewSidebar, refreshReviewSidebar } from './sidebar/review-sidebar.js';
import { handleTeamMessage, mountTeamsView, setTabActivityCallback } from './teams-panel.js';
import { applyTheme } from './theme.js';
import { getThemeId, isSoundEnabled, setSoundEnabled } from './ui-prefs.js';

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
      // Reconnected after restart - reload for fresh state
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

// Real projects (id -> name) for the Teams panel project picker. Ephemeral team-stage sessions
// (id like "team:<run>:<stage>") are excluded - they are transient run cards, not run targets.
const knownProjects = new Map();
function getKnownProjects() {
  return [...knownProjects].map(([id, name]) => ({ id, name }));
}

function handleSnapshot(sessions) {
  knownProjects.clear();
  for (const s of (sessions || [])) {
    if (!s.ephemeral) knownProjects.set(s.id, s.name);
  }

  for (const s of (sessions || [])) {
    if (hasSession(s.id)) {
      applyState(s.id, s.state);
    } else {
      createSessionCard(s.id, s.name, s.state, { skipPerms: !!s.dangerouslySkipPermissions, worktree: !!s.isWorktree });
    }
    // Hydrate the review sidebar's status/count from the snapshot (quiet: no auto-open on reconnect).
    seedSessionMergeStatus(s.id, s.mergeStatus);
    // Restore the live background sub-agent chip on reconnect (Glissa reloads on every restart).
    setSessionAgents(s.id, s.activeAgents);
  }
  updateAggregateStatus();

  // Focus can be the active view when the initial snapshot lands; rebuild its rail from the new cards.
  // The empty state ("Nothing to focus") lives in the Focus view itself, so no grid placeholder here.
  if (isFocusActive()) refreshFocusRoster();
}

function handleStateChange(msg) {
  if (!hasSession(msg.id)) {
    createSessionCard(msg.id, msg.session, msg.to, { skipPerms: !!msg.skipPerms });
    return;
  }

  // Close-out reset: a finished session returning to DORMANT is rebuilt as a dormant card (no live
  // terminal) in the off-screen grid home, reusing the well-tested create path instead of mutating a
  // live card. skipPerms is read off the existing card so the YOLO badge survives the rebuild.
  if (msg.to === STATES.DORMANT && msg.from !== STATES.DORMANT) {
    const card = document.querySelector(`.session-card[data-id="${CSS.escape(msg.id)}"]`);
    const skipPerms = card ? card.dataset.skipPerms !== undefined : false;
    removeSessionCard(msg.id);
    createSessionCard(msg.id, msg.session, STATES.DORMANT, { skipPerms });
    if (isFocusActive()) refreshFocusRoster();
    refreshReviewSidebar(msg.id);
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
  'session-added':      (msg) => { if (!msg.ephemeral) knownProjects.set(msg.id, msg.session); if (!hasSession(msg.id)) { createSessionCard(msg.id, msg.session, msg.state, { skipPerms: !!msg.skipPerms, worktree: !!msg.worktree }); } if (isFocusActive()) refreshFocusRoster(); },
  'session-removed':    (msg) => { knownProjects.delete(msg.id); removeSessionCard(msg.id); forgetReviewSession(msg.id); if (isFocusActive()) refreshFocusRoster(); },
  'session-renamed':    (msg) => { if (knownProjects.has(msg.id)) knownProjects.set(msg.id, msg.newName); renameSessionCard(msg.id, msg.newName); },
  'session-modified':   (msg) => { if (!msg.ephemeral) knownProjects.set(msg.id, msg.session); removeSessionCard(msg.id); forgetReviewSession(msg.id); createSessionCard(msg.id, msg.session, msg.state, { skipPerms: !!msg.skipPerms, worktree: !!msg.worktree }); if (isFocusActive()) refreshFocusRoster(); },
  'session-git':        (msg) => setSessionWorktree(msg.id, !!msg.worktree),
  'session-agents':     (msg) => setSessionAgents(msg.id, msg.activeAgents),
  'session-merge-status': (msg) => { setSessionMergeStatus(msg.id, msg.mergeStatus); setFocusMergeStatus(msg.id, msg.mergeStatus); },
  'session-worktree-blocked': (msg) => { showErrorToast(`${msg.session}: ${msg.notice || 'integration branch not found'}`); },
  'session-worktree-ready': () => {},
  'session-diff':       (msg) => { setSessionDiff(msg.id, { committed: msg.committed, uncommitted: msg.uncommitted, hasCommits: msg.hasCommits }); },
  'post-turn-result':   (msg) => setSessionPostTurn(msg.id, msg),
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
    // The guided-setup session is an interactive terminal; jump to Focus and pull it into the center
    // so the operator can answer the interview instead of the click appearing to do nothing.
    if (msg.sessionId) {
      activateView('focus'); // synchronous; activates Focus so the borrow below has a live center
      focusSessionInCenter(msg.sessionId);
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

// ── Primary view tabs (Focus / Teams) ─────────────────────

const viewTeamsEl = document.getElementById('view-teams');
const viewFocusEl = document.getElementById('view-focus');
const tabTeams = document.getElementById('tab-teams');
const tabFocus = document.getElementById('tab-focus');
const tabActivityEl = document.getElementById('tab-teams-activity');

setTabActivityCallback((active) => { tabActivityEl.classList.toggle('active', active); });

mountFocusView({
  rail: document.getElementById('focus-rail'),
  center: document.getElementById('focus-center'),
});

mountReviewSidebar({ panel: document.getElementById('review-sidebar') });

// Primary views in tab-strip order. Adding a view = adding an entry here (N-way, not a boolean).
// Focus leads as the default landing view; the session-card grid (#sessions-container) stays mounted
// off-screen as the canonical card home Focus borrows from - it is no longer a navigable view.
const VIEW_TABS = [
  { view: 'focus', tab: tabFocus, el: viewFocusEl },
  { view: 'teams', tab: tabTeams, el: viewTeamsEl },
];

let _activeView = 'focus';

function activateView(view) {
  const prev = _activeView;
  _activeView = view;
  for (const v of VIEW_TABS) {
    const selected = v.view === view;
    if (v.el) v.el.hidden = !selected;
    v.tab.setAttribute('aria-selected', String(selected));
    v.tab.tabIndex = selected ? 0 : -1;
  }
  // Leaving Focus returns the borrowed card to its off-screen home grid.
  if (prev === 'focus' && view !== 'focus') deactivateFocusView();
  if (view === 'teams') {
    mountTeamsView(viewTeamsEl, getKnownProjects());
  } else if (view === 'focus') {
    activateFocusView();
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

// Land on Focus by default. Call activateView (not a bare dataset set) so the Focus module activates
// and builds its roster; the snapshot that arrives later refreshes it (see handleSnapshot).
activateView('focus');

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

// ── Keyboard shortcuts (chrome-level) ─────────────────────────
// Alt+0 opens a new session; Alt+1..9 focuses the Nth session in the Focus rail; Alt+W jumps
// to the next session that needs input (triage). Both drive the Focus center, the only session
// destination now that the Sessions grid view was removed. The Alt+<key> namespace is used
// on purpose: it collides with neither browser shortcuts (which switch tabs on
// Ctrl+digit, not Alt) nor VS Code defaults (which are Ctrl / Ctrl+Shift / F-key /
// chord based, and use Ctrl+1..3 for editor groups). Guarded so they never reach a
// focused xterm - its key handling lives in terminal.js and forwards most keys to
// the PTY - so these fire only when the operator is on the dashboard chrome.
function isTypingContext() {
  const a = document.activeElement;
  if (!a) return false;
  if (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable) return true;
  return !!(a.closest && a.closest('.terminal-wrap'));
}

document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  // Every shortcut here is a discrete action (triage-next, jump to card, open the add dialog), so
  // honor only the initial press. Without this, holding Alt+W (or a press long enough to trip the OS
  // auto-repeat) re-fires keydown and walks the round-robin on each repeat, so two waiting sessions
  // flicker past instead of stopping on the first.
  if (e.repeat) return;

  // Focus-tab triage (Alt+W -> next session needing you, borrowed into the center) must work even
  // while the centered terminal holds keyboard focus - that is the expected place to be while
  // triaging - so it runs BEFORE the typing guard. xterm's focused element is its helper textarea;
  // treat that as not-a-real-input so triage fires there, but a genuine text field (inline rename,
  // a dialog) still swallows Alt+W. terminal.js returns false for this key so it reaches here.
  if ((e.key === 'w' || e.key === 'W') && isFocusActive()) {
    const a = document.activeElement;
    const realInput = a && (a.isContentEditable
      || ((a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')
          && !a.classList.contains('xterm-helper-textarea')));
    if (!realInput) { e.preventDefault(); focusNextAttention(); return; }
  }

  if (isTypingContext()) return;

  if (e.key === '0') {
    e.preventDefault();
    document.getElementById('btn-add-session-header')?.click();
    return;
  }
  if (e.key >= '1' && e.key <= '9') {
    if (!isFocusActive()) return;
    e.preventDefault();
    focusNthInRail(Number(e.key));
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
