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
import { setActivityRenderer } from '../session-card/activity.js';
import { container, sessionUIs } from '../session-card/card-registry.js';
import { ensureTerminalSetup, forceTerminalRepaint } from '../session-card/terminal.js';
import { setSelectedId } from '../sidebar/selection.js';
import { getLastFocusedSessionId, getRailWidth, setLastFocusedSessionId, setRailWidth } from '../ui-prefs.js';
import { orderRoster, pickAdjacent, pickNextAttention } from './attention-core.mjs';
import { groupRoster, NO_PATH_KEY, visibleOrder } from './roster-groups.mjs';

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

// ── Project grouping (organization level) ──
// The rail groups its pills by project (the session's repo path). Each project is a header button
// (collapse toggle) followed by its OWN role=listbox sublist of option pills, so every listbox holds
// only options (ARIA valid). The single-project case renders the flat railListEl with no headers.
const groupListById = new Map();   // project key (path) -> its <div role=listbox> sublist element
const groupHeaderById = new Map(); // project key (path) -> its header <button>

// railTabStopId is the rail's single roving / selected option, DECOUPLED from focusedId (which is
// "which session is centered"). They coincide in steady state; they diverge only when a collapse
// moves the tab stop off a now-hidden pill. paintPill derives tabIndex/aria-selected from this scalar
// (not focusedId), so a relocation SURVIVES the per-signal refreshFocusRoster repaint - the single
// selection invariant is structural, not a one-shot DOM poke.
let railTabStopId = null;

// Per-project collapse state, persisted and size-bounded. Map<path, lastSeen>; PRESENCE means
// collapsed (expanded is the default and stores nothing). Bounded by an LRU cap so a long tail of
// stale projects can't grow localStorage without end; a present (live) group is never evicted.
const COLLAPSE_KEY = 'glissa.focus.collapsedGroups';
const COLLAPSE_CAP = 50;
let collapseMap = loadCollapse();

function loadCollapse() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
    const m = new Map();
    for (const [k, v] of Object.entries(raw)) m.set(k, Number(v) || 0);
    return m;
  } catch { return new Map(); }
}
function persistCollapsed() {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Object.fromEntries(collapseMap))); }
  catch { /* storage unavailable: stays in-memory for this session */ }
}
function isCollapsed(key) { return collapseMap.has(key); }
function collapsedSet() { return new Set(collapseMap.keys()); }
function setCollapsed(key, collapsed) {
  if (collapsed) collapseMap.set(key, Date.now());
  else collapseMap.delete(key);
  persistCollapsed();
}
// Bump lastSeen for present groups BEFORE eviction, so a present group is never the oldest and is
// never evicted; eviction acts only on stale (non-present) collapsed keys.
function touchAndBound(presentKeys) {
  const now = Date.now();
  // Bump present groups' lastSeen IN MEMORY only. A timestamp bump is NOT a membership change, so it
  // must not trigger a localStorage write on this hot path (refreshFocusRoster runs on every state /
  // merge / agent signal). The persisted timestamps refresh whenever setCollapsed (toggle) or an
  // eviction below actually changes the SET of collapsed keys - which is all the cold-start LRU needs.
  for (const k of presentKeys) if (collapseMap.has(k)) collapseMap.set(k, now);
  if (collapseMap.size > COLLAPSE_CAP) {
    const oldestFirst = [...collapseMap.entries()].sort((a, b) => a[1] - b[1]);
    let over = collapseMap.size - COLLAPSE_CAP;
    let evicted = false;
    for (const [k] of oldestFirst) {
      if (over <= 0) break;
      if (presentKeys.has(k)) continue;
      collapseMap.delete(k); over--; evicted = true;
    }
    if (evicted) persistCollapsed(); // membership changed -> persist
  }
}

// The group key for a session id, keyed exactly as groupRoster keys rows (so isCollapsed lines up).
function groupKeyOf(id) {
  const ui = sessionUIs.get(id);
  const p = ui && ui.path;
  return p ? String(p) : NO_PATH_KEY;
}

