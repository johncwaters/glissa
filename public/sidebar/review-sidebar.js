// Right-docked review sidebar: the single home for the worktree review gate of the SELECTED session.
// Shows a changed-files summary over a collapsible per-file diff (each file minimized until clicked),
// plus the actions (Merge; Discard only for a settled worktree). "Merge" merges into the base branch
// and rebases the worktree onto it WITHOUT ending the session, so the operator commits as they go (the
// PTY effectively never dies, so there is no separate finish/close-out step). It REPLACES the old inline
// card review bar; the card now only carries data-merge for the remove-warning. The sidebar is app-level
// (spans every view via .app-body) on desktop, and the SAME element is re-parented into the phone
// Review screen (reparentReviewPanel), so both layouts share one review surface.
//
// Data flow: merge status arrives via setReviewMergeStatus (from the server's session-merge-status),
// the diff via setReviewDiff (reply to request-session-diff, asked on selection and on every server
// `session-changed` push via notifyWorktreeChanged). Session name/state are read live from the shared
// card registry. Pure parsing lives in diff-core.mjs.
//
// A separate, unrelated fact - whether the project's LOCAL base branch has drifted from
// its remote upstream - arrives via setReviewBranchSync (reply to request-branch-sync, asked on
// selection, or resync-branch, asked on a Resync click/Alt+R). Both requests reply with the same
// branch-sync-status message; a resync-branch reply additionally carries action/error, which is what
// tells the two apart client-side. This never touches the worktree merge gate above it.

import { MERGEABLE_LIVE_STATES, STATES } from '/shared/states.mjs';
import { sendControlMsg } from '../control-ws.js';
import { adoptElement, el, releaseElement } from '../dom-helpers.js';
import { sessionUIs } from '../session-card/card-registry.js';
import { openConfirmDialog } from '../session-card/modal.js';
import { getSidebarWidth, setSidebarWidth } from '../ui-prefs.js';
import { parseUnifiedDiff, shouldDropDiffCache, summarizeFiles } from './diff-core.mjs';
import {
  baseLabel,
  decideMergeAction,
  mergeActionTitle,
  mergeDisabledReason,
  mergeTargetText,
  parkedStatusText,
} from './review-copy-core.mjs';
import { getSelectedId, onSelectionChange, setSelectedId } from './selection.js';

const REVIEWABLE = new Set(['pending-review', 'parked']);
const MAX_FILE_LINES = 600; // per-file DOM line cap; beyond this a file collapses to a count with click-to-expand
const SIDEBAR_MIN = 260;    // resize bounds (px)
const SIDEBAR_MAX = 700;

const statusById = new Map(); // id -> mergeStatus ('none'|'pending-review'|'merging'|'parked'|'merged')
const reasonById = new Map();
const diffById = new Map();   // id -> { committed, uncommitted, hasCommits } (null until fetched)
// id -> branch-sync payload; null while a request is in flight, undefined if never requested.
const syncById = new Map();
// ids with a resync-branch request in flight (Resync button disabled; sibling status shows "Resyncing...").
const resyncingIds = new Set();
// Open/expanded keys are `${section}:${path}` so the SAME file appearing in both the committed and the
// uncommitted section collapses independently (default: every file minimized).
const openFiles = new Set();
const expanded = new Set();

/** @type {HTMLElement|null} */
let panelEl = null;
/** @type {HTMLElement|null} */
let branchSyncEl = null;
/** @type {HTMLElement|null} */
let controlsEl = null;
/** @type {HTMLElement|null} */
let bodyEl = null;
/** @type {HTMLElement|null} */
let sessionNameEl = null;
let resolveJustSent = false;
/** @type {string|null} */
let resolveJustSentFor = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let resolveSentTimer = null;
// Latest resync outcome, keyed to the session it came from: { forId, text, isError } | null. A success/
// diverged/in-sync result auto-fades (see applyResyncResult); an error persists until the next resync.
/** @type {{ forId: string, text: string, isError: boolean }|null} */
let resyncResult = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let resyncResultTimer = null;

// ── Mount ──
// The panel is built once and never rebuilt. On desktop it is docked in the body row; on a phone the
// SAME element is re-parented into the Review screen (see reparentReviewPanel below), so both layouts
// share one review surface with one set of caches and listeners rather than two implementations that
// could disagree. It has no close control in either layout: the desktop dock is permanent, and the
// phone screen is dismissed by the bottom nav like every other screen.

