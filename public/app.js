// ── Glissa Dashboard - Boot ───────────────────────────────────
// Thin entry point: wires modules together and boots the app.

import '@xterm/xterm/css/xterm.css';
import './tailwind.css';

import { shouldShowServerAction } from '/shared/client-trust.mjs';
import { STATES } from '/shared/states.mjs';
import { connectControl, disableReconnect, onControlMessage, sendControlMsg, sendControlRequest, setConnectionStateCallback } from './control-ws.js';
import { createAddSessionDialog, createSettingsDialog } from './dialogs.js';
import { observeHeaderHeight, writeClipboardText } from './dom-helpers.js';
import { activateFocusView, centerSessionQuietly, deactivateFocusView, focusAdjacentInRail, focusNextAttention, focusNthInRail, getFocusedSessionId, isFocusActive, mountFocusView, noteKnownProjectPath, refreshFocusRoster, restoreFocusedSession, setFocusMergeStatus } from './focus-view/focus-view.js';
import { initFormFactor, isPhoneLayout, onLayoutChange } from './form-factor.js';
import { applyHealthSnapshot, mountHealthMonitor } from './health-monitor.js';
import { applyIngestActivity, applyIngestSnapshot, applyNavigatorComments, applyNavigatorFindings, applyNavigatorIntent, applyNavigatorSnapshot, mountNavigatorView, refreshNavigatorView, setNavigatorActivityCallback } from './navigator-panel.js';
import { initNotifications, showDesktopNotification } from './notifications.js';
import { activatePhoneShell, deactivatePhoneShell, getPhoneSessionId, isPhoneScreenActive, isPhoneShellActive, mountPhoneShell, refreshPhoneBoard, setPhoneScreenAttention, showPhoneScreen } from './phone/phone-shell.js';
import { acknowledgePrAttention, applyPrStatus, mountPrView, setPrActivityCallback } from './pr-panel.js';
// Radar is a SECOND consumer of the health, update and PR feeds: it summarizes what needs the operator,
// while the health footer, the update banner and the PRs tab keep rendering each feed in full.
import { updateBannerText } from './radar-core.mjs';
import { acknowledgeRadarAttention, applyHealthSnapshot as applyRadarHealth, applyPosthogStatus, applyPrStatus as applyRadarPrStatus, applyUpdateAvailable as applyRadarUpdate, mountRadarView, setRadarActivityCallback, setRadarNavigateToPrs } from './radar-panel.js';
import { handleDebugStateRefresh, handleDebugStateResponse } from './session-card/card-dom.js';
import { applyState, applyTerminalSettings, createSessionCard, getSessionCount, hasSession, notePackVersion, removeSessionCard, renameSessionCard, seedSessionMergeStatus, setLatestPackVersions, setSessionAgents, setSessionDiff, setSessionEffectiveBase, setSessionMergeStatus, setSessionPacks, setSessionPostTurn, setSessionPrompt, setSessionResume, setSessionUsage, setSessionWakeup, setSessionWorktree, updateAggregateStatus } from './session-card/lifecycle.js';
import { openConfirmDialog } from './session-card/modal.js';
import { reconnectDataWs } from './session-card/terminal.js';
import { showErrorToast } from './session-card/toast.js';
import { forgetReviewSession, mergeSelectedSession, mountReviewSidebar, notifyWorktreeChanged, refreshReviewSidebar, resolveSelectedSession, resyncSelectedSession, setReviewBranchSync } from './sidebar/review-sidebar.js';
import { applyTheme } from './theme.js';
import { getActiveView, getDismissedUpdate, getThemeId, isSoundEnabled, setActiveView, setDismissedUpdate, setSoundEnabled } from './ui-prefs.js';
import { acknowledgeUsageAttention, applyPlanLimits, applyUsageReport, applyUsageSessions, mountUsageView, refreshUsageView, requestUsageReport, setUsageActivityCallback, setUsageRequestSender } from './usage-panel.js';

// ── Apply saved theme ─────────────────────────────────────────

applyTheme(getThemeId());

