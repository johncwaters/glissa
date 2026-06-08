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
import { parseUnifiedDiff, summarizeFiles } from './diff-core.mjs';
import { getSelectedId, onSelectionChange, setSelectedId } from './selection.js';

const REVIEWABLE = new Set(['pending-review', 'parked']);
// Per-file rendered-line cap so a huge diff never stalls the DOM (R6). Beyond this, a file collapses
// to a count with a click-to-expand.
const MAX_FILE_LINES = 600;

const statusById = new Map(); // id -> mergeStatus ('none'|'pending-review'|'merging'|'parked'|'merged')
const diffById = new Map();   // id -> { committed, uncommitted, hasCommits } (null until fetched)
// Open/expanded keys are `${section}:${path}` so the SAME file appearing in both the committed and the
// uncommitted section collapses independently (default: every file minimized).
const openFiles = new Set();
const expanded = new Set();

let panelEl = null;
let bodyEl = null;

// ── Mount ──
// The sidebar is always visible (no collapse): with no session selected it shows an empty state, and
// with a selected session that has no changes it says so.

export function mountReviewSidebar({ panel }) {
  panelEl = panel;
  if (!panelEl) return;

  const head = el('div', 'review-sidebar-head');
  const title = el('span', 'review-sidebar-title', 'Review');
  head.append(title);

  bodyEl = el('div', 'review-sidebar-body');
  panelEl.append(head, bodyEl);

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

// Record a status and refresh the count/render. After a merge or discard ('merged'/'none') the worktree
// is gone, so any cached diff is stale and is dropped; 'merging'/'parked' keep the diff visible.
function applyStatus(id, next) {
  statusById.set(id, next);
  if (next === 'merged' || next === 'none') diffById.delete(id);
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
// watch, a turn end, or the backstop poll catching an out-of-band / cross-session move). Auto-re-fetch
// the diff, but ONLY for the selected session, so the heavy git diff stays scoped to what the operator
// is viewing. This push (not a manual button) is what keeps the diff live.
export function notifyWorktreeChanged(id) {
  if (id && id === getSelectedId()) requestDiff(id);
}

// Re-render if the given session is the selected one (e.g. its state changed: DONE -> DORMANT).
export function refreshReviewSidebar(id) {
  if (id === getSelectedId()) render();
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
  if ((statusById.get(id) || 'none') === 'merging') return false; // a merge is already in flight
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

function requestDiff(id) {
  sendControlMsg({ type: 'request-session-diff', id });
}

function sessionName(ui, id) {
  return ui?.card?.dataset.session || id;
}

// ── Render ──

function render() {
  if (!bodyEl) return;
  bodyEl.replaceChildren();

  const id = getSelectedId();
  const ui = id ? sessionUIs.get(id) : null;
  if (!id || !ui) {
    renderEmpty('No session selected', 'Click a session name to review its changes here.');
    return;
  }

  const status = statusById.get(id) || 'none';
  const state = ui.currentState;
  const reviewable = REVIEWABLE.has(status);

  // Merge-status note only. The session name and state badge are intentionally NOT shown here: the
  // session card already carries both, so repeating them in the sidebar is redundant.
  if (status && status !== 'none') {
    const note = el('div', 'review-status-note');
    note.dataset.merge = status;
    note.textContent = status === 'parked' ? 'Needs manual merge'
      : status === 'merging' ? 'Merging...'
      : status === 'merged' ? 'Merged'
      : 'Changes ready to review';
    bodyEl.append(note);
  }

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
  // committed there is nothing to merge, so the action is withheld. Only a session that is actively working
  // (RUNNING) gets a read-only preview; a session paused awaiting the operator (WAITING) is mergeable.
  const live = isLive(state);
  const mergeableLive = isMergeableLive(state, hasCommits);

  // Actions sit at the TOP of the changes area so the merge button leads. Skipped entirely when there
  // is nothing to act on (e.g. a still-working session), now that the always-present Refresh is gone.
  const actions = renderActions(id, { status, reviewable, mergeableLive, live });
  if (actions.childElementCount > 0) bodyEl.append(actions);

  // Committed section first: it is what a merge moves into develop.
  if (committedFiles.length > 0) {
    bodyEl.append(renderSection('committed', 'Committed', 'merges into develop', committedFiles));
  } else if (!fetched && reviewable) {
    bodyEl.append(el('div', 'review-nochanges review-loading', 'Loading diff...'));
  } else {
    const msg = uncommittedFiles.length > 0 ? 'Nothing committed yet. Commit to merge.'
      : 'No changes in this worktree.';
    bodyEl.append(el('div', 'review-nochanges', msg));
  }

  // Uncommitted section, clearly divided off: present but excluded from the merge.
  if (uncommittedFiles.length > 0) {
    bodyEl.append(renderSection('uncommitted', 'Uncommitted', '', uncommittedFiles));
  }

  if (!reviewable && !mergeableLive && hasCommits) {
    bodyEl.append(el('div', 'review-hint', 'Read-only preview. The session is working right now; it can be merged once its current turn finishes.'));
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
  stat.append(el('span', 'review-add', `+${sum.added}`), el('span', 'review-del', `-${sum.removed}`));
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
  else c.append(el('span', 'review-add', `+${f.added}`), el('span', 'review-del', `-${f.removed}`));
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

function renderActions(id, { status, reviewable, mergeableLive, live }) {
  const actions = el('div', 'review-actions');

  // No manual "Refresh diff" button: the diff is kept live by the server (it pushes `session-changed`
  // on a turn end, a commit, or the backstop poll, and the client auto-re-fetches for the selected
  // session - see notifyWorktreeChanged). Only real actions live here now.

  // Parked merge: the auto rebase-then-FF could not complete. Hand it to the agent IN the worktree by
  // pasting a context-rich prompt (why it parked + conflicting files + how to rebase/resolve) into the
  // session, so it can finish the merge; the operator then re-runs Merge. Needs a live PTY to paste into.
  if (status === 'parked' && live) {
    const resolve = el('button', 'review-btn review-btn-primary', 'Resolve in session');
    resolve.type = 'button';
    resolve.title = 'Paste a prompt into this session explaining why the merge parked and how to resolve it, so the agent in the worktree can finish the merge';
    resolve.addEventListener('click', () => sendControlMsg({ type: 'resolve-session-merge', id }));
    actions.append(resolve);
  }

  // The one merge action: merge into develop + rebase this worktree onto develop, then keep working in the
  // same session (the PTY stays alive - there is no separate "finish" step). Offered on a quiescent live
  // session with changes.
  if (mergeableLive) {
    const merge = el('button', 'review-btn review-btn-primary', 'Merge');
    merge.type = 'button';
    merge.title = 'Merge into develop and rebase this worktree onto develop, then keep working in this session';
    merge.disabled = status === 'merging';
    merge.addEventListener('click', () => sendControlMsg({ type: 'merge-continue-session', id }));
    actions.append(merge);
  }

  // Discard throws the worktree away unmerged. Gated on NO live PTY in the worktree (its original safety
  // invariant): never destroy a worktree a running session is sitting in.
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
