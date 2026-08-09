// Session-card DOM construction and per-card chrome: the card builder, the
// state badge, the inline rename flow, the inline confirm dialog, and the debug
// overlay. These build or mutate a single card's DOM; cross-card lifecycle
// (create/remove/applyState) lives in lifecycle.js.
//
// Must NOT import dialogs.js. dialogs.js imports naming helpers from this
// package, so the showConfirmDialog below is an inline confirm that keeps the
// card-dom.js <-> dialogs.js edge from becoming a cycle.

import { STATES } from '/shared/states.mjs';
import { sendControlMsg } from '../control-ws.js';
import { el, escapeHtml } from '../dom-helpers.js';
import { sessionUIs } from './card-registry.js';
import { createModalOverlay, trapFocus } from './modal.js';
import { showErrorToast } from './toast.js';

// Debug overlay visibility - toggled by applyTerminalSettings (lifecycle) via
// setDebugMode so the lets that drive terminal options can stay in terminal.js.
let _debugMode = false;

export function setDebugMode(on) {
  _debugMode = !!on;
  updateDebugVisibility();
}

// ── Helpers (private) ────────────────────────────────────────

// Inline confirm dialog - avoids circular dep with dialogs.js (card-dom.js <-> dialogs.js).
export function showConfirmDialog({ title, message, confirmLabel = 'Confirm', onConfirm }) {
  const { dialog, close } = createModalOverlay();

  const titleId = `sc-confirm-${Math.random().toString(36).slice(2)}`;

  const titleEl = document.createElement('h3');
  titleEl.id = titleId;
  titleEl.className = 'dialog-title';
  titleEl.textContent = title;

  const msgEl = document.createElement('p');
  msgEl.className = 'dialog-message';
  msgEl.textContent = message;

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';

  const btnCancel = document.createElement('button');
  btnCancel.className = 'btn-dialog btn-dialog-cancel';
  btnCancel.textContent = 'Cancel';

  const btnConfirm = document.createElement('button');
  btnConfirm.className = 'btn-dialog btn-dialog-confirm';
  btnConfirm.textContent = confirmLabel;

  actions.append(btnCancel, btnConfirm);
  dialog.append(titleEl, msgEl, actions);

  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);

  trapFocus(dialog);

  btnCancel.addEventListener('click', close);
  btnConfirm.addEventListener('click', () => { close(); onConfirm?.(); });

  requestAnimationFrame(() => btnCancel.focus());
}

// ── Card DOM builder ─────────────────────────────────────────

