import '@xterm/xterm/css/xterm.css';
import './tailwind.css';

import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { shouldShowServerAction } from '#shared/client-trust.ts';
import { STATES } from '#shared/states.ts';
import { checkControlLiveness, connectControl, onControlMessage, sendControlMsg, sendControlRequest, setConnectionStateCallback } from './control-ws.ts';
import { createAddSessionDialog } from './dialogs.ts';
import { observeHeaderHeight, queryTag, writeClipboardText } from './dom-helpers.ts';
import { refreshFavicon } from './favicon.ts';
import { activateFocusView, centerSessionQuietly, deactivateFocusView, focusAdjacentInRail, focusNextAttention, focusNthInRail, getFocusedSessionId, isFocusActive, mountFocusView, refreshFocusRoster, restoreFocusedSession, setFocusMergeStatus } from './focus-view/focus-view.ts';
import { initFormFactor, isPhoneLayout, onLayoutChange } from './form-factor.ts';
import type { HealthSnapshot } from './health-monitor.ts';
import { applyHealthSnapshot, mountHealthMonitor } from './health-monitor.ts';
import { applyIngestActivity, applyIngestSnapshot, applyVisionsComments, applyVisionsFindings, applyVisionsFix, applyVisionsHand, applyVisionsIntent, applyVisionsSettings, applyVisionsSnapshot, mountVisionsView, refreshVisionsView, setVisionsActivityCallback, setVisionsProjectNames } from './visions-panel.ts';
import { acknowledgeMillAttention, applyMillReport, mountMillView, refreshMillView, requestMillReport, setMillActivityCallback, setMillRequestSender } from './mill-panel.ts';
import { applyDeleteHookResult, applyHooksReport, applySaveHookResult, mountHooksView, refreshHooksView, requestHooksReport, setHooksRequestSender } from './hooks-panel.ts';
import { initNotifications, showDesktopNotification } from './notifications.ts';
import { activatePhoneShell, deactivatePhoneShell, getPhoneSessionId, isPhoneScreenActive, isPhoneShellActive, mountPhoneShell, refreshPhoneBoard, setPhoneScreenAttention, showPhoneScreen } from './phone/phone-shell.ts';
import { noteKnownProjectPath } from './project-registry.ts';
import { acknowledgePrAttention, applyPrStatus, mountPrView, setPrActivityCallback } from './pr-panel.ts';

import { updateBannerText } from './radar-core.ts';
import { acknowledgeRadarAttention, applyHealthSnapshot as applyRadarHealth, applyPosthogStatus, applyPrStatus as applyRadarPrStatus, applyUpdateAvailable as applyRadarUpdate, mountRadarView, setRadarActivityCallback, setRadarNavigateToPrs } from './radar-panel.ts';
import { handleDebugStateRefresh, handleDebugStateResponse } from './session-card/card-dom.ts';
import { sessionUIs } from './session-card/card-registry.ts';
import { applyState, applyTerminalSettings, createSessionCard, getSessionCount, hasSession, notePackVersion, removeSessionCard, renameSessionCard, seedSessionMergeStatus, setLatestPackVersions, setSessionAgent, setSessionAgents, setSessionDiff, setSessionEffectiveBase, setSessionMergeStatus, setSessionPacks, setSessionPostTurn, setSessionPrompt, setSessionResume, setSessionUsage, setSessionWakeup, setSessionWorktree, updateAggregateStatus } from './session-card/lifecycle.ts';
import { openConfirmDialog } from './session-card/modal.ts';
import { reconnectDataWs } from './session-card/terminal.ts';
import { showErrorToast } from './session-card/toast.ts';
import { activateSettingsSection, applySettingsBroadcast, applySettingsProjectReport, applySettingsProjects, mountSettingsView, refreshSettingsStatus, resolveSettingsTarget } from './settings-panel.ts';
import { forgetReviewSession, mergeSelectedSession, mountReviewSidebar, notifyWorktreeChanged, refreshReviewSidebar, resolveSelectedSession, resyncSelectedSession, setReviewBranchSync } from './sidebar/review-sidebar.ts';
import { decideReloadOnBuild } from './server-build-core.ts';
import { applyTheme } from './theme.ts';
import { getActiveView as getSavedActiveView, getDismissedUpdate, getThemeId, isSoundEnabled, setActiveView, setDismissedUpdate, setSoundEnabled } from './ui-prefs.ts';
import { getActiveView, uiState } from './ui-state-core.ts';
import { acknowledgeUsageAttention, applyPlanLimits, applyUsageReport, applyUsageSessions, mountUsageView, refreshUsageView, requestUsageReport, setUsageActivityCallback, setUsageRequestSender } from './usage-panel.ts';