export function mountReviewSidebar({ panel }) {
  panelEl = panel;
  if (!panelEl) return;
  const mountedPanel = panelEl;

  const head = el('div', 'review-sidebar-head');
  const title = el('span', 'review-sidebar-title', 'Review');
  sessionNameEl = el('span', 'review-sidebar-session');
  head.append(title, sessionNameEl);

  // Local-base-branch-vs-remote-upstream indicator.
  // A project-level fact, not tied to the merge/review gate below it, so it is its own row (collapses
  // via :empty when nothing is selected/requested yet) rather than folded into review-controls.
  branchSyncEl = el('div', 'review-branch-sync');

  // Pinned control region between the title and the scrolling diff: status note + actions + a
  // why-disabled reason line. Always present while a session is selected (collapsed via :empty
  // otherwise), so Merge and the other controls never scroll out of reach inside a long diff.
  controlsEl = el('div', 'review-controls');
  bodyEl = el('div', 'review-sidebar-body');

  // Resize handle: drag left edge to widen, right to narrow. Width persisted via ui-prefs. Pointer
  // events (not mouse) with capture, so the drag survives the cursor leaving the 6px strip and a pen
  // or trackpad drives it identically; CSS hides the handle under [data-layout="phone"], where the
  // panel is a full-width screen and there is nothing to resize against.
  const handle = el('div', 'review-resize-handle');
  handle.setAttribute('aria-hidden', 'true');
  mountedPanel.append(head, branchSyncEl, controlsEl, bodyEl, handle);

  let dragStartX = 0, dragStartWidth = 0;

  const applyWidth = (px) => {
    const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, px));
    if (!Number.isFinite(w)) return null;
    mountedPanel.style.setProperty('--sidebar-width', `${w}px`);
    return w;
  };

  const onDrag = (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    applyWidth(dragStartWidth + (dragStartX - e.clientX)); // drag left = wider (sidebar is right-docked)
  };

  // Teardown runs from pointerup AND from lostpointercapture, which is the only signal for a capture
  // torn away by something other than a clean release (window blur mid-drag, the OS stealing the
  // pointer). Without it the col-resize cursor and the userSelect lock would stick on the whole
  // document. lostpointercapture also fires right after our own releasePointerCapture, so the guard
  // makes the second call a no-op rather than a double persist.
  let dragging = false;
  const stopDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    document.documentElement.style.cursor = '';
    document.documentElement.style.userSelect = '';
    const w = mountedPanel.style.getPropertyValue('--sidebar-width');
    if (w) setSidebarWidth(parseInt(w, 10));
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragStartX = e.clientX;
    dragStartWidth = mountedPanel.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    dragging = true;
    document.documentElement.style.cursor = 'col-resize';
    document.documentElement.style.userSelect = 'none';
  });
  handle.addEventListener('pointermove', onDrag);
  handle.addEventListener('pointerup', stopDrag);
  handle.addEventListener('pointercancel', stopDrag);
  handle.addEventListener('lostpointercapture', stopDrag);

  const storedWidth = getSidebarWidth();
  if (storedWidth !== null) applyWidth(storedWidth);

  onSelectionChange((id) => {
    // Per-session: don't carry one session's open/expanded files into the next (start minimized).
    openFiles.clear();
    expanded.clear();
    if (id) { requestDiff(id); requestBranchSync(id); }
    render();
  });

  render();
}

// The phone Review screen is just another mount target for this panel. Moving the built element (rather
// than rebuilding it there) is what makes the two layouts one review surface: the diff cache, the
// selection subscription, the resize preference and every listener travel with it. Pass null to put it
// back in its declared home in the body row.
export function reparentReviewPanel(parentEl) {
  if (!panelEl) return;
  if (parentEl) {
    adoptElement(panelEl, parentEl);
    return;
  }
  releaseElement(panelEl);
}

// ── External updates (from app.js message handlers) ──

// Record a status and refresh the count/render. The cached diff is dropped when the transition makes it
// stale (merge/discard, or a parked merge handed back as mergeable; see shouldDropDiffCache);
// 'merging'/'parked' keep the diff visible. The staleness check lives HERE (not in setReviewMergeStatus)
// because applyStatus is the shared chokepoint: seedReviewMergeStatus (reconnect / page-load hydration)
// must drop a stale cache too.
function applyStatus(id, next) {
  const prev = statusById.get(id);
  statusById.set(id, next);
  if (shouldDropDiffCache(prev, next)) diffById.delete(id);
  if (id === getSelectedId()) render();
}

export function setReviewMergeStatus(id, mergeStatus, reason = null) {
  const prev = statusById.get(id) || 'none';
  const next = mergeStatus || 'none';
  reasonById.set(id, reason);
  applyStatus(id, next);
  // On a fresh transition INTO a reviewable state, auto-select it when nothing reviewable is selected,
  // so the always-visible panel jumps to the session that just produced changes.
  if (REVIEWABLE.has(next) && !REVIEWABLE.has(prev)) {
    const sel = getSelectedId();
    const selReviewable = sel ? REVIEWABLE.has(statusById.get(sel) || 'none') : false;
    if (!sel || !sessionUIs.has(sel) || !selReviewable) setSelectedId(id);
  }
}

