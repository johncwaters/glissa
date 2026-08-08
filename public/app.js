// ── Glissa Dashboard - Boot ───────────────────────────────────
// Thin entry point: wires modules together and boots the app.

import '@xterm/xterm/css/xterm.css';
import './tailwind.css';

import { STATES } from '/shared/states.mjs';
import { connectControl, disableReconnect, onControlMessage, sendControlMsg, sendControlRequest, setConnectionStateCallback } from './control-ws.js';
import { createAddSessionDialog, createConfirmDialog, createSettingsDialog } from './dialogs.js';
import { writeClipboardText } from './dom-helpers.js';
import { activateFocusView, deactivateFocusView, focusAdjacentInRail, focusNextAttention, focusNthInRail, focusSessionInCenter, isFocusActive, mountFocusView, noteKnownProjectPath, refreshFocusRoster, restoreFocusedSession, setFocusMergeStatus } from './focus-view/focus-view.js';
import { applyHealthSnapshot, mountHealthMonitor } from './health-monitor.js';
import { initNotifications, showDesktopNotification } from './notifications.js';
import { handleDebugStateRefresh, handleDebugStateResponse } from './session-card/card-dom.js';
import { applyState, applyTerminalSettings, createSessionCard, getSessionCount, hasSession, removeSessionCard, renameSessionCard, seedSessionMergeStatus, setSessionAgents, setSessionDiff, setSessionEffectiveBase, setSessionMergeStatus, setSessionPostTurn, setSessionPrompt, setSessionResume, setSessionWakeup, setSessionWorktree, updateAggregateStatus } from './session-card/lifecycle.js';
import { reconnectDataWs } from './session-card/terminal.js';
import { showErrorToast } from './session-card/toast.js';
import { forgetReviewSession, mergeSelectedSession, mountReviewSidebar, notifyWorktreeChanged, refreshReviewSidebar, resolveSelectedSession, resyncSelectedSession, setReviewBranchSync } from './sidebar/review-sidebar.js';
import { handleTeamMessage, mountTeamsView, refreshTeamsProjects, setTabActivityCallback } from './teams-panel.js';
import { applyTheme } from './theme.js';
import { getActiveView, getThemeId, isSoundEnabled, setActiveView, setSoundEnabled } from './ui-prefs.js';

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
  // transitionend never fires under reduced-motion / no computed transition; the timeout is the
  // fallback so the overlay node cannot persist. remove() on an already-removed node is a no-op.
  const removeLoading = () => loadingScreen.remove();
  loadingScreen.addEventListener('transitionend', removeLoading, { once: true });
  setTimeout(removeLoading, 1000);
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
      .then((msg) => {
        if (!msg.settings) return;
        applyTerminalSettings(msg.settings);
      })
      .catch(() => {});
    return;
  }
  if (state === 'shutdown') {
    if (appRevealed) {
      shutdownStatus.textContent = 'Server shut down';
      shutdownScreen.classList.add('done');
      return;
    }
    loadingStatus.textContent = 'Server shut down';
    return;
  }
  if (state === 'disconnected' && shutdownScreen.classList.contains('active')) {
    // Restart: server dropped connection, waiting for it to come back
    shutdownStatus.textContent = 'Waiting for server...';
    return;
  }
  if (!appRevealed) loadingStatus.textContent = 'Reconnecting to server...';
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
    if (!s.ephemeral) noteKnownProjectPath(s.path); // remember the project so its rail group survives a last-session close
    const exists = hasSession(s.id);
    if (exists) applyState(s.id, s.state);
    if (!exists) createSessionCard(s.id, s.name, s.state, { skipPerms: !!s.dangerouslySkipPermissions, worktree: !!s.isWorktree, path: s.path, resume: !!s.resumeSessionId });
    // Restore the "resumed" marker on reconnect (the binding lives on the server; the badge does not).
    setSessionResume(s.id, s.resumeSessionId);
    // Hydrate the review sidebar's status/count from the snapshot (quiet: no auto-open on reconnect).
    seedSessionMergeStatus(s.id, s.mergeStatus);
    setSessionEffectiveBase(s.id, s.effectiveBase);
    // Restore the live background sub-agent chip on reconnect (Glissa reloads on every restart).
    setSessionAgents(s.id, s.activeAgents);
    // Restore the pending scheduled-revival chip the same way.
    setSessionWakeup(s.id, s.pendingWakeup);
    // Restore the advisory pending-prompt-kind chip the same way.
    setSessionPrompt(s.id, s.pendingPromptKind);
  }
  updateAggregateStatus();

  // Focus can be the active view when the initial snapshot lands; rebuild its rail from the new cards,
  // then restore the session the operator had open (the boot/reload race: the saved session does not
  // exist until this first snapshot populates the cards). The empty state ("Nothing to focus") lives
  // in the Focus view itself, so no grid placeholder here.
  const focusActive = isFocusActive();
  if (focusActive) { refreshFocusRoster(); restoreFocusedSession(); }
  // Teams may have been restored as the active view at boot, before knownProjects was populated, so its
  // project picker was seeded empty; refill it in place now that the snapshot has arrived.
  if (!focusActive && _activeView === 'teams') refreshTeamsProjects(getKnownProjects());
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
    // Read path off the old card BEFORE removeSessionCard detaches it. Nothing re-populates path
    // after the rebuild (unlike worktree, which rides a later session-git delta), so a DORMANT
    // round-trip would otherwise drop the session into the rail's (no path) group.
    const path = card ? card.dataset.path : undefined;
    removeSessionCard(msg.id);
    createSessionCard(msg.id, msg.session, STATES.DORMANT, { skipPerms, path });
    if (isFocusActive()) refreshFocusRoster();
    refreshReviewSidebar(msg.id);
    return;
  }

  applyState(msg.id, msg.to);
  // Re-evaluate the review sidebar's merge gate: it is state-dependent (isMergeableLive), so a turn
  // ending RUNNING -> COMPLETE must surface the Merge button without the operator clicking a file, and
  // COMPLETE -> RUNNING must withdraw it. No-op unless this session is selected.
  refreshReviewSidebar(msg.id);
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
  'session-added':      (msg) => { if (!msg.ephemeral) { knownProjects.set(msg.id, msg.session); noteKnownProjectPath(msg.path); } if (!hasSession(msg.id)) { createSessionCard(msg.id, msg.session, msg.state, { skipPerms: !!msg.skipPerms, worktree: !!msg.worktree, path: msg.path, resume: !!msg.resumeSessionId }); } if (isFocusActive()) refreshFocusRoster(); },
  'session-removed':    (msg) => { knownProjects.delete(msg.id); removeSessionCard(msg.id); forgetReviewSession(msg.id); if (isFocusActive()) refreshFocusRoster(); },
  'session-renamed':    (msg) => { if (knownProjects.has(msg.id)) knownProjects.set(msg.id, msg.newName); renameSessionCard(msg.id, msg.newName); },
  'session-modified':   (msg) => { if (!msg.ephemeral) { knownProjects.set(msg.id, msg.session); noteKnownProjectPath(msg.path); } removeSessionCard(msg.id); forgetReviewSession(msg.id); createSessionCard(msg.id, msg.session, msg.state, { skipPerms: !!msg.skipPerms, worktree: !!msg.worktree, path: msg.path, resume: !!msg.resumeSessionId }); if (isFocusActive()) refreshFocusRoster(); },
  'session-git':        (msg) => setSessionWorktree(msg.id, !!msg.worktree),
  'session-resume':     (msg) => setSessionResume(msg.id, msg.resumeSessionId),
  // The agent count and a delivered notification both move the decision trace without any
  // state-change, so each refreshes the overlay too (a no-op unless it is open).
  'session-agents':     (msg) => { setSessionAgents(msg.id, msg.activeAgents); handleDebugStateRefresh(msg.id); },
  'session-wakeup':     (msg) => setSessionWakeup(msg.id, msg.pendingWakeup),
  'session-prompt':     (msg) => setSessionPrompt(msg.id, msg.pendingPromptKind),
  'session-merge-status': (msg) => { setSessionMergeStatus(msg.id, msg.mergeStatus); setFocusMergeStatus(msg.id, msg.mergeStatus); },
  'session-worktree-blocked': (msg) => { showErrorToast(`${msg.session}: ${msg.notice || 'integration branch not found'}`, { persist: true }); },
  'session-worktree-ready': () => {},
  'session-diff':       (msg) => { setSessionDiff(msg.id, { committed: msg.committed, uncommitted: msg.uncommitted, hasCommits: msg.hasCommits }); },
  'branch-sync-status': (msg) => setReviewBranchSync(msg.id, { branch: msg.branch, upstream: msg.upstream, state: msg.state, ahead: msg.ahead, behind: msg.behind, fetched: msg.fetched, action: msg.action, error: msg.error }),
  'session-changed':    (msg) => notifyWorktreeChanged(msg.id),
  'post-turn-result':   (msg) => setSessionPostTurn(msg.id, msg),
  'debug-state-response': (msg) => handleDebugStateResponse(msg),
  // msg.session carries the session id here (NotificationManager keys its entries by the id the
  // backend passes to trigger), so it is what the overlay refresh needs.
  'notify':             (msg) => { showDesktopNotification(msg); handleDebugStateRefresh(msg.session); },
  'update-available':   (msg) => showUpdateBanner(msg),
  'error':              (msg) => showErrorToast(msg.message, { persist: true }),
  'session-error':      (msg) => showErrorToast(`${msg.session}: ${msg.message}`, { persist: true }),
  'settings-updated':   (msg) => { if (msg.settings) applyTerminalSettings(msg.settings); },
  'health-snapshot':    (msg) => { if (msg.stats) applyHealthSnapshot(msg.stats); },
  'team-run-accepted':  (msg) => handleTeamMessage(msg),
  'team-run-started':   (msg) => handleTeamMessage(msg),
  'team-stage-started': (msg) => handleTeamMessage(msg),
  'team-stage-complete': (msg) => handleTeamMessage(msg),
  'team-run-cancelling': (msg) => handleTeamMessage(msg),
  'team-run-complete':  (msg) => handleTeamMessage(msg),
  'team-revise-round':  (msg) => handleTeamMessage(msg),
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

