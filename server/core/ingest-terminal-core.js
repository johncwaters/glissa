/*
 * Pure core of the terminal ingest source (docs/plan-ingestion.md, M6): the per-session accumulator,
 * ANSI stripping, coalescing into one bounded event per flush window, and the drop-not-queue byte
 * budget that keeps a multi-MB burst off the event loop every session shares.
 *
 * The processing here is MECHANICAL only. Nothing in this file tokenizes terminal bytes for meaning:
 * the standing prohibition on parsing PTY content for state detection is untouched, and the model is
 * what interprets the text, exactly as it does buffer text today.
 */

'use strict';

const { MAX_SUMMARY_CHARS: RING_SUMMARY_CHARS, SOURCE_DEFAULTS, scrubText } = require('./ingest-core');

const DEFAULT_ACCUMULATOR_BYTES = SOURCE_DEFAULTS.terminal.accumulatorBytes;
const DEFAULT_WINDOW_BYTES = SOURCE_DEFAULTS.terminal.windowBytes;
const DEFAULT_FLUSH_MS = SOURCE_DEFAULTS.terminal.flushMs;
// Taken from the ring's own bound so the two cannot drift: a summary built longer than the ring keeps
// would be sliced from the front at publish time, which is exactly where the truncation note lives.
const MAX_SUMMARY_CHARS = RING_SUMMARY_CHARS;
const MAX_TEXT_CHARS = 1000;
const TRUNCATION_NOTE = 'output truncated';

/*
 * OSC, CSI, charset designators and the two-character escapes, each in its own alternative and in that
 * order, because a bare-escape rule placed first would eat the introducer of a longer sequence and
 * leave its payload behind as text. Built from strings because the house style keeps literal control
 * characters out of source. Nothing here depends on what a sequence MEANT: it is all mechanical.
 */
const OSC_SEQUENCE = '(?:\\u001B\\]|\\u009D)[^\\u0007\\u001B\\n]*(?:\\u0007|\\u001B\\\\)?';
const CSI_SEQUENCE = '(?:\\u001B\\[|\\u009B)[0-9:;<=>?]*[ -/]*[@-~]';
const CHARSET_SEQUENCE = '\\u001B[()#%][0-9A-Za-z]';
const SIMPLE_ESCAPE = '\\u001B[@-Z\\\\-_=><]';
const ANSI_PATTERN = new RegExp(
  [OSC_SEQUENCE, CSI_SEQUENCE, CHARSET_SEQUENCE, SIMPLE_ESCAPE].join('|'),
  'g',
);
// Everything else that is not printable. The gaps are the two whitespace characters worth keeping:
// tab at 0x09 and newline at 0x0A. Written as escapes for the same reason the sequences above are.
const CONTROL_RANGES = ['\\u0000-\\u0008', '\\u000B-\\u001F', '\\u007F'];
const CONTROL_PATTERN = new RegExp(`[${CONTROL_RANGES.join('')}]`, 'g');

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function stripAnsi(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value) return '';
  return value.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '');
}

/*
 * A LONE carriage return means the emitter rewrote the line in place (a progress bar), so only the text
 * after the last one survives. CRLF is normalized away first: that CR is a line ending, not a rewrite,
 * and treating it as one erases every line of Windows output. Done before the control strip would
 * silently delete the marker either way.
 */
function collapseCarriageReturns(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const lastReturn = line.lastIndexOf('\r');
      return lastReturn === -1 ? line : line.slice(lastReturn + 1);
    })
    .join('\n');
}

