// ── Session card module ───────────────────────────────────────
// Owns session card DOM lifecycle, terminal setup, and per-session state.

// Vite alias — resolves to shared/states.esm.js
import { BADGE_LABELS, KILLABLE_STATES, RESTARTABLE_STATES, STATE_GLYPHS, STATES } from '/shared/states.mjs';
import { playAlertSound } from '../alert-sound.js';
import { sendControlMsg } from '../control-ws.js';
import { el } from '../dom-helpers.js';
import { getSoundId, isMinimized, isSoundEnabled } from '../ui-prefs.js';
import { computeAggregate } from './aggregate-core.mjs';
import { buildCardDOM, closeDebugOverlay, makeBadge, openDebugOverlay, setDebugMode, showConfirmDialog, startInlineRename } from './card-dom.js';
import { aggregateEl, consumeLocalReorderPending, container, minimizedBar, sessionUIs } from './card-registry.js';
// Load-bearing import: evaluating drag-drop.js installs the container-level
// dragover/dragleave/drop listeners and the _dropZone side effects at module load.
import { setupDragAndDrop } from './drag-drop.js';
import { _performExpand, enforceSplitOnCreate, exitMaximizeMode, forgetSessionLayout, getMaximizedSession, isMaximizeActive, SLEEP_ELIGIBLE, sleepSession, toggleMaximize, toggleMinimize, wakeSession } from './layout.js';
import { ensureTerminalSetup, setTerminalCursorBlink, setupTerminal, wireTerminalIO } from './terminal.js';
import { releaseWebgl, tryLoadWebGL } from './webgl-pool.js';

// ── Constants ────────────────────────────────────────────────


// Aggregate roll-up glyphs keyed by severity. Shape varies per severity so the
// header summary stays legible without relying on hue (color-blind safe); the
// text spells it out regardless. Neutral/running use the brand forward-marker.
const AGGREGATE_GLYPHS = {
  critical: '✕', // failed
  warning:  '▲', // needs input
  done:     '✓', // finished / exited
  success:  '▸', // running
  '':       '▸', // neutral / dormant
};

// Last rendered aggregate summary — gates DOM writes + the aria-live re-announce.
let _lastAggregateText = null;
let _lastAggregateSeverity = null;

// ── State ────────────────────────────────────────────────────

// sessionUIs now lives in ./session-card/card-registry.js (imported above).

// ── DOM refs ─────────────────────────────────────────────────

// container, minimizedBar and aggregateEl now live in ./session-card/card-registry.js.

// ── Helpers (private) ────────────────────────────────────────

// WebGL context pool (releaseWebgl, tryLoadWebGL, the LRU cap) moved to
// ./session-card/webgl-pool.js.
// OSC-52 clipboard (decodeOsc52Payload, reportClipboardFailure) and the data
// WebSocket (connectDataWs, reconnectDataWs) moved to ./session-card/terminal.js.

function updateButtonVisibility(ui) {
  const state = ui.currentState;
  const canRestart = KILLABLE_STATES.includes(state) || RESTARTABLE_STATES.includes(state);
  ui.btnRestart.classList.toggle('visible', canRestart);
  // Rename and Remove are always available
  ui.btnRename.classList.add('visible');
  ui.btnRemove.classList.add('visible');
}

// ── Card event wiring ────────────────────────────────────────