export function buildCardDOM(sessionId, sessionName, initialState, options = {}) {
  const state = initialState || STATES.INITIALIZING;
  const card = el('div', 'session-card');
  card.dataset.id = sessionId;
  card.dataset.session = sessionName;
  card.dataset.state = state;
  if (options.skipPerms) card.dataset.skipPerms = '';
  if (options.worktree) card.dataset.worktree = '';
  if (options.resume) card.dataset.resume = '';
  // The session's project root. The Focus rail groups pills by this (basename = group label).
  // Durable on-DOM home so the DORMANT close-out rebuild can re-read it (nothing inherits through
  // that rebuild automatically - app.js reads dataset.path back by hand, same as skipPerms).
  if (options.path) card.dataset.path = options.path;

  // Header
  const header = el('div', 'session-card-header');

  const nameEl = el('span', 'session-name', sessionName);
  const permsBadge = options.skipPerms ? el('span', 'perms-badge', 'YOLO') : null;
  if (permsBadge) permsBadge.title = 'Running with --dangerously-skip-permissions';
  // Always built; shown only when the card carries data-worktree (toggled live by
  // setSessionWorktree on the session-git delta), so the badge needs no rebuild.
  const worktreeBadge = el('span', 'worktree-badge', 'worktree');
  worktreeBadge.title = 'Running in a linked git worktree';
  worktreeBadge.setAttribute('aria-label', 'Linked git worktree');
  // Resumed-conversation marker. Shown only when the card carries data-resume (set at build time from
  // the snapshot, toggled live by setSessionResume on the session-resume delta): the card will resume a
  // saved conversation on its next start rather than beginning a fresh one.
  const resumeBadge = el('span', 'resume-badge', 'resumed');
  resumeBadge.title = 'Resumes a saved conversation on next start';
  resumeBadge.setAttribute('aria-label', 'Resumes a saved conversation');
  // Post-turn auto-fix marker. Hidden unless the card carries data-pt (set live by
  // setSessionPostTurn on a post-turn-result delta). Text/title are filled there.
  const postTurnBadge = el('span', 'post-turn-badge', '');
  postTurnBadge.setAttribute('aria-hidden', 'true');
  // Live background sub-agent count. Hidden unless the card carries data-agents (set live by
  // setSessionAgents on a session-agents delta): the main turn ended but N background sub-agents are
  // still running, so the card stays Working rather than flipping to Complete. Text filled there.
  const agentsBadge = el('span', 'agents-badge', '');
  agentsBadge.title = 'Background sub-agents still running';
  // Pending scheduled revival. Hidden unless the card carries data-wakeup (set live by
  // setSessionWakeup on a session-wakeup delta / snapshot): the turn genuinely finished, but the
  // session scheduled its own revival (dynamic /loop ScheduleWakeup or a cron task), so the card
  // says "sleeping until ~HH:MM" instead of just looking done. Advisory and self-expiring:
  // Esc-cancel fires no hook, so the chip ages out rather than being authoritative.
  const wakeupBadge = el('span', 'wakeup-badge', '');
  // Advisory pending-prompt-kind marker. Hidden unless the card carries data-prompt (set live by
  // setSessionPrompt on a session-prompt delta / snapshot): shows WHAT a WAITING session is
  // waiting on (permission vs elicitation). Text filled there.
  const promptBadge = el('span', 'prompt-badge', '');
  promptBadge.title = 'Waiting on a permission or input prompt';
  const spacer = el('span', 'session-header-spacer');

  // Time-in-current-state readout on the card header (trailing the name), shown in the Focus center:
  // "how long has this been working / waiting". Empty for settled states, so :empty hides it. Ticked by
  // session-tick.js. aria-hidden so a per-second text change never spams a screen reader (the rail pill
  // and the toolbar accent strip carry the state itself).
  const elapsedEl = el('span', 'card-elapsed');
  elapsedEl.setAttribute('aria-hidden', 'true');

  // Action buttons
  const actions = el('div', 'session-actions');

  // Overflow menu (Restart + Remove tucked away to prevent accidental clicks)
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
  // Resume a prior Claude conversation (including one started in a different worktree) into this card.
  const btnResume = el('button', 'overflow-item overflow-resume', 'Resume conversation...');
  btnResume.setAttribute('role', 'menuitem');

  const btnRemove = el('button', 'overflow-item overflow-remove', 'Remove');
  btnRemove.setAttribute('role', 'menuitem');
  overflowMenu.append(btnRename, btnRestart, btnResume, btnRemove);
  overflow.append(btnOverflow, overflowMenu);

  const btnDebug = el('button', 'btn-action btn-debug', '\u2699');
  btnDebug.title = 'Debug state';
  btnDebug.setAttribute('aria-label', 'Debug session state');

  actions.append(btnDebug, overflow);
  // Order matters for layout stability. The name and its trailing elapsed clock sit in the LEFT
  // zone; the spacer then absorbs the clock's width changes, so the persistent tags + actions in
  // the RIGHT zone never reflow when the timer ticks. (Status is not shown here: it lives on the
  // Focus rail pill and the toolbar accent strip.)
  const headerChildren = [nameEl, elapsedEl, spacer, worktreeBadge, resumeBadge, postTurnBadge, agentsBadge, wakeupBadge, promptBadge];
  if (permsBadge) headerChildren.push(permsBadge);
  headerChildren.push(actions);
  header.append(...headerChildren);

  // The worktree review gate moved to the right review sidebar (sidebar/review-sidebar.js), the single
  // home for diff + merge/discard. The card keeps only data-merge (set by setSessionMergeStatus) for the
  // remove-warning; it no longer renders an inline review bar.
  const termWrap = el('div', 'terminal-wrap');

  card.append(header, termWrap);

  return { card, header, nameEl, elapsedEl, btnRename, btnRestart, btnResume, btnRemove, btnDebug, btnOverflow, overflowMenu, termWrap };
}

// ── Inline rename ────────────────────────────────────────────

// The rename field's class, and the predicate ANY surface must consult before repainting a name into
// an element that can be a rename target. Both live here because startInlineRename owns the field's
// lifecycle. A repaint that replaces the node mid-edit either loses what the operator typed outright
// (Chrome does not reliably fire blur on a removed focused node) or fires blur and commits a
// half-typed name, so this guard is load-bearing, not cosmetic.
const RENAME_INPUT_CLASS = 'session-rename-input';

export function isRenameInProgress(targetEl) {
  return !!targetEl?.querySelector(`.${RENAME_INPUT_CLASS}`);
}

export function startInlineRename(ui, sessionId) {
  // Resolve the target BEFORE anything reads a name, so the seed, the field and the restore all act on
  // the same element. The phone Terminal screen borrows the card without its header and parks its own
  // top-bar name on ui.renameTargetEl; a stale target left disconnected by a layout flip falls back to
  // the card header rather than editing a node nobody can see.
  const targetEl = ui.renameTargetEl?.isConnected ? ui.renameTargetEl : ui.nameEl;
  if (!targetEl || isRenameInProgress(targetEl)) return; // also guards double-invoke

  // card.dataset.session is the one authoritative display name (renameSessionCard writes it when the
  // server broadcasts). Seeding and restoring from it, rather than from whichever node happened to be
  // the target, is what keeps the card header and the phone top bar in agreement when a layout flip
  // moves the target mid-edit.
  const nameBeforeEdit = ui.card?.dataset.session ?? targetEl.textContent;

  // Repaint every node that shows this name from the authoritative value, so neither surface is left
  // holding a stale one until its own next repaint.
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
    // Check for duplicate name (not id - names are display labels)
    for (const [, other] of sessionUIs) {
      if (other !== ui && other.card.dataset.session === newName) {
        repaintName();
        showErrorToast(`Session "${newName}" already exists.`);
        return;
      }
    }
    sendControlMsg({ type: 'rename-session', id: sessionId, newName });
    // Repaints the name the session CURRENTLY has, not the one just submitted, so the operator sees the
    // old name until the server's session-renamed broadcast lands and renameSessionCard applies the new
    // one. That brief flash is deliberate, not an oversight: the server can refuse this rename and sends
    // no broadcast when it does, and its name pattern (SESSION_NAME_RE in control-handlers.js) is
    // stricter than the two checks above, so a name with a slash or a colon reaches here and is rejected.
    // Painting newName optimistically would leave the card header showing a name the session never took,
    // with nothing to correct it. Show the state that is known, never the one that was asked for.
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

  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', onKey);
}

