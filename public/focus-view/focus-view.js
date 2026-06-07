// Focus view: a watch-and-steer layout. A persistent left ROSTER RAIL (one lightweight pill per
// session) and a single large CENTER that holds the focused session's real card (re-parented into the
// center, since each session owns one xterm). The rail is STABLE: pills sort non-dormant-then-name and
// never reorder on a state change, so the operator keeps a fixed spatial map. Attention is carried in
// place, never by floating to the top: WAITING pulses amber, a freshly COMPLETE pill announces once
// then holds a steady emerald until focused, a sticky "{n} NEED YOU" header counts what needs you, and
// Alt+W (or the header) jumps straight to the next such session. Worktree review happens in the right
// review sidebar: focusing a session (or clicking a rail pill) selects it there; the rail pill still
// tags REVIEW/PARKED so the operator knows which sessions have changes waiting.
//
// State lives here (view-local); it reads sessions from the shared card registry. The borrowed card is
// returned to its exact home slot in the off-screen grid on leave/swap.

import { BADGE_LABELS, STATE_GLYPHS, STATES } from '/shared/states.mjs';
import { sendControlMsg } from '../control-ws.js';
import { orderRoster, pickNextAttention } from './attention-core.mjs';
import { setSelectedId } from '../sidebar/selection.js';
import { setActivityRenderer } from '../session-card/activity.js';
import { container, sessionUIs } from '../session-card/card-registry.js';
import { ensureTerminalSetup, forceTerminalRepaint } from '../session-card/terminal.js';

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

let railEl = null;
let railHeadEl = null;  // the "{n} NEED YOU" jump header (sticky top of the rail)
let railListEl = null;  // inner listbox the pills live in (so the header is not a listbox child)
let centerEl = null;
let cardSlotEl = null;
let emptyEl = null;
let emptyTitleEl = null;
let emptyDescEl = null;

let active = false;
let focusedId = null;
let attnCursorId = null;            // round-robin cursor for the Alt+W attention queue
const mergeStatusById = new Map(); // id -> 'none'|'pending-review'|'merging'|'parked'|'merged'
const pillById = new Map();        // id -> rail pill element

export function isFocusActive() { return active; }

