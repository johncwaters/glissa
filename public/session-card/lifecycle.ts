import type { SessionState } from '#shared/states.ts';
import { KILLABLE_STATES, RESTARTABLE_STATES, STATES } from '#shared/states.ts';
import { playAlertSound } from '../alert-sound.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { setHealthMonitorVisible } from '../health-monitor.ts';
import { seedReviewMergeStatus, setReviewDiff, setReviewMergeStatus } from '../sidebar/review-sidebar.ts';
import { setSelectedId } from '../sidebar/selection.ts';
import { getSoundId, isSoundEnabled } from '../ui-prefs.ts';
import type { UsageSessionUsage } from '../usage-view-core.ts';
import { sessionChipText, sessionChipTitle } from '../usage-view-core.ts';
import { setRunningActivity } from './activity.ts';
import { agentBadgeText } from './agent-core.ts';
import { computeAggregate } from './aggregate-core.ts';
import type { CardOptions } from './card-dom.ts';
import { buildCardDOM, closeDebugOverlay, isRenameInProgress, openDebugOverlay, setDebugMode, startInlineRename } from './card-dom.ts';
import type { SessionUi } from './card-registry.ts';
import { aggregateEl, container, findSessionUi, sessionIdOf, sessionUIs } from './card-registry.ts';
import { openConfirmDialog } from './modal.ts';
import type { DeliveredPack } from './pack-stale-core.ts';
import { stalePackNames } from './pack-stale-core.ts';
import { openResumeDialog } from './resume-dialog.ts';

import { refreshElapsed } from './session-tick.ts';
import {
  cancelTerminalRepaint,
  ensureTerminalSetup,
  setTerminalCursorBlink,
  setupTerminal,
  wireTerminalIO,
} from './terminal.ts';
import { releaseWebgl } from './webgl-pool.ts';

const AGGREGATE_GLYPHS: Record<string, string> = {
  critical: '✕',
  warning:  '▲',
  done:     '✓',
  '':       '▸',
};

let _lastAggregateText: string | null = null;
let _lastAggregateSeverity: string | null = null;

const latestPackVersions = new Map<string, string>();

const asText = (value: unknown) => (value == null ? '' : String(value));

const isKillable = (state: string) => KILLABLE_STATES.includes(state as SessionState);
const isRestartable = (state: string) => RESTARTABLE_STATES.includes(state as SessionState);

interface PostTurnReport {
  skipped?: boolean;
  mode?: string;
  filesFixed?: number;
  findings?: { file?: string; rule: string; count?: number }[];
}

function updateButtonVisibility(ui: SessionUi) {
  const state = ui.currentState;
  const canRestart = isKillable(state) || isRestartable(state);
  ui.btnRestart.classList.toggle('visible', canRestart);
  ui.btnRestartFresh.classList.toggle('visible', canRestart);

  ui.btnRename.classList.add('visible');
  ui.btnResume.classList.add('visible');
  ui.btnRemove.classList.add('visible');
}

function closeOverflowMenu(ui: SessionUi) {
  ui.overflowMenu.classList.remove('open');
  ui.btnOverflow.setAttribute('aria-expanded', 'false');
}