// ── Form factor ──────────────────────────────────────────────
// Stamp <html data-layout> before anything else runs, so the first paint is already in the right one of
// the two first-class layouts (desktop three-panel, or the phone screen stack). Everything phone-shaped
// keys off that attribute; see form-factor-core.mjs for the rule.

initFormFactor();

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
    // A reload straight into the Usage tab (or a reconnect while it is open) has to ask for its own
    // report: the connect-time replay only carries one if the server already had a cached report.
    requestUsageReportIfVisible();
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

function handleSnapshot(sessions, packVersions) {
  // Before the per-session loop: the staleness chip compares each card's delivered pack versions
  // against this map, so the baseline has to be in place when the cards are hydrated below.
  setLatestPackVersions(packVersions);
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
    // The context packs this session was spawned against; stale once the mill rebuilds one.
    setSessionPacks(s.id, s.packs);
    // Usage rides no snapshot field, so the chip is restored from the last push instead.
    restoreUsageChip(s.id);
  }
  updateAggregateStatus();

  // Focus can be the active view when the initial snapshot lands; rebuild its rail from the new cards,
  // then restore the session the operator had open (the boot/reload race: the saved session does not
  // exist until this first snapshot populates the cards). The empty state ("Nothing to focus") lives
  // in the Focus view itself, so no grid placeholder here.
  if (isFocusActive()) { refreshFocusRoster(); restoreFocusedSession(); }
  // The phone Board reads the same registry these cards just populated; a no-op off the phone layout.
  refreshPhoneBoard();
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
    restoreUsageChip(msg.id);
    if (isFocusActive()) refreshFocusRoster();
    refreshPhoneBoard();
    refreshReviewSidebar(msg.id);
    return;
  }

  applyState(msg.id, msg.to);
  // Re-evaluate the review sidebar's merge gate: it is state-dependent (isMergeableLive), so a turn
  // ending RUNNING -> COMPLETE must surface the Merge button without the operator clicking a file, and
  // COMPLETE -> RUNNING must withdraw it. No-op unless this session is selected.
  refreshReviewSidebar(msg.id);
  if (isFocusActive()) refreshFocusRoster();
  refreshPhoneBoard();

  // Live-update debug overlay on state change
  handleDebugStateRefresh(msg.id);

  // On restart (INITIALIZING after DONE/FAILED), reconnect data WS for fresh PTY
  if (msg.to === STATES.INITIALIZING && (msg.from === STATES.DONE || msg.from === STATES.FAILED)) {
    reconnectDataWs(msg.id);
  }
}

// ── Usage ────────────────────────────────────────────────────
// usage-sessions is a small push (and a connect-time replay); the full report is pulled, so it is
// re-requested when the Usage surface is the one the operator is looking at and a delta says the
// numbers moved. Off-surface deltas still update the per-card chips and the tab dot for free.
// The last payload, kept because a card is REBUILT (a DORMANT round-trip, session-modified) far more
// often than the totals move, and an identical payload is suppressed server-side, so a rebuilt card
// would otherwise wear no chip until its next real spend.
const usageBySessionId = new Map();

function applyUsageSessionChips(rows) {
  const seen = new Set();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!row?.id) continue;
    seen.add(row.id);
    const usage = { tokens: row.tokens, costUSD: row.costUSD, officialCostUSD: row.officialCostUSD };
    usageBySessionId.set(row.id, usage);
    setSessionUsage(row.id, usage);
  }
  // A session the payload no longer accounts for (transcript pruned by retainDays, session removed)
  // must lose its chip rather than wear a frozen number forever.
  for (const id of [...usageBySessionId.keys()]) {
    if (seen.has(id)) continue;
    usageBySessionId.delete(id);
    setSessionUsage(id, null);
  }
}

function restoreUsageChip(sessionId) {
  const usage = usageBySessionId.get(sessionId);
  if (!usage) return;
  setSessionUsage(sessionId, usage);
}

setUsageRequestSender(sendControlMsg);

function isUsageSurfaceVisible() {
  if (isPhoneShellActive()) return isPhoneScreenActive('usage');
  return _activeView === 'usage';
}

function requestUsageReportIfVisible() {
  if (!isUsageSurfaceVisible()) return;
  requestUsageReport();
}