function cleanOutput(raw) {
  return stripAnsi(collapseCarriageReturns(typeof raw === 'string' ? raw : ''))
    .split('\n')
    .map((line) => line.replace(/\t/g, '  ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// One bounded line for the ring and the digest: the multi-line tail folded onto itself.
function summarize(text, maxChars = MAX_SUMMARY_CHARS) {
  const folded = text.replace(/\s+/g, ' ').trim();
  if (folded.length <= maxChars) return folded;
  return folded.slice(folded.length - maxChars);
}

function createTerminalAccumulator({
  sessionId = null,
  root = null,
  accumulatorBytes = DEFAULT_ACCUMULATOR_BYTES,
  windowBytes = DEFAULT_WINDOW_BYTES,
  maxSummaryChars = MAX_SUMMARY_CHARS,
  maxTextChars = MAX_TEXT_CHARS,
} = {}) {
  return {
    sessionId,
    root,
    maxAccumulatorBytes: positiveInt(accumulatorBytes, DEFAULT_ACCUMULATOR_BYTES),
    maxWindowBytes: positiveInt(windowBytes, DEFAULT_WINDOW_BYTES),
    maxSummaryChars: positiveInt(maxSummaryChars, MAX_SUMMARY_CHARS),
    maxTextChars: positiveInt(maxTextChars, MAX_TEXT_CHARS),
    pending: '',
    pendingBytes: 0,
    windowBytesSeen: 0,
    droppedBytes: 0,
    truncated: false,
  };
}

// A buffer sliced at an arbitrary offset can start mid-codepoint; those bytes decode as replacement
// characters, so they go rather than ride into a prompt.
function trimLeadingContinuation(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xC0) === 0x80) start += 1;
  return buffer.subarray(start);
}

/*
 * Whole lines only. A byte-exact cap cut can land INSIDE `api_key=secret`, stripping the name the
 * scrub matches on and letting the bare value ride into the ring; a secret assignment never spans a
 * line, so a line-aligned cut can only ever drop one whole. A window holding no break at all keeps
 * what it has rather than emptying itself.
 */
function dropPartialFirstLine(text) {
  const firstBreak = text.indexOf('\n');
  if (firstBreak === -1) return text;
  return text.slice(firstBreak + 1) || text;
}

/**
 * Backpressure is decided HERE, before any decoding. Past the per-window budget a chunk is dropped
 * outright and never queued, which is what bounds the event-loop cost of a multi-MB burst; inside the
 * budget the accumulator keeps only its newest bytes. Either way the event says it was truncated.
 */
function appendChunk(state, chunk) {
  const text = typeof chunk === 'string' ? chunk : String(chunk == null ? '' : chunk);
  if (!text) return state;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (state.windowBytesSeen >= state.maxWindowBytes) {
    state.windowBytesSeen += bytes;
    state.droppedBytes += bytes;
    state.truncated = true;
    return state;
  }
  state.windowBytesSeen += bytes;
  state.pending += text;
  state.pendingBytes += bytes;
  if (state.pendingBytes <= state.maxAccumulatorBytes) return state;
  const heldBytes = state.pendingBytes;
  const kept = trimLeadingContinuation(
    Buffer.from(state.pending, 'utf8').subarray(heldBytes - state.maxAccumulatorBytes),
  );
  state.pending = dropPartialFirstLine(kept.toString('utf8'));
  state.pendingBytes = Buffer.byteLength(state.pending, 'utf8');
  state.droppedBytes += heldBytes - state.pendingBytes;
  state.truncated = true;
  return state;
}

// The screen was rewritten, so pending bytes no longer describe appended output.
function rebaseline(state) {
  state.pending = '';
  state.pendingBytes = 0;
  state.windowBytesSeen = 0;
  state.droppedBytes = 0;
  state.truncated = false;
  return state;
}

/**
 * One flush window drained into at most one event. A window whose bytes cleaned away to nothing
 * publishes nothing at all rather than an empty event, and the window budget resets either way.
 */
function flushAccumulator(state, { now = Date.now() } = {}) {
  const raw = state.pending;
  const truncated = state.truncated;
  const droppedBytes = state.droppedBytes;
  rebaseline(state);
  /*
   * SCRUB BEFORE ANY SLICING. summarize() and the detail tail below both cut from the FRONT, and a cut
   * through `api_key=secret` strips the very name the scrub matches on, so scrubbing afterwards lets
   * the bare value through into the ring, the activity feed and the dispatch prompt's digest. The
   * publish-time scrub in ingest-core still runs behind this one; it cannot repair a cut already made.
   */
  const text = scrubText(cleanOutput(raw));
  if (!text) return null;
  // The note is budgeted INTO the summary and appended after the slice, never past it: the ring's own
  // cap slices from the front and would otherwise cut the note off the one event that needed it.
  const note = truncated ? ` [${TRUNCATION_NOTE}]` : '';
  const summary = summarize(text, state.maxSummaryChars - note.length);
  if (!summary) return null;
  return {
    source: 'terminal',
    kind: 'output',
    ts: now,
    scope: { root: state.root, sessionId: state.sessionId },
    summary: `${summary}${note}`,
    detail: {
      text: text.length > state.maxTextChars ? text.slice(text.length - state.maxTextChars) : text,
      truncated,
      droppedBytes,
    },
  };
}

module.exports = {
  DEFAULT_ACCUMULATOR_BYTES,
  DEFAULT_FLUSH_MS,
  DEFAULT_WINDOW_BYTES,
  MAX_SUMMARY_CHARS,
  TRUNCATION_NOTE,
  appendChunk,
  cleanOutput,
  createTerminalAccumulator,
  flushAccumulator,
  rebaseline,
  stripAnsi,
  summarize,
};