applyTheme(getThemeId());

initFormFactor();

const connectionEl = queryTag(document, '#connection-status', 'span');
const connectionLabel = queryTag(connectionEl, '.connection-label', 'span');

const loadingScreen = queryTag(document, '#loading-screen', 'div');
const loadingStatus = queryTag(document, '#loading-status', 'div');
const shutdownScreen = queryTag(document, '#shutdown-screen', 'div');
const shutdownStatus = queryTag(document, '#shutdown-status', 'div');
let appRevealed = false;

function revealApp() {
  if (appRevealed) return;
  appRevealed = true;
  document.body.classList.add('app-ready');
  loadingScreen.classList.add('fade-out');

  const removeLoading = () => loadingScreen.remove();
  loadingScreen.addEventListener('transitionend', removeLoading, { once: true });
  setTimeout(removeLoading, 1000);
}

interface SnapshotSession {
  id: string;
  name: string;
  state: string;
  stateSince?: number;
  ephemeral?: boolean;
  path?: string;
  agent?: string;
  dangerouslySkipPermissions?: boolean;
  isWorktree?: boolean;
  resumeSessionId?: string | null;
  mergeStatus?: string;
  mergeReason?: string | null;
  effectiveBase?: string;
  activeAgents?: number;
  pendingWakeup?: unknown;
  pendingPromptKind?: unknown;
  packs?: unknown;
}

interface SessionUsageChip {
  tokens: unknown;
  costUSD: unknown;
  officialCostUSD: unknown;
}

function showShutdownOverlay(message?: string) {
  if (message) shutdownStatus.textContent = message;
  shutdownScreen.classList.add('active');
}

setConnectionStateCallback((state, label) => {
  connectionEl.dataset.state = state;
  connectionLabel.textContent = label;

  if (state === 'connected') {
    if (shutdownScreen.classList.contains('active')) {

      location.reload();
      return;
    }
    revealApp();
    sendFocusState();

    requestUsageReportIfVisible();
    requestHooksReportIfVisible();

    sendControlRequest('get-settings', {})
      .then((msg) => {
        if (!msg.settings) return;
        applyTerminalSettings(msg.settings);
        applySettingsBroadcast(msg.settings);
        applyVisionsSettings(msg.settings);
      })
      .catch(() => {});
    return;
  }
  if (state === 'disconnected' && shutdownScreen.classList.contains('active')) {

    shutdownStatus.textContent = 'Waiting for server...';
    return;
  }
  if (!appRevealed) loadingStatus.textContent = 'Reconnecting to server...';
});

let knownServerBuild: string | null | undefined = null;

function noteServerBuild(serverBuild: unknown) {
  const decision = decideReloadOnBuild(knownServerBuild, serverBuild);
  knownServerBuild = decision.knownBuild;
  if (decision.reload) location.reload();
}