function wireCardEvents(ui: SessionUi, sessionId: string) {
  ui.btnRename.addEventListener('click', () => {
    ui.overflowMenu.classList.remove('open');
    startInlineRename(ui, sessionId);
  });

  ui.nameEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    startInlineRename(ui, sessionId);
  });

  ui.nameEl.addEventListener('click', () => {
    if (isRenameInProgress(ui.nameEl)) return;
    setSelectedId(sessionId);
  });

  ui.btnRestart.addEventListener('click', () => {
    ui.overflowMenu.classList.remove('open');
    const type = isKillable(ui.currentState) ? 'force-restart' : 'restart';
    sendControlMsg({ type, id: sessionId });
  });

  ui.btnRestartFresh.addEventListener('click', () => {
    ui.overflowMenu.classList.remove('open');
    const type = isKillable(ui.currentState) ? 'force-restart' : 'restart';
    sendControlMsg({ type, id: sessionId, fresh: true });
  });

  ui.btnResume.addEventListener('click', () => {
    ui.overflowMenu.classList.remove('open');
    openResumeDialog(sessionId, { currentState: ui.currentState });
  });

  ui.btnRemove.addEventListener('click', () => {
    ui.overflowMenu.classList.remove('open');
    const name = ui.card.dataset.session;

    const merge = ui.card.dataset.merge;
    const unmerged = merge === 'pending-review' || merge === 'parked';
    openConfirmDialog({
      title: 'Remove Session',
      message: unmerged
        ? `"${name}" has unmerged worktree changes that will be permanently discarded if you remove it. Merge or review them first to keep them. Remove anyway?`
        : `Remove session "${name}"?`,
      confirmLabel: unmerged ? 'Discard & Remove' : 'Remove',
      onConfirm: () => sendControlMsg({ type: 'remove-session', id: sessionId }),
    });
  });

  ui.btnOverflow.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const [, other] of sessionUIs) {
      if (other !== ui) {
        other.overflowMenu.classList.remove('open');
        other.btnOverflow.setAttribute('aria-expanded', 'false');
      }
    }
    const nowOpen = ui.overflowMenu.classList.toggle('open');
    ui.btnOverflow.setAttribute('aria-expanded', String(nowOpen));
  });

  document.addEventListener('click', (e) => {
    const clicked = e.target instanceof Node ? e.target : null;
    if (!ui.overflowMenu.contains(clicked) && clicked !== ui.btnOverflow) {
      closeOverflowMenu(ui);
    }
  }, { signal: ui.abortController.signal });

  ui.termWrap.addEventListener('mousedown', () => {
    if (ui.currentState === STATES.WAITING || ui.currentState === STATES.COMPLETE) {
      sendControlMsg({ type: 'dismiss', id: sessionId });
    }
  });

  ui.btnDebug.addEventListener('click', (e) => {
    e.stopPropagation();
    openDebugOverlay(ui, sessionId);
  });

  document.addEventListener('click', (e) => {
    const clicked = e.target instanceof Node ? e.target : null;
    if (ui.debugOpen && !ui.card.contains(clicked)) {
      closeDebugOverlay(ui);
    }
  }, { signal: ui.abortController.signal });
}

export function hasSession(id: unknown) {
  return typeof id === 'string' && sessionUIs.has(id);
}

export function getSessionCount() {
  return sessionUIs.size;
}

export function applyTerminalSettings(settings: unknown) {

  const terminalSettings = (settings || {}) as { cursorBlink?: boolean; debugMode?: boolean };
  if (terminalSettings.cursorBlink != null) setTerminalCursorBlink(terminalSettings.cursorBlink);
  if (terminalSettings.debugMode != null) {
    setDebugMode(terminalSettings.debugMode);
    setHealthMonitorVisible(terminalSettings.debugMode);
  }
  for (const [, ui] of sessionUIs) {
    if (!ui.term) continue;
    if (terminalSettings.cursorBlink != null) ui.term.options.cursorBlink = terminalSettings.cursorBlink;
  }
}

export function updateAggregateStatus() {
  if (!aggregateEl) return;
  let waiting = 0, failed = 0, done = 0, complete = 0, dormant = 0, total = 0;

  for (const [, ui] of sessionUIs) {
    total++;
    const state = ui.currentState;
    if (state === STATES.WAITING) { waiting++; continue; }
    if (state === STATES.FAILED) { failed++; continue; }
    if (state === STATES.DONE) { done++; continue; }
    if (state === STATES.COMPLETE) { complete++; continue; }
    if (state === STATES.DORMANT) dormant++;
  }

  const { text, severity, alertCount } = computeAggregate({ waiting, failed, done, complete, dormant, total });

  if (text !== _lastAggregateText || severity !== _lastAggregateSeverity) {
    _lastAggregateText = text;
    _lastAggregateSeverity = severity;
    aggregateEl.dataset.severity = severity;
    aggregateEl.textContent = '';
    if (text) {
      const glyph = el('span', 'aggregate-glyph', AGGREGATE_GLYPHS[severity] ?? AGGREGATE_GLYPHS['']);
      glyph.setAttribute('aria-hidden', 'true');
      aggregateEl.append(glyph, document.createTextNode(text));
    }
  }

  document.title = alertCount > 0 ? `(${alertCount}) Glissa` : 'Glissa';
}

