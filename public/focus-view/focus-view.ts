import { STATES } from '#shared/states.ts';
import { borrowCard, getBorrowedCardId, releaseCard } from '../card-host.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el, MERGE_TAGS, query, stateChip } from '../dom-helpers.ts';
import { emptyProjectKeys, forgetProject } from '../project-registry.ts';
import { quickAddSession, requestSessionRemoval } from '../session-actions.ts';
import type { ActivityRenderKind } from '../session-card/activity.ts';
import { setActivityRenderer } from '../session-card/activity.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionIdOf, sessionUIs } from '../session-card/card-registry.ts';
import { setSelectedId } from '../sidebar/selection.ts';
import { getLastFocusedSessionId, getRailWidth, setLastFocusedSessionId, setRailWidth } from '../ui-prefs.ts';
import { uiState } from '../ui-state-core.ts';
import { attentionSummaryText, countSessionsNeedingAttention, needsAttention, orderRoster, pickAdjacent, pickNextAttention } from './attention-core.ts';
import type { RosterGroup } from './roster-groups.ts';
import { groupRoster, NO_PATH_KEY, visibleOrder } from './roster-groups.ts';

interface RosterRow {
  id: string;
  ui: SessionUi;
  name: string | null;
  isDormant: boolean;
}

type FocusPill = ReturnType<typeof buildPill>;

type GroupList = HTMLDivElement & { _lastOrderKey?: string };
type GroupHeader = HTMLDivElement & { _addBtn: HTMLButtonElement; _forgetBtn: HTMLButtonElement };

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

const touchRail = window.matchMedia?.('(hover: none) and (min-width: 769px)');

let railEl: HTMLElement | null = null;
let railHeadEl: HTMLButtonElement | null = null;
let centerEl: HTMLElement | null = null;
let cardSlotEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let emptyTitleEl: HTMLElement | null = null;
let emptyDescEl: HTMLElement | null = null;

let active = false;
let attnCursorId: string | null = null;
const mergeStatusById = new Map<string, string>();
const pillById = new Map<string, FocusPill>();

const groupListById = new Map<string, GroupList>();
const groupHeaderById = new Map<string, GroupHeader>();

let railTabStopId: string | null = null;

const NO_COLLAPSED = new Set<string>();
function railVisibleIds() { return visibleOrder(currentGroups(), NO_COLLAPSED); }