function handleSnapshot(sessions: unknown, packVersions: unknown) {
  const rows = (sessions || []) as SnapshotSession[];

  setLatestPackVersions(packVersions);

  setVisionsProjectNames(new Map(rows.filter((s) => !s.ephemeral).map((s): [string, string] => [s.id, s.name])));
  applySettingsProjects(rows.filter((session) => !session.ephemeral).map((session) => ({
    id: session.id,
    name: session.name,
    agent: session.agent,
    permissionMode: session.dangerouslySkipPermissions ? 'Skip permissions' : 'Default',
  })));
  for (const s of rows) {
    if (!s.ephemeral) noteKnownProjectPath(s.path);
    const exists = hasSession(s.id);
    if (exists) applyState(s.id, s.state, s.stateSince);
    if (!exists) createSessionCard(s.id, s.name, s.state, { skipPerms: !!s.dangerouslySkipPermissions, worktree: !!s.isWorktree, path: s.path, resume: !!s.resumeSessionId, stateSince: s.stateSince });

    setSessionAgent(s.id, s.agent);

    setSessionResume(s.id, s.resumeSessionId);

    seedSessionMergeStatus(s.id, s.mergeStatus, s.mergeReason);
    setSessionEffectiveBase(s.id, s.effectiveBase);

    setSessionAgents(s.id, s.activeAgents);

    setSessionWakeup(s.id, s.pendingWakeup);

    setSessionPrompt(s.id, s.pendingPromptKind);

    setSessionPacks(s.id, s.packs);

    restoreUsageChip(s.id);
  }
  updateAggregateStatus();
  refreshFavicon(sessionUIs);

  if (isFocusActive()) { refreshFocusRoster(); restoreFocusedSession(); }

  refreshPhoneBoard();
}

function handleStateChange(msg: ServerMessage) {
  if (!hasSession(msg.id)) {
    createSessionCard(msg.id, msg.session, msg.to, { skipPerms: !!msg.skipPerms, stateSince: msg.timestamp });
    refreshFavicon(sessionUIs);
    return;
  }

  if (msg.to === STATES.DORMANT && msg.from !== STATES.DORMANT) {
    const matchedCard = document.querySelector(`.session-card[data-id="${CSS.escape(String(msg.id))}"]`);
    const card = matchedCard instanceof HTMLElement ? matchedCard : null;
    const skipPerms = card ? card.dataset.skipPerms !== undefined : false;

    const path = card ? card.dataset.path : undefined;
    removeSessionCard(msg.id);
    createSessionCard(msg.id, msg.session, STATES.DORMANT, { skipPerms, path, stateSince: msg.timestamp });
    restoreUsageChip(msg.id);
    if (isFocusActive()) refreshFocusRoster();
    refreshPhoneBoard();
    refreshReviewSidebar(msg.id);
    refreshFavicon(sessionUIs);
    return;
  }

  applyState(msg.id, msg.to, msg.timestamp);
  refreshFavicon(sessionUIs);

  refreshReviewSidebar(msg.id);
  if (isFocusActive()) refreshFocusRoster();
  refreshPhoneBoard();

  handleDebugStateRefresh(msg.id);

  if (msg.to === STATES.INITIALIZING && (msg.from === STATES.DONE || msg.from === STATES.FAILED)) {
    reconnectDataWs(msg.id);
  }
}

const usageBySessionId = new Map<unknown, SessionUsageChip>();

function applyUsageSessionChips(rows: unknown) {
  const seen = new Set<unknown>();
  const usageRows: { id?: unknown; tokens?: unknown; costUSD?: unknown; officialCostUSD?: unknown }[] = Array.isArray(rows) ? rows : [];
  for (const row of usageRows) {
    if (!row?.id) continue;
    seen.add(row.id);
    const usage = { tokens: row.tokens, costUSD: row.costUSD, officialCostUSD: row.officialCostUSD };
    usageBySessionId.set(row.id, usage);
    setSessionUsage(row.id, usage);
  }

  for (const id of [...usageBySessionId.keys()]) {
    if (seen.has(id)) continue;
    usageBySessionId.delete(id);
    setSessionUsage(id, null);
  }
}

function restoreUsageChip(sessionId: unknown) {
  const usage = usageBySessionId.get(sessionId);
  if (!usage) return;
  setSessionUsage(sessionId, usage);
}

setUsageRequestSender(sendControlMsg);
setMillRequestSender(sendControlMsg);
setHooksRequestSender(sendControlMsg);

function isHooksSurfaceVisible() {
  if (isPhoneShellActive()) return isPhoneScreenActive('hooks');
  return getActiveView() === 'hooks';
}