// Quiet variant for snapshot hydration (reconnect / page load): record the status without auto-opening
// or auto-selecting. Auto-surfacing is reserved for LIVE transitions (setReviewMergeStatus), so a
// reconnect never pops the panel open on its own.
export function seedReviewMergeStatus(id, mergeStatus, reason = null) {
  reasonById.set(id, reason);
  applyStatus(id, mergeStatus || 'none');
}

// Cache a session's diff payload ({ committed, uncommitted, hasCommits }, reply to request-session-diff)
// and re-render if it is the selected one. Each section also carries a --stat string, but the sidebar
// derives its own exact per-file stats from the diff text, so only the diff parts are used here.
export function setReviewDiff(id, payload) {
  diffById.set(id, payload || null);
  if (id === getSelectedId()) render();
}

// Cache a session's branch-sync payload (reply to request-branch-sync OR resync-branch, which share the
// same message) and re-render if it is the selected one. `payload` is { branch, upstream, state, ahead,
// behind, fetched } for a plain refresh, plus { action, error } for a resync outcome. `action` is only
// ever present on a resync-branch reply (getBranchSync never sets it), so that field's presence is what
// tells a shared reply apart from a plain one.
export function setReviewBranchSync(id, payload) {
  syncById.set(id, payload || null);
  if (payload && payload.action !== undefined) applyResyncResult(id, payload);
  if (id === getSelectedId()) render();
}

// Record a resync's outcome and clear its in-flight marker. A clean success/diverged/in-sync result
// auto-fades after a few seconds (mirrors review-resolve-sent); an error is left up until the next
// resync attempt for this session, since the operator needs time to actually read it.
function applyResyncResult(id, payload) {
  resyncingIds.delete(id);
  clearTimeout(resyncResultTimer ?? undefined);
  const text = resyncOutcomeText(payload);
  resyncResult = text ? { forId: id, text, isError: !!payload.error } : null;
  if (resyncResult && !resyncResult.isError) {
    resyncResultTimer = setTimeout(() => {
      if (resyncResult && resyncResult.forId === id) resyncResult = null;
      render();
    }, 5000);
  }
}

// Pure: the one-line outcome text for a completed resync, exhaustive over every reply the server can
// send: an error, a mutation action, or any post-resync state. The UI's button gate never sends a
// resync for no-upstream, but the server does not re-check that gate, so a non-UI control-WS caller
// (or a stale sidebar) can still land here with those states. Ordered most-specific first, mirroring
// branchSyncLabel/mergeDisabledReason.
function resyncOutcomeText(sync) {
  if (sync.error) return `Resync failed: ${sync.error}`;
  if (sync.action === 'fast-forwarded') return `Fast-forwarded ${sync.branch} to ${sync.upstream}.`;
  if (sync.action === 'pushed') return `Pushed ${sync.branch} to ${sync.upstream}.`;
  if (sync.state === 'diverged') return `${sync.branch} has diverged from ${sync.upstream}. Resolve manually.`;
  if (sync.state === 'in-sync') return `${sync.branch} is already in sync with ${sync.upstream}.`;
  if (sync.state === 'no-upstream') return `${sync.branch || 'The base branch'} has no upstream to resync against.`;
  return 'Could not determine sync status.';
}

// A server `session-changed` push: this session's worktree changed (a commit/stage via the gitdir
// watch, a turn end, or the integration-ref watcher catching an out-of-band / cross-session merge into
// the integration branch). Auto-re-fetch the diff, but ONLY for the selected session, so the heavy git
// diff stays scoped to what the operator is viewing. This push (not a manual button) keeps the diff live.
export function notifyWorktreeChanged(id) {
  if (id && id === getSelectedId()) requestDiff(id);
}

// Re-render if the given session is the selected one. Called on every state transition (app.js
// handleStateChange) because the Merge gate is STATE-dependent (isMergeableLive): a turn ending
// RUNNING -> COMPLETE must re-evaluate the gate so the button appears without the operator poking the
// UI. If this session's diff was never fetched, pull it so `hasCommits` exists to evaluate (the
// reported symptom - preview visible, button missing - is fixed by the re-render alone, but this also
// covers a selected session whose diff never loaded).
export function refreshReviewSidebar(id) {
  if (id !== getSelectedId()) return;
  if (!diffById.has(id)) requestDiff(id);
  render();
}

