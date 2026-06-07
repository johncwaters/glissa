// Right-docked review sidebar: the single home for the worktree review gate of the SELECTED session.
// Shows a rendered, per-file diff with a changed-files stat header, and the close-out actions
// (Merge & finish / Discard / Refresh). It REPLACES the old inline card review bar; the card now only
// carries data-merge for the remove-warning. The sidebar is app-level (spans every view via .app-body),
// so it serves the Sessions grid and the Focus view alike.
//
// Data flow: merge status arrives via setReviewMergeStatus (from the server's session-merge-status),
// the diff via setReviewDiff (reply to request-session-diff, asked on selection/refresh). Session
// name/state are read live from the shared card registry. Pure parsing lives in diff-core.mjs.

import { BADGE_LABELS, STATE_GLYPHS, STATES } from '/shared/states.mjs';
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
const diffById = new Map();   // id -> { stat, diff }
const expanded = new Set();   // file paths the user expanded past the cap (per current render pass)

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
    expanded.clear(); // per-session: don't carry one session's expanded files into the next
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

// Cache a session's diff (reply to request-session-diff) and re-render if it is the selected one. The
// session-diff message also carries a --stat string; the sidebar derives its own exact per-file stats
// from the diff, so only the diff is kept.
export function setReviewDiff(id, diff) {
  diffById.set(id, diff || '');
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

  // Header: name + state badge + merge-status note.
  const header = el('div', 'review-head');
  const name = el('div', 'review-name', sessionName(ui, id));
  const badge = el('span', 'review-badge');
  badge.dataset.state = state;
  const badgeGlyph = el('span', 'review-badge-glyph', STATE_GLYPHS[state] || '');
  badgeGlyph.setAttribute('aria-hidden', 'true');
  badge.append(badgeGlyph, el('span', 'review-badge-label', BADGE_LABELS[state] || state));
  header.append(name, badge);
  if (status && status !== 'none') {
    const note = el('div', 'review-status-note');
    note.dataset.merge = status;
    note.textContent = status === 'parked' ? 'Needs manual merge'
      : status === 'merging' ? 'Merging...'
      : status === 'merged' ? 'Merged'
      : 'Changes ready to review';
    header.append(note);
  }
  bodyEl.append(header);

  // Diff (rendered) + stat header.
  const fetched = diffById.has(id);
  const files = fetched ? parseUnifiedDiff(diffById.get(id)) : [];
  if (files.length === 0) {
    // No diff fetched yet for a reviewable session reads as "Loading"; otherwise there is nothing to show.
    const msg = (!fetched && reviewable) ? 'Loading diff...' : 'No changes in this worktree.';
    bodyEl.append(el('div', 'review-nochanges', msg));
  } else {
    bodyEl.append(renderStat(files));
    const diffWrap = el('div', 'review-diff');
    for (const f of files) diffWrap.append(renderFile(f));
    bodyEl.append(diffWrap);
  }

  // "Merge & finish" is available for a settled session (pending-review/parked) AND for a quiescent live
  // session that has changes (COMPLETE/IDLE): clicking it ends the session first, then merges. A session
  // that is still actively working (RUNNING) or waiting for input only gets a read-only preview.
  const finishableLive = (state === STATES.COMPLETE || state === STATES.IDLE) && files.length > 0;
  const canFinish = reviewable || finishableLive;

  bodyEl.append(renderActions(id, status, reviewable, canFinish));

  if (!canFinish && files.length > 0) {
    bodyEl.append(el('div', 'review-hint', 'Read-only preview. The session is still active; it can be merged once it is complete or idle.'));
  }
}

function renderEmpty(title, desc) {
  const wrap = el('div', 'review-empty');
  wrap.append(el('div', 'review-empty-title', title), el('div', 'review-empty-desc', desc));
  bodyEl.append(wrap);
}

function renderStat(files) {
  const sum = summarizeFiles(files);
  const stat = el('div', 'review-stat');
  const head = el('div', 'review-stat-head',
    `${sum.files} file${sum.files === 1 ? '' : 's'} changed`);
  const counts = el('span', 'review-stat-counts');
  counts.append(
    el('span', 'review-add', `+${sum.added}`),
    el('span', 'review-del', `-${sum.removed}`),
  );
  head.append(counts);
  stat.append(head);
  const list = el('ul', 'review-stat-list');
  for (const f of files) {
    const li = el('li', 'review-stat-item');
    li.dataset.status = f.status;
    const path = el('span', 'review-stat-path', f.path);
    const c = el('span', 'review-stat-c');
    if (f.binary) c.append(el('span', 'review-bin', 'bin'));
    else c.append(el('span', 'review-add', `+${f.added}`), el('span', 'review-del', `-${f.removed}`));
    li.append(path, c);
    list.append(li);
  }
  stat.append(list);
  return stat;
}

function renderFile(f) {
  const sec = el('div', 'review-file');
  sec.dataset.status = f.status;
  const head = el('div', 'review-file-head');
  head.append(el('span', 'review-file-path', f.path));
  head.append(el('span', 'review-file-tag', f.status));
  sec.append(head);

  if (f.binary) {
    sec.append(el('div', 'review-file-binary', 'Binary file not shown'));
    return sec;
  }

  // Flatten the hunks into rendered rows, capped for performance.
  let rendered = 0;
  let truncated = false;
  for (const h of f.hunks) {
    if (rendered >= MAX_FILE_LINES && !expanded.has(f.path)) { truncated = true; break; }
    sec.append(el('div', 'review-hunk-head', h.header));
    for (const line of h.lines) {
      if (rendered >= MAX_FILE_LINES && !expanded.has(f.path)) { truncated = true; break; }
      const row = el('div', `review-line review-line-${line.type}`);
      const gutter = line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'meta' ? '\\' : ' ';
      row.append(el('span', 'review-line-gutter', gutter));
      row.append(el('span', 'review-line-text', line.text));
      sec.append(row);
      rendered++;
    }
    if (truncated) break;
  }
  if (truncated) {
    const more = el('button', 'review-expand', 'Show the rest of this file');
    more.type = 'button';
    more.addEventListener('click', () => { expanded.add(f.path); render(); });
    sec.append(more);
  }
  return sec;
}

function renderActions(id, status, reviewable, canFinish) {
  const actions = el('div', 'review-actions');

  const refresh = el('button', 'review-btn review-btn-ghost', 'Refresh diff');
  refresh.type = 'button';
  refresh.addEventListener('click', () => requestDiff(id));
  actions.append(refresh);

  if (canFinish) {
    const finish = el('button', 'review-btn review-btn-primary', 'Merge & finish');
    finish.type = 'button';
    finish.title = 'End the session if running, merge into develop, clean up the worktree, and return to dormant';
    finish.disabled = status === 'merging';
    finish.addEventListener('click', () => sendControlMsg({ type: 'finish-session', id }));
    actions.append(finish);
  }

  // Discard throws the worktree away; only offered once the session has settled (no live PTY in it).
  if (reviewable) {
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