const messageHandlers = {
  'snapshot':           (msg) => handleSnapshot(msg.sessions, msg.packVersions),
  // A context pack finished rebuilding: every session still running an older version of it is now
  // stale. Nothing is done to the sessions themselves (see AGENTS.md "Context Packs").
  'pack-updated':       (msg) => notePackVersion(msg.name, msg.version),
  // The versions a spawn actually delivered, pushed as the session starts.
  'session-packs':      (msg) => setSessionPacks(msg.id, msg.packs),
  'state-change':       (msg) => handleStateChange(msg),
  'session-added':      (msg) => { if (!msg.ephemeral) noteKnownProjectPath(msg.path); if (!hasSession(msg.id)) { createSessionCard(msg.id, msg.session, msg.state, { skipPerms: !!msg.skipPerms, worktree: !!msg.worktree, path: msg.path, resume: !!msg.resumeSessionId }); restoreUsageChip(msg.id); } if (isFocusActive()) refreshFocusRoster(); refreshPhoneBoard(); },
  'session-removed':    (msg) => { removeSessionCard(msg.id); forgetReviewSession(msg.id); if (isFocusActive()) refreshFocusRoster(); refreshPhoneBoard(); },
  'session-renamed':    (msg) => { renameSessionCard(msg.id, msg.newName); refreshPhoneBoard(); },
  'session-modified':   (msg) => { if (!msg.ephemeral) noteKnownProjectPath(msg.path); removeSessionCard(msg.id); forgetReviewSession(msg.id); createSessionCard(msg.id, msg.session, msg.state, { skipPerms: !!msg.skipPerms, worktree: !!msg.worktree, path: msg.path, resume: !!msg.resumeSessionId }); restoreUsageChip(msg.id); if (isFocusActive()) refreshFocusRoster(); refreshPhoneBoard(); },
  'session-git':        (msg) => setSessionWorktree(msg.id, !!msg.worktree),
  'session-resume':     (msg) => setSessionResume(msg.id, msg.resumeSessionId),
  // The agent count and a delivered notification both move the decision trace without any
  // state-change, so each refreshes the overlay too (a no-op unless it is open).
  'session-agents':     (msg) => { setSessionAgents(msg.id, msg.activeAgents); handleDebugStateRefresh(msg.id); },
  'session-wakeup':     (msg) => setSessionWakeup(msg.id, msg.pendingWakeup),
  'session-prompt':     (msg) => setSessionPrompt(msg.id, msg.pendingPromptKind),
  'session-merge-status': (msg) => { setSessionMergeStatus(msg.id, msg.mergeStatus); setFocusMergeStatus(msg.id, msg.mergeStatus); refreshPhoneBoard(); },
  'session-worktree-blocked': (msg) => { showErrorToast(`${msg.session}: ${msg.notice || 'integration branch not found'}`, { persist: true }); },
  'session-diff':       (msg) => { setSessionDiff(msg.id, { committed: msg.committed, uncommitted: msg.uncommitted, hasCommits: msg.hasCommits }); },
  'branch-sync-status': (msg) => setReviewBranchSync(msg.id, { branch: msg.branch, upstream: msg.upstream, state: msg.state, ahead: msg.ahead, behind: msg.behind, fetched: msg.fetched, action: msg.action, error: msg.error }),
  'session-changed':    (msg) => notifyWorktreeChanged(msg.id),
  'post-turn-result':   (msg) => setSessionPostTurn(msg.id, msg),
  'debug-state-response': (msg) => handleDebugStateResponse(msg),
  // msg.session carries the session id here (NotificationManager keys its entries by the id the
  // backend passes to trigger), so it is what the overlay refresh needs.
  'notify':             (msg) => { showDesktopNotification(msg); handleDebugStateRefresh(msg.session); },
  'update-available':   (msg) => { showUpdateBanner(msg); applyRadarUpdate(msg); },
  'error':              (msg) => showErrorToast(msg.message, { persist: true }),
  'session-error':      (msg) => showErrorToast(`${msg.session}: ${msg.message}`, { persist: true }),
  'settings-updated':   (msg) => { if (msg.settings) applyTerminalSettings(msg.settings); },
  'health-snapshot':    (msg) => { if (msg.stats) { applyHealthSnapshot(msg.stats); applyRadarHealth(msg.stats); } },
  'posthog-status':     (msg) => applyPosthogStatus(msg),
  'pr-status':          (msg) => { applyPrStatus(msg); applyRadarPrStatus(msg); },
  'usage-sessions':     (msg) => { applyUsageSessionChips(msg.sessions); applyUsageSessions(msg); requestUsageReportIfVisible(); },
  'usage-report':       (msg) => applyUsageReport(msg),
  // Official account rate limits from the managed statusLine relay (machine-wide, not per session).
  'plan-limits':        (msg) => applyPlanLimits(msg),
  // A budget threshold was crossed. A moment, not a state: deliberately absent from the control replay log
  // (server/control-replay-core.js REPLAYABLE_EXACT), so a reconnect never re-alerts a past crossing. The
  // claim key is scope + period + threshold, so every open tab raises it at most once.
  'usage-budget-alert': (msg) => showDesktopNotification({
    session: `budget-${msg.scope}-${msg.periodKey}`,
    category: `threshold-${msg.threshold}`,
    message: msg.text,
    ignoreFocus: true,
  }),
  // Navigator lane. The per-uri push carries one document's current findings (empty clears it); the
  // snapshot is the whole map, sent on every connect so a reconnect repairs the tab in one frame.
  'navigator-findings': (msg) => applyNavigatorFindings(msg),
  // Tier 3 model comments for one uri, pushed when a dispatch lands (empty clears that uri).
  'navigator-comments': (msg) => applyNavigatorComments(msg),
  // The machine-wide intent statement, pushed whenever it actually moves (model proposal or correction).
  'navigator-intent':   (msg) => applyNavigatorIntent(msg),
  'navigator-snapshot': (msg) => applyNavigatorSnapshot(msg),
  // Ingest lane. One batched delta per second at most (overflow inside the window arrives as a count),
  // and a snapshot on every connect: like the navigator's, the deltas are deliberately not replayable,
  // because the snapshot repairs the whole feed in one frame.
  'ingest-activity':    (msg) => applyIngestActivity(msg),
  'ingest-snapshot':    (msg) => applyIngestSnapshot(msg),
  'client-trust':       (msg) => applyClientTrust(msg.trust),
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

// Dismissible update notice. The banner is passive (never a desktop notification); it shows the running
// -> latest commit, a compare link, and the copy-pasteable update command for this install flavor.
// Dismiss is keyed on the latest commit and persisted, so it stays dismissed until a NEWER tip arrives.
// The Radar ops row is deliberately not gated by the dismissal: that panel is where a dismissed advisory
// remains findable.
let updateBannerDismissed = false;

// What a dismissal remembers. The commit is the identity of the update; the version string is the
// fallback for an install whose commit could not be resolved.
function updateIdentity({ latestSha, latest }) {
  if (typeof latestSha === 'string' && latestSha) return latestSha;
  if (typeof latest === 'string' && latest) return latest;
  return null;
}

function showUpdateBanner(msg) {
  if (updateBannerDismissed) return;
  const identity = updateIdentity(msg);
  if (identity && getDismissedUpdate() === identity) return;
  const banner = document.getElementById('update-banner');
  if (!banner) return;
  const command = msg.command;
  document.getElementById('update-banner-text').textContent = updateBannerText(msg);
  document.getElementById('update-banner-cmd').textContent = command;
  const link = document.getElementById('update-banner-link');
  link.hidden = !msg.compareUrl;
  link.href = msg.compareUrl || '';
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
    setDismissedUpdate(identity);
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

observeHeaderHeight(document.querySelector('.header'));

document.getElementById('btn-settings').addEventListener('click', () => {
  headerMenu.classList.remove('open');
  syncMenuAria();
  createSettingsDialog();
});

// The header ? button (next to the menu) opens Settings straight to the Shortcuts tab.
document.getElementById('btn-help').addEventListener('click', () => {
  createSettingsDialog('shortcuts');
});

// ── Primary view tabs (Focus / Radar / PRs / Usage / Navigator) ────────

const viewFocusEl = document.getElementById('view-focus');
const viewRadarEl = document.getElementById('view-radar');
const viewPrsEl = document.getElementById('view-prs');
const viewUsageEl = document.getElementById('view-usage');
const viewNavigatorEl = document.getElementById('view-navigator');
const tabFocus = document.getElementById('tab-focus');
const tabRadar = document.getElementById('tab-radar');
const tabPrs = document.getElementById('tab-prs');
const tabUsage = document.getElementById('tab-usage');
const tabNavigator = document.getElementById('tab-navigator');
const tabRadarActivityEl = document.getElementById('tab-radar-activity');
const tabPrsActivityEl = document.getElementById('tab-prs-activity');
const tabUsageActivityEl = document.getElementById('tab-usage-activity');
const tabNavigatorActivityEl = document.getElementById('tab-navigator-activity');

setRadarActivityCallback((active) => {
  tabRadarActivityEl.classList.toggle('active', active);
  setPhoneScreenAttention('radar', active);
});
setPrActivityCallback((active) => {
  tabPrsActivityEl.classList.toggle('active', active);
  setPhoneScreenAttention('prs', active);
});
setUsageActivityCallback((active) => {
  tabUsageActivityEl.classList.toggle('active', active);
  setPhoneScreenAttention('usage', active);
});
// No phone counterpart to raise: the Navigator tab is desktop only in v1, so there is no screen to
// attach attention to.
setNavigatorActivityCallback((active) => {
  tabNavigatorActivityEl.classList.toggle('active', active);
});
// A Radar PR row points at the full PR view: the phone screen when that layout owns the panel, the
// desktop tab otherwise. Radar never navigates itself.
setRadarNavigateToPrs(() => {
  if (showPhoneScreen('prs')) return;
  activateView('prs');
});

mountFocusView({
  rail: document.getElementById('focus-rail'),
  center: document.getElementById('focus-center'),
  resizer: document.getElementById('focus-rail-resizer'),
});

mountReviewSidebar({ panel: document.getElementById('review-sidebar') });

// Mounted eagerly: a posthog-status broadcast can land while another tab is active, and the tab's
// attention dot has to reflect it without the operator ever opening Radar.
mountRadarView(viewRadarEl);

// Eager for the same reason as Radar: a pr-status broadcast can land while another tab is active, and
// the tab's attention dot has to reflect it without the operator ever opening PRs.
mountPrView(viewPrsEl);

// Eager for the same reason again: usage-sessions is pushed and the connect-time usage-report replay
// can land before the operator ever opens Usage, and its token-limit warning has to raise the tab dot
// from wherever they are.
mountUsageView(viewUsageEl);

// Eager for the same reason again: a navigator-findings push (or the connect-time snapshot) can land
// while another tab is active, and the dot has to say so from wherever the operator is.
mountNavigatorView(viewNavigatorEl);

// Primary views in tab-strip order. Adding a view = adding an entry here (N-way, not a boolean).
// Focus leads as the default landing view; the session-card grid (#sessions-container) stays mounted
// off-screen as the canonical card home Focus borrows from - it is no longer a navigable view.
const VIEW_TABS = [
  { view: 'focus', tab: tabFocus, el: viewFocusEl },
  { view: 'radar', tab: tabRadar, el: viewRadarEl },
  { view: 'prs', tab: tabPrs, el: viewPrsEl },
  { view: 'usage', tab: tabUsage, el: viewUsageEl },
  { view: 'navigator', tab: tabNavigator, el: viewNavigatorEl },
];

let _activeView = 'focus';

// Looking at a surface is what clears its dot, on either layout: a desktop tab activation and a phone
// screen becoming visible mean the same thing, and the screen ids match the view ids. The panel stores
// what it showed and re-runs its own activity callback, so the desktop tab dot, the phone row dot and
// the More aggregate all update through the seams that already exist.
function acknowledgeViewAttention(view) {
  if (view === 'radar') acknowledgeRadarAttention();
  if (view === 'prs') acknowledgePrAttention();
  if (view === 'usage') acknowledgeUsageAttention();
}

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
  if (view === 'focus') activateFocusView();
  // The usage report is pulled, not pushed (it is far too big to broadcast on every scan), so opening
  // the tab asks for a current one and repaints whatever arrived while the panel was hidden.
  if (view === 'usage') {
    refreshUsageView();
    requestUsageReport();
  }
  // Navigator is pushed, not pulled, so opening it asks for nothing; looking at it is what clears the dot.
  if (view === 'navigator') refreshNavigatorView();
  acknowledgeViewAttention(view);
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
// the centered session (see handleSnapshot).
const savedView = getActiveView();
activateView(VIEW_TABS.some((v) => v.view === savedView) ? savedView : 'focus');

// ── Form-factor layout switch ────────────────────────────────
// One app instance, two first-class layouts. Switching between them is a HANDOFF, not a re-render: the
// phone shell borrows the review sidebar, the Radar and PRs panels, the desktop header's controls and
// the focused session's card out of the desktop DOM, and gives them all back on the way out. Nothing is
// duplicated, so neither layout can drift from the other's state.

mountPhoneShell({
  radarPanelEl: viewRadarEl,
  prsPanelEl: viewPrsEl,
  usagePanelEl: viewUsageEl,
  // Usage is the one screen that PULLS rather than being pushed to, so it asks for a fresh report the
  // moment it becomes visible; every other screen ignores this.
  onScreenShown: (screenId) => {
    if (screenId === 'usage') { refreshUsageView(); requestUsageReport(); }
    acknowledgeViewAttention(screenId);
  },
  // The desktop header does not render under [data-layout="phone"], so its controls move to the Board's
  // top bar rather than being rebuilt there. Every listener, and the client-trust gating on Shut Down,
  // travels with them.
  headerControls: [
    document.getElementById('status-indicator'),
    document.getElementById('btn-add-session-header'),
    document.getElementById('btn-help'),
    headerMenu,
  ],
});

function applyFormFactorLayout(layout) {
  if (layout === 'phone') {
    const carriedSessionId = getFocusedSessionId();
    deactivateFocusView(); // returns the centered card to its off-screen home before the phone takes it
    activatePhoneShell({ sessionId: carriedSessionId });
    return;
  }
  const carriedSessionId = getPhoneSessionId();
  deactivatePhoneShell();
  activateView(_activeView); // re-activates the saved view now that the desktop DOM is whole
  // Quietly, NOT via the pill-activation path: that one is the operator making a selection, so it
  // sends start-session for a DORMANT target and dismiss for a COMPLETE one. A rotation is a layout event,
  // and treating it as a selection would respawn a session the operator just killed or acknowledge away
  // a COMPLETE they never read.
  if (carriedSessionId) centerSessionQuietly(carriedSessionId);
}

if (isPhoneLayout()) applyFormFactorLayout('phone');
onLayoutChange(applyFormFactorLayout);

document.getElementById('btn-restart').addEventListener('click', () => {
  headerMenu.classList.remove('open');
  syncMenuAria();
  const count = getSessionCount();
  const suffix = count > 1 ? 's' : '';
  const message = count > 0
    ? `Kill ${count} session${suffix} and restart the server?`
    : 'Restart the server?';
  openConfirmDialog({
    title: 'Restart Server',
    message,
    confirmLabel: 'Restart',
    danger: false,
    onConfirm: () => sendControlMsg({ type: 'restart-server' }),
  });
});

// UX honesty, not a security boundary: a paired device is full-trust by design, but a phone that
// shuts the server down has no way to start it again, so that item is not offered there. Restart
// stays: production respawns the process detached and the dashboard reconnects on its own.
function applyClientTrust(trust) {
  const showShutdown = shouldShowServerAction('shutdown', trust);
  document.getElementById('btn-shutdown').hidden = !showShutdown;
  document.getElementById('menu-divider-shutdown').hidden = !showShutdown;
}

document.getElementById('btn-shutdown').addEventListener('click', () => {
  headerMenu.classList.remove('open');
  syncMenuAria();
  const count = getSessionCount();
  const suffix = count > 1 ? 's' : '';
  const message = count > 0
    ? `Kill ${count} session${suffix} and shut down the server?`
    : 'Shut down the server?';
  openConfirmDialog({
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