// Drop a removed session's cached review state, so the maps never leak.
export function forgetReviewSession(id) {
  statusById.delete(id);
  reasonById.delete(id);
  diffById.delete(id);
  syncById.delete(id);
  resyncingIds.delete(id);
  if (resyncResult && resyncResult.forId === id) { clearTimeout(resyncResultTimer ?? undefined); resyncResult = null; }
  if (id === getSelectedId()) { setSelectedId(null); return; } // setSelectedId fires render
  render();
}

// Fire the Merge action for the currently selected session, the keyboard-shortcut path (Alt+M) into the
// same control message the Merge button sends. It re-checks the button's exact gate here (a quiescent
// live session with committed changes, not already merging), so the shortcut can never merge something
// the button itself would withhold. Returns true only when a merge was actually sent.
export function mergeSelectedSession() {
  const id = getSelectedId();
  if (!id) return false;
  const ui = sessionUIs.get(id);
  if (!ui) return false;
  const curStatus = statusById.get(id) || 'none';
  const payload = diffById.get(id);
  const hasCommits = !!(payload?.hasCommits);
  const mergeAction = decideMergeAction(
    curStatus,
    reasonById.get(id) || null,
    isMergeableLive(ui.currentState, hasCommits),
  );
  if (!mergeAction.isEnabled) return false;
  sendMergeContinue(id, ui.currentState);
  return true;
}

// Fire the "Resolve in session" action for the currently selected session, the keyboard-shortcut path
// (Alt+R) into the same control message the Resolve button sends. Gated exactly like that button: a
// PARKED merge with a live PTY in the worktree to paste the resolve prompt into. Returns true only when
// the message was actually sent.
export function resolveSelectedSession() {
  const id = getSelectedId();
  if (!id) return false;
  const ui = sessionUIs.get(id);
  if (!ui) return false;
  if ((statusById.get(id) || 'none') !== 'parked') return false;
  if (reasonById.get(id) === 'base-diverged') return false;
  if (!isLive(ui.currentState)) return false;
  sendControlMsg({ type: 'resolve-session-merge', id });
  return true;
}

// Fire the Resync action for the currently selected session - the same control message the Resync
// button sends, and the fallback half of the Alt+R shortcut (app.js tries resolveSelectedSession first;
// this only runs when that no-ops, i.e. nothing is parked, since the two share the Alt+R binding and a
// parked worktree conflict is the more urgent of the two). Gated exactly like the rendered button: a
// session must be selected, not already resyncing, and its branch-sync state must be one
// resyncDisabledReason does not withhold. Returns true only when a request was actually sent.
export function resyncSelectedSession() {
  const id = getSelectedId();
  if (!id || !sessionUIs.has(id)) return false;
  if (resyncingIds.has(id)) return false;
  if (resyncDisabledReason(syncById.get(id), false)) return false;
  requestResyncBranch(id);
  return true;
}

// ── Helpers ──

// The Merge action's gate in one place, shared by the rendered button and the Alt+M shortcut: a quiescent
// live session (WAITING, IDLE, or COMPLETE - see shared MERGEABLE_LIVE_STATES, the same set the server's
// mergeAndContinue enforces) whose worktree has COMMITTED changes. WAITING is fine (the agent paused for
// the operator, so its committed work is stable). RUNNING is also allowed here (a stuck-WORKING card can
// still merge), but goes through an explicit confirm + force:true (see sendMergeContinue) since the agent
// may still be mid-edit. The 'merging' in-flight check is the caller's separate concern (it disables the
// button / short-circuits the shortcut).
function isMergeableLive(state, hasCommits) {
  return (MERGEABLE_LIVE_STATES.includes(state) || state === STATES.RUNNING) && hasCommits;
}

// Single chokepoint for sending the merge-continue control message. A RUNNING session still "looks like"
// it might be mid-edit, so it gets an explicit confirm before force:true is sent; every other mergeable
// state sends immediately, exactly as before.
function sendMergeContinue(id, state) {
  if (state !== STATES.RUNNING) {
    sendControlMsg({ type: 'merge-continue-session', id });
    return;
  }
  openConfirmDialog({
    title: 'Merge while working',
    message: 'This session still looks like it is working. Merging rebases its worktree under it. Merge anyway?',
    confirmLabel: 'Merge anyway',
    onConfirm: () => sendControlMsg({ type: 'merge-continue-session', id, force: true }),
  });
}

// Whether the session still has a live PTY in its worktree (anything but a terminal/dormant state). Gates
// the in-worktree "Resolve in session" action and the discard safety check; shared by render and Alt+R.
function isLive(state) {
  return state !== STATES.DORMANT && state !== STATES.DONE && state !== STATES.FAILED;
}

