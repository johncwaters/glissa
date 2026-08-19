// ── Session card module ───────────────────────────────────────
// Owns session card DOM lifecycle, terminal setup, and per-session state.

// Vite alias - resolves to shared/states.esm.js
import { KILLABLE_STATES, RESTARTABLE_STATES, STATES } from '/shared/states.mjs';
import { playAlertSound } from '../alert-sound.js';
import { sendControlMsg } from '../control-ws.js';
import { el } from '../dom-helpers.js';
import { setHealthMonitorVisible } from '../health-monitor.js';
import { seedReviewMergeStatus, setReviewDiff, setReviewMergeStatus } from '../sidebar/review-sidebar.js';
import { setSelectedId } from '../sidebar/selection.js';
import { getSoundId, isSoundEnabled } from '../ui-prefs.js';
import { sessionChipText } from '../usage-view-core.mjs';
import { setRunningActivity } from './activity.js';
import { computeAggregate } from './aggregate-core.mjs';
import { buildCardDOM, closeDebugOverlay, isRenameInProgress, openDebugOverlay, setDebugMode, showConfirmDialog, startInlineRename } from './card-dom.js';
import { aggregateEl, container, sessionUIs } from './card-registry.js';
import { stalePackNames } from './pack-stale-core.mjs';
import { openResumeDialog } from './resume-dialog.js';
// Load-bearing import: evaluating session-tick.js installs the shared 1s tick (elapsed clock +
// working-heartbeat poll) at module load.
import { refreshElapsed } from './session-tick.js';
import { ensureTerminalSetup, setTerminalCursorBlink, setupTerminal, wireTerminalIO } from './terminal.js';
import { releaseWebgl } from './webgl-pool.js';

// ── Constants ────────────────────────────────────────────────


// Aggregate roll-up glyphs keyed by severity. Shape varies per severity so the
// header summary stays legible without relying on hue (color-blind safe); the
// text spells it out regardless. Neutral/dormant use the brand forward-marker.
const AGGREGATE_GLYPHS = {
  critical: '✕', // failed
  warning:  '▲', // needs input
  done:     '✓', // finished / exited
  '':       '▸', // neutral / dormant
};

// Last rendered aggregate summary - gates DOM writes + the aria-live re-announce.
let _lastAggregateText = null;
let _lastAggregateSeverity = null;

// Latest built version per context pack (server-wide, not per session): the baseline each card's
// delivered versions are judged against. See setLatestPackVersions / pack-stale-core.mjs.
const latestPackVersions = new Map();

// ── State ────────────────────────────────────────────────────

// sessionUIs now lives in ./session-card/card-registry.js (imported above).

// ── DOM refs ─────────────────────────────────────────────────

// container and aggregateEl now live in ./session-card/card-registry.js.

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

