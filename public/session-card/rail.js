// Minimized-session rail: the bottom dock of status pills and the peek tray that
// flies up off a pill. This module owns everything the rail does beyond the pure
// CSS in style.css:
//
//   - A MutationObserver on the minimized bar that keeps each pill's a11y chrome
//     (role=button, roving tabindex, aria-expanded) correct as cards enter/leave,
//     and tears down an open peek when its pill leaves the bar (drag-to-grid,
//     restore, maximize-swap, remove all flow through here).
//   - A 1s interval that ticks each pill's "time in current state" readout.
//   - Click / keyboard (arrows, Home/End, Enter/Space, Escape) interaction.
//   - The peek tray itself: a live xterm peek (the card's real terminal, reparented
//     in) for running sessions, a status readout for finished/dormant ones, plus
//     the contextual actions.
//
// Dependency direction is one-way (rail -> layout/terminal/registry); layout.js
// never imports rail.js, so there is no cycle. lifecycle.js imports this module
// purely to evaluate it (the listeners below install at module load, mirroring
// drag-drop.js) and to call refreshPill / closePeekFor.

import { BADGE_LABELS, KILLABLE_STATES, STATE_GLYPHS, STATES } from '/shared/states.mjs';
import { sendControlMsg } from '../control-ws.js';
import { el } from '../dom-helpers.js';
import { showConfirmDialog } from './card-dom.js';
import { minimizedBar, sessionUIs } from './card-registry.js';
import { toggleMaximize, toggleMinimize } from './layout.js';
import { forceTerminalRepaint } from './terminal.js';
import { tryLoadWebGL } from './webgl-pool.js';

// The single open peek, or null. { id, pill, tray, hadTerm }.
let _peek = null;

// States where a ticking "time in state" reads as meaningful: only while the
// session is actively progressing. IDLE / COMPLETE / DONE / FAILED / DORMANT are
// settled, so a stopwatch there is just noise (per operator feedback).
const ELAPSED_STATES = new Set([STATES.RUNNING, STATES.WAITING, STATES.STARTING, STATES.INITIALIZING]);
const showsElapsed = (state) => ELAPSED_STATES.has(state);

// ── Elapsed formatting ───────────────────────────────────────

function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtRelative(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

// The pill's time-in-state text, or '' for settled states (which show no timer).
function pillElapsed(ui) {
  return showsElapsed(ui.currentState) ? fmtElapsed(Date.now() - (ui.stateSince || Date.now())) : '';
}

// ── Pill chrome (a11y) ───────────────────────────────────────

function applyPillChrome(card) {
  card.setAttribute('role', 'button');
  card.setAttribute('aria-expanded', 'false');
  if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '-1');
}

function clearPillChrome(card) {
  card.removeAttribute('role');
  card.removeAttribute('aria-expanded');
  card.removeAttribute('tabindex');
  card.removeAttribute('aria-label');
}

function railPills() {
  return [...minimizedBar.children].filter((c) => c.classList?.contains('session-card'));
}

// Keep exactly one pill in the roving tab order so the rail is reachable by Tab.
function normalizeRoving() {
  const pills = railPills();
  if (pills.length === 0) return;
  if (!pills.some((p) => p.getAttribute('tabindex') === '0')) {
    pills[0].setAttribute('tabindex', '0');
  }
}

// Refresh a single pill's live readout (aria-label + elapsed). No-op off the rail.
// Called by lifecycle.applyState so a state change is reflected immediately, and
// by the interval tick for the elapsed clock.
export function refreshPill(ui) {
  const card = ui.card;
  if (!card.classList.contains('minimized')) return;
  const label = BADGE_LABELS[ui.currentState] || ui.currentState;
  card.setAttribute('aria-label', `${card.dataset.session}: ${label}`);
  if (ui.railElapsed) ui.railElapsed.textContent = pillElapsed(ui);
  // If the peeked session crossed the live<->finished line (e.g. it just exited
  // while open), the tray contents are stale, so drop it rather than show a frame
  // that no longer matches the terminal we reparented.
  if (_peek && _peek.id === card.dataset.id && !!ui.term !== _peek.hadTerm) closePeek();
}

// ── Peek tray ────────────────────────────────────────────────

function positionTray(tray, pill) {
  const r = pill.getBoundingClientRect();
  tray.style.position = 'fixed';
  // Anchor by the bottom edge so the tray grows upward off the pill.
  tray.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
  // Never taller than the gap above the pill, so the whole tray (and the
  // terminal's input row) stays on-screen; the terminal slot flexes to fit.
  tray.style.maxHeight = `${Math.max(160, Math.round(r.top - 16))}px`;
  const tw = tray.offsetWidth;
  let left = Math.min(r.left, window.innerWidth - tw - 8);
  left = Math.max(8, left);
  tray.style.left = `${Math.round(left)}px`;
}

