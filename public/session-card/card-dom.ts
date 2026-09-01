
import { STATES } from '#shared/states.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el, escapeHtml } from '../dom-helpers.ts';
import type { SessionUi } from './card-registry.ts';
import { findSessionUi, sessionUIs } from './card-registry.ts';
import { showErrorToast } from './toast.ts';

let _debugMode = false;

export function setDebugMode(on: boolean) {
  _debugMode = !!on;
  updateDebugVisibility();
}


interface TagBadgeSpec {
  cls: string;
  text?: string;
  title?: string;
  ariaLabel?: string;
  ariaHidden?: boolean;
}

const TAG_BADGES: TagBadgeSpec[] = [
  { cls: 'agent-badge', title: 'Agent CLI this session supervises' },
  { cls: 'worktree-badge', text: 'worktree', title: 'Running in a linked git worktree', ariaLabel: 'Linked git worktree' },
  { cls: 'resume-badge', text: 'resumed', title: 'Resumes a saved conversation on next start', ariaLabel: 'Resumes a saved conversation' },
  { cls: 'post-turn-badge', ariaHidden: true },
  { cls: 'agents-badge', title: 'Background sub-agents still running' },
  { cls: 'usage-badge', title: 'Tokens and estimated API list-price cost for this conversation' },
  { cls: 'pack-badge', text: 'pack stale' },
  { cls: 'wakeup-badge' },
  { cls: 'prompt-badge', title: 'Waiting on a permission or input prompt' },
];

function buildTagBadge({ cls, text = '', title, ariaLabel, ariaHidden }: TagBadgeSpec) {
  const badge = el('span', cls, text);
  if (title) badge.title = title;
  if (ariaLabel) badge.setAttribute('aria-label', ariaLabel);
  if (ariaHidden) badge.setAttribute('aria-hidden', 'true');
  return badge;
}

export interface CardOptions {
  skipPerms?: boolean;
  worktree?: boolean;
  resume?: boolean;
  path?: unknown;
  stateSince?: unknown;
}

export function buildCardDOM(sessionId: string, sessionName: string, initialState: string, options: CardOptions = {}) {
  const state = initialState || STATES.INITIALIZING;
  const card = el('div', 'session-card');
  card.dataset.id = sessionId;
  card.dataset.session = sessionName;
  card.dataset.state = state;
  if (options.skipPerms) card.dataset.skipPerms = '';
  if (options.worktree) card.dataset.worktree = '';
  if (options.resume) card.dataset.resume = '';
  if (options.path) card.dataset.path = String(options.path);

  const header = el('div', 'session-card-header');

  const nameEl = el('span', 'session-name', sessionName);
  const permsBadge = options.skipPerms ? el('span', 'perms-badge', 'YOLO') : null;
  if (permsBadge) permsBadge.title = 'Running with --dangerously-skip-permissions';
  const spacer = el('span', 'session-header-spacer');

  const elapsedEl = el('span', 'card-elapsed');
  elapsedEl.setAttribute('aria-hidden', 'true');

  const actions = el('div', 'session-actions');

  const overflow = el('div', 'session-overflow');
  const btnOverflow = el('button', 'btn-action btn-overflow visible', '\u22ee');
  btnOverflow.title = 'More actions';
  btnOverflow.setAttribute('aria-label', 'More actions');
  btnOverflow.setAttribute('aria-haspopup', 'menu');
  btnOverflow.setAttribute('aria-expanded', 'false');
  const overflowMenu = el('div', 'session-overflow-menu');
  overflowMenu.setAttribute('role', 'menu');

  const btnRename = el('button', 'overflow-item overflow-rename', 'Rename');
  btnRename.setAttribute('role', 'menuitem');
  const btnRestart = el('button', 'overflow-item overflow-restart', 'Restart');
  btnRestart.setAttribute('role', 'menuitem');
  const btnRestartFresh = el('button', 'overflow-item overflow-restart-fresh', 'Restart fresh');
  btnRestartFresh.setAttribute('role', 'menuitem');
  const btnResume = el('button', 'overflow-item overflow-resume', 'Resume conversation...');
  btnResume.setAttribute('role', 'menuitem');

  const btnRemove = el('button', 'overflow-item overflow-remove', 'Remove');
  btnRemove.setAttribute('role', 'menuitem');
  overflowMenu.append(btnRename, btnRestart, btnRestartFresh, btnResume, btnRemove);
  overflow.append(btnOverflow, overflowMenu);

  const btnDebug = el('button', 'btn-action btn-debug', '\u2699');
  btnDebug.title = 'Debug state';
  btnDebug.setAttribute('aria-label', 'Debug session state');

  actions.append(btnDebug, overflow);
  const tags = el('div', 'session-card-tags');
  const tagChildren = TAG_BADGES.map((spec) => buildTagBadge(spec));
  if (permsBadge) tagChildren.push(permsBadge);
  tags.append(...tagChildren);
  header.append(nameEl, elapsedEl, spacer, tags, actions);

  const termWrap = el('div', 'terminal-wrap');

  card.append(header, termWrap);

  return { card, header, nameEl, elapsedEl, btnRename, btnRestart, btnRestartFresh, btnResume, btnRemove, btnDebug, btnOverflow, overflowMenu, termWrap };
}