function closeOverflowMenu(ui) {
  ui.overflowMenu.classList.remove('open');
  ui.btnOverflow.setAttribute('aria-expanded', 'false');
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

  // Click a session's name to select it for the review sidebar (single-click; double-click still renames).
  // Ignored while the inline rename input is open so typing/clicking the field never re-selects.
  ui.nameEl.addEventListener('click', () => {
    if (isRenameInProgress(ui.nameEl)) return;
    setSelectedId(sessionId);
  });

  ui.btnRestart.addEventListener('click', () => {
    ui.overflowMenu.classList.remove('open');
    const type = KILLABLE_STATES.includes(ui.currentState) ? 'force-restart' : 'restart';
    sendControlMsg({ type, id: sessionId });
  });

  ui.btnResume.addEventListener('click', () => {
    ui.overflowMenu.classList.remove('open');
    openResumeDialog(sessionId, { currentState: ui.currentState });
  });

  ui.btnRemove.addEventListener('click', () => {
    ui.overflowMenu.classList.remove('open');
    const name = ui.card.dataset.session;
    // Warn before discarding a worktree that still holds unmerged work (pending-review / parked):
    // removing the session throws it away, so give the operator a chance to merge/review first.
    const merge = ui.card.dataset.merge;
    const unmerged = merge === 'pending-review' || merge === 'parked';
    showConfirmDialog({
      title: 'Remove Session',
      message: unmerged
        ? `"${name}" has unmerged worktree changes that will be permanently discarded if you remove it. Merge or review them first to keep them. Remove anyway?`
        : `Remove session "${name}"?`,
      confirmLabel: unmerged ? 'Discard & Remove' : 'Remove',
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
      closeOverflowMenu(ui);
    }
  }, { signal: ui.abortController.signal });

  ui.termWrap.addEventListener('mousedown', () => {
    if (ui.currentState === STATES.WAITING || ui.currentState === STATES.COMPLETE) {
      sendControlMsg({ type: 'dismiss', id: sessionId });
    }
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
    setHealthMonitorVisible(settings.debugMode);
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
    if (state === STATES.WAITING) { waiting++; continue; }
    if (state === STATES.FAILED) { failed++; continue; }
    if (state === STATES.DONE) { done++; continue; }
    if (state === STATES.COMPLETE) { complete++; continue; }
    if (state === STATES.DORMANT) dormant++;
  }

  const { text, severity, alertCount } = computeAggregate({ waiting, failed, done, complete, dormant, total });

  // Only rewrite the DOM (and re-announce via aria-live) when the summary
  // actually changed - avoids spamming assistive tech on every state tick.
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

  const isDormant = state === STATES.DORMANT;

  // Dormant cards have no terminal or data WS until started (via the Focus rail pill, which sends
  // start-session). The card lives in the off-screen grid home; Focus borrows it into the center on focus.
  container.appendChild(dom.card);

  const ui = {
    term: null,
    fitAddon: null,
    webglAddon: null,
    needsWebGLReload: false,
    dataWs: null,
    card: dom.card,
    nameEl: dom.nameEl,
    elapsedEl: dom.elapsedEl,
    // Project root (for the Focus rail's project grouping). '' when unknown -> the rail's (no path) group.
    path: options.path || '',
    // Wall-clock of the latest state entry; session-tick.js renders "time in this state".
    stateSince: Date.now(),
    btnOverflow: dom.btnOverflow,
    overflowMenu: dom.overflowMenu,
    termWrap: dom.termWrap,
    btnDebug: dom.btnDebug,
    btnRename: dom.btnRename,
    btnRestart: dom.btnRestart,
    btnResume: dom.btnResume,
    btnRemove: dom.btnRemove,
    debugOverlay: null,
    debugOpen: false,
    abortController: new AbortController(),
    currentState: state,
  };
  sessionUIs.set(sessionId, ui);

  wireCardEvents(ui, sessionId);
  updateButtonVisibility(ui);

  // A card that loads already RUNNING (snapshot reconnect) arms the heartbeat now, so it goes
  // quiet on silence even before the first replayed chunk; applyState handles later transitions.
  if (state === STATES.RUNNING) setRunningActivity(ui, true);

  if (!isDormant) {
    setupTerminal(dom.termWrap, ui);
    wireTerminalIO(ui, sessionId);
  }

  updateAggregateStatus();
  return ui;
}

// Store the effective base branch name (display form, e.g. "main") on the ui object so the
// review sidebar can read it without a separate lookup. Updated on every snapshot.
export function setSessionEffectiveBase(sessionId, base) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  ui.effectiveBase = base;
}

// Toggle the linked-worktree marker on an existing card without recreating it
// (driven by the server's session-git delta on the health tick).
export function setSessionWorktree(sessionId, worktree) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  if (worktree) { ui.card.dataset.worktree = ''; return; }
  delete ui.card.dataset.worktree;
}

// Toggle the "resumed" marker on a card (driven by the server's session-resume delta and the snapshot's
// resumeSessionId). Marks that the card is bound to a saved conversation it will resume on next start.
export function setSessionResume(sessionId, resumeSessionId) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  if (resumeSessionId) { ui.card.dataset.resume = ''; return; }
  delete ui.card.dataset.resume;
}