function setRailTabStop(id: string | null) {
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

function currentGroups() {
  const order = orderedSessions();
  return groupRoster(order, (row) => row.ui.path, emptyProjectKeys(order, (row) => row.ui.path));
}

function ensureGroup(group: RosterGroup<RosterRow>) {
  let header = groupHeaderById.get(group.key);
  let list = groupListById.get(group.key);
  if (!header || !list) {
    const row: GroupHeader = Object.assign(el('div', 'focus-rail-group'), {
      _addBtn: el('button', 'focus-rail-group-add', '+'),
      _forgetBtn: el('button', 'focus-rail-group-remove', '×'),
    });
    row.dataset.key = group.key;
    row.innerHTML = '<span class="focus-rail-group-label"></span>'
      + '<span class="focus-rail-group-rule" aria-hidden="true"></span>';
    const add = row._addBtn;
    add.type = 'button';
    add.addEventListener('click', () => quickAddSession(row.dataset.path, row.dataset.label));

    const forget = row._forgetBtn;
    forget.type = 'button';
    forget.addEventListener('click', () => {
      forgetProject(row.dataset.path);
      refreshFocusRoster();
    });
    row.appendChild(forget);
    row.appendChild(add);
    header = row;
    list = el('div', 'focus-rail-list');
    list.setAttribute('role', 'listbox');
    groupHeaderById.set(group.key, header);
    groupListById.set(group.key, list);
  }
  query(header, '.focus-rail-group-label').textContent = group.label;
  header.title = group.title;
  header.dataset.path = group.key;
  header.dataset.label = group.label;

  const noPath = group.key === NO_PATH_KEY;
  const empty = group.rows.length === 0;
  header._addBtn.hidden = noPath;
  if (!noPath) {
    header._addBtn.title = `Add a session to ${group.label}`;
    header._addBtn.setAttribute('aria-label', `Add a session to ${group.label}`);
  }
  header._forgetBtn.hidden = noPath || !empty;
  if (!noPath && empty) {
    header._forgetBtn.title = `Remove ${group.label} from the rail`;
    header._forgetBtn.setAttribute('aria-label', `Remove ${group.label} from the rail`);
  }
  header.toggleAttribute('data-empty', empty);
  list.setAttribute('aria-label', `${group.label} sessions`);
  return { header, list };
}

export function isFocusActive() { return active; }

export function getFocusedSessionId() { return uiState.snapshot().focusedSessionId; }

export function mountFocusView({ rail, center, resizer }: { rail: HTMLElement | null; center: HTMLElement | null; resizer: HTMLElement | null }) {
  railEl = rail;
  centerEl = center;
  if (!railEl || !centerEl) return;
  const mountedRail = railEl;
  const mountedCenter = centerEl;
  wireRailResizer(resizer);

  mountedRail.removeAttribute('role');
  mountedRail.removeAttribute('aria-label');

  railHeadEl = el('button', 'focus-rail-head');
  railHeadEl.type = 'button';

  railHeadEl.innerHTML = '<span class="focus-rail-head-count"></span>'
    + '<span class="shortcut-keys">'
    + '<kbd class="kbd">Alt</kbd><span class="shortcut-sep">+</span><kbd class="kbd">W</kbd>'
    + '</span>';
  railHeadEl.addEventListener('click', focusNextAttention);
  setRailHeadActive(false, attentionSummaryText(0));

  mountedRail.append(railHeadEl);

  emptyEl = el('div', 'focus-empty');
  emptyEl.innerHTML = '<p class="focus-empty-title"></p>'
    + '<p class="focus-empty-desc"></p>';
  emptyTitleEl = emptyEl.querySelector<HTMLElement>('.focus-empty-title');
  emptyDescEl = emptyEl.querySelector<HTMLElement>('.focus-empty-desc');

  cardSlotEl = el('div', 'focus-card-slot');

  mountedCenter.append(emptyEl, cardSlotEl);

  mountedRail.addEventListener('keydown', onRailKeydown);
}

const RAIL_MIN_PX = 180;
const RAIL_MAX_PX = 480;
const RAIL_KEY_STEP_PX = 16;

function applyRailWidth(resizer: HTMLElement, px: number) {
  if (!railEl) return null;
  const w = Math.round(Math.min(RAIL_MAX_PX, Math.max(RAIL_MIN_PX, px)));
  railEl.style.setProperty('--rail-width', `${w}px`);
  resizer.setAttribute('aria-valuenow', String(w));
  return w;
}

function wireRailResizer(resizer: HTMLElement | null) {
  if (!resizer || !railEl) return;
  const mountedRail = railEl;
  resizer.setAttribute('aria-valuemin', String(RAIL_MIN_PX));
  resizer.setAttribute('aria-valuemax', String(RAIL_MAX_PX));

  const stored = getRailWidth();
  if (typeof stored === 'number' && Number.isFinite(stored)) applyRailWidth(resizer, stored);

  let startX = 0;
  let startW = 0;
  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    startX = e.clientX;
    startW = mountedRail.getBoundingClientRect().width;
    resizer.setPointerCapture(e.pointerId);
    resizer.dataset.dragging = 'true';
    e.preventDefault();
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    applyRailWidth(resizer, startW + (e.clientX - startX));
  });
  const releaseDrag = (e: PointerEvent) => {
    resizer.releasePointerCapture(e.pointerId);
    delete resizer.dataset.dragging;
  };
  resizer.addEventListener('pointerup', (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    releaseDrag(e);
    setRailWidth(applyRailWidth(resizer, startW + (e.clientX - startX)));
  });

  resizer.addEventListener('pointercancel', (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    releaseDrag(e);
    applyRailWidth(resizer, startW);
  });

  resizer.addEventListener('dblclick', () => {
    mountedRail.style.removeProperty('--rail-width');
    resizer.removeAttribute('aria-valuenow');
    setRailWidth(null);
  });
  resizer.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? RAIL_KEY_STEP_PX : -RAIL_KEY_STEP_PX;
    const width = applyRailWidth(resizer, mountedRail.getBoundingClientRect().width + delta);
    if (width !== null) setRailWidth(width);
  });
}