function requestDiff(id) {
  sendControlMsg({ type: 'request-session-diff', id });
}

// Explicit request only (sidebar open via onSelectionChange, or the operator clicking the rendered
// branch-sync line to refresh) - never on a timer, since it includes a `git fetch` against the remote.
function requestBranchSync(id) {
  syncById.set(id, null); // pending: renders the loading pulse until the reply lands
  sendControlMsg({ type: 'request-branch-sync', id });
  if (id === getSelectedId()) render();
}

// Explicit request only (the Resync button click or the Alt+R fallback) - never on a timer. A second
// call for the SAME id while one is in flight is a no-op here (the caller checks resyncingIds first);
// the server additionally coalesces concurrent resyncs per session as a backstop.
function requestResyncBranch(id) {
  resyncingIds.add(id);
  clearTimeout(resyncResultTimer ?? undefined);
  if (resyncResult && resyncResult.forId === id) resyncResult = null; // a fresh attempt supersedes the last outcome
  sendControlMsg({ type: 'resync-branch', id });
  if (id === getSelectedId()) render();
}

// Pure: the compact display text for a branch-sync payload, or null when there is nothing to show yet
// (never requested). Ordered by state, mirroring mergeDisabledReason's shape below.
function branchSyncLabel(sync) {
  if (!sync) return null;
  const { branch, upstream, state, ahead, behind } = sync;
  if (state === 'no-upstream') return `${branch}: no upstream`;
  if (state === 'unknown') return `${branch}: sync state unknown vs ${upstream}`;
  if (state === 'in-sync') return `${branch}: in sync with ${upstream}`;
  if (state === 'ahead') return `${branch}: ${ahead} ahead of ${upstream}`;
  if (state === 'behind') return `${branch}: ${behind} behind ${upstream}`;
  if (state === 'diverged') return `${branch}: ${ahead} ahead, ${behind} behind ${upstream}`;
  return null;
}

// Pure: the one-line reason Resync is unavailable, or null when it is actionable. Unlike Merge, most
// states stay enabled: in-sync (still worth a fetch+refresh), ahead, behind, and diverged (clicking
// still fetches and reports the diverged outcome - see resyncOutcomeText - it just never mutates
// anything for that state). Only "nothing to compare against yet" disables it.
function resyncDisabledReason(sync, resyncing) {
  if (resyncing) return null; // the sibling status line already says "Resyncing..."
  if (!sync) return 'Checking branch sync...';
  if (sync.state === 'no-upstream') return 'No upstream configured.';
  if (sync.state === 'unknown') return 'Could not determine sync status.';
  return null;
}

// Pure: the { text, loading, error } to render as the Resync sibling status line, or null for nothing.
// Priority order: an in-flight spinner beats a stale outcome, which beats a fresh disabled reason -
// only one of the three is ever true for a given (id, sync, resyncing), so this is a single line.
function resyncStatusLine(id, sync, resyncing) {
  if (resyncing) return { text: 'Resyncing...', loading: true, error: false };
  if (resyncResult && resyncResult.forId === id) return { text: resyncResult.text, loading: false, error: resyncResult.isError };
  const reason = resyncDisabledReason(sync, false);
  return reason ? { text: reason, loading: !sync, error: false } : null;
}

function sessionName(ui, id) {
  return ui?.card?.dataset.session || id;
}

// ── Render ──

