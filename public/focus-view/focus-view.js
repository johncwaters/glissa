// Focus view: an experimental watch-and-steer layout. A persistent left ROSTER RAIL (one lightweight
// pill per session, WAITING/needs-review bubble to the top) and a single large CENTER that holds the
// focused session's real card (re-parented, mirroring the maximize pattern, since each session owns one
// xterm). Signal-only: a session that needs input re-sorts in the rail and pulses, but never hijacks the
// center while you work. Worktree review happens in the right review sidebar: focusing a session (or
// clicking a rail pill) selects it there; the rail pill still tags REVIEW/PARKED so the operator knows
// which sessions have changes waiting.
//
// State lives here (view-local); it reads sessions from the shared card registry and never mutates the
// Sessions-tab minimize/maximize state. The card is returned to its exact home slot on leave/swap.

import { BADGE_LABELS, STATE_GLYPHS, STATES } from '/shared/states.mjs';
import { sendControlMsg } from '../control-ws.js';
import { setSelectedId } from '../sidebar/selection.js';
import { container, sessionUIs } from '../session-card/card-registry.js';
import { wakeSession } from '../session-card/layout.js';
import { ensureTerminalSetup, forceTerminalRepaint } from '../session-card/terminal.js';

let railEl = null;
let centerEl = null;
let cardSlotEl = null;
let emptyEl = null;
let emptyTitleEl = null;
let emptyDescEl = null;

let active = false;
let focusedId = null;
const mergeStatusById = new Map(); // id -> 'none'|'pending-review'|'merging'|'parked'|'merged'
const pillById = new Map();        // id -> rail pill element

export function isFocusActive() { return active; }

export function mountFocusView({ rail, center }) {
  railEl = rail;
  centerEl = center;

  emptyEl = document.createElement('div');
  emptyEl.className = 'focus-empty';
  emptyEl.innerHTML = '<p class="focus-empty-title"></p>'
    + '<p class="focus-empty-desc"></p>';
  emptyTitleEl = emptyEl.querySelector('.focus-empty-title');
  emptyDescEl = emptyEl.querySelector('.focus-empty-desc');

  cardSlotEl = document.createElement('div');
  cardSlotEl.className = 'focus-card-slot';

  // Review (diff + Merge & finish / Discard) lives in the right review sidebar, not in the center, so
  // the borrowed card is just the live terminal; selection drives the sidebar (see focusSession).
  centerEl.append(emptyEl, cardSlotEl);

  railEl.addEventListener('keydown', onRailKeydown);
}

// Roving-tabindex list nav: Up/Down move focus between pills; Enter/click (native button) focuses the
// session into the center. Lives on the rail only, so it never intercepts keystrokes meant for the
// centered terminal.
function onRailKeydown(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const pills = [...railEl.querySelectorAll('.focus-pill')];
  if (!pills.length) return;
  e.preventDefault();
  const dir = e.key === 'ArrowDown' ? 1 : -1;
  const cur = pills.indexOf(document.activeElement);
  const start = cur === -1 ? (dir === 1 ? -1 : 0) : cur;
  pills[(start + dir + pills.length) % pills.length].focus();
}

// ── Roster ordering: WAITING first, then needs-review, then RUNNING, then the rest (stable) ──

function rosterRank(ui, id) {
  if (ui.currentState === STATES.WAITING) return 0;
  const ms = mergeStatusById.get(id);
  if (ms === 'pending-review' || ms === 'parked') return 1;
  if (ui.currentState === STATES.RUNNING) return 2;
  return 3;
}

function orderedSessions() {
  return [...sessionUIs.entries()]
    .map(([id, ui], i) => ({ id, ui, i }))
    .sort((a, b) => rosterRank(a.ui, a.id) - rosterRank(b.ui, b.id) || a.i - b.i);
}

function sessionName(ui) {
  return ui.nameEl ? ui.nameEl.textContent : (ui.card ? (ui.card.dataset.session || ui.card.dataset.id) : '');
}

// ── Rail pills ──

function buildPill(id) {
  const pill = document.createElement('button');
  pill.className = 'focus-pill';
  pill.type = 'button';
  pill.dataset.id = id;
  pill.setAttribute('role', 'option');
  // Name first so its left edge never shifts as the state label (DORMANT -> RUNNING -> ...) changes
  // width; the badge + merge tag ride on the right where their flex is absorbed by the name's 1fr.
  pill.innerHTML = '<span class="focus-pill-name"></span>'
    + '<span class="focus-pill-badge">'
    + '<span class="focus-pill-glyph"></span><span class="focus-pill-label"></span></span>'
    + '<span class="focus-pill-merge"></span>';
  pill.addEventListener('click', () => onPillActivate(id));
  return pill;
}

// Clicking a pill focuses its session into the center. A DORMANT session is also STARTED (mirrors the
// Sessions-view minimized-pill expand): borrowToCenter has already wired the data WS via
// ensureTerminalSetup, so the spawning PTY's output flows into the centered card.
function onPillActivate(id) {
  const ui = sessionUIs.get(id);
  if (!ui) return;
  if (ui.currentState === STATES.DORMANT) sendControlMsg({ type: 'start-session', id });
  focusSession(id);
}