// ── Debug overlay ────────────────────────────────────────────

const DEBUG_CLOSE_BTN = '<button type="button" class="debug-close" aria-label="Close debug overlay" title="Close">×</button>';

function formatTimestamp(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatSeconds(ms) {
  return `${(Number(ms || 0) / 1000).toFixed(1)}s`;
}

// What a gate verdict was decided on. 'cancel' has neither figure to report: it fires on a state
// change or newer activity, where the live count and the quiet window are both irrelevant.
function gateEvidence(d) {
  if (d.decision === 'gated') return `(${Number(d.active) || 0} bg)`;
  if (d.decision === 'wait' || d.decision === 'release') return `(quiet ${formatSeconds(d.quietMs)})`;
  return '';
}

// One compact line per decision-trace entry (session/core/decision-log.js): what the session
// decided, and the evidence it decided on.
function formatDecision(d) {
  const at = `<span class="debug-dim">${formatTimestamp(d.ts)}</span>`;
  if (d.kind === 'signal') {
    const from = escapeHtml([d.signal, d.source].filter(Boolean).join('/'));
    if (d.action === 'transition') return `${at} ${from} → <span class="debug-label">${escapeHtml(d.event || '')}</span>`;
    if (d.action === 'gate-held') return `${at} ${from} → held <span class="debug-dim">(${Number(d.active) || 0} bg)</span>`;
    return `${at} ${from} → <span class="debug-dim">no-op</span>`;
  }
  if (d.kind === 'gate') {
    const repeats = d.repeats > 1 ? ` <span class="debug-dim">x${Number(d.repeats)}</span>` : '';
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

function renderDebugOverlay(ui, payload) {
  if (!ui.debugOverlay) return;
  const p = payload;

  let html = DEBUG_CLOSE_BTN;
  html += `<div class="debug-section"><div class="debug-section-title">State</div>`;
  html += `<div class="debug-field"><span class="debug-label">Current:</span> <span class="debug-value">${escapeHtml(p.state)}</span></div>`;
  html += `</div>`;

  // Transitions
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

  // Detection (structural signals)
  const det = p.detection || {};
  const ls = det.lastSignal;
  const ts = det.titleState || {};
  html += `<div class="debug-section"><div class="debug-section-title">Detection</div>`;
  html += `<div class="debug-field"><span class="debug-label">Last signal:</span> <span class="debug-value">${ls ? `${escapeHtml(ls.signal)} (${escapeHtml(ls.source || '?')}${ls.confidence ? `/${escapeHtml(ls.confidence)}` : ''})` : 'none'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Hooks injected:</span> <span class="debug-value">${det.hooksInjected ? 'yes' : 'no'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Hook seen:</span> <span class="debug-value">${det.hookSeen ? 'yes' : 'no (degraded → title)'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Title state:</span> <span class="debug-value">${escapeHtml(ts.lastKind || 'none')}${ts.hasSeenSpinner ? ' · spun' : ''}</span></div>`;
  html += `</div>`;

  // Background work + the completion gate: the two inputs that decide whether a turn-end ready
  // completes the card now, later, or never.
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

  // Decision trace: why each of the above fired (or stayed silent), newest last.
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

export function openDebugOverlay(ui, sessionId) {
  if (ui.debugOpen) { closeDebugOverlay(ui); return; }

  const overlay = document.createElement('div');
  overlay.className = 'debug-overlay';
  overlay.innerHTML = `${DEBUG_CLOSE_BTN}<div class="debug-field debug-dim">Loading...</div>`;
  ui.card.appendChild(overlay);
  ui.debugOverlay = overlay;
  ui.debugOpen = true;

  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('.debug-close')) closeDebugOverlay(ui);
  });

  sendControlMsg({ type: 'debug-state', id: sessionId });
}

export function closeDebugOverlay(ui) {
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

export function handleDebugStateResponse(msg) {
  const ui = sessionUIs.get(msg.id);
  if (!ui || !ui.debugOpen) return;
  renderDebugOverlay(ui, msg.payload);
}

export function handleDebugStateRefresh(sessionId) {
  const ui = sessionUIs.get(sessionId);
  if (!ui || !ui.debugOpen) return;
  sendControlMsg({ type: 'debug-state', id: sessionId });
}