const RENAME_INPUT_CLASS = 'session-rename-input';

export function isRenameInProgress(targetEl: Element | null | undefined) {
  return !!targetEl?.querySelector(`.${RENAME_INPUT_CLASS}`);
}

export function startInlineRename(ui: SessionUi, sessionId: string) {
  const targetEl = ui.renameTargetEl?.isConnected ? ui.renameTargetEl : ui.nameEl;
  if (!targetEl || isRenameInProgress(targetEl)) return;

  const nameBeforeEdit = ui.card?.dataset.session ?? targetEl.textContent ?? '';

  function repaintName() {
    const name = ui.card?.dataset.session ?? nameBeforeEdit;
    targetEl.textContent = name;
    if (ui.nameEl && ui.nameEl !== targetEl) ui.nameEl.textContent = name;
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.className = RENAME_INPUT_CLASS;
  input.value = nameBeforeEdit;
  input.maxLength = 64;

  targetEl.textContent = '';
  targetEl.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const newName = input.value.trim();
    cleanup();
    if (!newName || newName === nameBeforeEdit) {
      repaintName();
      return;
    }
    for (const [, other] of sessionUIs) {
      if (other !== ui && other.card.dataset.session === newName) {
        repaintName();
        showErrorToast(`Session "${newName}" already exists.`);
        return;
      }
    }
    sendControlMsg({ type: 'rename-session', id: sessionId, newName });
    repaintName();
  }

  function cancel() {
    cleanup();
    repaintName();
  }

  function cleanup() {
    input.removeEventListener('blur', commit);
    input.removeEventListener('keydown', onKey);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', onKey);
}


const DEBUG_CLOSE_BTN = '<button type="button" class="debug-close" aria-label="Close debug overlay" title="Close">×</button>';

function formatTimestamp(ts: number | undefined) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatSeconds(ms: number | undefined) {
  return `${(Number(ms || 0) / 1000).toFixed(1)}s`;
}

interface DecisionEntry {
  ts?: number;
  kind?: string;
  signal?: string;
  source?: string;
  action?: string;
  event?: string;
  active?: number;
  decision?: string;
  quietMs?: number;
  repeats?: number;
  category?: string;
  from?: string;
  to?: string;
  reason?: string;
}

interface TransitionDetail {
  signal?: string;
  source?: string;
  deferred?: boolean;
}

interface DebugStatePayload {
  state: string;
  transitions: { timestamp?: number; from: string; to: string; event: string; detail?: TransitionDetail | null }[];
  detection?: {
    lastSignal?: { signal?: string; source?: string; confidence?: string } | null;
    hooksInjected?: boolean;
    hookSeen?: boolean;
    titleState?: { lastKind?: string; hasSeenSpinner?: boolean } | null;
    agents?: { active?: number; counted?: number; declared?: number; idleNames?: number; idleTasks?: number } | null;
    gate?: { heldForMs?: number; seq?: number; lastActivitySeq?: number } | null;
  } | null;
  packs?: { name: string; version?: string }[];
  decisions?: DecisionEntry[];
}

function gateEvidence(d: DecisionEntry) {
  if (d.decision === 'gated') return `(${Number(d.active) || 0} bg)`;
  if (d.decision === 'wait' || d.decision === 'release') return `(quiet ${formatSeconds(d.quietMs)})`;
  return '';
}

function formatDecision(d: DecisionEntry) {
  const at = `<span class="debug-dim">${formatTimestamp(d.ts)}</span>`;
  if (d.kind === 'signal') {
    const from = escapeHtml([d.signal, d.source].filter(Boolean).join('/'));
    if (d.action === 'transition') return `${at} ${from} → <span class="debug-label">${escapeHtml(d.event || '')}</span>`;
    if (d.action === 'gate-held') return `${at} ${from} → held <span class="debug-dim">(${Number(d.active) || 0} bg)</span>`;
    return `${at} ${from} → <span class="debug-dim">no-op</span>`;
  }
  if (d.kind === 'gate') {
    const repeats = (d.repeats ?? 0) > 1 ? ` <span class="debug-dim">x${Number(d.repeats)}</span>` : '';
    const evidence = gateEvidence(d);
    const why = evidence ? ` <span class="debug-dim">${evidence}</span>` : '';
    return `${at} gate <span class="debug-label">${escapeHtml(d.decision || '?')}</span>${why}${repeats}`;
  }
  if (d.kind === 'notify') {
    const what = escapeHtml(d.category || d.to || '?');
    if (d.category) return `${at} notify <span class="debug-label">${what}</span>: fired`;
    return `${at} notify ${what}: <span class="debug-dim">silent (${escapeHtml(d.reason || '')})</span>`;
  }
  if (d.kind === 'notify-state') {
    return `${at} notify ${escapeHtml(d.category || '?')}: <span class="debug-dim">${escapeHtml(d.from || '?')} → ${escapeHtml(d.to || '?')}</span>`;
  }
  return `${at} <span class="debug-dim">${escapeHtml(d.kind || 'decision')}</span>`;
}

function renderDebugOverlay(ui: SessionUi, payload: DebugStatePayload) {
  if (!ui.debugOverlay) return;
  const p = payload;

  let html = DEBUG_CLOSE_BTN;
  html += `<div class="debug-section"><div class="debug-section-title">State</div>`;
  html += `<div class="debug-field"><span class="debug-label">Current:</span> <span class="debug-value">${escapeHtml(p.state)}</span></div>`;
  html += `</div>`;

  html += `<div class="debug-section"><div class="debug-section-title">Transitions (last ${p.transitions.length})</div>`;
  if (p.transitions.length === 0) {
    html += `<div class="debug-field debug-dim">No transitions recorded</div>`;
  }
  if (p.transitions.length > 0) {
    for (const t of p.transitions) {
      const d = t.detail && typeof t.detail === 'object' ? t.detail : null;
      const tagParts = d ? [d.signal, d.source, d.deferred ? 'deferred' : null].filter(Boolean) : [];
      const tag = tagParts.length > 0 ? ` <span class="debug-dim">${escapeHtml(tagParts.join('/'))}</span>` : '';
      html += `<div class="debug-field"><span class="debug-dim">${formatTimestamp(t.timestamp)}</span> ${escapeHtml(t.from)} → ${escapeHtml(t.to)} <span class="debug-label">${escapeHtml(t.event)}</span>${tag}</div>`;
    }
  }
  html += `</div>`;

  const det = p.detection || {};
  const ls = det.lastSignal;
  const ts = det.titleState || {};
  html += `<div class="debug-section"><div class="debug-section-title">Detection</div>`;
  html += `<div class="debug-field"><span class="debug-label">Last signal:</span> <span class="debug-value">${ls ? `${escapeHtml(ls.signal)} (${escapeHtml(ls.source || '?')}${ls.confidence ? `/${escapeHtml(ls.confidence)}` : ''})` : 'none'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Hooks injected:</span> <span class="debug-value">${det.hooksInjected ? 'yes' : 'no'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Hook seen:</span> <span class="debug-value">${det.hookSeen ? 'yes' : 'no (degraded → title)'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Title state:</span> <span class="debug-value">${escapeHtml(ts.lastKind || 'none')}${ts.hasSeenSpinner ? ' · spun' : ''}</span></div>`;
  html += `</div>`;

  const agents = det.agents || {};
  const gate = det.gate;
  html += `<div class="debug-section"><div class="debug-section-title">Agents</div>`;
  html += `<div class="debug-field"><span class="debug-label">Active:</span> <span class="debug-value">${Number(agents.active) || 0} (counted ${Number(agents.counted) || 0}, declared ${Number(agents.declared) || 0})</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Idle:</span> <span class="debug-value">${Number(agents.idleNames) || 0} names, ${Number(agents.idleTasks) || 0} tasks</span></div>`;
  const gateText = gate
    ? `held ${formatSeconds(gate.heldForMs)} (seq ${Number(gate.seq) || 0}, lastActivity ${Number(gate.lastActivitySeq) || 0})`
    : 'none';
  html += `<div class="debug-field"><span class="debug-label">Gate:</span> <span class="debug-value">${escapeHtml(gateText)}</span></div>`;
  html += `</div>`;

  const packs = Array.isArray(p.packs) ? p.packs : [];
  if (packs.length > 0) {
    html += `<div class="debug-section"><div class="debug-section-title">Packs</div>`;
    for (const pack of packs) {
      html += `<div class="debug-field"><span class="debug-label">${escapeHtml(pack.name)}:</span> <span class="debug-value">${escapeHtml(pack.version || 'unknown version')}</span></div>`;
    }
    html += `</div>`;
  }

  const decisions = Array.isArray(p.decisions) ? p.decisions : [];
  html += `<div class="debug-section"><div class="debug-section-title">Decisions (last ${decisions.length})</div>`;
  if (decisions.length === 0) {
    html += `<div class="debug-field debug-dim">No decisions recorded</div>`;
  }
  for (const d of decisions) {
    html += `<div class="debug-field">${formatDecision(d)}</div>`;
  }
  html += `</div>`;

  ui.debugOverlay.innerHTML = html;
}

export function openDebugOverlay(ui: SessionUi, sessionId: string) {
  if (ui.debugOpen) { closeDebugOverlay(ui); return; }

  const overlay = document.createElement('div');
  overlay.className = 'debug-overlay';
  overlay.innerHTML = `${DEBUG_CLOSE_BTN}<div class="debug-field debug-dim">Loading...</div>`;
  ui.card.appendChild(overlay);
  ui.debugOverlay = overlay;
  ui.debugOpen = true;

  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('.debug-close')) closeDebugOverlay(ui);
  });

  sendControlMsg({ type: 'debug-state', id: sessionId });
}

export function closeDebugOverlay(ui: SessionUi) {
  if (ui.debugOverlay) {
    ui.debugOverlay.remove();
    ui.debugOverlay = null;
  }
  ui.debugOpen = false;
}

function updateDebugVisibility() {
  for (const [, ui] of sessionUIs) {
    ui.btnDebug.classList.toggle('visible', _debugMode);
    if (!_debugMode && ui.debugOpen) closeDebugOverlay(ui);
  }
}

export function handleDebugStateResponse(msg: Record<string, unknown>) {
  const ui = typeof msg.id === 'string' ? sessionUIs.get(msg.id) : undefined;
  if (!ui || !ui.debugOpen) return;
  renderDebugOverlay(ui, msg.payload as DebugStatePayload);
}

export function handleDebugStateRefresh(sessionId: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui || !ui.debugOpen) return;
  sendControlMsg({ type: 'debug-state', id: sessionId });
}