// Move the rail's single tab stop / selected option to `id` (or null), updating the DOM immediately
// so Arrow nav and collapse don't wait for a refresh. paintPill re-derives the same thing from
// railTabStopId on every later repaint, so this stays consistent.
function setRailTabStop(id) {
  const prev = railTabStopId;
  railTabStopId = id || null;
  if (prev && prev !== railTabStopId) {
    const p = pillById.get(prev);
    if (p) { p.tabIndex = -1; p.setAttribute('aria-selected', 'false'); }
  }
  if (railTabStopId) {
    const n = pillById.get(railTabStopId);
    if (n) { n.tabIndex = 0; n.setAttribute('aria-selected', 'true'); }
  }
}

// The current project grouping of the live roster (orderRoster output, partitioned by repo path).
function currentGroups() {
  return groupRoster(orderedSessions(), (row) => row.ui.path);
}

// Apply a group's collapsed state to its header (aria-expanded + data-collapsed) and sublist (hidden).
function paintGroupCollapsed(key, collapsed) {
  const header = groupHeaderById.get(key);
  const list = groupListById.get(key);
  if (header) { header.setAttribute('aria-expanded', String(!collapsed)); header.dataset.collapsed = String(collapsed); }
  if (list) list.hidden = collapsed;
}

// Ensure (and relabel) a project group's header button + sublist listbox. Created once per key and
// reused; the click handler toggles collapse. Returns { header, list }.
function ensureGroup(group) {
  let header = groupHeaderById.get(group.key);
  let list = groupListById.get(group.key);
  if (!list) {
    header = document.createElement('button');
    header.type = 'button';
    header.className = 'focus-rail-group';
    header.dataset.key = group.key;
    header.innerHTML = '<span class="focus-rail-group-label"></span>'
      + '<span class="focus-rail-group-rule" aria-hidden="true"></span>'
      + '<span class="focus-rail-group-chev" aria-hidden="true">▾</span>';
    header.addEventListener('click', () => toggleGroup(group.key));
    list = document.createElement('div');
    list.className = 'focus-rail-list';
    list.setAttribute('role', 'listbox');
    groupHeaderById.set(group.key, header);
    groupListById.set(group.key, list);
  }
  header.querySelector('.focus-rail-group-label').textContent = group.label; // ORIGINAL case; CSS uppercases
  header.title = group.title; // full path
  list.setAttribute('aria-label', `${group.label} sessions`);
  paintGroupCollapsed(group.key, isCollapsed(group.key));
  return { header, list };
}

// Remove all group headers/sublists (used when switching to the flat single-project render).
function teardownGroups() {
  for (const [key, header] of groupHeaderById) {
    header.remove();
    groupListById.get(key)?.remove();
  }
  groupHeaderById.clear();
  groupListById.clear();
}

function expandGroup(key) {
  if (!isCollapsed(key)) return;
  setCollapsed(key, false);
  paintGroupCollapsed(key, false);
}

function toggleGroup(key) {
  const collapsing = !isCollapsed(key);
  setCollapsed(key, collapsing);
  paintGroupCollapsed(key, collapsing);
  // If we just hid the group holding the rail tab stop, relocate it to the nearest visible pill (or
  // none). setRailTabStop survives the next refresh because paintPill sources from railTabStopId.
  if (collapsing && railTabStopId && groupKeyOf(railTabStopId) === key) {
    setRailTabStop(pickNearestVisible(currentGroups(), key));
  }
}

// The visible id closest to a just-collapsed group: the first row of the nearest visible group AT or
// AFTER it in group order, else the last row of the nearest visible group before it, else null.
function pickNearestVisible(groups, collapsedKey) {
  const collapsed = collapsedSet();
  const byKey = new Map(groups.groups.map((g) => [g.key, g]));
  const idx = groups.order.indexOf(collapsedKey);
  for (let i = idx + 1; i < groups.order.length; i++) {
    const k = groups.order[i];
    if (collapsed.has(k)) continue;
    const g = byKey.get(k);
    if (g && g.rows.length) return g.rows[0].id;
  }
  for (let i = idx - 1; i >= 0; i--) {
    const k = groups.order[i];
    if (collapsed.has(k)) continue;
    const g = byKey.get(k);
    if (g && g.rows.length) return g.rows[g.rows.length - 1].id;
  }
  return null;
}

export function isFocusActive() { return active; }