function render() {
  if (!controlsEl || !bodyEl) return;
  controlsEl.replaceChildren();
  bodyEl.replaceChildren();
  if (branchSyncEl) branchSyncEl.replaceChildren();

  const id = getSelectedId();
  const ui = id ? sessionUIs.get(id) : null;
  if (!id || !ui) {
    if (sessionNameEl) sessionNameEl.textContent = '';
    renderEmpty('No session selected', 'Click a session name to review its changes here.');
    return;
  }

  if (branchSyncEl) {
    const row = renderBranchSync(id);
    if (row) branchSyncEl.append(row);
  }

  const status = statusById.get(id) || 'none';
  const mergeReason = reasonById.get(id) || null;
  const state = ui.currentState;
  const reviewable = REVIEWABLE.has(status);

  const fetched = diffById.has(id);
  const payload = fetched ? diffById.get(id) : null;
  // The hard line the operator asked for: COMMITTED changes are the mergeable unit; UNCOMMITTED working-
  // tree changes are shown for awareness but are never part of a merge until the session commits them.
  const committedFiles = payload ? parseUnifiedDiff(payload.committed?.diff || '') : [];
  const uncommittedFiles = payload ? parseUnifiedDiff(payload.uncommitted?.diff || '') : [];
  const hasCommits = !!(payload?.hasCommits);

  // One merge action, never a "finish". A session's PTY effectively never dies (Claude's built-in restart
  // keeps it alive; only an explicit /exit ends it, which never happens), so there is no settled/close-out
  // state to merge from. "Merge" on a quiescent live session (WAITING/IDLE/COMPLETE) with COMMITTED changes
  // merges into the base and rebases this worktree onto it, KEEPING the session running. With nothing
  // committed there is nothing to merge, so the button is disabled (with a reason) rather than withheld.
  const live = isLive(state);
  const mergeableLive = isMergeableLive(state, hasCommits);
  const mergeAction = decideMergeAction(status, mergeReason, mergeableLive);

  // Resync is orthogonal to the merge/worktree gate above (it acts on the project's base branch vs its
  // own remote, not this session's worktree), so it renders regardless of merge `status`.
  const sync = syncById.get(id);
  const resyncing = resyncingIds.has(id);

  if (sessionNameEl) sessionNameEl.textContent = sessionName(ui, id);

  // ── Pinned control region: status note + overall totals + actions + why-disabled reason.
  // Only statuses that carry news get a note; a reviewable diff speaks for itself in the body.
  const statusNoteText = status === 'parked' ? parkedStatusText(mergeReason)
    : status === 'merging' ? 'Merging...'
    : status === 'merged' ? 'Merged'
    : null;
  if (statusNoteText) {
    const note = el('div', 'review-status-note');
    note.dataset.merge = status;
    note.textContent = statusNoteText;
    controlsEl.append(note);
  }

  // No combined total in the actions row: each section head right below carries its own +/- stat,
  // and a pinned grand total only repeated those numbers one scroll-line above them.
  const effectiveBase = baseLabel(ui.effectiveBase);
  const actions = renderActions(id, {
    status, reviewable, mergeAction, live, state, sync, resyncing, effectiveBase, mergeReason,
  });
  controlsEl.append(actions);

  // Resync status line: spinner while in flight, else the latest outcome (persists on error), else the
  // disabled reason. At most one of these applies at a time, so this is a single line, not three.
  const resyncStatus = resyncStatusLine(id, sync, resyncing);
  if (resyncStatus) {
    const r = el('div', resyncStatus.loading ? 'review-control-reason review-loading' : 'review-control-reason', resyncStatus.text);
    if (resyncStatus.error) r.classList.add('review-control-reason-error');
    r.id = 'review-resync-reason';
    controlsEl.append(r);
    const resyncBtn = actions.querySelector('#review-resync-btn');
    if (resyncBtn) resyncBtn.setAttribute('aria-describedby', 'review-resync-reason');
  }

  // Disabled reason only when Merge is rendered (not suppressed by parked) and unavailable.
  let reasonShown = false;
  if (mergeAction.isRendered && !mergeAction.isEnabled) {
    const reason = mergeDisabledReason({ status, mergeReason, fetched, hasCommits, live, state });
    if (reason) {
      // While the diff is unfetched the reason line IS the loading indicator (it replaced the body's
      // "Loading diff..." placeholder), so it carries the loading pulse.
      const r = el('div', !fetched ? 'review-control-reason review-loading' : 'review-control-reason', reason);
      r.id = 'review-merge-reason';
      controlsEl.append(r);
      reasonShown = true;
      const mergeBtn = actions.querySelector('#review-merge-btn');
      if (mergeBtn) mergeBtn.setAttribute('aria-describedby', 'review-merge-reason');
    }
  }

  // Transient confirmation after "Resolve in session" is clicked.
  if (resolveJustSent && resolveJustSentFor === id) {
    controlsEl.append(el('div', 'review-resolve-sent', 'Resolve prompt sent'));
  }

  // ── Scrolling body: diff sections only. Committed section first: it is what a merge moves into the base.
  if (committedFiles.length > 0) {
    bodyEl.append(renderSection('committed', 'Committed', mergeTargetText(effectiveBase), committedFiles));
  }
  if (committedFiles.length === 0 && !reasonShown) {
    // A pinned reason line ("Checking for changes...", "Session ended.") already explains an empty
    // committed section, so the body adds its own placeholder only when no reason rendered, never a
    // second wording of the same fact.
    const placeholder = !fetched && reviewable
      ? el('div', 'review-nochanges review-loading', 'Loading diff...')
      : el('div', 'review-nochanges', uncommittedFiles.length > 0 ? 'No committed changes.' : 'No changes in this worktree.');
    bodyEl.append(placeholder);
  }

  // Uncommitted section, clearly divided off: present but excluded from the merge.
  if (uncommittedFiles.length > 0) {
    bodyEl.append(renderSection('uncommitted', 'Uncommitted', '', uncommittedFiles));
  }
}

