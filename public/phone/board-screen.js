// The phone Board: the landing screen, and the phone's answer to the question the whole product
// exists for - which session needs a carbon unit right now.
//
// It is a plain vertical list of session rows, ordered attention-first (triage-core.mjs), each row a
// 56px tap target that opens that session's Terminal screen. It renders from the SAME session registry
// the desktop cards render from (session-card/card-registry sessionUIs) and is refreshed from the same
// control-WS handlers in app.js that refresh the desktop rail, so there is one state pipeline, not two.
//
// The phone top bar is part of this screen rather than a global chrome strip: the desktop .header does
// not render under [data-layout="phone"] at all. Everything that lived in it is ADOPTED here (the
// connection chip, "+ Session", the help button, the hamburger with Mute / Settings / Restart / Shut
// Down), so the client-trust gating and every existing listener come along untouched.

import { BADGE_LABELS, STATE_GLYPHS, STATES } from '/shared/states.mjs';
import { el } from '../dom-helpers.js';
import { orderRoster } from '../focus-view/attention-core.mjs';
import { sessionUIs } from '../session-card/card-registry.js';
import { onSessionTick, sessionElapsedText } from '../session-card/session-tick.js';
import { attentionSummaryText, countSessionsNeedingAttention, orderSessionsForTriage } from './triage-core.mjs';

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

  const listEl = el('div', 'phone-board-list');
  listEl.setAttribute('role', 'list');

  const emptyEl = el('div', 'phone-empty');
  emptyEl.innerHTML = '<p class="phone-empty-title"></p><p class="phone-empty-desc"></p>';
  const emptyTitleEl = emptyEl.querySelector('.phone-empty-title');
  const emptyDescEl = emptyEl.querySelector('.phone-empty-desc');

  screen.append(topBar, attentionEl, listEl, emptyEl);

  const rowById = new Map();
  let attentionCount = 0;

  // The board's own --header-h, so toasts land below the phone top bar exactly as they land below the
  // desktop header. Same guard as the desktop observer: a hidden bar measures 0 and must not clobber
  // the live value written by whichever bar IS on screen.
  let headerSizeRaf = null;
  new ResizeObserver(() => {
    if (headerSizeRaf !== null) return;
    headerSizeRaf = requestAnimationFrame(() => {
      headerSizeRaf = null;
      const height = topBar.offsetHeight;
      if (height > 0) document.documentElement.style.setProperty('--header-h', `${height}px`);
    });
  }).observe(topBar);

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
    row._refs = {
      glyph: row.querySelector('.phone-row-glyph'),
      name: row.querySelector('.phone-row-name'),
      badge: row.querySelector('.phone-row-badge'),
      merge: row.querySelector('.phone-row-merge'),
      elapsed: row.querySelector('.phone-row-elapsed'),
    };
    row.addEventListener('click', () => onSelectSession?.(id));
    // role=listitem on the button itself would REPLACE its button role, so a screen reader would
    // announce a list item that gives no hint it is activatable. The item semantics ride a wrapper
    // instead, keeping "list, N items" for triage while each row still announces as a button. The
    // reconcile loop appends row._item, never the bare row (same shape as the rail's pill._row).
    const item = el('div', 'phone-row-item');
    item.setAttribute('role', 'listitem');
    item.appendChild(row);
    row._item = item;
    return row;
  }

  function sessionName(ui) {
    return ui.card?.dataset.session || ui.nameEl?.textContent || '';
  }

  // Merge status is read off the card's data-merge, which lifecycle.js already maintains for the
  // remove-warning. Reusing it keeps the board off any pipeline of its own.
  const MERGE_TAGS = { 'pending-review': 'REVIEW', parked: 'PARKED', merging: 'MERGING' };

  function paintRow(row, entry) {
    const { ui, state, unseen } = entry;
    const label = (BADGE_LABELS[state] || state).toUpperCase();
    const name = entry.name;
    row.dataset.state = state;
    row.toggleAttribute('data-unseen', unseen);
    row._refs.glyph.textContent = STATE_GLYPHS[state] || '';
    row._refs.name.textContent = name;
    row._refs.badge.textContent = label;
    const merge = ui.card?.dataset.merge || '';
    row.dataset.merge = merge;
    row._refs.merge.textContent = MERGE_TAGS[merge] || '';
    row._refs.elapsed.textContent = sessionElapsedText(ui);
    row.setAttribute('aria-label', `${name}, ${label}`);
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

  function currentRows() {
    const entries = [...sessionUIs.entries()].map(([id, ui]) => ({
      id,
      ui,
      name: sessionName(ui),
      isDormant: (ui.currentState || STATES.DORMANT) === STATES.DORMANT,
      state: ui.currentState || STATES.DORMANT,
    }));
    noteStateTransitions(entries);
    for (const entry of entries) entry.unseen = unseenCompleteIds.has(entry.id);
    return orderSessionsForTriage(orderRoster(entries));
  }

  function refresh() {
    const rows = currentRows();
    attentionCount = countSessionsNeedingAttention(rows);
    attentionEl.textContent = attentionSummaryText(attentionCount);
    attentionEl.toggleAttribute('data-lit', attentionCount > 0);

    const seen = new Set();
    for (const entry of rows) {
      seen.add(entry.id);
      let row = rowById.get(entry.id);
      if (!row) {
        row = buildRow(entry.id);
        rowById.set(entry.id, row);
      }
      paintRow(row, entry);
      listEl.appendChild(row._item); // re-append settles the attention-first order
    }
    for (const [id, row] of [...rowById]) {
      if (seen.has(id)) continue;
      row._item.remove();
      rowById.delete(id);
    }

    const hasSessions = rows.length > 0;
    listEl.hidden = !hasSessions;
    emptyEl.hidden = hasSessions;
    if (hasSessions) return;
    emptyTitleEl.textContent = 'No sessions';
    emptyDescEl.textContent = 'Spawn a session to start watching.';
  }

  // Row clocks ride the shared 1s tick; only the elapsed text moves, so this never reorders under the
  // operator's thumb mid-scroll.
  onSessionTick(() => {
    for (const [id, row] of rowById) {
      const ui = sessionUIs.get(id);
      if (ui) row._refs.elapsed.textContent = sessionElapsedText(ui);
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