export function mountFocusView({ rail, center, resizer }) {
  railEl = rail;
  centerEl = center;
  wireRailResizer(resizer);

  // The rail is a sticky jump header above a scrolling listbox of pills. Move the listbox
  // semantics off the outer nav (which now also holds the header button) onto an inner list, so
  // the header is never an invalid child of a listbox. The roving-arrow keydown listener stays on
  // the outer nav (pill keydowns bubble up to it).
  railEl.removeAttribute('role');
  railEl.removeAttribute('aria-label');

  railHeadEl = document.createElement('button');
  railHeadEl.type = 'button';
  railHeadEl.className = 'focus-rail-head';
  // Render the shortcut as the SAME shared <kbd> chips the Shortcuts help panel uses (dialogs.js
  // renderShortcutGroups: .shortcut-keys cluster of .kbd chips joined by a .shortcut-sep "+"), so the
  // operator meets one consistent representation of Alt+W on both surfaces. The head is a single
  // readout: the count slot reports the attention queue ("ALL CLEAR" at rest, "{n} NEED YOU" lit),
  // the keys ride on the right as the always-visible legend, so the slot is complete in both states.
  railHeadEl.innerHTML = '<span class="focus-rail-head-count"></span>'
    + '<span class="shortcut-keys">'
    + '<kbd class="kbd">Alt</kbd><span class="shortcut-sep">+</span><kbd class="kbd">W</kbd>'
    + '</span>';
  railHeadEl.addEventListener('click', focusNextAttention);
  setRailHeadActive(false, ''); // resting from the start: quiet "ALL CLEAR" legend until something needs you

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

// ── Rail resize ──
// The rail width is a user preference: pointer-drag the separator (or Arrow keys when it has focus;
// double-click resets to the CSS default). The chosen width rides an inline flex-basis on the rail,
// clamped so pills stay readable and the center always keeps room, and persists via ui-prefs.
const RAIL_MIN_PX = 180;
const RAIL_MAX_PX = 480;
const RAIL_KEY_STEP_PX = 16;

function applyRailWidth(resizer, px) {
  const w = Math.round(Math.min(RAIL_MAX_PX, Math.max(RAIL_MIN_PX, px)));
  railEl.style.flexBasis = `${w}px`;
  resizer.setAttribute('aria-valuenow', String(w));
  return w;
}

function wireRailResizer(resizer) {
  if (!resizer) return;
  resizer.setAttribute('aria-valuemin', String(RAIL_MIN_PX));
  resizer.setAttribute('aria-valuemax', String(RAIL_MAX_PX));

  const stored = getRailWidth();
  if (Number.isFinite(stored)) applyRailWidth(resizer, stored);

  let startX = 0;
  let startW = 0;
  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    startX = e.clientX;
    startW = railEl.getBoundingClientRect().width;
    resizer.setPointerCapture(e.pointerId);
    resizer.dataset.dragging = 'true';
    e.preventDefault(); // no text selection / focus steal while dragging
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    applyRailWidth(resizer, startW + (e.clientX - startX));
  });
  const releaseDrag = (e) => {
    resizer.releasePointerCapture(e.pointerId);
    delete resizer.dataset.dragging;
  };
  resizer.addEventListener('pointerup', (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    releaseDrag(e);
    setRailWidth(applyRailWidth(resizer, startW + (e.clientX - startX)));
  });
  // A cancelled gesture (capture stolen, touch interrupt) carries unreliable coordinates that
  // could snap the rail to a clamp edge: revert to the pre-drag width and persist nothing.
  resizer.addEventListener('pointercancel', (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    releaseDrag(e);
    applyRailWidth(resizer, startW);
  });

  resizer.addEventListener('dblclick', () => {
    railEl.style.flexBasis = ''; // back to the stylesheet default
    resizer.removeAttribute('aria-valuenow');
    setRailWidth(null);
  });
  resizer.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? RAIL_KEY_STEP_PX : -RAIL_KEY_STEP_PX;
    setRailWidth(applyRailWidth(resizer, railEl.getBoundingClientRect().width + delta));
  });
}