function renderEmpty(title, desc) {
  if (!bodyEl) return;
  const wrap = el('div', 'review-empty');
  wrap.append(el('div', 'review-empty-title', title), el('div', 'review-empty-desc', desc));
  bodyEl.append(wrap);
}

// The local-base-branch-vs-remote-upstream row for the given (selected) session id. Returns a node or
// null (nothing requested yet, e.g. a session card that hasn't been selected since page load). Clicking
// the rendered line is the operator's explicit "refresh" action (the only other trigger is selecting
// the session, in onSelectionChange - never a timer, since this includes a `git fetch`).
function renderBranchSync(id) {
  const sync = syncById.get(id);
  if (sync === undefined) return null;
  if (sync === null) return el('span', 'review-branch-sync-text review-loading', 'Checking branch sync...');
  const label = branchSyncLabel(sync);
  if (!label) return null;
  const row = el('button', 'review-branch-sync-text', label);
  row.type = 'button';
  row.dataset.syncState = sync.state;
  // fetched null means no fetch was attempted (no-upstream short-circuit), which is not staleness;
  // the state guard covers the fetch-attempted-then-parse-failed path that also lands on no-upstream.
  const isStale = sync.fetched === false && sync.state !== 'no-upstream';
  if (isStale) row.dataset.stale = 'true';
  row.title = isStale
    ? 'The last fetch against the remote failed; these counts may be stale. Click to retry.'
    : 'Click to refresh';
  row.addEventListener('click', () => requestBranchSync(id));
  return row;
}

// One change group, summarized in a SINGLE header row so the two groups read as two distinct things at a
// glance instead of two near-identical "N files changed" blocks. The git term (`label`) appears exactly
// once, with a short plain-English `meaning` beside it and the file/line stats folded into the same row.
// The committed-vs-uncommitted distinction is carried by the colored section label plus a state-tinted full
// border on the diff box (keyed off data-kind in CSS), not a side-stripe. A collapsible per-file list sits
// below, minimized by default.
function renderSection(kind, label, meaning, files) {
  const wrap = el('div', 'review-section');
  wrap.dataset.kind = kind;

  const sum = summarizeFiles(files);
  const head = el('div', 'review-section-head');

  const lhs = el('div', 'review-section-id');
  lhs.append(el('span', 'review-section-label', label));
  if (meaning) lhs.append(el('span', 'review-section-meaning', meaning));
  head.append(lhs);

  const stat = el('div', 'review-section-stat');
  stat.append(el('span', 'review-stat-files', `${sum.files} file${sum.files === 1 ? '' : 's'}`));
  stat.append(
    el('span', 'review-add', `+${sum.added}`),
    el('span', 'review-del', `-${sum.removed}`)
  );
  head.append(stat);
  wrap.append(head);

  const list = el('div', 'review-diff');
  for (const f of files) list.append(renderFile(f, kind));
  wrap.append(list);
  return wrap;
}

function renderFile(f, kind) {
  const key = `${kind}:${f.path}`; // per-section collapse state (same path can be in both sections)
  const open = openFiles.has(key);
  const sec = el('div', 'review-file');
  sec.dataset.status = f.status;
  sec.dataset.open = open ? 'true' : 'false';

  // Clickable header toggles this file's diff. Path + change counts always show; the diff body is built
  // only when open, so a freshly selected session renders as a cheap list of rows (all minimized).
  const head = el('button', 'review-file-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', open ? 'true' : 'false');
  const twisty = el('span', 'review-file-twisty', open ? '▾' : '▸'); // down vs right triangle
  twisty.setAttribute('aria-hidden', 'true');
  head.append(twisty, el('span', 'review-file-path', f.path));
  const c = el('span', 'review-file-counts');
  if (f.binary) c.append(el('span', 'review-bin', 'bin'));
  if (!f.binary) c.append(
    el('span', 'review-add', `+${f.added}`),
    el('span', 'review-del', `-${f.removed}`)
  );
  head.append(c);
  head.addEventListener('click', () => {
    const wasOpen = openFiles.has(key);
    if (wasOpen) openFiles.delete(key);
    if (!wasOpen) openFiles.add(key);
    render();
  });
  sec.append(head);

  if (!open) return sec; // minimized: header only

  const body = el('div', 'review-file-body');
  if (f.binary) {
    body.append(el('div', 'review-file-binary', 'Binary file not shown'));
    sec.append(body);
    return sec;
  }

  // Flatten the hunks into rendered rows, capped for performance.
  let rendered = 0;
  let truncated = false;
  for (const h of f.hunks) {
    if (rendered >= MAX_FILE_LINES && !expanded.has(key)) { truncated = true; break; }
    body.append(el('div', 'review-hunk-head', h.header));
    for (const line of h.lines) {
      if (rendered >= MAX_FILE_LINES && !expanded.has(key)) { truncated = true; break; }
      const row = el('div', `review-line review-line-${line.type}`);
      const gutter = line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'meta' ? '\\' : ' ';
      row.append(el('span', 'review-line-gutter', gutter));
      row.append(el('span', 'review-line-text', line.text));
      body.append(row);
      rendered++;
    }
    if (truncated) break;
  }
  if (truncated) {
    const more = el('button', 'review-expand', 'Show the rest of this file');
    more.type = 'button';
    more.addEventListener('click', () => { expanded.add(key); render(); });
    body.append(more);
  }
  sec.append(body);
  return sec;
}