function makeActionButton(label, onClick) {
  const b = el('button', null, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function buildHead(ui, name) {
  const head = el('div', 'rail-peek-head');

  const badge = el('span', 'state-badge has-glyph');
  badge.dataset.state = ui.currentState;
  const glyph = el('span', 'state-glyph');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = STATE_GLYPHS[ui.currentState] || '';
  const lbl = el('span', 'state-label', BADGE_LABELS[ui.currentState] || ui.currentState);
  badge.append(glyph, lbl);

  const nameEl = el('span', 'rail-peek-name', name);
  head.append(badge, nameEl);

  if (showsElapsed(ui.currentState)) {
    head.append(el('span', 'rail-peek-time', fmtElapsed(Date.now() - (ui.stateSince || Date.now()))));
  }
  return head;
}

// Action handlers all close the peek FIRST so the reparented terminal is back
// inside its card before any expand/maximize re-shows it.
function buildActions(id, ui, pill) {
  const actions = el('div', 'rail-peek-actions');
  const state = ui.currentState;
  const name = pill.dataset.session;

  const confirmRemove = () => {
    closePeek();
    showConfirmDialog({
      title: 'Remove Session',
      message: `Remove session "${name}"?`,
      confirmLabel: 'Remove',
      onConfirm: () => sendControlMsg({ type: 'remove-session', id }),
    });
  };

  if (state === STATES.DORMANT) {
    actions.append(
      makeActionButton('Start', () => { closePeek(); toggleMinimize(id); }),
    );
    const remove = makeActionButton('Remove', confirmRemove);
    remove.classList.add('rail-peek-danger');
    actions.append(remove);
  } else if (state === STATES.DONE || state === STATES.FAILED) {
    actions.append(
      makeActionButton('Open', () => { closePeek(); toggleMinimize(id); }),
      makeActionButton('Restart', () => {
        closePeek();
        const type = KILLABLE_STATES.includes(state) ? 'force-restart' : 'restart';
        sendControlMsg({ type, id });
      }),
    );
    const remove = makeActionButton('Remove', confirmRemove);
    remove.classList.add('rail-peek-danger');
    actions.append(remove);
  } else {
    actions.append(
      makeActionButton('Open', () => {
        closePeek();
        toggleMinimize(id);
        // toggleMinimize's inline expand does not repaint; force one so the
        // restored terminal redraws cleanly after the reparent.
        const u = sessionUIs.get(id);
        if (u) forceTerminalRepaint(u);
      }),
      makeActionButton('Maximize', () => { closePeek(); toggleMaximize(id); }),
    );
  }
  return actions;
}

function openPeek(id, pill) {
  const ui = sessionUIs.get(id);
  if (!ui) return;

  // Looking at the result acknowledges it.
  pill.removeAttribute('data-unseen');

  const tray = el('div', 'rail-peek');
  tray.setAttribute('role', 'dialog');
  tray.setAttribute('aria-label', `${pill.dataset.session} status`);

  const hadTerm = !!ui.term;
  const head = buildHead(ui, pill.dataset.session);
  tray.appendChild(head);

  let slot = null;
  if (hadTerm) {
    // Live peek: reparent the card's REAL terminal into the tray, at its real size.
    // We deliberately do NOT resize it: a minimized terminal keeps the size it had
    // on the grid, so restoring it later is a no-op size change that never reflows
    // or corrupts the live session (resizing here was the cause of the garbled
    // restore). The slot caps the height and pins the terminal to the bottom (CSS),
    // so the live input row is always visible and only old scrollback clips at top.
    slot = el('div', 'rail-peek-term');
    slot.appendChild(ui.termWrap);
    tray.appendChild(slot);
  } else {
    tray.appendChild(el('div', 'rail-peek-status', describeDead(ui)));
  }

  const actions = buildActions(id, ui, pill);
  tray.appendChild(actions);
  document.body.appendChild(tray);

  _peek = { id, pill, tray, hadTerm };
  pill.setAttribute('aria-expanded', 'true');

  positionTray(tray, pill);

  // Cap the terminal viewport to the room above the pill (minus the header/actions),
  // so the whole tray stays on-screen. The CSS pins the terminal to the bottom.
  if (slot) {
    const room = Math.max(160, Math.round(pill.getBoundingClientRect().top - 16));
    const reserve = head.offsetHeight + actions.offsetHeight + 44; // gaps + padding
    slot.style.maxHeight = `${Math.max(120, room - reserve)}px`;
  }

  // Tab out of the tray (focus leaves both tray and pill) dismisses it.
  tray.addEventListener('focusout', (e) => {
    if (!_peek || _peek.tray !== tray) return;
    const to = e.relatedTarget;
    if (to && (tray.contains(to) || to === pill)) return;
    closePeek();
  });

  if (hadTerm) {
    // Clear ghost glyphs from the reparent, scroll to the live cursor, and land
    // focus in the terminal so the operator can type immediately. No fit / resize.
    requestAnimationFrame(() => {
      if (!_peek || _peek.id !== id || !ui.term) return;
      if (ui.needsWebGLReload) tryLoadWebGL(ui);
      forceTerminalRepaint(ui);
      ui.term.scrollToBottom();
      ui.term.focus();
    });
  } else {
    // No terminal (finished/dormant): land on the first action instead.
    tray.querySelector('button')?.focus();
  }
}

function describeDead(ui) {
  const ago = fmtRelative(Date.now() - (ui.stateSince || Date.now()));
  switch (ui.currentState) {
    case STATES.DONE:    return `Exited ${ago}.`;
    case STATES.FAILED:  return `Failed ${ago}.`;
    case STATES.DORMANT: return 'Not started yet. Start to spawn this session.';
    default:             return `${BADGE_LABELS[ui.currentState] || ui.currentState} ${ago}.`;
  }
}

export function closePeek(returnFocus) {
  const p = _peek;
  if (!p) return;
  _peek = null;

  const ui = sessionUIs.get(p.id);
  // Move the live terminal back into its card before the tray is removed.
  if (ui && p.tray.contains(ui.termWrap)) ui.card.appendChild(ui.termWrap);

  p.pill?.setAttribute('aria-expanded', 'false');
  p.tray.remove();

  if (returnFocus && p.pill?.isConnected) p.pill.focus();
}

export function closePeekFor(id) {
  if (_peek && _peek.id === id) closePeek();
}

function togglePeek(id, pill) {
  if (_peek && _peek.id === id) { closePeek(true); return; }
  if (_peek) closePeek();
  openPeek(id, pill);
}

// ── Roving focus ─────────────────────────────────────────────

function focusPillAt(pills, n) {
  pills.forEach((p, i) => p.setAttribute('tabindex', i === n ? '0' : '-1'));
  pills[n].focus();
}

// ── Wiring (installs at module load) ─────────────────────────

// Pill a11y + roving + peek invalidation, driven by the bar's composition.
const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType === 1 && node.classList.contains('session-card')) {
        applyPillChrome(node);
        const ui = sessionUIs.get(node.dataset.id);
        if (ui) refreshPill(ui);
      }
    }
    for (const node of m.removedNodes) {
      if (node.nodeType === 1 && node.classList.contains('session-card')) {
        clearPillChrome(node);
        // Leaving the rail (restore / maximize / drag-to-grid) acknowledges a
        // recently-completed result.
        node.removeAttribute('data-unseen');
        if (_peek && _peek.id === node.dataset.id) closePeek();
      }
    }
  }
  normalizeRoving();
});
observer.observe(minimizedBar, { childList: true });

