// Session-card DOM construction and per-card chrome: the card builder, the
// state badge, the inline rename flow, the inline confirm dialog, and the debug
// overlay. These build or mutate a single card's DOM; cross-card lifecycle
// (create/remove/applyState) lives in lifecycle.js.
//
// Must NOT import dialogs.js. dialogs.js imports naming helpers from this
// package, so the showConfirmDialog below is an inline confirm that keeps the
// card-dom.js <-> dialogs.js edge from becoming a cycle.

import { BADGE_LABELS, STATE_GLYPHS, STATES } from '/shared/states.mjs';
import { sendControlMsg } from '../control-ws.js';
import { el, escapeHtml } from '../dom-helpers.js';
import { sessionUIs } from './card-registry.js';
import { showErrorToast } from './toast.js';

// Debug overlay visibility — toggled by applyTerminalSettings (lifecycle) via
// setDebugMode so the lets that drive terminal options can stay in terminal.js.
let _debugMode = false;

export function setDebugMode(on) {
  _debugMode = !!on;
  updateDebugVisibility();
}

// ── Helpers (private) ────────────────────────────────────────

// Inline confirm dialog — avoids circular dep with dialogs.js (card-dom.js <-> dialogs.js).
export function showConfirmDialog({ title, message, confirmLabel = 'Confirm', onConfirm }) {
  const opener = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog';

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
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

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

  function close() {
    overlay.remove();
    opener?.focus?.();
  }

  btnCancel.addEventListener('click', close);
  btnConfirm.addEventListener('click', () => { close(); onConfirm?.(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
  });

  requestAnimationFrame(() => btnCancel.focus());
}

export function makeBadge(state) {
  const badge = el('span', 'state-badge');
  badge.dataset.state = state;
  badge.classList.add('has-glyph');
  const glyph = STATE_GLYPHS[state] || '';
  badge.innerHTML = '';
  const glyphSpan = document.createElement('span');
  glyphSpan.className = 'state-glyph';
  glyphSpan.setAttribute('aria-hidden', 'true');
  glyphSpan.textContent = glyph;
  // Label sits in its own span so CSS can reserve a fixed slot (min-width sized
  // to the widest label). A constant-width badge is what stops status changes
  // from reflowing the YOLO/worktree tags downstream of it. applyState() updates
  // this span's text in place (see lifecycle.applyState).
  const labelSpan = document.createElement('span');
  labelSpan.className = 'state-label';
  labelSpan.textContent = BADGE_LABELS[state] || state;
  badge.appendChild(glyphSpan);
  badge.appendChild(labelSpan);
  return badge;
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

  // Header
  const header = el('div', 'session-card-header');

  const btnMinimize = el('span', 'btn-minimize', '\u25bc');
  btnMinimize.title = 'Collapse';
  btnMinimize.setAttribute('aria-label', 'Collapse');

  const nameEl = el('span', 'session-name', sessionName);
  const badge = makeBadge(state);
  badge.classList.add('session-badge');
  const permsBadge = options.skipPerms ? el('span', 'perms-badge', 'YOLO') : null;
  if (permsBadge) permsBadge.title = 'Running with --dangerously-skip-permissions';
  // Always built; shown only when the card carries data-worktree (toggled live by
  // setSessionWorktree on the session-git delta), so the badge needs no rebuild.
  const worktreeBadge = el('span', 'worktree-badge', 'worktree');
  worktreeBadge.title = 'Running in a linked git worktree';
  worktreeBadge.setAttribute('aria-label', 'Linked git worktree');
  // Post-turn auto-fix marker. Hidden unless the card carries data-pt (set live by
  // setSessionPostTurn on a post-turn-result delta). Text/title are filled there.
  const postTurnBadge = el('span', 'post-turn-badge', '');
  postTurnBadge.setAttribute('aria-hidden', 'true');
  const spacer = el('span', 'session-header-spacer');

  // Time-in-current-state readout. Hidden in the grid (CSS); shown only on the
  // minimized rail pill, where it answers "how long has this been waiting / working".
  // Ticked by rail.js. aria-hidden so a per-second text change never spams a screen
  // reader (the pill's aria-label carries the state name instead).
  const railElapsed = el('span', 'rail-elapsed');
  railElapsed.setAttribute('aria-hidden', 'true');

  // Action buttons
  const actions = el('div', 'session-actions');

  const btnMaximize = el('button', 'btn-action btn-maximize visible', '\u26F6');
  btnMaximize.title = 'Enter full screen';
  btnMaximize.setAttribute('aria-label', 'Enter full screen');

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
  const btnRemove = el('button', 'overflow-item overflow-remove', 'Remove');
  btnRemove.setAttribute('role', 'menuitem');
  overflowMenu.append(btnRename, btnRestart, btnRemove);
  overflow.append(btnOverflow, overflowMenu);

  const btnDebug = el('button', 'btn-action btn-debug', '\u2699');
  btnDebug.title = 'Debug state';
  btnDebug.setAttribute('aria-label', 'Debug session state');

  actions.append(btnDebug, btnMaximize, overflow);
  // Order matters for layout stability. The variable-width status badge sits in
  // the LEFT zone (with the name); the spacer then absorbs its width changes, so
  // the persistent tags + actions in the RIGHT zone never reflow when status
  // changes. Combined with the reserved-width badge slot (see .state-label), the
  // header is dimensionally rigid across all states.
  const headerChildren = [btnMinimize, nameEl, badge, spacer, worktreeBadge, postTurnBadge];
  if (permsBadge) headerChildren.push(permsBadge);
  headerChildren.push(railElapsed, actions);
  header.append(...headerChildren);

  const termWrap = el('div', 'terminal-wrap');

  card.append(header, termWrap);

  return { card, header, badge, nameEl, railElapsed, btnRename, btnRestart, btnRemove, btnMinimize, btnMaximize, btnDebug, btnOverflow, overflowMenu, termWrap };
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
    // Check for duplicate name (not id — names are display labels)
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
  if (!ts) return '—';
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

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + '...' : str;
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
