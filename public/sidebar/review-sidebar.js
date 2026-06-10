// Right-docked review sidebar: the single home for the worktree review gate of the SELECTED session.
// Shows a changed-files summary over a collapsible per-file diff (each file minimized until clicked),
// plus the actions (Merge; Discard only for a settled worktree). "Merge" merges into develop
// and rebases the worktree onto it WITHOUT ending the session, so the operator commits as they go (the
// PTY effectively never dies, so there is no separate finish/close-out step). It REPLACES the old inline
// card review bar; the card now only carries data-merge for the remove-warning. The sidebar is app-level
// (spans every view via .app-body), so it serves the Sessions grid and the Focus view alike.
//
// Data flow: merge status arrives via setReviewMergeStatus (from the server's session-merge-status),
// the diff via setReviewDiff (reply to request-session-diff, asked on selection and on every server
// `session-changed` push via notifyWorktreeChanged). Session name/state are read live from the shared
// card registry. Pure parsing lives in diff-core.mjs.

import { MERGEABLE_LIVE_STATES, STATES } from '/shared/states.mjs';
import { sendControlMsg } from '../control-ws.js';
import { el } from '../dom-helpers.js';
import { showConfirmDialog } from '../session-card/card-dom.js';
import { sessionUIs } from '../session-card/card-registry.js';
import { parseUnifiedDiff, shouldDropDiffCache, summarizeFiles } from './diff-core.mjs';
import { getSelectedId, onSelectionChange, setSelectedId } from './selection.js';

const REVIEWABLE = new Set(['pending-review', 'parked']);
const MAX_FILE_LINES = 600; // per-file DOM line cap; beyond this a file collapses to a count with click-to-expand
const SIDEBAR_MIN = 260;    // resize bounds (px)
const SIDEBAR_MAX = 700;

const statusById = new Map(); // id -> mergeStatus ('none'|'pending-review'|'merging'|'parked'|'merged')
const diffById = new Map();   // id -> { committed, uncommitted, hasCommits } (null until fetched)
// Open/expanded keys are `${section}:${path}` so the SAME file appearing in both the committed and the
// uncommitted section collapses independently (default: every file minimized).
const openFiles = new Set();
const expanded = new Set();

let panelEl = null;
let controlsEl = null;
let bodyEl = null;
let sessionNameEl = null;
let resolveJustSent = false;
let resolveJustSentFor = null;
let resolveSentTimer = null;

// ── Mount ──
// The sidebar is always visible (no collapse): with no session selected it shows an empty state, and
// with a selected session that has no changes it says so.

export function mountReviewSidebar({ panel }) {
  panelEl = panel;
  if (!panelEl) return;

  const head = el('div', 'review-sidebar-head');
  const title = el('span', 'review-sidebar-title', 'Review');
  sessionNameEl = el('span', 'review-sidebar-session');
  head.append(title, sessionNameEl);

  // Pinned control region between the title and the scrolling diff: status note + actions + a
  // why-disabled reason line. Always present while a session is selected (collapsed via :empty
  // otherwise), so Merge and the other controls never scroll out of reach inside a long diff.
  controlsEl = el('div', 'review-controls');
  bodyEl = el('div', 'review-sidebar-body');

  // Resize handle: drag left edge to widen, right to narrow. Width persisted to localStorage.
  const handle = el('div', 'review-resize-handle');
  handle.setAttribute('aria-hidden', 'true');
  panelEl.append(head, controlsEl, bodyEl, handle);

  let dragStartX = 0, dragStartWidth = 0;

  const onDrag = (e) => {
    const delta = dragStartX - e.clientX; // drag left = wider (sidebar is right-docked)
    const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, dragStartWidth + delta));
    panelEl.style.setProperty('--sidebar-width', `${w}px`);
  };

  const stopDrag = () => {
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDrag);
    window.removeEventListener('blur', stopDrag); // cancel on focus loss mid-drag
    document.documentElement.style.cursor = '';
    document.documentElement.style.userSelect = '';
    const w = panelEl.style.getPropertyValue('--sidebar-width');
    if (w) { try { localStorage.setItem('glissa:sidebar-width', parseInt(w, 10)); } catch (_) {} }
  };

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragStartX = e.clientX;
    dragStartWidth = panelEl.getBoundingClientRect().width;
    document.documentElement.style.cursor = 'col-resize';
    document.documentElement.style.userSelect = 'none';
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', stopDrag);
    window.addEventListener('blur', stopDrag, { once: true });
  });

  try {
    const stored = localStorage.getItem('glissa:sidebar-width');
    if (stored) {
      const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, parseInt(stored, 10)));
      if (Number.isFinite(w)) panelEl.style.setProperty('--sidebar-width', `${w}px`);
    }
  } catch (_) {}

  onSelectionChange((id) => {
    // Per-session: don't carry one session's open/expanded files into the next (start minimized).
    openFiles.clear();
    expanded.clear();
    if (id) requestDiff(id);
    render();
  });

  render();
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