// One shape for every action in this row: an optional id, an optional key hint rendered as a <kbd>
// chip, and a label that never varies with state (the sibling reason line carries progress).
/**
 * @param {{
 *   label: string,
 *   onClick: (event: MouseEvent) => void,
 *   id?: string,
 *   shortcut?: string,
 *   title?: string,
 *   disabled?: boolean,
 *   danger?: boolean,
 * }} spec
 */
function actionButton({ id, label, shortcut, title, disabled = false, danger = false, onClick }) {
  const btn = el('button', danger ? 'review-btn review-btn-danger' : 'review-btn review-btn-primary');
  btn.type = 'button';
  if (id) btn.id = id;
  if (title) btn.title = title;
  btn.disabled = disabled;
  btn.innerHTML = shortcut
    ? `${label} <kbd class="review-shortcut" aria-hidden="true">${shortcut}</kbd>`
    : label;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderActions(id, { status, reviewable, mergeAction, live, state, sync, resyncing, effectiveBase, mergeReason }) {
  const actions = el('div', 'review-actions');

  if (mergeAction.isRendered) {
    actions.append(actionButton({
      id: 'review-merge-btn',
      label: 'Merge',
      shortcut: 'alt+m',
      title: mergeActionTitle(effectiveBase),
      disabled: !mergeAction.isEnabled,
      onClick: () => sendMergeContinue(id, state),
    }));
  }

  // Parked: the auto rebase-then-FF could not complete due to a conflict. Paste a context-rich
  // resolve prompt into the session so the agent can finish the merge; operator re-runs Merge after.
  const resolveShown = status === 'parked' && live && mergeReason !== 'base-diverged';
  if (resolveShown) {
    actions.append(actionButton({
      label: 'Resolve',
      shortcut: 'alt+r',
      title: 'Paste a resolve prompt into this session so the agent can finish the merge (alt+r)',
      onClick: () => {
        sendControlMsg({ type: 'resolve-session-merge', id });
        resolveJustSent = true;
        resolveJustSentFor = id;
        clearTimeout(resolveSentTimer ?? undefined);
        resolveSentTimer = setTimeout(() => { resolveJustSent = false; resolveJustSentFor = null; render(); }, 3000);
        render();
      },
    }));
  }

  // Resync: fetch + fast-forward/push the project's LOCAL base branch against its remote upstream.
  // Orthogonal to the worktree merge gate above (it never touches this session's worktree), so it
  // always renders next to Merge/Resolve regardless of `status`. The label never changes for any
  // reason (in flight, error, success) - progress/outcome live in the sibling reason line render()
  // appends after the actions row, per the button-label rule. When Resolve is also shown, Alt+R goes to
  // it first (see app.js), so the shortcut hint is suppressed here to avoid implying a false tie.
  actions.append(actionButton({
    id: 'review-resync-btn',
    label: 'Resync',
    shortcut: resolveShown ? undefined : 'alt+r',
    title: resolveShown
      ? 'Fetch and fast-forward/push the local base branch against its remote upstream'
      : 'Fetch and fast-forward/push the local base branch against its remote upstream (alt+r)',
    disabled: resyncing || !!resyncDisabledReason(sync, resyncing),
    onClick: () => requestResyncBranch(id),
  }));

  // Discard throws the worktree away unmerged. Gated on NO live PTY (never destroy a worktree a
  // running session is sitting in).
  if (reviewable && !live) {
    actions.append(actionButton({
      label: 'Discard',
      danger: true,
      disabled: status === 'merging',
      onClick: () => {
        const ui = sessionUIs.get(id);
        const nm = sessionName(ui, id);
        openConfirmDialog({
          title: 'Discard worktree',
          message: `Throw away the worktree changes for "${nm}"? This cannot be undone.`,
          confirmLabel: 'Discard',
          onConfirm: () => sendControlMsg({ type: 'discard-session-worktree', id }),
        });
      },
    }));
  }
  return actions;
}