export function createSessionCard(sessionId: unknown, sessionName: unknown, initialState: unknown, options: CardOptions = {}) {
  if (!container) return;
  const id = sessionIdOf(sessionId);
  const state = asText(initialState) || STATES.DORMANT;
  const dom = buildCardDOM(id, asText(sessionName), state, options);

  const isDormant = state === STATES.DORMANT;

  container.appendChild(dom.card);

  const ui: SessionUi = {
    term: null,
    fitAddon: null,
    webglAddon: null,
    needsWebGLReload: false,
    dataWs: null,
    card: dom.card,
    nameEl: dom.nameEl,
    elapsedEl: dom.elapsedEl,

    path: asText(options.path),

    stateSince: typeof options.stateSince === 'number' && Number.isFinite(options.stateSince) ? options.stateSince : Date.now(),
    btnOverflow: dom.btnOverflow,
    overflowMenu: dom.overflowMenu,
    termWrap: dom.termWrap,
    btnDebug: dom.btnDebug,
    btnRename: dom.btnRename,
    btnRestart: dom.btnRestart,
    btnRestartFresh: dom.btnRestartFresh,
    btnResume: dom.btnResume,
    btnRemove: dom.btnRemove,
    debugOverlay: null,
    debugOpen: false,
    abortController: new AbortController(),
    currentState: state,
  };
  sessionUIs.set(id, ui);

  wireCardEvents(ui, id);
  updateButtonVisibility(ui);

  if (state === STATES.RUNNING) setRunningActivity(ui, true);

  if (!isDormant) {
    setupTerminal(dom.termWrap, ui);
    wireTerminalIO(ui, id);
  }

  updateAggregateStatus();
  return ui;
}

export function setSessionEffectiveBase(sessionId: unknown, base: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  ui.effectiveBase = typeof base === 'string' ? base : undefined;
}

export function setSessionAgent(sessionId: unknown, agent: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  const text = agentBadgeText(agent);
  paintCardBadge(ui, '.agent-badge', 'agent', { on: text !== '', value: text, text });
}

export function setSessionWorktree(sessionId: unknown, worktree: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  if (worktree) { ui.card.dataset.worktree = ''; return; }
  delete ui.card.dataset.worktree;
}

export function setSessionResume(sessionId: unknown, resumeSessionId: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  if (resumeSessionId) { ui.card.dataset.resume = ''; return; }
  delete ui.card.dataset.resume;
}

function paintCardBadge(ui: SessionUi, selector: string, datasetKey: string, badgeState: { on: boolean; value?: string; text?: string; title?: string }) {
  const { on, value = '', text, title } = badgeState;
  const badge = ui.card.querySelector<HTMLElement>(selector);
  if (!on) {
    delete ui.card.dataset[datasetKey];
    if (!badge) return;
    if (text !== undefined) badge.textContent = '';
    if (title !== undefined) badge.removeAttribute('title');
    return;
  }
  ui.card.dataset[datasetKey] = value;
  if (!badge) return;
  if (text !== undefined) badge.textContent = text;
  if (title !== undefined) badge.title = title;
}

export function setSessionAgents(sessionId: unknown, activeAgents: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  const n = Math.max(0, Number(activeAgents) || 0);
  ui.activeAgents = n;
  paintCardBadge(ui, '.agents-badge', 'agents', {
    on: n > 0,
    value: String(n),
    text: n === 1 ? '1 agent' : `${n} agents`,
  });
}