// All closures capture sessionId (stable UUID). For mutable display name,
// read ui.card.dataset.session which is updated on rename.
function wireCardEvents(ui, sessionId) {
  ui.btnRename.addEventListener('click', () => {
    ui.overflowMenu.classList.remove('open');
    startInlineRename(ui, sessionId);
  });

  ui.nameEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    startInlineRename(ui, sessionId);
  });

  ui.btnRestart.addEventListener('click', () => {
    ui.overflowMenu.classList.remove('open');
    const type = KILLABLE_STATES.includes(ui.currentState) ? 'force-restart' : 'restart';
    sendControlMsg({ type, id: sessionId });
  });

  ui.btnRemove.addEventListener('click', () => {
    ui.overflowMenu.classList.remove('open');
    showConfirmDialog({
      title: 'Remove Session',
      message: `Remove session "${ui.card.dataset.session}"?`,
      confirmLabel: 'Remove',
      onConfirm: () => sendControlMsg({ type: 'remove-session', id: sessionId }),
    });
  });

  ui.btnOverflow.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const [, other] of sessionUIs) {
      if (other !== ui) {
        other.overflowMenu.classList.remove('open');
        other.btnOverflow.setAttribute('aria-expanded', 'false');
      }
    }
    const nowOpen = ui.overflowMenu.classList.toggle('open');
    ui.btnOverflow.setAttribute('aria-expanded', String(nowOpen));
  });

  document.addEventListener('click', (e) => {
    if (!ui.overflowMenu.contains(e.target) && e.target !== ui.btnOverflow) {
      ui.overflowMenu.classList.remove('open');
      ui.btnOverflow.setAttribute('aria-expanded', 'false');
    }
  }, { signal: ui.abortController.signal });

  ui.termWrap.addEventListener('mousedown', () => {
    if (ui.currentState === STATES.WAITING || ui.currentState === STATES.COMPLETE) {
      sendControlMsg({ type: 'dismiss', id: sessionId });
    }
  });

  ui.btnMaximize.addEventListener('click', () => {
    toggleMaximize(sessionId);
  });

  ui.btnDebug.addEventListener('click', (e) => {
    e.stopPropagation();
    openDebugOverlay(ui, sessionId);
  });

  // Close debug overlay on click outside the card
  document.addEventListener('click', (e) => {
    if (ui.debugOpen && !ui.card.contains(e.target)) {
      closeDebugOverlay(ui);
    }
  }, { signal: ui.abortController.signal });
}

// ── Public API ────────────────────────────────────────────────
// All public functions accept session `id` (stable UUID).

export function hasSession(id) {
  return sessionUIs.has(id);
}

export function getSessionCount() {
  return sessionUIs.size;
}

export function applyTerminalSettings(settings) {
  if (settings.cursorBlink != null) setTerminalCursorBlink(settings.cursorBlink);
  if (settings.debugMode != null) {
    setDebugMode(settings.debugMode);
  }
  for (const [, ui] of sessionUIs) {
    if (!ui.term) continue;
    if (settings.cursorBlink != null) ui.term.options.cursorBlink = settings.cursorBlink;
  }
}

export function updateAggregateStatus() {
  let waiting = 0, failed = 0, done = 0, complete = 0, dormant = 0, total = 0;

  for (const [, ui] of sessionUIs) {
    total++;
    const state = ui.currentState;
    if (state === STATES.WAITING) waiting++;
    else if (state === STATES.FAILED) failed++;
    else if (state === STATES.DONE) done++;
    else if (state === STATES.COMPLETE) complete++;
    else if (state === STATES.DORMANT) dormant++;
  }

  const { text, severity, alertCount } = computeAggregate({ waiting, failed, done, complete, dormant, total });

  // Only rewrite the DOM (and re-announce via aria-live) when the summary
  // actually changed — avoids spamming assistive tech on every state tick.
  if (text !== _lastAggregateText || severity !== _lastAggregateSeverity) {
    _lastAggregateText = text;
    _lastAggregateSeverity = severity;
    aggregateEl.dataset.severity = severity;
    aggregateEl.textContent = '';
    if (text) {
      const glyph = el('span', 'aggregate-glyph', AGGREGATE_GLYPHS[severity] ?? AGGREGATE_GLYPHS['']);
      glyph.setAttribute('aria-hidden', 'true');
      aggregateEl.append(glyph, document.createTextNode(text));
    }
  }

  document.title = alertCount > 0 ? `(${alertCount}) Glissa` : 'Glissa';
}