export function setReviewMergeStatus(id, mergeStatus) {
  const prev = statusById.get(id) || 'none';
  const next = mergeStatus || 'none';
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
export function seedReviewMergeStatus(id, mergeStatus) {
  applyStatus(id, mergeStatus || 'none');
}

// Cache a session's diff payload ({ committed, uncommitted, hasCommits }, reply to request-session-diff)
// and re-render if it is the selected one. Each section also carries a --stat string, but the sidebar
// derives its own exact per-file stats from the diff text, so only the diff parts are used here.
export function setReviewDiff(id, payload) {
  diffById.set(id, payload || null);
  if (id === getSelectedId()) render();
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
  diffById.delete(id);
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
  if (curStatus === 'merging' || curStatus === 'parked') return false; // in-flight or conflict needs resolving
  const payload = diffById.get(id);
  const hasCommits = !!(payload && payload.hasCommits);
  if (!isMergeableLive(ui.currentState, hasCommits)) return false;
  sendControlMsg({ type: 'merge-continue-session', id });
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
  if (!isLive(ui.currentState)) return false;
  sendControlMsg({ type: 'resolve-session-merge', id });
  return true;
}

// ── Helpers ──

// The Merge action's gate in one place, shared by the rendered button and the Alt+M shortcut: a quiescent
// live session (WAITING, IDLE, or COMPLETE - see shared MERGEABLE_LIVE_STATES, the same set the server's
// mergeAndContinue enforces) whose worktree has COMMITTED changes. RUNNING is excluded (the agent is
// actively editing); WAITING is fine (the agent paused for the operator, so its committed work is stable).
// The 'merging' in-flight check is the caller's separate concern (it disables the button / short-circuits
// the shortcut).
function isMergeableLive(state, hasCommits) {
  return MERGEABLE_LIVE_STATES.includes(state) && hasCommits;
}

// Whether the session still has a live PTY in its worktree (anything but a terminal/dormant state). Gates
// the in-worktree "Resolve in session" action and the discard safety check; shared by render and Alt+R.
function isLive(state) {
  return state !== STATES.DORMANT && state !== STATES.DONE && state !== STATES.FAILED;
}

// Pure: the one-line reason Merge is unavailable, or null when no line is needed. Centralizes the
// disabled-state copy so the always-visible control region can say WHY the operator cannot merge yet.
// Only called when Merge is disabled; ordered most-specific first.
function mergeDisabledReason({ status, fetched, hasCommits, live, hasUncommitted }) {
  if (status === 'merging') return null;                       // the status note already says "Merging..."
  if (status === 'parked') return 'Resolve the conflict, then merge.';
  if (!fetched) return 'Checking for changes...';
  if (!hasCommits && !hasUncommitted) return 'No changes to merge.';
  if (!hasCommits) return 'Nothing committed yet. Commit to merge.';
  if (!live) return 'Session ended.';                          // committed work, but no PTY to keep running
  return 'Working. Mergeable when the turn ends.';             // committed work, live, but still RUNNING
}

function requestDiff(id) {
  sendControlMsg({ type: 'request-session-diff', id });
}

function sessionName(ui, id) {
  return ui?.card?.dataset.session || id;
}

// ── Render ──

function render() {
  if (!controlsEl || !bodyEl) return;
  controlsEl.replaceChildren();
  bodyEl.replaceChildren();

  const id = getSelectedId();
  const ui = id ? sessionUIs.get(id) : null;
  if (!id || !ui) {
    if (sessionNameEl) sessionNameEl.textContent = '';
    renderEmpty('No session selected', 'Click a session name to review its changes here.');
    return;
  }

  const status = statusById.get(id) || 'none';
  const state = ui.currentState;
  const reviewable = REVIEWABLE.has(status);

  const fetched = diffById.has(id);
  const payload = fetched ? diffById.get(id) : null;
  // The hard line the operator asked for: COMMITTED changes are the mergeable unit; UNCOMMITTED working-
  // tree changes are shown for awareness but are never part of a merge until the session commits them.
  const committedFiles = payload ? parseUnifiedDiff(payload.committed?.diff || '') : [];
  const uncommittedFiles = payload ? parseUnifiedDiff(payload.uncommitted?.diff || '') : [];
  const hasCommits = !!(payload && payload.hasCommits);

  // One merge action, never a "finish". A session's PTY effectively never dies (Claude's built-in restart
  // keeps it alive; only an explicit /exit ends it, which never happens), so there is no settled/close-out
  // state to merge from. "Merge" on a quiescent live session (WAITING/IDLE/COMPLETE) with COMMITTED changes
  // merges into develop and rebases this worktree onto develop, KEEPING the session running. With nothing
  // committed there is nothing to merge, so the button is disabled (with a reason) rather than withheld.
  const live = isLive(state);
  const mergeableLive = isMergeableLive(state, hasCommits);
  // Parked means a conflict needs resolving first; suppress Merge entirely until it clears.
  const mergeEnabled = mergeableLive && status !== 'merging' && status !== 'parked';

  if (sessionNameEl) sessionNameEl.textContent = sessionName(ui, id);

  // ── Pinned control region: status note + overall totals + actions + why-disabled reason.
  if (status && status !== 'none') {
    const note = el('div', 'review-status-note');
    note.dataset.merge = status;
    note.textContent = status === 'parked' ? 'Needs manual merge'
      : status === 'merging' ? 'Merging...'
      : status === 'merged' ? 'Merged'
      : 'Changes ready to review';
    controlsEl.append(note);
  }

  // No combined total in the actions row: each section head right below carries its own +/- stat,
  // and a pinned grand total only repeated those numbers one scroll-line above them.
  const actions = renderActions(id, { status, reviewable, mergeEnabled, live });
  controlsEl.append(actions);

  // Disabled reason only when Merge is rendered (not suppressed by parked) and unavailable.
  let reasonShown = false;
  if (!mergeEnabled && status !== 'parked') {
    const reason = mergeDisabledReason({
      status, fetched, hasCommits, live, hasUncommitted: uncommittedFiles.length > 0,
    });
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
    const mergeTarget = ui?.effectiveBase || 'develop';
    bodyEl.append(renderSection('committed', 'Committed', `merges into ${mergeTarget}`, committedFiles));
  } else if (!reasonShown) {
    // The pinned reason line already explains an empty committed section ("No changes to merge.",
    // "Nothing committed yet...", "Checking for changes..."), so the body adds its own placeholder
    // only when no reason rendered, never a second wording of the same fact.
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
  const wrap = el('div', 'review-empty');
  wrap.append(el('div', 'review-empty-title', title), el('div', 'review-empty-desc', desc));
  bodyEl.append(wrap);
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
  else c.append(
    el('span', 'review-add', `+${f.added}`),
    el('span', 'review-del', `-${f.removed}`)
  );
  head.append(c);
  head.addEventListener('click', () => {
    if (openFiles.has(key)) openFiles.delete(key);
    else openFiles.add(key);
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

function renderActions(id, { status, reviewable, mergeEnabled, live }) {
  const actions = el('div', 'review-actions');

  // Suppress Merge when parked: Resolve is the only path forward until the conflict clears.
  // When not parked, Merge always leads so the operator knows exactly where it lives.
  if (status !== 'parked') {
    const merge = el('button', 'review-btn review-btn-primary');
    merge.type = 'button';
    merge.id = 'review-merge-btn';
    merge.title = 'Merge into develop and rebase this worktree, then keep working (alt+m)';
    merge.disabled = !mergeEnabled;
    merge.innerHTML = 'Merge <kbd class="review-shortcut" aria-hidden="true">alt+m</kbd>';
    merge.addEventListener('click', () => sendControlMsg({ type: 'merge-continue-session', id }));
    actions.append(merge);
  }

  // Parked: the auto rebase-then-FF could not complete due to a conflict. Paste a context-rich
  // resolve prompt into the session so the agent can finish the merge; operator re-runs Merge after.
  if (status === 'parked' && live) {
    const resolve = el('button', 'review-btn review-btn-primary');
    resolve.type = 'button';
    resolve.title = 'Paste a resolve prompt into this session so the agent can finish the merge (alt+r)';
    resolve.innerHTML = 'Resolve <kbd class="review-shortcut" aria-hidden="true">alt+r</kbd>';
    resolve.addEventListener('click', () => {
      sendControlMsg({ type: 'resolve-session-merge', id });
      resolveJustSent = true;
      resolveJustSentFor = id;
      clearTimeout(resolveSentTimer);
      resolveSentTimer = setTimeout(() => { resolveJustSent = false; resolveJustSentFor = null; render(); }, 3000);
      render();
    });
    actions.append(resolve);
  }

  // Discard throws the worktree away unmerged. Gated on NO live PTY (never destroy a worktree a
  // running session is sitting in).
  if (reviewable && !live) {
    const discard = el('button', 'review-btn review-btn-danger', 'Discard');
    discard.type = 'button';
    discard.disabled = status === 'merging';
    discard.addEventListener('click', () => {
      const ui = sessionUIs.get(id);
      const nm = sessionName(ui, id);
      showConfirmDialog({
        title: 'Discard worktree',
        message: `Throw away the worktree changes for "${nm}"? This cannot be undone.`,
        confirmLabel: 'Discard',
        onConfirm: () => sendControlMsg({ type: 'discard-session-worktree', id }),
      });
    });
    actions.append(discard);
  }
  return actions;
}
