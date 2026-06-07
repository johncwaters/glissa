// Minimized-session rail: the bottom dock of status pills. This module owns
// everything the rail does beyond the pure CSS in style.css:
//
//   - A MutationObserver on the minimized bar that keeps each pill's a11y chrome
//     (role=button, roving tabindex) correct as cards enter/leave the bar.
//   - A 1s interval that ticks each session's "time in current state" readout (the rail pill
//     and, since the clock is shared, the grid header badge) and derives each working session's
//     heartbeat quiet flag from its last-output timestamp (so activity.js needs no own timer).
//   - Click / keyboard (arrows, Home/End, Enter/Space) interaction: activating a
//     pill RESTORES its session back to the grid.
//
// Dependency direction is one-way (rail -> layout/terminal/registry); layout.js
// never imports rail.js, so there is no cycle. lifecycle.js imports this module
// purely to evaluate it (the listeners below install at module load, mirroring
// drag-drop.js) and to call refreshPill.

import { BADGE_LABELS, STATES } from '/shared/states.mjs';
import { refreshSessionActivity } from './activity.js';
import { minimizedBar, sessionUIs } from './card-registry.js';
import { toggleMinimize } from './layout.js';
import { forceTerminalRepaint } from './terminal.js';

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

// The pill's time-in-state text, or '' for settled states (which show no timer).
function pillElapsed(ui) {
  return showsElapsed(ui.currentState) ? fmtElapsed(Date.now() - (ui.stateSince || Date.now())) : '';
}

// ── Pill chrome (a11y) ───────────────────────────────────────

function applyPillChrome(card) {
  card.setAttribute('role', 'button');
  if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '-1');
}

function clearPillChrome(card) {
  card.removeAttribute('role');
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
  // The time-in-state clock is shared by the grid header badge and the rail pill, so set it
  // before the minimized gate; on the grid that is the only thing this refresh touches.
  if (ui.railElapsed) ui.railElapsed.textContent = pillElapsed(ui);
  if (!card.classList.contains('minimized')) return;
  const label = BADGE_LABELS[ui.currentState] || ui.currentState;
  card.setAttribute('aria-label', `${card.dataset.session}: ${label}`);
}

// ── Restore ──────────────────────────────────────────────────

// Activating a pill restores its session back to the grid. (The old fly-up peek
// tray was removed; a minimized pill is now a plain restore button.)
function restoreSession(id) {
  toggleMinimize(id);
  // toggleMinimize's inline expand does not repaint; force one so the restored
  // terminal redraws cleanly after the reparent.
  const ui = sessionUIs.get(id);
  if (ui) forceTerminalRepaint(ui);
}

// ── Roving focus ─────────────────────────────────────────────

function focusPillAt(pills, n) {
  pills.forEach((p, i) => p.setAttribute('tabindex', i === n ? '0' : '-1'));
  pills[n].focus();
}

// ── Wiring (installs at module load) ─────────────────────────

// Pill a11y + roving, driven by the bar's composition.
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
      }
    }
  }
  normalizeRoving();
});
observer.observe(minimizedBar, { childList: true });

// The shared 1s session tick: refresh the time-in-state clock (grid header badge and rail pill
// alike) and derive each working session's quiet flag from its last-output timestamp - one place
// to poll, so the heartbeat needs no per-session timer. Cheap: a handful of sessions, a couple of
// writes each, both no-ops when nothing changed.
setInterval(() => {
  for (const [, ui] of sessionUIs) {
    if (ui.railElapsed) ui.railElapsed.textContent = pillElapsed(ui);
    refreshSessionActivity(ui);
  }
}, 1000);

// Click a pill (not a drag, which fires no click) to restore its session.
minimizedBar.addEventListener('click', (e) => {
  const card = e.target.closest('.session-card');
  if (!card || !minimizedBar.contains(card)) return;
  if (e.target.closest('.session-actions')) return; // hidden on the pill, but be safe
  restoreSession(card.dataset.id);
});

// Keyboard: arrows/Home/End move the roving focus; Enter/Space restore.
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
    restoreSession(card.dataset.id);
  }
});