export function createSessionCard(sessionId, sessionName, initialState, options = {}) {
  const state = initialState || STATES.DORMANT;
  const dom = buildCardDOM(sessionId, sessionName, state, options);
  setupDragAndDrop(dom.card, dom.header, dom.btnMinimize, sessionId);

  const isDormant = state === STATES.DORMANT;

  // Dormant cards live in the minimized bar with no terminal and no data WS
  // until the user expands them, which sends start-session and triggers spawn.
  if (isDormant) {
    dom.card.classList.add('minimized');
    dom.btnMinimize.textContent = '▲';
    dom.btnMinimize.title = 'Start session';
    dom.btnMinimize.setAttribute('aria-label', 'Start session');
    minimizedBar.appendChild(dom.card);
  } else {
    container.appendChild(dom.card);
  }

  const ui = {
    term: null,
    fitAddon: null,
    webglAddon: null,
    needsWebGLReload: false,
    dataWs: null,
    card: dom.card,
    badge: dom.badge,
    nameEl: dom.nameEl,
    btnMinimize: dom.btnMinimize,
    btnMaximize: dom.btnMaximize,
    btnOverflow: dom.btnOverflow,
    overflowMenu: dom.overflowMenu,
    termWrap: dom.termWrap,
    btnDebug: dom.btnDebug,
    btnRename: dom.btnRename,
    btnRestart: dom.btnRestart,
    btnRemove: dom.btnRemove,
    debugOverlay: null,
    debugOpen: false,
    abortController: new AbortController(),
    currentState: state,
    sleeping: false,
  };
  sessionUIs.set(sessionId, ui);

  wireCardEvents(ui, sessionId);
  updateButtonVisibility(ui);

  if (!isDormant) {
    setupTerminal(dom.termWrap, ui);
    wireTerminalIO(ui, sessionId);

    // Restore minimized state from localStorage
    if (isMinimized(sessionId)) toggleMinimize(sessionId);

    // In split mode, auto-minimize if already at limit (C2: encapsulated in layout.js)
    enforceSplitOnCreate(sessionId, ui);
  }

  updateAggregateStatus();
  return ui;
}

// Toggle the linked-worktree marker on an existing card without recreating it
// (driven by the server's session-git delta on the health tick).
export function setSessionWorktree(sessionId, worktree) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  if (worktree) ui.card.dataset.worktree = '';
  else delete ui.card.dataset.worktree;
}

export function renameSessionCard(sessionId, newName) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  // Only update the display name — id stays the same, no re-keying needed
  ui.card.dataset.session = newName;
  ui.nameEl.textContent = newName;
}

// Bring a session's card into view and put the cursor in its terminal. Used when an action taken
// elsewhere (e.g. starting guided team setup from the Teams view) spawns a session the operator is
// expected to answer in, so focus lands on it instead of nothing visibly happening. Focus is
// best-effort: a card with no live terminal (dormant/never-started) is revealed but not typed into.
export function focusSessionCard(sessionId) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return false;

  // Maximize mode hides every other card, so a different maximized session would keep the target
  // invisible — exit it so focus actually reveals the target.
  if (isMaximizeActive() && getMaximizedSession() !== sessionId) exitMaximizeMode();

  // Restore a minimized card with the non-toggling primitive: unlike toggleMinimize it never spawns
  // a dormant PTY or evicts a split pane as a side effect of focusing.
  if (ui.card.classList.contains('minimized')) _performExpand(sessionId, ui);

  // Scroll + one-shot accent flash + cursor, deferred via the same double-rAF restart idiom as
  // completion-flash: a repeat focus replays the animation, and layout settles after any expand
  // before we measure the scroll target or grab the cursor.
  ui.card.classList.remove('focus-flash');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      ui.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      ui.card.classList.add('focus-flash');
      ui.card.addEventListener('animationend', () => ui.card.classList.remove('focus-flash'), { once: true });
      if (ui.term) ui.term.focus();
    });
  });
  return true;
}

export function removeSessionCard(sessionId) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;

  closeDebugOverlay(ui);
  sessionUIs.delete(sessionId);
  if (getMaximizedSession() === sessionId) exitMaximizeMode();
  forgetSessionLayout(sessionId);

  if (ui.resizeObserver) ui.resizeObserver.disconnect();
  if (ui.abortController) ui.abortController.abort();
  if (ui.dataWs?.readyState <= WebSocket.OPEN) ui.dataWs.close();
  releaseWebgl(ui);
  if (ui.term) ui.term.dispose();
  if (ui.card) ui.card.remove();
  updateAggregateStatus();
}