function requestHooksReportIfVisible() {
  if (!isHooksSurfaceVisible()) return;
  requestHooksReport();
}

function isUsageSurfaceVisible() {
  if (isPhoneShellActive()) return isPhoneScreenActive('usage');
  return getActiveView() === 'usage';
}

function requestUsageReportIfVisible() {
  if (!isUsageSurfaceVisible()) return;
  requestUsageReport();
}

const MILL_PULL_DEBOUNCE_MS = 500;
let millPullTimer: number | null = null;
let shouldResolveSettingsHashOnMillReport = location.hash.startsWith('#settings/');

function requestMillReportSoon() {
  if (millPullTimer) clearTimeout(millPullTimer);
  millPullTimer = setTimeout(() => {
    millPullTimer = null;
    requestMillReport();
  }, MILL_PULL_DEBOUNCE_MS);
}

const messageHandlers = {
  'snapshot':           (msg) => { noteServerBuild(msg.serverBuild); handleSnapshot(msg.sessions, msg.packVersions); requestMillReport(); },

  'pack-updated':       (msg) => { notePackVersion(msg.name, msg.version); requestMillReportSoon(); },
  'mill-report':        (msg) => {
    applyMillReport(msg);
    applySettingsProjectReport(msg);
    const shouldResolve = getActiveView() === 'settings' || shouldResolveSettingsHashOnMillReport;
    shouldResolveSettingsHashOnMillReport = false;
    if (shouldResolve) activateSettingsHash();
  },

  'project-packs-updated': () => requestMillReportSoon(),

  'set-project-packs-result': (msg) => { if (!msg.ok) { showErrorToast(msg.error || 'Could not change pack delivery', { persist: true }); requestMillReport(); } },

  'hooks-report':       (msg) => applyHooksReport(msg),
  'save-hook-result':   (msg) => applySaveHookResult(msg),
  'delete-hook-result': (msg) => applyDeleteHookResult(msg),
  'hooks-updated':      () => requestHooksReportIfVisible(),

  'session-packs':      (msg) => setSessionPacks(msg.id, msg.packs),
  'state-change':       (msg) => handleStateChange(msg),
  'session-added':      (msg) => { if (!msg.ephemeral) noteKnownProjectPath(msg.path); if (!hasSession(msg.id)) { createSessionCard(msg.id, msg.session, msg.state, { skipPerms: !!msg.skipPerms, worktree: !!msg.worktree, path: msg.path, resume: !!msg.resumeSessionId, stateSince: msg.stateSince }); restoreUsageChip(msg.id); } refreshFavicon(sessionUIs); if (isFocusActive()) refreshFocusRoster(); refreshPhoneBoard(); },
  'session-removed':    (msg) => { removeSessionCard(msg.id); forgetReviewSession(msg.id); refreshFavicon(sessionUIs); if (isFocusActive()) refreshFocusRoster(); refreshPhoneBoard(); },
  'session-renamed':    (msg) => { renameSessionCard(msg.id, msg.newName); refreshPhoneBoard(); },
  'session-modified':   (msg) => { if (!msg.ephemeral) noteKnownProjectPath(msg.path); removeSessionCard(msg.id); forgetReviewSession(msg.id); createSessionCard(msg.id, msg.session, msg.state, { skipPerms: !!msg.skipPerms, worktree: !!msg.worktree, path: msg.path, resume: !!msg.resumeSessionId, stateSince: msg.stateSince }); restoreUsageChip(msg.id); refreshFavicon(sessionUIs); if (isFocusActive()) refreshFocusRoster(); refreshPhoneBoard(); },
  'session-git':        (msg) => setSessionWorktree(msg.id, !!msg.worktree),
  'session-resume':     (msg) => setSessionResume(msg.id, msg.resumeSessionId),

  'session-agents':     (msg) => { setSessionAgents(msg.id, msg.activeAgents); handleDebugStateRefresh(msg.id); },
  'session-wakeup':     (msg) => setSessionWakeup(msg.id, msg.pendingWakeup),
  'session-prompt':     (msg) => setSessionPrompt(msg.id, msg.pendingPromptKind),
  'session-merge-status': (msg) => { setSessionMergeStatus(msg.id, msg.mergeStatus, msg.reason); setFocusMergeStatus(msg.id, msg.mergeStatus); refreshPhoneBoard(); },
  'session-worktree-blocked': (msg) => { showErrorToast(`${msg.session}: ${msg.notice || 'integration branch not found'}`, { persist: true }); },
  'session-worktree-warning': (msg) => { showErrorToast(`${msg.session}: ${msg.notice || 'base branch warning'}`); },
  'session-worktree-ready': (msg) => { setSessionEffectiveBase(msg.id, msg.base); },
  'session-diff':       (msg) => { setSessionDiff(msg.id, { committed: msg.committed, uncommitted: msg.uncommitted, hasCommits: msg.hasCommits }); },
  'branch-sync-status': (msg) => setReviewBranchSync(msg.id, { branch: msg.branch, upstream: msg.upstream, state: msg.state, ahead: msg.ahead, behind: msg.behind, fetched: msg.fetched, action: msg.action, error: msg.error }),
  'session-changed':    (msg) => notifyWorktreeChanged(msg.id),
  'post-turn-result':   (msg) => setSessionPostTurn(msg.id, msg),
  'debug-state-response': (msg) => handleDebugStateResponse(msg),

  'notify':             (msg) => { showDesktopNotification(msg); handleDebugStateRefresh(msg.session); },
  'update-available':   (msg) => { showUpdateBanner(msg); applyRadarUpdate(msg); },
  'error':              (msg) => showErrorToast(msg.message, { persist: true }),
  'session-error':      (msg) => showErrorToast(`${msg.session}: ${msg.message}`, { persist: true }),
  'settings-updated':   (msg) => { if (msg.settings) { applyTerminalSettings(msg.settings); applySettingsBroadcast(msg.settings); applyVisionsSettings(msg.settings); } },
  'health-snapshot':    (msg) => { if (msg.stats) { applyHealthSnapshot(msg.stats as HealthSnapshot); applyRadarHealth(msg.stats as HealthSnapshot); } },
  'posthog-status':     (msg) => applyPosthogStatus(msg),
  'pr-status':          (msg) => { applyPrStatus(msg); applyRadarPrStatus(msg); },
  'usage-sessions':     (msg) => { applyUsageSessionChips(msg.sessions); applyUsageSessions(msg); requestUsageReportIfVisible(); },
  'usage-report':       (msg) => { applyUsageReport(msg); refreshSettingsStatus(); },

  'plan-limits':        (msg) => applyPlanLimits(msg),

  'usage-budget-alert': (msg) => showDesktopNotification({
    session: `budget-${msg.scope}-${msg.periodKey}`,
    category: `threshold-${msg.threshold}`,
    message: msg.text,
    ignoreFocus: true,
  }),

  'visions-findings': (msg) => applyVisionsFindings(msg),

  'visions-comments': (msg) => applyVisionsComments(msg),
  'visions-hand':     (msg) => applyVisionsHand(msg),

  'visions-intent':   (msg) => applyVisionsIntent(msg),

  'visions-fix':      (msg) => applyVisionsFix(msg),
  'visions-snapshot': (msg) => applyVisionsSnapshot(msg),

  'ingest-activity':    (msg) => applyIngestActivity(msg),
  'ingest-snapshot':    (msg) => applyIngestSnapshot(msg),
  'client-trust':       (msg) => applyClientTrust(msg.trust),
  'shutting-down':      () => {
    connectionEl.dataset.state = 'shutdown';
    connectionLabel.textContent = 'Shutting down...';
    queryTag(document, '#btn-menu', 'button').disabled = true;
    showShutdownOverlay('Shutting down sessions...');
  },
  'restarting':         () => {
    connectionEl.dataset.state = 'shutdown';
    connectionLabel.textContent = 'Restarting...';
    queryTag(document, '#btn-menu', 'button').disabled = true;
    showShutdownOverlay('Restarting server...');
  },
} satisfies Record<string, (msg: ServerMessage) => void>;