// Roving-tabindex list nav: Up/Down move focus between pills; Enter/click (native button) focuses the
// session into the center. Lives on the rail only, so it never intercepts keystrokes meant for the
// centered terminal.
function onRailKeydown(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  // VISIBLE navigation order comes from the pure core (collapsed groups excluded), never a DOM scan.
  // pickAdjacent wraps and handles an absent roving id (its group was just collapsed) by starting from
  // the end per direction, so this only moves the highlight; centering stays on Enter/click (ARIA).
  const id = pickAdjacent(visibleOrder(currentGroups(), collapsedSet()), railTabStopId, e.key === 'ArrowDown' ? 1 : -1);
  if (id == null) return;
  e.preventDefault();
  setRailTabStop(id);
  pillById.get(id)?.focus();
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
  // Cache child-span refs once at build time. buildPill is the sole innerHTML writer, so these
  // refs are permanently valid for the life of the pill (never stale).
  pill._refs = {
    glyph: pill.querySelector('.focus-pill-glyph'),
    label: pill.querySelector('.focus-pill-label'),
    name: pill.querySelector('.focus-pill-name'),
    merge: pill.querySelector('.focus-pill-merge'),
  };
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
  dismissIfComplete(id);
  focusSession(id);
}

// Acknowledge a finished turn server-side on an operator-driven switch: centering a COMPLETE
// session (pill click/Enter, Alt+1..9, Alt+Up/Down, Alt+W; also the guided-setup auto-center via
// onPillActivate, harmless since that session is never COMPLETE at spawn) sends the same `dismiss`
// the terminal mousedown sends (session-card/lifecycle.js), so the session transitions COMPLETE ->
// IDLE without requiring a click on the terminal itself. WAITING is deliberately excluded: switching
// to a blocked prompt is looking at it, not answering it (dismiss would fake WAITING -> RUNNING).
// Non-operator focus paths (restoreFocusedSession on reload, the vanished-focus retarget in
// refreshFocusRoster) do NOT call this, so a COMPLETE signal survives a page reload.
function dismissIfComplete(id) {
  if (sessionUIs.get(id)?.currentState !== STATES.COMPLETE) return;
  sendControlMsg({ type: 'dismiss', id });
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
  pill._refs.glyph.textContent = STATE_GLYPHS[state] || '';
  pill._refs.label.textContent = (BADGE_LABELS[state] || state).toUpperCase();
  pill._refs.name.textContent = sessionName(ui);
  const ms = mergeStatusById.get(id) || 'none';
  pill.dataset.merge = ms === 'none' ? '' : ms;
  pill._refs.merge.textContent =
    ms === 'pending-review' ? 'REVIEW' : ms === 'parked' ? 'PARKED' : ms === 'merging' ? 'MERGING' : '';
  // Mirror the working heartbeat flag so a re-render keeps the breathe/quiet treatment without
  // waiting for the next signal (activity.js parks the live value on ui._activity).
  pill.dataset.activity = ui._activity || '';
  // .focused (the centered session highlight) stays on focusedId; the roving tab stop / aria-selected
  // option is railTabStopId (decoupled so collapse can move it off a hidden pill, refresh-stable).
  pill.classList.toggle('focused', id === focusedId);
  const isTabStop = id === railTabStopId;
  pill.setAttribute('aria-selected', String(isTabStop));
  pill.tabIndex = isTabStop ? 0 : -1;
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
  const glyph = pill._refs?.glyph;
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
  const groups = groupRoster(order, (row) => row.ui.path);
  const seen = new Set();

  // Build the desired id order for a list and re-append pills only if the order changed.
  // paintPill still runs for every pill to keep content current regardless of order.
  const placeList = (rows, listEl) => {
    const newKey = rows.map((r) => r.id).join(',');
    const orderUnchanged = listEl._lastOrderKey === newKey && listEl.childElementCount === rows.length;
    for (const { id, ui } of rows) {
      seen.add(id);
      let pill = pillById.get(id);
      if (!pill) { pill = buildPill(id); pillById.set(id, pill); }
      paintPill(pill, id, ui);
      if (!orderUnchanged) listEl.appendChild(pill);
    }
    listEl._lastOrderKey = newKey;
  };

  if (groups.flat) {
    // Single project (or 0/1 sessions): flat list, NO headers - exactly today's layout.
    teardownGroups();
    railListEl.hidden = false;
    placeList(order, railListEl);
  } else {
    // Grouped: a header button + its own role=listbox sublist per project, in A->Z group order.
    // railHeadEl stays the sticky first child; the flat railListEl is parked hidden.
    railListEl.hidden = true;
    const presentKeys = new Set(groups.order);
    for (const group of groups.groups) {
      const { header, list } = ensureGroup(group);
      railEl.appendChild(header); // re-append keeps headers + sublists in sorted order
      railEl.appendChild(list);
      placeList(group.rows, list);
    }
    // Remove vanished groups (their pills are pruned by the seen-sweep below).
    for (const [key, header] of [...groupHeaderById]) {
      if (!presentKeys.has(key)) {
        header.remove();
        groupListById.get(key)?.remove();
        groupHeaderById.delete(key);
        groupListById.delete(key);
      }
    }
    touchAndBound(presentKeys); // bump live groups' lastSeen, LRU-evict stale collapse keys
  }

  for (const [id, pill] of pillById) {
    if (!seen.has(id)) {
      pill.remove();
      pillById.delete(id);
      if (id === railTabStopId) railTabStopId = null; // don't leave the tab stop on a gone session
    }
  }
  // Prune merge-status for gone sessions (the rest of the module is careful not to leak).
  for (const id of [...mergeStatusById.keys()]) {
    if (!sessionUIs.has(id)) mergeStatusById.delete(id);
  }
  // Resolve the center: a vanished focus re-targets the top of the roster; a focused card that was
  // displaced or REBUILT (e.g. a session-modified rebuild) is re-borrowed back into the center.
  if (focusedId && !sessionUIs.has(focusedId)) {
    focusedId = null;
    railTabStopId = null;
    const next = order.find((o) => sessionUIs.has(o.id));
    if (next) { focusSession(next.id); return; } // focusSession re-syncs both scalars
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
// target pill into view. Every target also gets the terminal cursor so the operator can answer a
// WAITING prompt or send the next turn to a COMPLETE session immediately, no click.

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
  const n = attentionIds().length;
  setRailHeadActive(n > 0, n === 1 ? '1 NEEDS YOU' : `${n} NEED YOU`);
}

// Toggle the jump header between its quiet resting legend and the lit attention readout WITHOUT
// changing the layout. The head keeps a permanent slot at the top of the rail; at rest it reports
// "ALL CLEAR" in a neutral box (CSS .focus-rail-head[data-empty]), and lighting it swaps in the
// orchid "{n} NEED YOU" count so the accent is spent only on a real signal (earned-signal). At rest
// it is also non-interactive and out of the tab/AT order (disabled + aria-hidden): nothing to jump to.
function setRailHeadActive(on, label) {
  if (!railHeadEl) return;
  railHeadEl.querySelector('.focus-rail-head-count').textContent = on ? label : 'ALL CLEAR';
  railHeadEl.disabled = !on;
  if (on) {
    railHeadEl.removeAttribute('data-empty');
    railHeadEl.removeAttribute('aria-hidden');
  } else {
    railHeadEl.dataset.empty = '';
    railHeadEl.setAttribute('aria-hidden', 'true');
  }
}

export function focusNextAttention() {
  if (!active) return;
  const ids = attentionIds();
  if (!ids.length) return;
  const nextId = pickNextAttention(ids, attnCursorId);
  attnCursorId = nextId;
  const ui = sessionUIs.get(nextId);
  // The round-robin can resolve to the session already in the center (it COMPLETEd while centered, so
  // it joined the queue in place, or it is the only thing needing you). focusSession no-ops on that,
  // which made the press feel dead; flash the pill + center so the jump always reads as a response.
  const alreadyCentered = nextId === focusedId;
  dismissIfComplete(nextId);
  focusSession(nextId);
  pillById.get(nextId)?.scrollIntoView({ block: 'nearest' });
  if (alreadyCentered) flashAttention(nextId);
  // Drop the cursor into the centered terminal so the operator types right away. Deferred a double
  // rAF (the same idiom as focusSessionCard): borrowToCenter just re-parented the card and may have
  // woken or built its terminal, so the fit + repaint must settle before .focus() can land on the
  // live xterm helper textarea. Re-check the target still holds the center, in case a later press
  // advanced past it, so we never steal focus to a stale session.
  if (ui) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (active && focusedId === nextId) ui.term?.focus();
    }));
  }
}