// Tick the time-in-state readout. Cheap: only touches pills actually on the rail.
setInterval(() => {
  if (_peek) {
    const ui = sessionUIs.get(_peek.id);
    const t = _peek.tray.querySelector('.rail-peek-time');
    if (ui && t && showsElapsed(ui.currentState)) {
      t.textContent = fmtElapsed(Date.now() - (ui.stateSince || Date.now()));
    }
  }
  for (const card of railPills()) {
    const ui = sessionUIs.get(card.dataset.id);
    if (ui?.railElapsed) ui.railElapsed.textContent = pillElapsed(ui);
  }
}, 1000);

// Click a pill (not a drag, which fires no click) to toggle its peek.
minimizedBar.addEventListener('click', (e) => {
  const card = e.target.closest('.session-card');
  if (!card || !minimizedBar.contains(card)) return;
  if (e.target.closest('.session-actions')) return; // hidden on the pill, but be safe
  togglePeek(card.dataset.id, card);
});

// Keyboard: arrows/Home/End move the roving focus; Enter/Space peek.
minimizedBar.addEventListener('keydown', (e) => {
  const card = e.target.closest('.session-card');
  if (!card) return;
  const pills = railPills();
  const idx = pills.indexOf(card);
  if (idx === -1) return;

  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    focusPillAt(pills, (idx + 1) % pills.length);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    focusPillAt(pills, (idx - 1 + pills.length) % pills.length);
  } else if (e.key === 'Home') {
    e.preventDefault();
    focusPillAt(pills, 0);
  } else if (e.key === 'End') {
    e.preventDefault();
    focusPillAt(pills, pills.length - 1);
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    togglePeek(card.dataset.id, card);
  }
});

// Escape closes the peek. Capture phase + stopImmediatePropagation so it fires
// before both xterm's textarea handler (a peeked terminal is focused, and we do
// NOT want the ESC forwarded to the agent's PTY) and the maximize-exit handler in
// app.js (a peek can sit over a maximized session). No-op when no peek is open, so
// normal ESC handling is untouched.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _peek) {
    e.preventDefault();
    e.stopImmediatePropagation();
    closePeek(true);
  }
}, true);

// Dismiss on click-away. Capture phase so a click on a different pill closes this
// peek before that pill's bubble-phase handler opens its own.
document.addEventListener('click', (e) => {
  if (!_peek) return;
  if (_peek.tray.contains(e.target) || _peek.pill.contains(e.target)) return;
  closePeek();
}, true);

// A scroll or window resize invalidates the anchored position, so dismiss rather
// than chase it.
window.addEventListener('resize', () => closePeek());
window.addEventListener('blur', () => closePeek());
minimizedBar.addEventListener('scroll', () => closePeek());