onControlMessage((msg) => {
  const handlersByType = messageHandlers as Record<string, ((msg: ServerMessage) => void) | undefined>;
  const handler = handlersByType[msg.type];
  if (handler) handler(msg);
});

let updateBannerDismissed = false;

function updateIdentity(msg: ServerMessage) {
  const { latestSha, latest } = msg;
  if (typeof latest === 'string' && latest) return latest;
  if (typeof latestSha === 'string' && latestSha) return latestSha;
  return null;
}

function showUpdateBanner(msg: ServerMessage) {
  if (updateBannerDismissed) return;
  const identity = updateIdentity(msg);
  if (identity && getDismissedUpdate() === identity) return;
  const banner = queryTag(document, '#update-banner', 'div');
  const command = String(msg.command ?? '');
  queryTag(document, '#update-banner-text', 'span').textContent = updateBannerText(msg);
  queryTag(document, '#update-banner-cmd', 'code').textContent = command;
  const link = queryTag(document, '#update-banner-link', 'a');
  link.hidden = !msg.releaseUrl;
  link.href = typeof msg.releaseUrl === 'string' ? msg.releaseUrl : '';
  banner.hidden = false;

  const copyBtn = queryTag(document, '#update-banner-copy', 'button');
  const flashLabel = (text: string) => {
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
  queryTag(document, '#update-banner-dismiss', 'button').onclick = () => {
    updateBannerDismissed = true;
    setDismissedUpdate(identity);
    banner.hidden = true;
  };
}

queryTag(document, '#btn-add-session-header', 'button').addEventListener('click', createAddSessionDialog);

const headerMenu = queryTag(document, '#header-menu', 'div');
const btnMenu = queryTag(document, '#btn-menu', 'button');

function syncMenuAria() {
  btnMenu.setAttribute('aria-expanded', headerMenu.classList.contains('open') ? 'true' : 'false');
}

btnMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  headerMenu.classList.toggle('open');
  syncMenuAria();
});