export function setSessionPacks(sessionId: unknown, packs: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  ui.packs = Array.isArray(packs) ? (packs as DeliveredPack[]) : [];
  applyPackStaleness(ui);
}

export function setLatestPackVersions(versions: unknown) {
  latestPackVersions.clear();
  const byName = (versions || {}) as Record<string, string>;
  for (const [name, version] of Object.entries(byName)) latestPackVersions.set(name, version);
  refreshPackStaleness();
}

export function notePackVersion(name: unknown, version: unknown) {
  if (typeof name !== 'string' || typeof version !== 'string') return;
  latestPackVersions.set(name, version);
  refreshPackStaleness();
}

function applyPackStaleness(ui: SessionUi) {
  const stale = stalePackNames(ui.packs, latestPackVersions);
  paintCardBadge(ui, '.pack-badge', 'packStale', {
    on: stale.length > 0,
    title: stale.length > 0
      ? `Rebuilt since this session started: ${stale.join(', ')}. Restart it to pick up the new context.`
      : '',
  });
}

function refreshPackStaleness() {
  for (const [, ui] of sessionUIs) applyPackStaleness(ui);
}

export function setSessionUsage(sessionId: unknown, usage: UsageSessionUsage | null | undefined) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  const text = sessionChipText(usage);
  paintCardBadge(ui, '.usage-badge', 'usage', {
    on: !!text,
    text: text || '',

    title: text ? sessionChipTitle(usage) : undefined,
  });
}

export function setSessionPrompt(sessionId: unknown, kind: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  paintCardBadge(ui, '.prompt-badge', 'prompt', {
    on: !!kind,
    value: asText(kind),
    text: kind === 'permission' ? 'permission' : 'input',
  });
}

function formatWakeupChip(at: unknown) {
  if (!at) return 'scheduled';
  const d = new Date(at as string | number);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `sleeping until ~${hh}:${mm}`;
}

export function setSessionWakeup(sessionId: unknown, wakeup: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;

  const pending = wakeup as { kind?: string; at?: number; reason?: string } | null | undefined;
  paintCardBadge(ui, '.wakeup-badge', 'wakeup', {
    on: !!pending,
    value: pending?.kind || 'wakeup',
    text: formatWakeupChip(pending?.at),
    title: pending?.reason ? `Scheduled revival: ${pending.reason}` : 'Scheduled revival pending',
  });
}

export function setSessionPostTurn(sessionId: unknown, report: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;

  const r = (report || {}) as PostTurnReport;
  const findings = Array.isArray(r.findings) ? r.findings : [];
  const fixed = r.filesFixed || 0;
  let kind: 'fixed' | 'flagged' | null = null;
  let count = 0;
  if (!r.skipped && r.mode === 'fix' && fixed > 0) {
    kind = 'fixed';
    count = fixed;
  }
  if (!r.skipped && r.mode === 'report' && findings.length > 0) {
    kind = 'flagged';
    count = new Set(findings.map((f) => f.file)).size;
  }
  const perRule: Record<string, number> = {};
  for (const f of findings) perRule[f.rule] = (perRule[f.rule] || 0) + (f.count || 0);
  const detail = Object.keys(perRule).map((k) => `${k}: ${perRule[k]}`).join(', ');
  const verb = kind === 'fixed' ? 'auto-fixed' : 'flagged';
  const glyph = kind === 'fixed' ? '✓' : '⚠';
  paintCardBadge(ui, '.post-turn-badge', 'pt', {
    on: !!kind,
    value: kind || undefined,
    text: `${glyph} ${count}`,
    title: `Post-turn ${verb} ${count} file(s)${detail ? ` (${detail})` : ''}`,
  });
}

function applyMergeDataset(card: HTMLElement, ms: string) {
  if (ms === 'pending-review' || ms === 'parked' || ms === 'merging') { card.dataset.merge = ms; return; }
  delete card.dataset.merge;
}

export function setSessionMergeStatus(sessionId: unknown, mergeStatus: unknown, reason: unknown = null) {
  const ui = findSessionUi(sessionId);
  const ms = asText(mergeStatus) || 'none';
  if (ui) applyMergeDataset(ui.card, ms);
  setReviewMergeStatus(sessionIdOf(sessionId), ms, asText(reason) || null);
}