function onRailKeydown(e: KeyboardEvent) {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const target = e.target instanceof HTMLElement ? e.target : null;
    const id = target?.dataset.id;
    if (!id || pillById.get(id) !== target) return;
    e.preventDefault();
    requestSessionRemoval(id, mergeStatusById.get(id));
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;

  const id = pickAdjacent(railVisibleIds(), railTabStopId, e.key === 'ArrowDown' ? 1 : -1);
  if (id == null) return;
  e.preventDefault();
  setRailTabStop(id);
  pillById.get(id)?.focus();
}

function orderedSessions() {
  const rows = [...sessionUIs.entries()].map(([id, ui]) => ({
    id,
    ui,
    name: sessionName(ui),
    isDormant: (ui.currentState || STATES.DORMANT) === STATES.DORMANT,
  }));

  return orderRoster(rows);
}

function sessionName(ui: SessionUi): string | null {
  return ui.nameEl ? ui.nameEl.textContent : (ui.card ? (ui.card.dataset.session || ui.card.dataset.id || '') : '');
}

function buildPill(id: string) {
  const button = el('button', 'focus-pill');
  button.type = 'button';
  button.dataset.id = id;
  button.setAttribute('role', 'option');

  button.innerHTML = '<span class="focus-pill-name"></span>'
    + '<span class="focus-pill-badge">'
    + '<span class="focus-pill-glyph"></span><span class="focus-pill-label"></span></span>'
    + '<span class="focus-pill-merge"></span>';

  const refs = {
    glyph: query(button, '.focus-pill-glyph'),
    label: query(button, '.focus-pill-label'),
    name: query(button, '.focus-pill-name'),
    merge: query(button, '.focus-pill-merge'),
  };
  const pill: HTMLButtonElement & { _refs: typeof refs; _row: HTMLElement | null } =
    Object.assign(button, { _refs: refs, _row: null });
  pill.addEventListener('click', () => onPillActivate(id));

  const row = el('div', 'focus-pill-row');
  row.setAttribute('role', 'presentation');
  const removeBtn = el('button', 'focus-pill-remove', '×');
  removeBtn.type = 'button';
  removeBtn.tabIndex = -1;

  if (!touchRail?.matches) removeBtn.setAttribute('aria-hidden', 'true');
  removeBtn.title = 'Remove session';
  removeBtn.addEventListener('click', (e) => { e.stopPropagation(); requestSessionRemoval(id, mergeStatusById.get(id)); });
  row.append(pill, removeBtn);
  pill._row = row;
  return pill;
}

function onPillActivate(id: string) {
  const ui = sessionUIs.get(id);
  if (!ui) return;
  if (ui.currentState === STATES.DORMANT) sendControlMsg({ type: 'start-session', id });
  dismissIfComplete(id);
  focusSession(id);
}

function dismissIfComplete(id: string) {
  if (sessionUIs.get(id)?.currentState !== STATES.COMPLETE) return;
  sendControlMsg({ type: 'dismiss', id });
}

