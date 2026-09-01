// The phone Board: the landing screen, and the phone's answer to the question the whole product
// exists for - which session needs a carbon unit right now.
//
// It mirrors the desktop rail's project groups while keeping each project's rows attention-first. It
// renders from the SAME session registry the desktop cards render from and is refreshed from the same
// control-WS handlers in app.js that refresh the desktop rail, so there is one state pipeline, not two.
//
// The phone top bar is part of this screen rather than a global chrome strip: the desktop .header does
// not render under [data-layout="phone"] at all. Everything that lived in it is ADOPTED here (the
// connection chip, "+ Session", the help button, the hamburger with Mute / Settings / Restart / Shut
// Down), so the client-trust gating and every existing listener come along untouched.

import { STATES } from '#shared/states.ts';
import { el, MERGE_TAGS, observeHeaderHeight, queryTag, stateChip } from '../dom-helpers.js';
import { attentionSummaryText, countSessionsNeedingAttention, orderRoster } from '../focus-view/attention-core.mjs';
import { NO_PATH_KEY } from '../focus-view/roster-groups.mjs';
import { emptyProjectKeys, forgetProject } from '../project-registry.js';
import { quickAddSession, requestSessionRemoval } from '../session-actions.js';
import { sessionUIs } from '../session-card/card-registry.js';
import { onSessionTick, sessionElapsedText } from '../session-card/session-tick.js';
import { groupSessionsForBoard } from './board-groups-core.mjs';

const projectPathOf = (row) => row.ui.path;

/** @typedef {{ glyph: HTMLSpanElement, name: HTMLSpanElement, badge: HTMLSpanElement, merge: HTMLSpanElement, elapsed: HTMLSpanElement }} RowRefs */
/** @typedef {{ header: HTMLDivElement, label: HTMLSpanElement, count: HTMLSpanElement, addButton: HTMLButtonElement, forgetButton: HTMLButtonElement, rows: HTMLDivElement }} GroupRefs */