document.addEventListener('click', (e) => {
  if (!(e.target instanceof Node)) return;
  if (!headerMenu.contains(e.target)) {
    headerMenu.classList.remove('open');
    syncMenuAria();
  }
});

observeHeaderHeight(document.querySelector('.header'));

function openSettings(section?: string) {
  if (section) activateSettingsSection(section);
  if (showPhoneScreen('settings')) return;
  activateView('settings', { section });
}

function clearSettingsHash() {
  if (!location.hash.startsWith('#settings/')) return;
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
}

function activateSettingsTarget(target: { sectionId: string; settingId: string | null } | null) {
  if (!target) return false;
  activateSettingsSection(target.sectionId, target.settingId);
  if (showPhoneScreen('settings')) return true;
  activateView('settings', { section: target.sectionId, setting: target.settingId, persist: false });
  return true;
}

function activateSettingsHash() {
  const target = resolveSettingsTarget(location.hash);
  return activateSettingsTarget(target);
}

queryTag(document, '#btn-settings', 'button').addEventListener('click', () => {
  headerMenu.classList.remove('open');
  syncMenuAria();
  openSettings();
});

queryTag(document, '#btn-help', 'button').addEventListener('click', () => {
  openSettings('browser-shortcuts');
});

const viewFocusEl = queryTag(document, '#view-focus', 'section');
const viewRadarEl = queryTag(document, '#view-radar', 'section');
const viewPrsEl = queryTag(document, '#view-prs', 'section');
const viewUsageEl = queryTag(document, '#view-usage', 'section');
const viewMillEl = queryTag(document, '#view-mill', 'section');
const viewVisionsEl = queryTag(document, '#view-visions', 'section');
const viewHooksEl = queryTag(document, '#view-hooks', 'section');
const viewSettingsEl = queryTag(document, '#view-settings', 'section');
const tabFocus = queryTag(document, '#tab-focus', 'button');
const tabRadar = queryTag(document, '#tab-radar', 'button');
const tabPrs = queryTag(document, '#tab-prs', 'button');
const tabUsage = queryTag(document, '#tab-usage', 'button');
const tabMill = queryTag(document, '#tab-mill', 'button');
const tabVisions = queryTag(document, '#tab-visions', 'button');
const tabHooks = queryTag(document, '#tab-hooks', 'button');
const tabSettings = queryTag(document, '#tab-settings', 'button');
const tabRadarActivityEl = queryTag(document, '#tab-radar-activity', 'span');
const tabPrsActivityEl = queryTag(document, '#tab-prs-activity', 'span');
const tabUsageActivityEl = queryTag(document, '#tab-usage-activity', 'span');
const tabMillActivityEl = queryTag(document, '#tab-mill-activity', 'span');
const tabVisionsActivityEl = queryTag(document, '#tab-visions-activity', 'span');

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
setMillActivityCallback((active) => {
  tabMillActivityEl.classList.toggle('active', active);
  setPhoneScreenAttention('mill', active);
});
setVisionsActivityCallback((level) => {
  const active = level !== null;
  tabVisionsActivityEl.classList.toggle('active', active);

  if (!active) tabVisionsActivityEl.removeAttribute('data-attention');
  if (active) tabVisionsActivityEl.setAttribute('data-attention', level);
  setPhoneScreenAttention('visions', level);
});

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