function paintPill(pill: FocusPill, id: string, ui: SessionUi) {
  const state = ui.currentState || STATES.DORMANT;

  const prev = pill.dataset.state;
  if (state !== STATES.COMPLETE) pill.removeAttribute('data-unseen');
  if (state === STATES.COMPLETE && prev && prev !== STATES.COMPLETE) pill.dataset.unseen = '';
  pill.dataset.state = state;
  const { glyph, label } = stateChip(state);
  pill._refs.glyph.textContent = glyph;
  pill._refs.label.textContent = label;
  pill._refs.name.textContent = sessionName(ui);
  const ms = mergeStatusById.get(id) || 'none';
  pill.dataset.merge = ms === 'none' ? '' : ms;
  pill._refs.merge.textContent = MERGE_TAGS[ms] || '';

  pill.dataset.activity = ui._activity || '';

  pill.classList.toggle('focused', id === getFocusedSessionId());
  const isTabStop = id === railTabStopId;
  pill.setAttribute('aria-selected', String(isTabStop));
  pill.tabIndex = isTabStop ? 0 : -1;
}

function renderPillActivity(ui: SessionUi, kind: ActivityRenderKind) {
  if (!active) return;
  const id = ui?.card?.dataset.id;
  const pill = id ? pillById.get(id) : null;
  if (!pill) return;
  if (kind === 'flag') {
    pill.dataset.activity = ui._activity || '';
    return;
  }

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

export function refreshFocusRoster() {
  if (!active) return;
  const mountedRail = railEl;
  if (!mountedRail) return;
  const order = orderedSessions();
  const groups = groupRoster(order, (row) => row.ui.path, emptyProjectKeys(order, (row) => row.ui.path));
  const seen = new Set<string>();

  const placeList = (rows: RosterRow[], listEl: GroupList) => {
    const newKey = rows.map((r) => r.id).join(',');
    const orderUnchanged = listEl._lastOrderKey === newKey && listEl.childElementCount === rows.length;
    for (const { id, ui } of rows) {
      seen.add(id);
      let pill = pillById.get(id);
      if (!pill) { pill = buildPill(id); pillById.set(id, pill); }
      paintPill(pill, id, ui);
      if (!orderUnchanged && pill._row) listEl.appendChild(pill._row);
    }
    listEl._lastOrderKey = newKey;
  };

  const presentKeys = new Set(groups.order);
  for (const group of groups.groups) {
    const { header, list } = ensureGroup(group);
    mountedRail.appendChild(header);
    mountedRail.appendChild(list);
    placeList(group.rows, list);
  }

  for (const [key, header] of [...groupHeaderById]) {
    if (!presentKeys.has(key)) {
      header.remove();
      groupListById.get(key)?.remove();
      groupHeaderById.delete(key);
      groupListById.delete(key);
    }
  }

  for (const [id, pill] of pillById) {
    if (!seen.has(id)) {
      (pill._row || pill).remove();
      pillById.delete(id);
      if (id === railTabStopId) railTabStopId = null;
    }
  }

  for (const id of [...mergeStatusById.keys()]) {
    if (!sessionUIs.has(id)) mergeStatusById.delete(id);
  }

  const staleFocusedId = getFocusedSessionId();
  if (staleFocusedId && !sessionUIs.has(staleFocusedId)) {
    uiState.dispatch('focusSession', null);
    railTabStopId = null;
    const next = order.find((o) => sessionUIs.has(o.id));
    if (next) { focusSession(next.id); return; }
  }

  updateCenter();
  const centeredId = getFocusedSessionId();
  if (centeredId) {
    const ui = sessionUIs.get(centeredId);
    if (ui && ui.card.parentElement !== cardSlotEl) borrowToCenter(ui, centeredId);
  }
  updateRailHead();
}

function attentionRows() {
  return orderedSessions().map(({ id, ui }) => ({
    id,
    state: ui.currentState || STATES.DORMANT,
    unseen: !!pillById.get(id)?.hasAttribute('data-unseen'),
  }));
}

function attentionIds() {
  return attentionRows().filter(needsAttention).map(({ id }) => id);
}

function updateRailHead() {
  const count = countSessionsNeedingAttention(attentionRows());
  setRailHeadActive(count > 0, attentionSummaryText(count));
}

function setRailHeadActive(on: boolean, label: string) {
  if (!railHeadEl) return;
  query(railHeadEl, '.focus-rail-head-count').textContent = label;
  railHeadEl.disabled = !on;
  if (on) {
    railHeadEl.removeAttribute('data-empty');
    railHeadEl.removeAttribute('aria-hidden');
    return;
  }
  railHeadEl.dataset.empty = '';
  railHeadEl.setAttribute('aria-hidden', 'true');
}

export function focusNextAttention() {
  if (!active) return;
  const ids = attentionIds();
  if (!ids.length) return;
  const nextId = pickNextAttention(ids, attnCursorId);
  if (!nextId) return;
  attnCursorId = nextId;
  const ui = sessionUIs.get(nextId);

  const alreadyCentered = nextId === getFocusedSessionId();
  dismissIfComplete(nextId);
  focusSession(nextId);
  pillById.get(nextId)?.scrollIntoView({ block: 'nearest' });
  if (alreadyCentered) flashAttention(nextId);
  focusTerminalAfterSettle(ui, nextId);
}

function focusTerminalAfterSettle(ui: SessionUi | null | undefined, id: string) {
  if (!ui) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (active && getFocusedSessionId() === id) ui.term?.focus();
  }));
}