function paintPill(pill, id, ui) {
  const state = ui.currentState || STATES.DORMANT;
  pill.dataset.state = state;
  pill.querySelector('.focus-pill-glyph').textContent = STATE_GLYPHS[state] || '';
  pill.querySelector('.focus-pill-label').textContent = (BADGE_LABELS[state] || state).toUpperCase();
  pill.querySelector('.focus-pill-name').textContent = sessionName(ui);
  const ms = mergeStatusById.get(id) || 'none';
  pill.dataset.merge = ms === 'none' ? '' : ms;
  pill.querySelector('.focus-pill-merge').textContent =
    ms === 'pending-review' ? 'REVIEW' : ms === 'parked' ? 'PARKED' : ms === 'merging' ? 'MERGING' : '';
  const isFocused = id === focusedId;
  pill.classList.toggle('focused', isFocused);
  pill.setAttribute('aria-selected', String(isFocused));
  pill.tabIndex = isFocused ? 0 : -1;
}

// Re-render the rail in sorted order; reconcile pills against the live session set.
export function refreshFocusRoster() {
  if (!active || !railEl) return;
  const order = orderedSessions();
  const seen = new Set();
  for (const { id, ui } of order) {
    seen.add(id);
    let pill = pillById.get(id);
    if (!pill) { pill = buildPill(id); pillById.set(id, pill); }
    paintPill(pill, id, ui);
    railEl.appendChild(pill); // re-append moves it into sorted position
  }
  for (const [id, pill] of pillById) {
    if (!seen.has(id)) { pill.remove(); pillById.delete(id); }
  }
  // Prune merge-status for gone sessions (the rest of the module is careful not to leak).
  for (const id of [...mergeStatusById.keys()]) {
    if (!sessionUIs.has(id)) mergeStatusById.delete(id);
  }
  // Resolve the center: a vanished focus re-targets the top of the roster; a focused card that was
  // displaced or REBUILT (e.g. a session-modified rebuild) is re-borrowed back into the center.
  if (focusedId && !sessionUIs.has(focusedId)) {
    focusedId = null;
    const next = order.find((o) => sessionUIs.has(o.id));
    if (next) { focusSession(next.id); return; }
  } else if (focusedId) {
    const ui = sessionUIs.get(focusedId);
    if (ui && ui.card.parentElement !== cardSlotEl) borrowToCenter(ui, focusedId);
  }
  updateCenter();
}

// ── Center: borrow the focused card, run the review bar ──

function borrowToCenter(ui, id) {
  ui.card._focusHome = { parent: ui.card.parentElement, next: ui.card.nextElementSibling };
  ui.card._focusWasMinimized = ui.card.classList.contains('minimized');
  ui.card.classList.remove('minimized');
  ui.card.classList.add('focus-centered');
  cardSlotEl.appendChild(ui.card);
  // The card may be slept (term disposed by minimize) or dormant (never built) - ensure a live
  // terminal so the center is not a blank box. ensureTerminalSetup does NOT spawn a PTY for a dormant
  // session; it only builds the xterm, so this is safe.
  if (ui.sleeping) wakeSession(id);
  else if (!ui.term) ensureTerminalSetup(ui, id);
  // Deterministic fit to the (much larger) center rather than waiting on the ResizeObserver.
  ui._applyFit?.();
  forceTerminalRepaint(ui);
}

function releaseCenter() {
  if (!focusedId) return;
  const ui = sessionUIs.get(focusedId);
  if (ui && ui.card && ui.card.parentElement === cardSlotEl) {
    ui.card.classList.remove('focus-centered');
    if (ui.card._focusWasMinimized) ui.card.classList.add('minimized');
    const home = ui.card._focusHome;
    if (home && home.parent && home.parent.isConnected) {
      if (home.next && home.next.parentElement === home.parent) home.parent.insertBefore(ui.card, home.next);
      else home.parent.appendChild(ui.card);
    } else {
      container.appendChild(ui.card);
    }
    delete ui.card._focusHome;
    delete ui.card._focusWasMinimized;
    ui._applyFit?.();
    forceTerminalRepaint(ui);
  }
  focusedId = null;
}

function focusSession(id) {
  if (!active || !sessionUIs.has(id) || id === focusedId) return;
  releaseCenter();
  focusedId = id;
  // Drive the shared selection so the right review sidebar follows the focused session.
  setSelectedId(id);
  borrowToCenter(sessionUIs.get(id), id);
  refreshFocusRoster();
}

function updateCenter() {
  const has = !!(focusedId && sessionUIs.has(focusedId));
  emptyEl.hidden = has;
  if (has) return;
  // Two empty states: sessions exist but none is selected yet (the default on every open), vs. no
  // sessions at all. The first directs the operator to the rail; the second to spawn a session.
  const hasSessions = sessionUIs.size > 0;
  emptyTitleEl.textContent = hasSessions ? 'No session selected' : 'Nothing to focus';
  emptyDescEl.textContent = hasSessions
    ? 'Select a session from the rail on the left to focus it here.'
    : 'Spawn a session to start watching.';
}

// ── External hooks (called from app.js) ──

// Track merge status for the rail (sort + the pill's REVIEW/PARKED tag). The actual review controls
// live in the right review sidebar; the pill tag just signals which sessions have changes waiting.
export function setFocusMergeStatus(id, mergeStatus) {
  mergeStatusById.set(id, mergeStatus || 'none');
  if (active) refreshFocusRoster();
}

export function activateFocusView() {
  if (!railEl) return;
  active = true;
  // Opening Focus never auto-selects a session: it starts on the placeholder and the operator picks
  // one from the rail. (No order[0] auto-focus - the empty center is intentional.) releaseCenter
  // returns any stray centered card home and clears focusedId, so this is always a clean start.
  releaseCenter();
  refreshFocusRoster();
}

export function deactivateFocusView() {
  if (!active) return;
  releaseCenter();
  active = false;
}