// Reflect the live background sub-agent count on the card. n > 0 shows an "N agents" chip and sets
// data-agents (drives the CSS, mirroring data-worktree); 0 hides it. This is why a card can stay
// Working after the main turn's Stop: background sub-agents are still running (see backend
// session-agents delta / sessions.js _trackSubagent).
export function setSessionAgents(sessionId, activeAgents) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  const n = Math.max(0, Number(activeAgents) || 0);
  ui.activeAgents = n;
  const badge = ui.card.querySelector('.agents-badge');
  if (n > 0) {
    ui.card.dataset.agents = String(n);
    if (badge) badge.textContent = n === 1 ? '1 agent' : `${n} agents`;
    return;
  }
  delete ui.card.dataset.agents;
  if (badge) badge.textContent = '';
}

// Reflect the context packs a session was spawned against, and whether the mill has rebuilt any of
// them since. The delivered versions ride the snapshot (sessions[].packs); the latest versions come
// from the same snapshot's packVersions plus every later pack-updated broadcast, so both sides are
// kept here and the chip is recomputed whenever either moves. Advisory only: a stale pack still
// works, it is just older context than a fresh spawn would get.
export function setSessionPacks(sessionId, packs) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  ui.packs = Array.isArray(packs) ? packs : [];
  applyPackStaleness(ui);
}

// Latest built version per pack name, replaced wholesale by a snapshot and patched by each
// pack-updated broadcast.
export function setLatestPackVersions(versions) {
  latestPackVersions.clear();
  for (const [name, version] of Object.entries(versions || {})) latestPackVersions.set(name, version);
  refreshPackStaleness();
}

export function notePackVersion(name, version) {
  if (typeof name !== 'string' || typeof version !== 'string') return;
  latestPackVersions.set(name, version);
  refreshPackStaleness();
}

// One line of read telemetry per delivered pack: "name: N reads" (plus the count since the staleness
// notice, once one has been injected). Server-side counters, so a pack never read reads as 0.
function packReadsText(packs) {
  const rows = (Array.isArray(packs) ? packs : []).map((pack) => {
    const reads = Number(pack.reads) || 0;
    const since = pack.readsSinceNotice == null ? '' : `, ${Number(pack.readsSinceNotice) || 0} since notice`;
    return `${pack.name}: ${reads} ${reads === 1 ? 'read' : 'reads'}${since}`;
  });
  return `Reads by this session: ${rows.join('; ')}`;
}

function applyPackStaleness(ui) {
  const stale = stalePackNames(ui.packs, latestPackVersions);
  const badge = ui.card.querySelector('.pack-badge');
  if (stale.length === 0) {
    delete ui.card.dataset.packStale;
    if (badge) badge.title = '';
    return;
  }
  ui.card.dataset.packStale = '';
  // Reads ride the same tooltip rather than a chip of their own: "rebuilt, and this session read it
  // N times" is one thought, and the chip only renders while a pack is stale anyway.
  if (badge) badge.title = `Rebuilt since this session started: ${stale.join(', ')}. Restart it to pick up the new context.\n${packReadsText(ui.packs)}`;
}

function refreshPackStaleness() {
  for (const [, ui] of sessionUIs) applyPackStaleness(ui);
}

// Reflect this conversation's token spend on the card (server usage-sessions delta). `usage` is
// { tokens, costUSD } or null; sets data-usage and a short chip so the operator sees what the turn cost
// without opening the Usage tab. Estimated list-price arithmetic, never a bill; advisory only, and
// hidden entirely until the scanner has attributed something to this card (mirrors setSessionAgents).
export function setSessionUsage(sessionId, usage) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  const badge = ui.card.querySelector('.usage-badge');
  const text = sessionChipText(usage);
  if (!text) {
    delete ui.card.dataset.usage;
    if (badge) badge.textContent = '';
    return;
  }
  ui.card.dataset.usage = '';
  if (badge) badge.textContent = text;
}