function _handleEndedTransition(ui, wasActive, state) {
  if (!wasActive || !ui.term) return;
  ui.term.clear();
  ui.term.reset();
  const label = state === STATES.DONE ? 'Session complete' : 'Session failed';
  const color = state === STATES.DONE ? '\x1b[34m' : '\x1b[31m';
  ui.term.write(`\r\n\x1b[2m${color}  ${label}\x1b[0m\r\n\r\n\x1b[2m  Press Restart to start a new session.\x1b[0m\r\n`);
}

function _handleRestartTransition(ui, prevState) {
  if (!ui.term) return;
  if (prevState === STATES.DONE || prevState === STATES.FAILED) {
    ui.term.clear();
    ui.term.reset();
  }
}

export function applyState(sessionId, state) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;

  const prevState = ui.currentState;
  ui.currentState = state;

  // Leaving DORMANT: lazy-set up the terminal and promote the card from
  // the minimized bar to the main grid (if not already done optimistically).
  if (prevState === STATES.DORMANT && state !== STATES.DORMANT) {
    ensureTerminalSetup(ui, sessionId);
    if (ui.card.classList.contains('minimized')) {
      _performExpand(sessionId, ui);
    }
  }

  // Preserve the glyph span; only update its text and the sibling label text node.
  ui.badge.dataset.state = state;
  const glyphSpan = ui.badge.querySelector('.state-glyph');
  if (glyphSpan) {
    glyphSpan.textContent = STATE_GLYPHS[state] || '';
    const labelNode = glyphSpan.nextSibling;
    if (labelNode && labelNode.nodeType === Node.TEXT_NODE) {
      labelNode.nodeValue = BADGE_LABELS[state] || state;
    } else {
      ui.badge.appendChild(document.createTextNode(BADGE_LABELS[state] || state));
    }
  } else {
    // Fallback: no glyph present (unexpected) — rebuild in place preserving classes
    const fresh = makeBadge(state);
    fresh.classList.add('session-badge');
    ui.badge.replaceWith(fresh);
    ui.badge = fresh;
  }
  ui.card.dataset.state = state;

  updateButtonVisibility(ui);

  if (state === STATES.WAITING && prevState !== STATES.WAITING) {
    if (isSoundEnabled()) playAlertSound(getSoundId());
  }

  const isEnding = state === STATES.DONE || state === STATES.FAILED;
  const wasActive = prevState !== STATES.DONE && prevState !== STATES.FAILED && prevState !== STATES.INITIALIZING;
  if (isEnding && wasActive) {
    ui.card.classList.remove('completion-flash');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ui.card.classList.add('completion-flash');
        ui.card.addEventListener('animationend', () => ui.card.classList.remove('completion-flash'), { once: true });
      });
    });
    if (isSoundEnabled()) playAlertSound(getSoundId());
  }

  if (state === STATES.DONE || state === STATES.FAILED) {
    _handleEndedTransition(ui, wasActive, state);
  }

  if (state === STATES.INITIALIZING) {
    _handleRestartTransition(ui, prevState);
  }

  updateAggregateStatus();

  // Auto-wake: sleeping session received a non-sleep-eligible state (server
  // rejected sleep or transitioned back to active before sleep arrived).
  // Resync client by recreating terminal + data WS.
  if (ui.sleeping && !SLEEP_ELIGIBLE.includes(state)) {
    wakeSession(sessionId);
  }

  // Auto-sleep: minimized session just entered a sleep-eligible state
  if (!ui.sleeping
      && ui.card.classList.contains('minimized')
      && SLEEP_ELIGIBLE.includes(state)) {
    sleepSession(sessionId);
  }
}

export function handleSessionsReordered(order) {
  if (consumeLocalReorderPending()) {
    return;
  }

  for (const id of order) {
    const ui = sessionUIs.get(id);
    if (!ui?.card) continue;
    if (ui.card.classList.contains('minimized')) {
      minimizedBar.appendChild(ui.card);
    } else {
      container.appendChild(ui.card);
    }
  }
  for (const [, ui] of sessionUIs) {
    if (ui.card.classList.contains('minimized')) {
      ui.needsWebGLReload = true;
    } else {
      tryLoadWebGL(ui);
    }
  }
}