// createBoardScreen({ onSelectSession }) -> { el, topBarEl, refresh, getAttentionCount }
// The shell adopts the desktop header controls into topBarEl on activation and gives them back on
// deactivation, so ownership of those borrowed elements sits in one place.
export function createBoardScreen({ onSelectSession }) {
  const screen = el('div', 'phone-board');

  // No wordmark: the loading screen already brands, and at 390px every pixel the mark would take comes
  // out of the controls that do something. Chrome recedes.
  const topBar = el('header', 'phone-topbar');

  // The honest headline: how many sessions actually want you. Quiet at rest ("ALL CLEAR"), orchid and
  // counted only when something is genuinely blocked, broken, or finished-and-unread.
  const attentionEl = el('div', 'phone-attention');
  attentionEl.setAttribute('role', 'status');
  attentionEl.setAttribute('aria-live', 'polite');

  const groupsEl = el('div', 'phone-board-list');

  const emptyEl = el('div', 'phone-empty');
  emptyEl.innerHTML = '<p class="phone-empty-title"></p><p class="phone-empty-desc"></p>';
  const emptyTitleEl = queryTag(emptyEl, '.phone-empty-title', 'p');
  const emptyDescEl = queryTag(emptyEl, '.phone-empty-desc', 'p');

  screen.append(topBar, attentionEl, groupsEl, emptyEl);

  const rowById = new Map();
  const groupSectionByKey = new Map();
  /** @type {WeakMap<HTMLButtonElement, { refs: RowRefs, item: HTMLDivElement }>} */
  const rowState = new WeakMap();
  /** @type {WeakMap<HTMLElement, GroupRefs>} */
  const groupRefs = new WeakMap();
  /** @type {WeakMap<HTMLElement, string>} */
  const orderKeys = new WeakMap();
  let attentionCount = 0;

  observeHeaderHeight(topBar);

  function buildRow(id) {
    const row = el('button', 'phone-row');
    row.type = 'button';
    row.dataset.id = id;
    row.innerHTML = '<span class="phone-row-glyph" aria-hidden="true"></span>'
      + '<span class="phone-row-main">'
      + '<span class="phone-row-name"></span>'
      + '<span class="phone-row-meta">'
      + '<span class="phone-row-badge"></span><span class="phone-row-merge"></span>'
      + '</span></span>'
      + '<span class="phone-row-elapsed" aria-hidden="true"></span>';
    const refs = {
      glyph: queryTag(row, '.phone-row-glyph', 'span'),
      name: queryTag(row, '.phone-row-name', 'span'),
      badge: queryTag(row, '.phone-row-badge', 'span'),
      merge: queryTag(row, '.phone-row-merge', 'span'),
      elapsed: queryTag(row, '.phone-row-elapsed', 'span'),
    };
    row.addEventListener('click', () => onSelectSession?.(id));
    const item = el('div', 'phone-row-item');
    item.setAttribute('role', 'listitem');
    const removeButton = el('button', 'phone-row-remove', 'x');
    removeButton.type = 'button';
    removeButton.title = 'Remove session';
    removeButton.setAttribute('aria-label', 'Remove session');
    removeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      requestSessionRemoval(id);
    });
    item.append(row, removeButton);
    rowState.set(row, { refs, item });
    return row;
  }

  function buildGroup(key) {
    const section = el('section', 'phone-board-group');
    section.dataset.key = key;
    const header = el('div', 'phone-board-group-header');
    const label = el('span', 'phone-board-group-label');
    const count = el('span', 'phone-board-group-count');
    const addButton = el('button', 'phone-board-group-add', '+');
    addButton.type = 'button';
    addButton.addEventListener('click', () => quickAddSession(section.dataset.path, section.dataset.label));
    const forgetButton = el('button', 'phone-board-group-forget', 'x');
    forgetButton.type = 'button';
    forgetButton.addEventListener('click', () => {
      forgetProject(section.dataset.path);
      refresh();
    });
    const rows = el('div', 'phone-board-group-rows');
    rows.setAttribute('role', 'list');
    header.append(label, count, forgetButton, addButton);
    section.append(header, rows);
    groupRefs.set(section, { header, label, count, addButton, forgetButton, rows });
    return section;
  }

  function sessionName(ui) {
    return ui.card?.dataset.session || ui.nameEl?.textContent || '';
  }

  function paintRow(row, entry) {
    const rowDetails = rowState.get(row);
    if (!rowDetails) return;
    const { ui, state, unseen } = entry;
    const { glyph, label } = stateChip(state);
    const name = entry.name;
    row.dataset.state = state;
    row.toggleAttribute('data-unseen', unseen);
    rowDetails.refs.glyph.textContent = glyph;
    rowDetails.refs.name.textContent = name;
    rowDetails.refs.badge.textContent = label;
    // Merge status is read off the card's data-merge, which lifecycle.js already maintains for the
    // remove-warning. Reusing it keeps the board off any pipeline of its own.
    const merge = ui.card?.dataset.merge || '';
    row.dataset.merge = merge;
    rowDetails.refs.merge.textContent = MERGE_TAGS[merge] || '';
    rowDetails.refs.elapsed.textContent = sessionElapsedText(ui);
    row.setAttribute('aria-label', `${name}, ${label}`);
  }

  function paintGroup(section, group) {
    const refs = groupRefs.get(section);
    if (!refs) return;
    const { header, label, count, addButton, forgetButton, rows } = refs;
    const isPathless = group.key === NO_PATH_KEY;
    const isEmpty = group.rows.length === 0;
    section.dataset.path = group.key;
    section.dataset.label = group.label;
    section.toggleAttribute('data-empty', isEmpty);
    header.title = group.title;
    label.textContent = group.label;
    count.textContent = String(group.rows.length);
    count.title = `${group.rows.length} ${group.rows.length === 1 ? 'session' : 'sessions'}`;
    addButton.hidden = isPathless;
    forgetButton.hidden = isPathless || !isEmpty;
    if (!isPathless) {
      addButton.title = `Add a session to ${group.label}`;
      addButton.setAttribute('aria-label', `Add a session to ${group.label}`);
    }
    if (!isPathless && isEmpty) {
      forgetButton.title = `Remove ${group.label} from the Board`;
      forgetButton.setAttribute('aria-label', `Remove ${group.label} from the Board`);
    }
    rows.setAttribute('aria-label', `${group.label} sessions`);
  }

  // ── Announce-once bookkeeping (the desktop rail's data-unseen rule, kept out of the DOM) ──
  // A COMPLETE session counts toward the attention readout only until the operator opens it. Only a
  // session that ENTERS complete while the Board is live is unseen: one already COMPLETE at
  // snapshot/reconnect has no prior state here and is treated as already seen, so a page reload never
  // false-announces a turn the operator read yesterday. Held in a Set rather than on the row element so
  // the pure core is fed data, never a DOM query.
  const lastStateById = new Map();
  const unseenCompleteIds = new Set();

  function noteStateTransitions(entries) {
    for (const { id, state } of entries) {
      const previousState = lastStateById.get(id);
      lastStateById.set(id, state);
      if (state !== STATES.COMPLETE) {
        unseenCompleteIds.delete(id);
        continue;
      }
      if (previousState && previousState !== STATES.COMPLETE) unseenCompleteIds.add(id);
    }
    for (const id of [...lastStateById.keys()]) {
      if (sessionUIs.has(id)) continue;
      lastStateById.delete(id);
      unseenCompleteIds.delete(id);
    }
  }

  // Opening a session is reading it. The shell calls this before showing the Terminal screen, which is
  // the phone's peer of focusSession clearing the rail pill's data-unseen.
  function acknowledge(id) {
    unseenCompleteIds.delete(id);
  }

  function currentOrderedRows() {
    const entries = [...sessionUIs.entries()].map(([id, ui]) => ({
      id,
      ui,
      name: sessionName(ui),
      isDormant: (ui.currentState || STATES.DORMANT) === STATES.DORMANT,
      state: ui.currentState || STATES.DORMANT,
      unseen: false,
    }));
    noteStateTransitions(entries);
    for (const entry of entries) entry.unseen = unseenCompleteIds.has(entry.id);
    return orderRoster(entries);
  }

  function refresh() {
    const orderedRows = currentOrderedRows();
    const boardGroups = groupSessionsForBoard(
      orderedRows,
      projectPathOf,
      emptyProjectKeys(orderedRows, projectPathOf),
    );
    attentionCount = countSessionsNeedingAttention(orderedRows);
    attentionEl.textContent = attentionSummaryText(attentionCount);
    attentionEl.toggleAttribute('data-lit', attentionCount > 0);

    const presentGroupKeys = new Set(boardGroups.order);
    const groupOrderKey = boardGroups.order.join(',');
    const groupOrderUnchanged = orderKeys.get(groupsEl) === groupOrderKey
      && groupsEl.childElementCount === boardGroups.groups.length;
    for (const group of boardGroups.groups) {
      let section = groupSectionByKey.get(group.key);
      if (!section) {
        section = buildGroup(group.key);
        groupSectionByKey.set(group.key, section);
      }
      paintGroup(section, group);
      if (!groupOrderUnchanged) groupsEl.appendChild(section);
      const rowOrderKey = group.rows.map((entry) => entry.id).join(',');
      const refs = groupRefs.get(section);
      if (!refs) continue;
      const rowOrderUnchanged = orderKeys.get(refs.rows) === rowOrderKey
        && refs.rows.childElementCount === group.rows.length;
      for (const entry of group.rows) {
        let row = rowById.get(entry.id);
        if (!row) {
          row = buildRow(entry.id);
          rowById.set(entry.id, row);
        }
        paintRow(row, entry);
        const state = rowState.get(row);
        if (!state) continue;
        if (!rowOrderUnchanged) refs.rows.appendChild(state.item);
      }
      orderKeys.set(refs.rows, rowOrderKey);
    }
    orderKeys.set(groupsEl, groupOrderKey);
    for (const [key, section] of [...groupSectionByKey]) {
      if (presentGroupKeys.has(key)) continue;
      section.remove();
      groupSectionByKey.delete(key);
    }
    const seen = new Set(boardGroups.visibleIds);
    for (const [id, row] of [...rowById]) {
      if (seen.has(id)) continue;
      const state = rowState.get(row);
      if (state) state.item.remove();
      rowById.delete(id);
    }

    const hasGroups = boardGroups.groups.length > 0;
    groupsEl.hidden = !hasGroups;
    emptyEl.hidden = hasGroups;
    if (hasGroups) return;
    emptyTitleEl.textContent = 'No sessions';
    emptyDescEl.textContent = 'Spawn a session to start watching.';
  }

  // Row clocks ride the shared 1s tick; only the elapsed text moves, so this never reorders under the
  // operator's thumb mid-scroll.
  onSessionTick(() => {
    for (const [id, row] of rowById) {
      const ui = sessionUIs.get(id);
      const state = rowState.get(row);
      if (ui && state) state.refs.elapsed.textContent = sessionElapsedText(ui);
    }
  });

  return {
    el: screen,
    topBarEl: topBar,
    refresh,
    acknowledge,
    getAttentionCount: () => attentionCount,
  };
}
