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
// Enough to span the first line of any history or transcript file, small enough to re-read on every drain.
const HEAD_SAMPLE_BYTES = 512;
// Directory mtimes come off a COARSE clock (4ms on a stock Linux tick, a whole second on ext3 and FAT), so a child created in the tick a listing already read leaves an mtime that never moves again.
const LISTING_SETTLE_MS = 2000;

function finiteOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number;
}

// A negative test only: Linux reuses the inode and the coarse-tick creation time of a file recreated in the same directory (measured on 6.1: 200 of 200 kept both), so only headChanged proves sameness.
function fileIdentity(stat) {
  return `${Math.floor(finiteOr(stat?.ino, 0))}:${Math.floor(finiteOr(stat?.birthtimeMs, 0))}`;
}

// latin1 so the prefix comparison in headChanged is byte-exact whatever the window cut through.
function headSample(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  return bytes.subarray(0, HEAD_SAMPLE_BYTES).toString('latin1');
}

function headChanged(state, head) {
  const recorded = state?.head;
  if (typeof recorded !== 'string' || recorded.length === 0) return false;
  if (typeof head !== 'string') return false;
  return !head.startsWith(recorded);
}

function createTailState(stat, { path: filePath = null, head = null } = {}) {
  const size = Math.max(0, Math.floor(finiteOr(stat?.size, 0)));
  return {
    path: filePath,
    identity: fileIdentity(stat),
    size,
    mtimeMs: finiteOr(stat?.mtimeMs, 0),
    offset: size,
    carry: '',
    head: typeof head === 'string' ? head : null,
    vendorState: null,
  };
}

function skipPlan(state) {
  return {
    action: 'skip', start: state.offset, end: state.offset, reset: false, dropPartial: false, sampleHead: false,
  };
}

/**
 * What the next read of this file should be. `reset` means the state no longer describes the bytes on
 * disk (a truncation, or a file recreated at the same path), so the carry and any vendor state go with
 * it. `dropPartial` means the read skipped ahead to stay inside the catch-up bound, so its first line
 * starts mid-sentence and is discarded. `sampleHead` asks the caller for the file's first bytes beside
 * the range, which is what headChanged judges and what keeps the recorded head growing with the file.
 */
function planRead(state, stat, { maxCatchUpBytes = MAX_CATCH_UP_BYTES } = {}) {
  if (!state) {
    return {
      action: 'seed', start: 0, end: 0, reset: true, dropPartial: false, sampleHead: false,
    };
  }
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
  if (end <= start) {
    return {
      action: 'reset', start, end, reset, dropPartial: false, sampleHead: false,
    };
  }
  return {
    action: 'read', start, end, reset, dropPartial, sampleHead: !reset,
  };
}

/*
 * splitLines drops empty lines, which is right for a JSONL transcript and wrong for a shell history
 * file: PSReadLine writes an embedded newline as a trailing backtick, so a command ENDING in a newline
 * finishes on an empty physical line, and dropping it glues that command to the next one. The carry rule
 * is identical either way, so this is splitLines minus the filter and nothing else.
 */
function splitKeepingEmpty(carry, chunkText) {
  const text = `${carry || ''}${chunkText || ''}`;
  const lines = text.split(/\r?\n/);
  // Doubles as both pops: a text ending in a break splits to a trailing empty (carry '') and one that
  // does not splits to its unterminated tail.
  const nextCarry = lines.pop();
  return { lines, carry: nextCarry || '' };
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
  text = '', end = 0, stat = null, head = null, reset = false, dropPartial = false, keepEmptyLines = false,
} = {}) {
  if (reset || dropPartial) state.carry = '';
  if (reset) {
    state.vendorState = null;
    state.head = null;
  }
  if (typeof head === 'string' && head.length > 0) state.head = head;
  const body = dropPartial ? afterFirstBreak(text) : text;
  const split = keepEmptyLines ? splitKeepingEmpty(state.carry, body) : splitLines(state.carry, body);
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

function canTrustCachedListing({ mtimeMs, listedAtMs } = {}) {
  return finiteOr(listedAtMs, 0) - finiteOr(mtimeMs, 0) >= LISTING_SETTLE_MS;
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
  HEAD_SAMPLE_BYTES,
  LISTING_SETTLE_MS,
  MAX_CATCH_UP_BYTES,
  applyRead,
  canTrustCachedListing,
  createTailState,
  fileIdentity,
  headChanged,
  headSample,
  isActiveMtime,
  pickStaleByMtime,
  planRead,
};
