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
import { createModalOverlay } from './modal.js';
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

  const titleId = 'sc-confirm-' + Math.random().toString(36).slice(2);

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

  // Focus trap
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

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
  const spacer = el('span', 'session-header-spacer');

  // Time-in-current-state readout on the card header (trailing the name), shown in the Focus center:
  // "how long has this been working / waiting". Empty for settled states, so :empty hides it. Ticked by
  // session-tick.js. aria-hidden so a per-second text change never spams a screen reader (the rail pill
  // and the toolbar accent strip carry the state itself).
  const elapsedEl = el('span', 'card-elapsed');
  elapsedEl.setAttribute('aria-hidden', 'true');

  // Action buttons
  const actions = el('div', 'session-actions');

  // Overflow menu (Restart + Park + Remove tucked away to prevent accidental clicks)
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

  // Park: returns the session to DORMANT for reuse. On a session with unmerged worktree changes the
  // click reveals an inline confirm (no modal); a clean session parks immediately. The dot marks the
  // destructive case at rest (CSS shows it only when the card carries data-merge pending-review/parked).
  const parkGroup = el('div', 'overflow-park-group');
  const btnPark = el('button', 'overflow-item overflow-park', 'Park');
  btnPark.setAttribute('role', 'menuitem');
  btnPark.append(el('span', 'overflow-park-dot'));
  const parkConfirm = el('div', 'overflow-confirm');
  const parkConfirmInner = el('div', 'overflow-confirm-inner');
  const parkMsg = el('p', 'overflow-confirm-msg', 'Discards unmerged work');
  parkMsg.id = `park-msg-${sessionId}`;
  const parkActions = el('div', 'overflow-confirm-actions');
  const btnParkCancel = el('button', 'overflow-confirm-cancel', 'Cancel');
  const btnParkGo = el('button', 'overflow-confirm-go', 'Discard & park');
  btnParkGo.setAttribute('aria-describedby', parkMsg.id);
  parkActions.append(btnParkCancel, btnParkGo);
  parkConfirmInner.append(parkMsg, parkActions);
  parkConfirm.append(parkConfirmInner);
  parkGroup.append(btnPark, parkConfirm);

  const btnRemove = el('button', 'overflow-item overflow-remove', 'Remove');
  btnRemove.setAttribute('role', 'menuitem');
  overflowMenu.append(btnRename, btnRestart, btnResume, parkGroup, btnRemove);
  overflow.append(btnOverflow, overflowMenu);

  const btnDebug = el('button', 'btn-action btn-debug', '\u2699');
  btnDebug.title = 'Debug state';
  btnDebug.setAttribute('aria-label', 'Debug session state');

  actions.append(btnDebug, overflow);
  // Order matters for layout stability. The name and its trailing elapsed clock sit in the LEFT
  // zone; the spacer then absorbs the clock's width changes, so the persistent tags + actions in
  // the RIGHT zone never reflow when the timer ticks. (Status is not shown here: it lives on the
  // Focus rail pill and the toolbar accent strip.)
  const headerChildren = [nameEl, elapsedEl, spacer, worktreeBadge, resumeBadge, postTurnBadge, agentsBadge, wakeupBadge];
  if (permsBadge) headerChildren.push(permsBadge);
  headerChildren.push(actions);
  header.append(...headerChildren);

  // The worktree review gate moved to the right review sidebar (sidebar/review-sidebar.js), the single
  // home for diff + merge/discard. The card keeps only data-merge (set by setSessionMergeStatus) for the
  // remove-warning; it no longer renders an inline review bar.
  const termWrap = el('div', 'terminal-wrap');

  card.append(header, termWrap);

  return { card, header, nameEl, elapsedEl, btnRename, btnRestart, btnResume, parkGroup, btnPark, btnParkCancel, btnParkGo, btnRemove, btnDebug, btnOverflow, overflowMenu, termWrap };
}

// ── Inline rename ────────────────────────────────────────────

export function startInlineRename(ui, sessionId) {
  // Guard: prevent double-invoke
  if (ui.nameEl.querySelector('.session-rename-input')) return;

  const nameEl = ui.nameEl;
  const oldName = nameEl.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = oldName;
  input.maxLength = 64;

  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const newName = input.value.trim();
    cleanup();
    if (!newName || newName === oldName) {
      nameEl.textContent = oldName;
      return;
    }
    // Check for duplicate name (not id - names are display labels)
    for (const [, other] of sessionUIs) {
      if (other !== ui && other.card.dataset.session === newName) {
        nameEl.textContent = oldName;
        showErrorToast(`Session "${newName}" already exists.`);
        return;
      }
    }
    sendControlMsg({ type: 'rename-session', id: sessionId, newName });
    nameEl.textContent = oldName; // server broadcast will apply the actual rename
  }

  function cancel() {
    cleanup();
    nameEl.textContent = oldName;
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
  } else {
    for (const t of p.transitions) {
      const d = t.detail && typeof t.detail === 'object' ? t.detail : null;
      const tag = d && (d.signal || d.source) ? ` <span class="debug-dim">${escapeHtml([d.signal, d.source].filter(Boolean).join('/'))}</span>` : '';
      html += `<div class="debug-field"><span class="debug-dim">${formatTimestamp(t.timestamp)}</span> ${escapeHtml(t.from)} → ${escapeHtml(t.to)} <span class="debug-label">${escapeHtml(t.event)}</span>${tag}</div>`;
    }
  }
  html += `</div>`;

  // Detection (structural signals)
  const det = p.detection || {};
  const ls = det.lastSignal;
  const ts = det.titleState || {};
  html += `<div class="debug-section"><div class="debug-section-title">Detection</div>`;
  html += `<div class="debug-field"><span class="debug-label">Last signal:</span> <span class="debug-value">${ls ? `${escapeHtml(ls.signal)} (${escapeHtml(ls.source || '?')}${ls.confidence ? '/' + escapeHtml(ls.confidence) : ''})` : 'none'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Hooks injected:</span> <span class="debug-value">${det.hooksInjected ? 'yes' : 'no'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Hook seen:</span> <span class="debug-value">${det.hookSeen ? 'yes' : 'no (degraded → title)'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Title state:</span> <span class="debug-value">${escapeHtml(ts.lastKind || 'none')}${ts.hasSeenSpinner ? ' · spun' : ''}</span></div>`;
  html += `</div>`;

  ui.debugOverlay.innerHTML = html;
}

export function openDebugOverlay(ui, sessionId) {
  if (ui.debugOpen) { closeDebugOverlay(ui); return; }

  const overlay = document.createElement('div');
  overlay.className = 'debug-overlay';
  overlay.innerHTML = DEBUG_CLOSE_BTN + '<div class="debug-field debug-dim">Loading...</div>';
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