function flashAttention(id: string) {
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

function borrowToCenter(ui: SessionUi, id: string) {
  if (!cardSlotEl) return;
  borrowCard(ui, id, cardSlotEl, { className: 'focus-centered' });
}

function releaseCenter() {
  const centeredId = getFocusedSessionId();
  if (!centeredId) return;
  if (getBorrowedCardId() === centeredId) releaseCard();
  uiState.dispatch('focusSession', null);
}

function focusSession(id: string) {
  if (!active || !sessionUIs.has(id) || id === getFocusedSessionId()) return;
  releaseCenter();
  uiState.dispatch('focusSession', id);
  railTabStopId = id;

  setLastFocusedSessionId(id);

  pillById.get(id)?.removeAttribute('data-unseen');

  setSelectedId(id);
  refreshFocusRoster();
}

function updateCenter() {
  if (!emptyEl || !emptyTitleEl || !emptyDescEl) return;
  const centeredId = getFocusedSessionId();
  const has = !!(centeredId && sessionUIs.has(centeredId));
  emptyEl.hidden = has;
  if (has) return;

  const hasSessions = sessionUIs.size > 0;
  emptyTitleEl.textContent = hasSessions ? 'No session selected' : 'Nothing to focus';
  emptyDescEl.textContent = hasSessions
    ? 'Select a session from the rail on the left to focus it here.'
    : 'Spawn a session to start watching.';
}

export function setFocusMergeStatus(id: unknown, mergeStatus: unknown) {
  mergeStatusById.set(sessionIdOf(id), typeof mergeStatus === 'string' && mergeStatus ? mergeStatus : 'none');
  if (active) refreshFocusRoster();
}

export function centerSessionQuietly(id: string) {
  if (!active || !sessionUIs.has(id)) return;
  focusSession(id);
}

export function focusNthInRail(n: number) {
  if (!active) return;
  const id = railVisibleIds()[n - 1];
  if (id) onPillActivate(id);
}

export function focusAdjacentInRail(dir: number) {
  if (!active) return;
  const id = pickAdjacent(railVisibleIds(), railTabStopId, dir);
  if (id == null) return;
  onPillActivate(id);
  pillById.get(id)?.scrollIntoView({ block: 'nearest' });
  focusTerminalAfterSettle(sessionUIs.get(id), id);
}

export function activateFocusView() {
  if (!railEl) return;
  active = true;

  releaseCenter();
  railTabStopId = null;
  refreshFocusRoster();
  restoreFocusedSession();
}

export function restoreFocusedSession() {
  if (!active || getFocusedSessionId()) return;
  const id = getLastFocusedSessionId();
  if (!id) return;
  const ui = sessionUIs.get(id);
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