mountRadarView(viewRadarEl);

mountPrView(viewPrsEl);

mountUsageView(viewUsageEl);

mountMillView(viewMillEl);

mountVisionsView(viewVisionsEl);

mountHooksView(viewHooksEl);

mountSettingsView(viewSettingsEl);

const VIEW_TABS = [
  { view: 'focus', tab: tabFocus, el: viewFocusEl },
  { view: 'radar', tab: tabRadar, el: viewRadarEl },
  { view: 'prs', tab: tabPrs, el: viewPrsEl },
  { view: 'usage', tab: tabUsage, el: viewUsageEl },
  { view: 'mill', tab: tabMill, el: viewMillEl },
  { view: 'visions', tab: tabVisions, el: viewVisionsEl },
  { view: 'hooks', tab: tabHooks, el: viewHooksEl },
  { view: 'settings', tab: tabSettings, el: viewSettingsEl },
];

let shouldPersistActiveView = true;

function acknowledgeViewAttention(view: string) {
  if (view === 'radar') acknowledgeRadarAttention();
  if (view === 'prs') acknowledgePrAttention();
  if (view === 'usage') acknowledgeUsageAttention();
  if (view === 'mill') acknowledgeMillAttention();
  if (view === 'visions') refreshVisionsView();
}

interface ActivateViewOptions {
  section?: string;
  setting?: string | null;
  persist?: boolean;
}