// One-shot "you are already here" pulse for an Alt+W press that resolves to the centered session, so
// the keypress always reads as a response instead of a dead no-op. Pure GPU-only feedback (WAAPI
// transform/opacity, fire-and-forget like renderPillActivity), skipped under reduced-motion or a
// hidden tab; it never changes which session is focused.
function flashAttention(id) {
  if (reducedMotion?.matches || document.hidden) return;
  const pill = pillById.get(id);
  if (pill?.animate) {
    pill.animate(
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.045)', offset: 0.3 },
        { transform: 'scale(1)' },
      ],
      { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }
  const card = sessionUIs.get(id)?.card;
  if (card?.animate) {
    card.animate([{ opacity: 0.8 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  }
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
  // Expand the target's group if collapsed, so externally-driven focus (guided-setup, sidebar
  // selection, merge-status) never lands the tab stop / aria-selected on a hidden option.
  const key = groupKeyOf(id);
  if (isCollapsed(key)) expandGroup(key);
  releaseCenter();
  focusedId = id;
  railTabStopId = id; // sync: the centered session is also the rail's roving option
  // Remember the last session the operator centered so a tab switch or page reload can return to it
  // (consumed by restoreFocusedSession). Persist ONLY here, the one place a real selection lands, so
  // the value stays sticky across the releaseCenter/deactivate mechanics that null focusedId.
  setLastFocusedSessionId(id);
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
  // Count VISIBLE pills only (collapsed groups excluded), resolved by the pure core.
  const id = visibleOrder(currentGroups(), collapsedSet())[n - 1];
  if (id) onPillActivate(id);
}

// Center the previous (dir < 0) / next (dir >= 0) session in VISIBLE rail order, wrapping at the ends.
// Backs the global Alt+Up/Down shortcut, which fires even while the centered terminal holds focus, so
// the operator flips between sessions without leaving the keyboard. It navigates from railTabStopId
// (the rail's roving/selected option, synced to the centered session in steady state) and centers via
// onPillActivate - SAME as a click - so landing on a DORMANT session spins it up (start-session) just
// as clicking its pill would. The e.repeat guard on the chrome shortcut means each press is discrete,
// so this only starts the one session it stops on, never a list it walks past. Mirrors
// focusNextAttention's scroll + cursor handoff.
export function focusAdjacentInRail(dir) {
  if (!active) return;
  const id = pickAdjacent(visibleOrder(currentGroups(), collapsedSet()), railTabStopId, dir);
  if (id == null) return;
  onPillActivate(id); // centers; starts a DORMANT target first, exactly like a pill click
  pillById.get(id)?.scrollIntoView({ block: 'nearest' });
  // Drop the cursor into the centered terminal so the next Alt+Up/Down (or typing) lands without a
  // click. Double rAF, like focusNextAttention: borrowToCenter just re-parented and may have built the
  // xterm, so the fit/repaint must settle before .focus() can reach the live helper textarea. Re-check
  // the target still holds the center in case a later press advanced past it.
  const ui = sessionUIs.get(id);
  if (ui) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (active && focusedId === id) ui.term?.focus();
    }));
  }
}

