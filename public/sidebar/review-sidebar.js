// Right-docked review sidebar: the single home for the worktree review gate of the SELECTED session.
// Shows a changed-files summary over a collapsible per-file diff (each file minimized until clicked),
// plus the actions (Merge / Refresh; Discard only for a settled worktree). "Merge" merges into develop
// and rebases the worktree onto it WITHOUT ending the session, so the operator commits as they go (the
// PTY effectively never dies, so there is no separate finish/close-out step). It REPLACES the old inline
// card review bar; the card now only carries data-merge for the remove-warning. The sidebar is app-level
// (spans every view via .app-body), so it serves the Sessions grid and the Focus view alike.
//
// Data flow: merge status arrives via setReviewMergeStatus (from the server's session-merge-status),
// the diff via setReviewDiff (reply to request-session-diff, asked on selection/refresh). Session
// name/state are read live from the shared card registry. Pure parsing lives in diff-core.mjs.

import { STATES } from '/shared/states.mjs';
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
let countEl = null;

// ── Mount ──
// The sidebar is always visible (no collapse): with no session selected it shows an empty state, and
// with a selected session that has no changes it says so. The count next to the title shows how many
// sessions have changes ready to review.

export function mountReviewSidebar({ panel }) {
  panelEl = panel;
  if (!panelEl) return;

  const head = el('div', 'review-sidebar-head');
  const title = el('span', 'review-sidebar-title', 'Review');
  countEl = el('span', 'review-count', '');
  countEl.setAttribute('aria-hidden', 'true');
  countEl.title = 'Sessions with changes ready to review';
  head.append(title, countEl);

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
  updateCount();
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

// Re-render if the given session is the selected one (e.g. its state changed: DONE -> DORMANT).
export function refreshReviewSidebar(id) {
  if (id === getSelectedId()) render();
}

// Drop a removed session's cached review state, so the maps never leak.
export function forgetReviewSession(id) {
  statusById.delete(id);
  diffById.delete(id);
  updateCount();
  if (id === getSelectedId()) { setSelectedId(null); return; } // setSelectedId fires render
  render();
}

// ── Helpers ──

function requestDiff(id) {
  sendControlMsg({ type: 'request-session-diff', id });
}

// Count the sessions whose review gate is open. The gate self-heals server-side: getDiff demotes a
// stranded pending-review/parked status to 'none' (broadcast as a merge-status) the moment it finds an
// empty diff, so a status still in REVIEWABLE here genuinely has something to review.
function updateCount() {
  if (!countEl) return;
  let n = 0;
  for (const [id, st] of statusById) {
    if (REVIEWABLE.has(st) && sessionUIs.has(id)) n++;
  }
  countEl.textContent = n > 0 ? String(n) : '';
  countEl.classList.toggle('has-count', n > 0);
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
  // state to merge from. "Merge" on a quiescent live session (COMPLETE/IDLE) with COMMITTED changes merges
  // into develop and rebases this worktree onto develop, KEEPING the session running. With nothing
  // committed there is nothing to merge, so the action is withheld. A session still actively working
  // (RUNNING/WAITING) only gets a read-only preview.
  const live = state !== STATES.DORMANT && state !== STATES.DONE && state !== STATES.FAILED;
  const mergeableLive = (state === STATES.COMPLETE || state === STATES.IDLE) && hasCommits;

  // Actions sit at the TOP of the changes area so the merge button leads.
  bodyEl.append(renderActions(id, { status, reviewable, mergeableLive, live }));

  // Committed section first: it is what a merge moves into develop.
  if (committedFiles.length > 0) {
    bodyEl.append(renderSection('committed', 'Committed', 'merges into develop', committedFiles));
  } else {
    const msg = (!fetched && reviewable) ? 'Loading diff...'
      : uncommittedFiles.length > 0 ? 'Nothing committed yet. Commit in the session to make changes mergeable.'
      : 'No changes in this worktree.';
    bodyEl.append(el('div', 'review-nochanges', msg));
  }

  // Uncommitted section, clearly divided off: present but excluded from the merge.
  if (uncommittedFiles.length > 0) {
    bodyEl.append(renderSection('uncommitted', 'Uncommitted', 'not in the merge', uncommittedFiles));
  }

  if (!reviewable && !mergeableLive && hasCommits) {
    bodyEl.append(el('div', 'review-hint', 'Read-only preview. The session is still active; it can be merged once it is complete or idle.'));
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
// Color and a left accent bar (keyed off data-kind in CSS) carry the committed-vs-uncommitted distinction
// so it does not have to be spelled out twice. A collapsible per-file list sits below, minimized by default.
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

  const refresh = el('button', 'review-btn review-btn-ghost', 'Refresh diff');
  refresh.type = 'button';
  refresh.addEventListener('click', () => requestDiff(id));
  actions.append(refresh);

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