export function mountFocusView({ rail, center }) {
  railEl = rail;
  centerEl = center;

  // The rail is a sticky jump header above a scrolling listbox of pills. Move the listbox
  // semantics off the outer nav (which now also holds the header button) onto an inner list, so
  // the header is never an invalid child of a listbox. The roving-arrow keydown listener stays on
  // the outer nav (pill keydowns bubble up to it).
  railEl.removeAttribute('role');
  railEl.removeAttribute('aria-label');

  railHeadEl = document.createElement('button');
  railHeadEl.type = 'button';
  railHeadEl.className = 'focus-rail-head';
  railHeadEl.hidden = true;
  railHeadEl.innerHTML = '<span class="focus-rail-head-count"></span>'
    + '<span class="focus-rail-head-key">ALT+W</span>';
  railHeadEl.addEventListener('click', focusNextAttention);

  railListEl = document.createElement('div');
  railListEl.className = 'focus-rail-list';
  railListEl.setAttribute('role', 'listbox');
  railListEl.setAttribute('aria-label', 'Session roster');

  railEl.append(railHeadEl, railListEl);

  emptyEl = document.createElement('div');
  emptyEl.className = 'focus-empty';
  emptyEl.innerHTML = '<p class="focus-empty-title"></p>'
    + '<p class="focus-empty-desc"></p>';
  emptyTitleEl = emptyEl.querySelector('.focus-empty-title');
  emptyDescEl = emptyEl.querySelector('.focus-empty-desc');

  cardSlotEl = document.createElement('div');
  cardSlotEl.className = 'focus-card-slot';

  // Review (diff + Merge / Discard) lives in the right review sidebar, not in the center, so
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

// ── Roster ordering (identity-based, NOT status-based): non-dormant first, then alphabetical by
// name; a state change never reorders a pill. The operator keeps a stable spatial map of the rail,
// so attention is carried by the pill treatment (WAITING amber pulse, COMPLETE announce-once) and
// the Alt+W jump, never by a pill floating to the top. The pure sort + queue cursor live in
// attention-core.mjs. ──

function orderedSessions() {
  const rows = [...sessionUIs.entries()].map(([id, ui]) => ({
    id,
    ui,
    name: sessionName(ui),
    isDormant: (ui.currentState || STATES.DORMANT) === STATES.DORMANT,
  }));
  // Consumers only ever destructure { id, ui }; orderRoster preserves those fields, so return its
  // result directly rather than re-projecting it.
  return orderRoster(rows);
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

// Clicking a pill focuses its session into the center. A DORMANT session is also STARTED:
// borrowToCenter has already wired the data WS via ensureTerminalSetup, so the spawning PTY's
// output flows into the centered card.
function onPillActivate(id) {
  const ui = sessionUIs.get(id);
  if (!ui) return;
  if (ui.currentState === STATES.DORMANT) sendControlMsg({ type: 'start-session', id });
  focusSession(id);
}

function paintPill(pill, id, ui) {
  const state = ui.currentState || STATES.DORMANT;
  // Announce-once for a finished turn: a session that ENTERS complete while the rail is open tags
  // its pill unseen (CSS gives a one-shot flash, then holds a steady bright emerald border) until
  // the operator focuses it (focusSession clears it). A brand-new pill has no prior state, so an
  // already-complete session present at snapshot/reconnect is treated as already seen and never
  // false-announces (mirrors the minimized-rail data-unseen rule). prev===state===COMPLETE leaves
  // the flag untouched, so a focus-acknowledge persists across later unrelated refreshes.
  const prev = pill.dataset.state; // undefined on a freshly built pill
  if (state !== STATES.COMPLETE) pill.removeAttribute('data-unseen');
  else if (prev && prev !== STATES.COMPLETE) pill.dataset.unseen = '';
  pill.dataset.state = state;
  pill.querySelector('.focus-pill-glyph').textContent = STATE_GLYPHS[state] || '';
  pill.querySelector('.focus-pill-label').textContent = (BADGE_LABELS[state] || state).toUpperCase();
  pill.querySelector('.focus-pill-name').textContent = sessionName(ui);
  const ms = mergeStatusById.get(id) || 'none';
  pill.dataset.merge = ms === 'none' ? '' : ms;
  pill.querySelector('.focus-pill-merge').textContent =
    ms === 'pending-review' ? 'REVIEW' : ms === 'parked' ? 'PARKED' : ms === 'merging' ? 'MERGING' : '';
  // Mirror the working heartbeat flag so a re-render keeps the breathe/quiet treatment without
  // waiting for the next signal (activity.js parks the live value on ui._activity).
  pill.dataset.activity = ui._activity || '';
  const isFocused = id === focusedId;
  pill.classList.toggle('focused', isFocused);
  pill.setAttribute('aria-selected', String(isFocused));
  pill.tabIndex = isFocused ? 0 : -1;
}

// ── Working heartbeat (rail-only) ──
// The heartbeat lives ONLY on the rail pill, never on the centered terminal (redundant). activity.js
// computes the liveness/quiet signal content-blind and calls this renderer: 'beat' = one PTY-chunk
// ping on the glyph, 'flag' = the active/quiet flag (ui._activity) changed. paintPill mirrors the
// same flag, so a re-render keeps the breathe/quiet state without waiting for the next signal.
function renderPillActivity(ui, kind) {
  if (!active) return; // off-screen rail: nothing to paint or beat
  const id = ui?.card?.dataset.id;
  const pill = id ? pillById.get(id) : null;
  if (!pill) return;
  if (kind === 'flag') {
    pill.dataset.activity = ui._activity || '';
    return;
  }
  // kind === 'beat': one GPU-only ping (transform + opacity), fire-and-forget WAAPI so there is no
  // class bookkeeping. The CSS ambient breath animates opacity only, so this scale composes on top.
  if (reducedMotion?.matches || document.hidden) return;
  const glyph = pill.querySelector('.focus-pill-glyph');
  if (!glyph?.animate) return;
  glyph.animate(
    [
      { transform: 'scale(1)', opacity: 0.65 },
      { transform: 'scale(1.35)', opacity: 1, offset: 0.3 },
      { transform: 'scale(1)', opacity: 0.9 },
    ],
    { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
}
setActivityRenderer(renderPillActivity);

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
    railListEl.appendChild(pill); // re-append moves it into sorted position
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
  updateRailHead();
  updateCenter();
}

// ── One-key triage: the attention queue (Alt+W on the Focus tab, and the rail-head click) ──
// "Needs you" = WAITING (agent blocked) plus COMPLETE pills not yet acknowledged (data-unseen).
// updateRailHead surfaces the count + the shortcut; focusNextAttention walks the queue in rail
// order, borrows each session into the center, and (since the rail never reorders) scrolls the
// target pill into view. A WAITING target also gets the terminal cursor so the operator can answer
// at once.

function attentionIds() {
  return orderedSessions()
    .filter(({ id, ui }) => {
      const state = ui.currentState || STATES.DORMANT;
      if (state === STATES.WAITING) return true;
      return state === STATES.COMPLETE && !!pillById.get(id)?.hasAttribute('data-unseen');
    })
    .map(({ id }) => id);
}

function updateRailHead() {
  if (!railHeadEl) return;
  const n = attentionIds().length;
  railHeadEl.hidden = n === 0;
  if (n > 0) {
    railHeadEl.querySelector('.focus-rail-head-count').textContent =
      n === 1 ? '1 NEEDS YOU' : `${n} NEED YOU`;
  }
}

export function focusNextAttention() {
  if (!active) return;
  const ids = attentionIds();
  if (!ids.length) return;
  const nextId = pickNextAttention(ids, attnCursorId);
  attnCursorId = nextId;
  const ui = sessionUIs.get(nextId);
  focusSession(nextId);
  pillById.get(nextId)?.scrollIntoView({ block: 'nearest' });
  if (ui && ui.currentState === STATES.WAITING) ui.term?.focus();
}

// ── Center: borrow the focused card, run the review bar ──

function borrowToCenter(ui, id) {
  ui.card._focusHome = { parent: ui.card.parentElement, next: ui.card.nextElementSibling };
  ui.card.classList.add('focus-centered');
  cardSlotEl.appendChild(ui.card);
  // A dormant card has no terminal yet - ensure a live xterm so the center is not a blank box.
  // ensureTerminalSetup does NOT spawn a PTY for a dormant session; it only builds the xterm.
  if (!ui.term) ensureTerminalSetup(ui, id);
  // Deterministic fit to the (much larger) center rather than waiting on the ResizeObserver.
  ui._applyFit?.();
  forceTerminalRepaint(ui);
}

function releaseCenter() {
  if (!focusedId) return;
  const ui = sessionUIs.get(focusedId);
  if (ui && ui.card && ui.card.parentElement === cardSlotEl) {
    ui.card.classList.remove('focus-centered');
    const home = ui.card._focusHome;
    if (home && home.parent && home.parent.isConnected) {
      if (home.next && home.next.parentElement === home.parent) home.parent.insertBefore(ui.card, home.next);
      else home.parent.appendChild(ui.card);
    } else {
      container.appendChild(ui.card);
    }
    delete ui.card._focusHome;
    ui._applyFit?.();
    forceTerminalRepaint(ui);
  }
  focusedId = null;
}

function focusSession(id) {
  if (!active || !sessionUIs.has(id) || id === focusedId) return;
  releaseCenter();
  focusedId = id;
  // Acknowledge a finished-turn pill: focusing it clears the unseen flag so it stops announcing
  // (paintPill leaves a cleared flag alone while the state stays COMPLETE).
  pillById.get(id)?.removeAttribute('data-unseen');
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

// Focus a specific session into the center on demand. Used by the guided-setup handler (an interactive
// setup session the operator must answer) now that Focus is the only session destination. Delegates to
// onPillActivate (which guards a missing id and starts a DORMANT target first); the active guard keeps a
// hidden view from spawning a dormant session as a side effect, so the caller must switch to Focus first.
export function focusSessionInCenter(id) {
  if (active) onPillActivate(id);
}

// Focus the Nth session (1-based) in the current rail order. Backs the Alt+1..9 chrome shortcut.
export function focusNthInRail(n) {
  if (!active) return;
  const target = orderedSessions()[n - 1];
  if (target) onPillActivate(target.id);
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