function activateView(view: string, { section, setting, persist = true }: ActivateViewOptions = {}) {
  const prev = getActiveView();
  uiState.dispatch('setActiveView', view);
  shouldPersistActiveView = persist;

  document.body.dataset.activeView = view;

  if (persist) setActiveView(view);
  for (const v of VIEW_TABS) {
    const selected = v.view === view;
    if (v.el) v.el.hidden = !selected;
    v.tab.setAttribute('aria-selected', String(selected));
    v.tab.tabIndex = selected ? 0 : -1;
  }

  if (prev === 'focus' && view !== 'focus') deactivateFocusView();
  if (view === 'focus') activateFocusView();

  if (view === 'usage') {
    refreshUsageView();
    requestUsageReport();
  }

  if (view === 'mill') {
    refreshMillView();
    requestMillReport();
  }
  if (view === 'hooks') {
    refreshHooksView();
    requestHooksReport();
  }
  if (prev === 'settings' && view !== 'settings') clearSettingsHash();
  if (view === 'settings' && section) activateSettingsSection(section, setting ?? null);
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

const savedView = getSavedActiveView();
const initialSettingsTarget = resolveSettingsTarget(location.hash);
if (initialSettingsTarget) {
  shouldResolveSettingsHashOnMillReport = false;
  activateView('settings', {
    section: initialSettingsTarget.sectionId,
    setting: initialSettingsTarget.settingId,
    persist: false,
  });
}
if (!initialSettingsTarget) activateView(VIEW_TABS.some((v) => v.view === savedView) ? savedView : 'focus');

mountPhoneShell({
  radarPanelEl: viewRadarEl,
  prsPanelEl: viewPrsEl,
  usagePanelEl: viewUsageEl,
  millPanelEl: viewMillEl,
  visionsPanelEl: viewVisionsEl,
  hooksPanelEl: viewHooksEl,
  settingsPanelEl: viewSettingsEl,

  onScreenShown: (screenId: string) => {
    if (screenId === 'usage') { refreshUsageView(); requestUsageReport(); }
    if (screenId === 'mill') { refreshMillView(); requestMillReport(); }
    if (screenId === 'hooks') { refreshHooksView(); requestHooksReport(); }
    if (screenId !== 'settings') clearSettingsHash();
    if (screenId === 'settings' && !location.hash.startsWith('#settings/')) activateSettingsSection();
    acknowledgeViewAttention(screenId);
  },

  headerControls: [
    queryTag(document, '#status-indicator', 'div'),
    queryTag(document, '#btn-add-session-header', 'button'),
    queryTag(document, '#btn-help', 'button'),
    headerMenu,
  ],
});

function applyFormFactorLayout(layout: string) {
  if (layout === 'phone') {
    const carriedSessionId = getFocusedSessionId();
    deactivateFocusView();
    activatePhoneShell({ sessionId: carriedSessionId ?? undefined });
    return;
  }
  const carriedSessionId = getPhoneSessionId();
  deactivatePhoneShell();
  activateView(getActiveView(), { persist: shouldPersistActiveView });

  if (carriedSessionId) centerSessionQuietly(carriedSessionId);
}

if (isPhoneLayout()) applyFormFactorLayout('phone');
onLayoutChange(applyFormFactorLayout);
window.addEventListener('hashchange', activateSettingsHash);

queryTag(document, '#btn-restart', 'button').addEventListener('click', () => {
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

function applyClientTrust(trust: unknown) {
  const showShutdown = shouldShowServerAction('shutdown', trust);
  queryTag(document, '#btn-shutdown', 'button').hidden = !showShutdown;
  queryTag(document, '#menu-divider-shutdown', 'div').hidden = !showShutdown;
}

queryTag(document, '#btn-shutdown', 'button').addEventListener('click', () => {
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

const btnMute = queryTag(document, '#btn-mute', 'button');

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

function isRealInputFocused() {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement)) return false;
  if (a.isContentEditable) return true;
  return (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')
    && !a.classList.contains('xterm-helper-textarea');
}

document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

  if (e.repeat) return;

  if (isRealInputFocused()) return;

  if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    mergeSelectedSession();
    return;
  }

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

function isTextEntryContext() {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement)) return false;
  if (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable) return true;
  return !!a.closest?.('.terminal-wrap');
}

document.addEventListener('keydown', (e) => {
  if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (isTextEntryContext()) return;
  if (document.querySelector('.dialog-overlay')) return;
  e.preventDefault();
  openSettings('browser-shortcuts');
});

let _focusDebounce: number | null = null;

function sendFocusState() {
  if (_focusDebounce !== null) clearTimeout(_focusDebounce);
  _focusDebounce = setTimeout(() => {
    sendControlMsg({ type: 'focus-change', focused: document.hasFocus() });
  }, 150);
}

window.addEventListener('focus', sendFocusState);
window.addEventListener('blur', sendFocusState);
document.addEventListener('visibilitychange', sendFocusState);

let _wakeLivenessCheckRunning = false;

async function checkWakeLiveness() {
  if (_wakeLivenessCheckRunning) return;
  _wakeLivenessCheckRunning = true;
  try {
    const state = await checkControlLiveness();
    if (state !== 'dead') return;
    for (const id of sessionUIs.keys()) reconnectDataWs(id);
  } finally {
    _wakeLivenessCheckRunning = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  checkWakeLiveness();
});
window.addEventListener('online', checkWakeLiveness);
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  checkWakeLiveness();
});

mountHealthMonitor(queryTag(document, '#health-footer-mount', 'div'));

initNotifications();

connectControl();