// Dismissible startup update notice. The banner is passive (never a desktop notification); it shows the
// running -> latest versions and the copy-pasteable update command. Dismiss hides it for this page load;
// it reappears on the next boot only while a newer version is still published.
let updateBannerDismissed = false;
function showUpdateBanner({ current, latest, command }) {
  if (updateBannerDismissed) return;
  const banner = document.getElementById('update-banner');
  if (!banner) return;
  document.getElementById('update-banner-text').textContent = `Update available: ${current} -> ${latest}`;
  document.getElementById('update-banner-cmd').textContent = command;
  banner.hidden = false;

  const copyBtn = document.getElementById('update-banner-copy');
  const flashLabel = (text) => {
    copyBtn.textContent = text;
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
  };
  copyBtn.onclick = () => {
    const write = writeClipboardText(command);
    if (!write) {
      flashLabel('Copy failed');
      return;
    }
    write
      .then(() => flashLabel('Copied'))
      .catch(() => flashLabel('Copy failed'));
  };
  document.getElementById('update-banner-dismiss').onclick = () => {
    updateBannerDismissed = true;
    banner.hidden = true;
  };
}

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

// The header ? button (next to the menu) opens Settings straight to the Shortcuts tab.
document.getElementById('btn-help').addEventListener('click', () => {
  createSettingsDialog('shortcuts');
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
  resizer: document.getElementById('focus-rail-resizer'),
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
  // Mirror the active view onto the body: terminal.js reads document.body.dataset.activeView to decide
  // whether a focused xterm releases Alt+W to the chrome triage handler (Focus) or treats it as a real
  // keystroke. Without this write it stays undefined and xterm swallows Alt+W whenever a terminal is focused.
  document.body.dataset.activeView = view;
  // Persist the active tab so a page reload returns to it (restored at boot below).
  setActiveView(view);
  for (const v of VIEW_TABS) {
    const selected = v.view === view;
    if (v.el) v.el.hidden = !selected;
    v.tab.setAttribute('aria-selected', String(selected));
    v.tab.tabIndex = selected ? 0 : -1;
  }
  // Leaving Focus returns the borrowed card to its off-screen home grid.
  if (prev === 'focus' && view !== 'focus') deactivateFocusView();
  if (view === 'teams') mountTeamsView(viewTeamsEl, getKnownProjects());
  if (view === 'focus') activateFocusView();
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

// Restore the last active view (Focus by default). Validate the saved view against VIEW_TABS so a
// stale id (e.g. the removed "sessions" grid) falls back to Focus. Call activateView (not a bare
// dataset set) so the view module activates; the snapshot that arrives later refreshes it and restores
// the centered session / Teams projects (see handleSnapshot).
const savedView = getActiveView();
activateView(VIEW_TABS.some((v) => v.view === savedView) ? savedView : 'focus');

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
// Alt+0 opens a new session; Alt+1..9 focuses the Nth session in the Focus rail; Alt+Up/Down moves to
// the previous/next session in the rail; Alt+W jumps to the next session that needs input (triage);
// Alt+M merges the session selected in the review sidebar; Alt+R hands a parked merge to its session,
// or - when nothing is parked - resyncs its project's base branch against its remote upstream (the
// keyboard paths to the sidebar's Merge / Resolve / Resync buttons).
// All drive the Focus center, the only session destination now that the Sessions grid view was removed.
// The Alt+<key> namespace is used on purpose: it collides with neither browser shortcuts (which switch
// tabs on Ctrl+digit, not Alt) nor VS Code defaults (Ctrl / Ctrl+Shift / F-key / chord based, Ctrl+1..3
// for editor groups). They must work WHILE the centered terminal holds keyboard focus - the normal
// Focus posture - so they are gated on a real text field (inline rename, a dialog), NOT on the terminal:
// terminal.js returns false for exactly these keys on the Focus view (see isFocusAltShortcut) so they
// bubble here instead of going to the PTY. NOTE: when you add or remove a shortcut below, update
// isFocusAltShortcut in focus-view/focus-shortcuts.mjs to keep the xterm skip in lockstep.
//
// xterm's focused element is its helper textarea; treat that as chrome (not a real input) so the
// shortcuts fire from the terminal, while a genuine INPUT/TEXTAREA/contentEditable still swallows them.
function isRealInputFocused() {
  const a = document.activeElement;
  if (!a) return false;
  if (a.isContentEditable) return true;
  return (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')
    && !a.classList.contains('xterm-helper-textarea');
}

document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  // Every shortcut here is a discrete action (triage-next, prev/next, jump to card, open the add
  // dialog), so honor only the initial press. Without this, holding the key (or a press long enough to
  // trip the OS auto-repeat) re-fires keydown and walks the list on each repeat, flicking past the
  // target instead of stopping on it.
  if (e.repeat) return;
  // A genuine text field (inline rename, a dialog) keeps the keystroke; the centered terminal does not,
  // so every shortcut works while the operator is watching a session there.
  if (isRealInputFocused()) return;

  // Alt+M: merge the session selected in the review sidebar. App-level (not gated on the Focus view, like
  // Alt+0) since the sidebar spans every view; the gate lives in mergeSelectedSession, which no-ops when
  // nothing is mergeable. We claim the binding either way so it never leaks an escape sequence to a PTY.
  if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    mergeSelectedSession();
    return;
  }
  // Alt+R: two actions share this binding, tried in order of urgency. First, hand a parked merge to the
  // agent in its worktree ("Resolve in session") - resolveSelectedSession no-ops unless the selection is
  // a parked, still-live session. Only when that no-ops (nothing parked) does Alt+R fall through to
  // Resync (fetch + fast-forward/push the project's base branch against its remote); resyncSelectedSession
  // is its own no-op when nothing is actionable. Same app-level posture as Alt+M either way.
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    if (!resolveSelectedSession()) resyncSelectedSession();
    return;
  }
  if ((e.key === 'w' || e.key === 'W') && isFocusActive()) {
    e.preventDefault();
    focusNextAttention();
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (!isFocusActive()) return;
    e.preventDefault();
    focusAdjacentInRail(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
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

// '?' opens the keyboard-shortcuts help (Settings -> Shortcuts), the near-universal convention. Unlike
// the Alt shortcuts above, '?' is a literal character an operator types into a session terminal, so it
// fires ONLY from dashboard chrome: a text field OR a focused terminal suppresses it (the header ?
// button covers the terminal-focused case). Skip if a dialog is already open so it never stacks. The
// shortcut list it shows is sourced from public/shortcuts.mjs.
function isTextEntryContext() {
  const a = document.activeElement;
  if (!a) return false;
  if (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable) return true;
  return !!a.closest?.('.terminal-wrap');
}

document.addEventListener('keydown', (e) => {
  if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (isTextEntryContext()) return;
  if (document.querySelector('.dialog-overlay')) return; // a dialog is already open
  e.preventDefault();
  createSettingsDialog('shortcuts');
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
