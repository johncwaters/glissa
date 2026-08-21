/*
 * Pure per-file tail state for the file-backed ingest sources (docs/plan-ingestion.md, M7): where the
 * next read starts, what a size shrink or a file recreated at the same path means, and how appended
 * bytes become whole lines. It COMPOSES the offset rules already exported from usage-scan-core rather
 * than restating them, so the usage lane stays the one place those rules live and server/usage-scanner.js
 * is not touched at all.
 *
 * First sight of a file starts at END OF FILE. Ingestion is about recent activity, and replaying a
 * 200MB history file into the rings on daemon start is exactly the cost this plan exists to avoid.
 *
 * Nothing here knows what a line MEANS: this is the shared tail machinery the plan also hands to the
 * shellHistory source, so vendor transcript shapes live next door in ingest-agent-core.js.
 */

'use strict';

const { decideFileRead, splitLines } = require('./usage-scan-core');

// One read never spans more than this, so a file that grew by 50MB while the daemon was busy costs one
// bounded read of its newest bytes rather than a stall on the event loop every session shares.
const MAX_CATCH_UP_BYTES = 256 * 1024;
const DEFAULT_MAX_TRACKED = 256;

function finiteOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number;
}

/*
 * A path is the same file only while its inode and creation time both hold. Node fills in both on
 * Windows and POSIX, and a path whose file was deleted and recreated is a NEW file whose earlier offset
 * describes bytes that no longer exist.
 */
function fileIdentity(stat) {
  return `${Math.floor(finiteOr(stat?.ino, 0))}:${Math.floor(finiteOr(stat?.birthtimeMs, 0))}`;
}

function createTailState(stat, { path: filePath = null } = {}) {
  const size = Math.max(0, Math.floor(finiteOr(stat?.size, 0)));
  return {
    path: filePath,
    identity: fileIdentity(stat),
    size,
    mtimeMs: finiteOr(stat?.mtimeMs, 0),
    offset: size,
    carry: '',
    vendorState: null,
  };
}

function skipPlan(state) {
  return { action: 'skip', start: state.offset, end: state.offset, reset: false, dropPartial: false };
}

/**
 * What the next read of this file should be. `reset` means the state no longer describes the bytes on
 * disk (a truncation, or a file recreated at the same path), so the carry and any vendor state go with
 * it. `dropPartial` means the read skipped ahead to stay inside the catch-up bound, so its first line
 * starts mid-sentence and is discarded.
 */
function planRead(state, stat, { maxCatchUpBytes = MAX_CATCH_UP_BYTES } = {}) {
  if (!state) return { action: 'seed', start: 0, end: 0, reset: true, dropPartial: false };
  if (!stat || typeof stat.size !== 'number') return skipPlan(state);
  const rotated = fileIdentity(stat) !== state.identity;
  const decision = decideFileRead({ size: state.size, mtimeMs: state.mtimeMs, offset: state.offset }, stat);
  if (!rotated && decision.action === 'skip') return skipPlan(state);
  const reset = rotated || decision.action === 'restart';
  const end = Math.max(0, Math.floor(stat.size));
  let start = Math.min(Math.max(0, decision.readFrom), end);
  if (reset) start = 0;
  let dropPartial = false;
  const bound = Math.max(1, Math.floor(maxCatchUpBytes));
  if (end - start > bound) {
    start = end - bound;
    dropPartial = true;
  }
  if (end <= start) return { action: 'reset', start, end, reset, dropPartial: false };
  return { action: 'read', start, end, reset, dropPartial };
}

// Everything before the first break belongs to a line whose start was skipped past, so it goes rather
// than riding into a prompt as half a sentence. A chunk holding no break at all was all one such line.
function afterFirstBreak(text) {
  const firstBreak = text.indexOf('\n');
  if (firstBreak === -1) return '';
  return text.slice(firstBreak + 1);
}

/**
 * Fold one read into the state and hand back the COMPLETE lines it produced. A trailing partial line
 * becomes the carry, which the next read prepends, so a line split across two reads arrives whole once.
 */
function applyRead(state, {
  text = '', end = 0, stat = null, reset = false, dropPartial = false,
} = {}) {
  if (reset || dropPartial) state.carry = '';
  if (reset) state.vendorState = null;
  const body = dropPartial ? afterFirstBreak(text) : text;
  const split = splitLines(state.carry, body);
  state.carry = split.carry;
  state.offset = Math.max(0, Math.floor(finiteOr(end, state.offset)));
  state.size = Math.max(state.offset, Math.floor(finiteOr(stat?.size, state.offset)));
  state.mtimeMs = finiteOr(stat?.mtimeMs, state.mtimeMs);
  if (stat) state.identity = fileIdentity(stat);
  return split.lines;
}

function isActiveMtime(mtimeMs, { now, withinMs }) {
  return finiteOr(mtimeMs, 0) >= finiteOr(now, 0) - Math.max(0, finiteOr(withinMs, 0));
}

/**
 * Which keys of an mtime-stamped map to forget once it outgrows its bound, oldest first: the entry
 * nothing has touched in the longest is the one least likely to matter again. Used for both the tail
 * states and the directory listing cache, which are bounded by the same reasoning.
 */
function pickStaleByMtime(entriesByKey, { maxTracked = DEFAULT_MAX_TRACKED } = {}) {
  const entries = [...entriesByKey.entries()];
  const bound = Math.max(1, Math.floor(maxTracked));
  if (entries.length <= bound) return [];
  entries.sort((left, right) => finiteOr(left[1]?.mtimeMs, 0) - finiteOr(right[1]?.mtimeMs, 0));
  return entries.slice(0, entries.length - bound).map(([key]) => key);
}

module.exports = {
  DEFAULT_MAX_TRACKED,
  MAX_CATCH_UP_BYTES,
  applyRead,
  createTailState,
  fileIdentity,
  isActiveMtime,
  pickStaleByMtime,
  planRead,
};