// Reflect the advisory pending-prompt-kind on the card (server session-prompt delta / snapshot
// pendingPromptKind). `kind` is null | 'permission' | 'elicitation'; sets data-prompt and a short
// badge label so a WAITING card shows WHAT it is waiting on. Never gates anything (mirrors
// setSessionAgents).
export function setSessionPrompt(sessionId, kind) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  const badge = ui.card.querySelector('.prompt-badge');
  if (!kind) {
    delete ui.card.dataset.prompt;
    if (badge) badge.textContent = '';
    return;
  }
  ui.card.dataset.prompt = kind;
  if (!badge) return;
  badge.textContent = kind === 'permission' ? 'permission' : 'input';
}

// "sleeping until ~HH:MM" (one-shot with a fire time) or "scheduled" (cron, no time computed).
// Approximate by design: recurring tasks fire with up to 30 minutes of jitter.
function formatWakeupChip(at) {
  if (!at) return 'scheduled';
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `sleeping until ~${hh}:${mm}`;
}

// Reflect a pending scheduled revival on the card. `wakeup` is { at, kind, reason } or null
// (server session-wakeup delta / snapshot pendingWakeup; sessions.js _trackWakeup). Advisory
// only: the session genuinely finished its turn; the chip just says it will revive itself.
export function setSessionWakeup(sessionId, wakeup) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  const badge = ui.card.querySelector('.wakeup-badge');
  if (!wakeup) {
    delete ui.card.dataset.wakeup;
    if (badge) {
      badge.textContent = '';
      badge.title = '';
    }
    return;
  }
  ui.card.dataset.wakeup = wakeup.kind || 'wakeup';
  if (!badge) return;
  badge.textContent = formatWakeupChip(wakeup.at);
  badge.title = wakeup.reason ? `Scheduled revival: ${wakeup.reason}` : 'Scheduled revival pending';
}

// Reflect a post-turn-check result on the card. `report` is the server broadcast
// (filesFixed, mode, findings[], skipped). Shows a count badge when files were
// fixed (mode 'fix') or flagged (mode 'report'); hidden otherwise. The card's
// data-pt attribute drives the CSS, mirroring data-worktree.
export function setSessionPostTurn(sessionId, report) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  const badge = ui.card.querySelector('.post-turn-badge');
  if (!badge) return;
  const r = report || {};
  const findings = Array.isArray(r.findings) ? r.findings : [];
  const fixed = r.filesFixed || 0;
  let kind = null;
  let count = 0;
  if (!r.skipped && r.mode === 'fix' && fixed > 0) {
    kind = 'fixed';
    count = fixed;
  }
  if (!r.skipped && r.mode === 'report' && findings.length > 0) {
    kind = 'flagged';
    count = new Set(findings.map((f) => f.file)).size;
  }
  if (!kind) {
    delete ui.card.dataset.pt;
    badge.textContent = '';
    badge.removeAttribute('title');
    return;
  }
  ui.card.dataset.pt = kind;
  const glyph = kind === 'fixed' ? '✓' : '⚠'; // check mark / warning sign
  badge.textContent = `${glyph} ${count}`;
  const perRule = {};
  for (const f of findings) perRule[f.rule] = (perRule[f.rule] || 0) + (f.count || 0);
  const detail = Object.keys(perRule).map((k) => `${k}: ${perRule[k]}`).join(', ');
  const verb = kind === 'fixed' ? 'auto-fixed' : 'flagged';
  badge.title = `Post-turn ${verb} ${count} file(s)${detail ? ` (${detail})` : ''}`;
}

