import { STATES } from '#shared/states.ts';
import { el, MERGE_TAGS, observeHeaderHeight, queryTag, stateChip } from '../dom-helpers.ts';
import { attentionSummaryText, countSessionsNeedingAttention, orderRoster } from '../focus-view/attention-core.ts';
import type { RosterGroup } from '../focus-view/roster-groups.ts';
import { NO_PATH_KEY } from '../focus-view/roster-groups.ts';
import { emptyProjectKeys, forgetProject } from '../project-registry.ts';
import { quickAddSession, requestSessionRemoval } from '../session-actions.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { onSessionTick, sessionElapsedText } from '../session-card/session-tick.ts';
import { groupSessionsForBoard } from './board-groups-core.ts';

interface BoardRow {
  id: string;
  ui: SessionUi;
  name: string;
  isDormant: boolean;
  state: string;
  unseen: boolean;
}

const projectPathOf = (row: BoardRow) => row.ui.path;

interface RowRefs {
  glyph: HTMLSpanElement;
  name: HTMLSpanElement;
  badge: HTMLSpanElement;
  merge: HTMLSpanElement;
  elapsed: HTMLSpanElement;
}

interface GroupRefs {
  header: HTMLDivElement;
  label: HTMLSpanElement;
  count: HTMLSpanElement;
  addButton: HTMLButtonElement;
  forgetButton: HTMLButtonElement;
  rows: HTMLDivElement;
}

export function createBoardScreen({ onSelectSession }: { onSelectSession?: (id: string) => void }) {
  const screen = el('div', 'phone-board');

  const topBar = el('header', 'phone-topbar');

  const attentionEl = el('div', 'phone-attention');
  attentionEl.setAttribute('role', 'status');
  attentionEl.setAttribute('aria-live', 'polite');

  const groupsEl = el('div', 'phone-board-list');

  const emptyEl = el('div', 'phone-empty');
  emptyEl.innerHTML = '<p class="phone-empty-title"></p><p class="phone-empty-desc"></p>';
  const emptyTitleEl = queryTag(emptyEl, '.phone-empty-title', 'p');
  const emptyDescEl = queryTag(emptyEl, '.phone-empty-desc', 'p');

  screen.append(topBar, attentionEl, groupsEl, emptyEl);

  const rowById = new Map<string, HTMLButtonElement>();
  const groupSectionByKey = new Map<string, HTMLElement>();
  const rowState = new WeakMap<HTMLButtonElement, { refs: RowRefs; item: HTMLDivElement }>();
  const groupRefs = new WeakMap<HTMLElement, GroupRefs>();
  const orderKeys = new WeakMap<HTMLElement, string>();
  let attentionCount = 0;

  observeHeaderHeight(topBar);

  function buildRow(id: string) {
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

  function buildGroup(key: string) {
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

  function sessionName(ui: SessionUi) {
    return ui.card?.dataset.session || ui.nameEl?.textContent || '';
  }

  function paintRow(row: HTMLButtonElement, entry: BoardRow) {
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

    const merge = ui.card?.dataset.merge || '';
    row.dataset.merge = merge;
    rowDetails.refs.merge.textContent = MERGE_TAGS[merge] || '';
    rowDetails.refs.elapsed.textContent = sessionElapsedText(ui);
    row.setAttribute('aria-label', `${name}, ${label}`);
  }

  function paintGroup(section: HTMLElement, group: RosterGroup<BoardRow>) {
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

  const lastStateById = new Map<string, string>();
  const unseenCompleteIds = new Set<string>();

  function noteStateTransitions(entries: readonly BoardRow[]) {
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

  function acknowledge(id: string) {
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