export function activateFocusView() {
  if (!railEl) return;
  active = true;
  // releaseCenter returns any stray centered card home and clears focusedId, so this is always a clean
  // start. We then restore the last session the operator had open (restoreFocusedSession), so switching
  // away to Teams and back returns to it. When nothing valid is saved the center stays on the
  // intentional empty placeholder and the operator picks from the rail.
  releaseCenter();
  railTabStopId = null;
  refreshFocusRoster();
  restoreFocusedSession();
}

// Re-center the last session the operator had open. Idempotent and safe to call on activation and on
// every snapshot: it no-ops unless Focus is up, the center is empty, and the saved session still
// exists in the roster AND is not DORMANT. The dormant guard is what makes a first-time start select
// nothing: after the server starts (npm run dev) it holds no live PTYs, so every session loads
// DORMANT and there is nothing worth returning to (the saved card "isn't on"); a fresh boot lands on
// the empty placeholder. A browser reload while the server is still up keeps the session non-dormant,
// so the restore still returns to it there. On the boot/reload race the roster is empty at
// activation, so the no-op here is re-attempted from app.js handleSnapshot once the snapshot has
// populated the cards (with their state).
export function restoreFocusedSession() {
  if (!active || focusedId) return;
  const id = getLastFocusedSessionId();
  const ui = id && sessionUIs.get(id);
  if (!ui) return;
  if ((ui.currentState || STATES.DORMANT) === STATES.DORMANT) return;
  focusSession(id);
}

export function deactivateFocusView() {
  if (!active) return;
  releaseCenter();
  railTabStopId = null;
  active = false;
}