export function seedSessionMergeStatus(sessionId: unknown, mergeStatus: unknown, reason: unknown = null) {
  const ui = findSessionUi(sessionId);
  const ms = asText(mergeStatus) || 'none';
  if (ui) applyMergeDataset(ui.card, ms);
  seedReviewMergeStatus(sessionIdOf(sessionId), ms, asText(reason) || null);
}

export function setSessionDiff(sessionId: unknown, payload: unknown) {
  setReviewDiff(sessionIdOf(sessionId), payload);
}

export function renameSessionCard(sessionId: unknown, newName: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;

  const name = asText(newName);
  ui.card.dataset.session = name;
  ui.nameEl.textContent = name;
}

export function removeSessionCard(sessionId: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;

  closeDebugOverlay(ui);
  sessionUIs.delete(sessionIdOf(sessionId));

  if (ui.resizeObserver) ui.resizeObserver.disconnect();
  if (ui.abortController) ui.abortController.abort();
  if (ui.dataWs && ui.dataWs.readyState <= WebSocket.OPEN) ui.dataWs.close();
  releaseWebgl(ui);
  cancelTerminalRepaint(ui);
  if (ui.term) ui.term.dispose();

  ui.term = null;
  ui.fitAddon = null;
  if (ui.card) ui.card.remove();
  updateAggregateStatus();
}

function _handleEndedTransition(ui: SessionUi, wasActive: boolean, state: string) {
  if (!wasActive || !ui.term) return;
  ui.term.clear();
  ui.term.reset();
  const label = state === STATES.DONE ? 'Session complete' : 'Session failed';
  const color = state === STATES.DONE ? '\x1b[34m' : '\x1b[31m';
  ui.term.write(`\r\n\x1b[2m${color}  ${label}\x1b[0m\r\n\r\n\x1b[2m  Press Restart to start a new session.\x1b[0m\r\n`);
}

function _handleRestartTransition(ui: SessionUi, prevState: string) {
  if (!ui.term) return;
  if (prevState === STATES.DONE || prevState === STATES.FAILED) {
    ui.term.clear();
    ui.term.reset();
  }
}

export function applyState(sessionId: unknown, nextState: unknown, stateSince: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;

  const state = asText(nextState);
  const prevState = ui.currentState;
  ui.currentState = state;

  if (state !== prevState) {
    ui.stateSince = typeof stateSince === 'number' && Number.isFinite(stateSince) ? stateSince : Date.now();
    setRunningActivity(ui, state === STATES.RUNNING);
  }

  if (prevState === STATES.DORMANT && state !== STATES.DORMANT) {
    ensureTerminalSetup(ui, sessionIdOf(sessionId));
  }

  ui.card.dataset.state = state;

  updateButtonVisibility(ui);

  if ((state === STATES.WAITING && prevState !== STATES.WAITING)
      || (state === STATES.COMPLETE && prevState !== STATES.COMPLETE)) {
    if (isSoundEnabled()) playAlertSound(getSoundId());
  }

  const isEnding = state === STATES.DONE || state === STATES.FAILED;
  const wasActive = prevState !== STATES.DONE && prevState !== STATES.FAILED && prevState !== STATES.INITIALIZING;
  if (isEnding && wasActive) {
    ui.card.classList.remove('completion-flash');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ui.card.classList.add('completion-flash');
        ui.card.addEventListener('animationend', () => ui.card.classList.remove('completion-flash'), { once: true });
      });
    });
    if (isSoundEnabled()) playAlertSound(getSoundId());
  }

  if (state === STATES.DONE || state === STATES.FAILED) {
    _handleEndedTransition(ui, wasActive, state);
  }

  if (state === STATES.INITIALIZING) {
    _handleRestartTransition(ui, prevState);
  }

  updateAggregateStatus();

  refreshElapsed(ui);
}