// Reflect the worktree merge lifecycle. `mergeStatus` is the server's session-merge-status
// (none|pending-review|merging|parked|merged). The review UI itself (diff + Merge / Discard)
// now lives in the right review sidebar; here we only keep data-merge on the card so the remove button
// can warn before discarding unmerged work, and forward the status to the sidebar.
// Shared by setSessionMergeStatus and seedSessionMergeStatus: set the card's data-merge for an
// unmerged status, clear it otherwise.
function applyMergeDataset(card, ms) {
  if (ms === 'pending-review' || ms === 'parked' || ms === 'merging') { card.dataset.merge = ms; return; }
  delete card.dataset.merge;
}

export function setSessionMergeStatus(sessionId, mergeStatus) {
  const ui = sessionUIs.get(sessionId);
  const ms = mergeStatus || 'none';
  if (ui) applyMergeDataset(ui.card, ms);
  setReviewMergeStatus(sessionId, ms);
}

// Snapshot hydration: set the card's data-merge (remove-warning) and seed the sidebar quietly (count +
// render), WITHOUT auto-opening the panel. Used on (re)connect so a pending-review session is reflected
// immediately instead of only after the next live broadcast.
export function seedSessionMergeStatus(sessionId, mergeStatus) {
  const ui = sessionUIs.get(sessionId);
  const ms = mergeStatus || 'none';
  if (ui) applyMergeDataset(ui.card, ms);
  seedReviewMergeStatus(sessionId, ms);
}

// Forward a session's diff payload ({ committed, uncommitted, hasCommits }, reply to
// request-session-diff) to the review sidebar, which renders it.
export function setSessionDiff(sessionId, payload) {
  setReviewDiff(sessionId, payload);
}

export function renameSessionCard(sessionId, newName) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;
  // Only update the display name - id stays the same, no re-keying needed
  ui.card.dataset.session = newName;
  ui.nameEl.textContent = newName;
}

export function removeSessionCard(sessionId) {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return;

  closeDebugOverlay(ui);
  sessionUIs.delete(sessionId);

  if (ui.resizeObserver) ui.resizeObserver.disconnect();
  if (ui.abortController) ui.abortController.abort();
  if (ui.dataWs?.readyState <= WebSocket.OPEN) ui.dataWs.close();
  releaseWebgl(ui);
  if (ui._repaintRafId != null) { cancelAnimationFrame(ui._repaintRafId); ui._repaintRafId = null; }
  if (ui.term) ui.term.dispose();
  // Null the disposed instance so still-pending RAF callbacks' `if (!ui.term)` guards actually skip it
  // (a disposed terminal is truthy, and refresh()/fit() on it throws inside the RAF).
  ui.term = null;
  ui.fitAddon = null;
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
  // Reset the time-in-state clock on a real transition so the elapsed readout measures the
  // current state, not the whole session age. The working heartbeat arms on entry to RUNNING
  // and tears down on exit (only real transitions, so a redundant RUNNING apply can't re-arm
  // the quiet countdown).
  if (state !== prevState) {
    ui.stateSince = Date.now();
    setRunningActivity(ui, state === STATES.RUNNING);
  }

  // Leaving DORMANT: lazy-set up the terminal (the card already lives in the off-screen grid home).
  if (prevState === STATES.DORMANT && state !== STATES.DORMANT) {
    ensureTerminalSetup(ui, sessionId);
  }

  // The status text is no longer shown in the card header (it lives on the Focus rail pill and the
  // toolbar accent strip); the card just carries data-state for the state-driven styling below.
  ui.card.dataset.state = state;

  updateButtonVisibility(ui);

  // Attention sound on the turn boundaries that want the operator: needs-input and turn-complete.
  // Process exit (DONE/FAILED) gets its own sound + completion-flash below. Without COMPLETE here a
  // finished turn was silent (only a focus-suppressible desktop toast fired server-side).
  if ((state === STATES.WAITING && prevState !== STATES.WAITING)
      || (state === STATES.COMPLETE && prevState !== STATES.COMPLETE)) {
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

  // Reset the elapsed readout immediately on a state change (the tick handles the per-second advance).
  refreshElapsed(ui);
}

