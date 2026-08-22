/*
 * Pure core of the terminal ingest source (docs/plan-ingestion.md, M6 and the TUI repaint filtering
 * decision record): the per-session accumulator, repaint segmentation, ANSI stripping, coalescing into
 * one bounded event per flush window, and the drop-not-queue byte budget that keeps a multi-MB burst
 * off the event loop every session shares.
 *
 * The processing here is MECHANICAL only. Nothing in this file tokenizes terminal bytes for meaning:
 * the standing prohibition on parsing PTY content for state detection is untouched, and the model is
 * what interprets the text, exactly as it does buffer text today.
 *
 * A glissa session runs the Claude Code TUI, which PAINTS a screen rather than appending output.
 * Stripping the escape sequences out of a painted frame keeps every character the sequences were
 * positioning and loses the positions, so the frame arrives as shredded fragments. Segmentation is the
 * answer, and it reads ANSI STRUCTURE only: where the cursor was moved, and whether a run of text was
 * newline-terminated. It never looks at what the characters say.
 */

'use strict';

const { MAX_SUMMARY_CHARS: RING_SUMMARY_CHARS, SOURCE_DEFAULTS, scrubText } = require('./ingest-core');
const { positiveInt } = require('./ingest-number-core');

const DEFAULT_ACCUMULATOR_BYTES = SOURCE_DEFAULTS.terminal.accumulatorBytes;
const DEFAULT_WINDOW_BYTES = SOURCE_DEFAULTS.terminal.windowBytes;
const DEFAULT_FLUSH_MS = SOURCE_DEFAULTS.terminal.flushMs;
// Taken from the ring's own bound so the two cannot drift: a summary built longer than the ring keeps
// would be sliced from the front at publish time, which is exactly where the truncation note lives.
const MAX_SUMMARY_CHARS = RING_SUMMARY_CHARS;
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

/*
 * The segmentation alphabet. Only two things about a sequence matter here: does it MOVE the cursor
 * somewhere a linear reader cannot predict, and does it erase text that was already written.
 *
 * Motion finals, in ANSI order: CUU/CUD/CUF/CUB (A-D), CNL/CPL (E,F), CHA (G), CUP (H), CHT (I),
 * CBT (Z), SU/SD (S,T), HVP (f), VPA (d), HPA (backtick), HPR (a), CBT-alt (b), VPR (e), DECSTBM (r),
 * SCP/RCP (s,u). J and K are deliberately absent: they erase, they do not move.
 */
const CSI_INTRO = '(?:\\u001B\\[|\\u009B)';
const MOTION_FINALS = 'A-GHIZSTabdef\\u0060rsu';
const CURSOR_MOTION_SEQUENCE = `${CSI_INTRO}[0-9;]*[${MOTION_FINALS}]`;
// Entering or leaving the alternate screen replaces everything on it, so it counts as motion too.
const ALT_SCREEN_SEQUENCE = `${CSI_INTRO}\\?(?:1049|1047|47)[hl]`;
// DECSC and DECRC save and restore the cursor, which is a jump the linear stream cannot follow.
const SAVE_RESTORE_SEQUENCE = '\\u001B[78]';
const ERASE_DISPLAY_SEQUENCE = `${CSI_INTRO}[0-9;]*J`;
const ERASE_LINE_SEQUENCE = `${CSI_INTRO}[0-9;]*K`;

/*
 * One pass over the raw window, each alternative the walker acts on in a NAMED group so it can tell a
 * jump from a colour change without any alternative knowing its own position: adding or reordering one
 * cannot silently retarget another, which a table of numeric indices beside this pattern could not
 * promise. Order is still significant for MATCHING: the erase and motion forms are more specific than
 * the general CSI catch-all that follows them, and OSC comes first because its payload can contain
 * anything. The two forms the walker ignores stay uncaptured.
 */
const SEGMENT_PATTERN = new RegExp([
  `(?:${OSC_SEQUENCE})`,
  `(?<altScreen>${ALT_SCREEN_SEQUENCE})`,
  `(?<eraseDisplay>${ERASE_DISPLAY_SEQUENCE})`,
  `(?<eraseLine>${ERASE_LINE_SEQUENCE})`,
  `(?<motion>${CURSOR_MOTION_SEQUENCE})`,
  `(?<saveRestore>${SAVE_RESTORE_SEQUENCE})`,
  `(?:${CSI_SEQUENCE}|${CHARSET_SEQUENCE}|${SIMPLE_ESCAPE})`,
].join('|'), 'g');

// The parameter list of an erase, taken off the sequence the walker matched rather than scanned for.
const ERASE_PARAMETERS = new RegExp(`^${CSI_INTRO}(?<parameters>[0-9;]*)[JK]$`);

/*
 * An erase with no parameter, or parameter 0, reaches FORWARD from the cursor and leaves what was
 * already written alone; 1, 2 and 3 reach back over it. That distinction is why a plain `ESC[K` at the
 * end of a coloured line does not cost the line, while a status bar rewriting itself with `ESC[2K`
 * loses what it just overwrote. It is read off the FIRST parameter, never guessed: an omitted parameter
 * is 0 by the ANSI default, which is what `ESC[;2K` means and what a scan for any digit gets wrong.
 */
function erasesBehindCursor(sequence) {
  const match = ERASE_PARAMETERS.exec(sequence);
  if (!match) return false;
  const firstParameter = match.groups.parameters.split(';')[0];
  return Number(firstParameter || 0) >= 1;
}

/**
 * Split a raw flush window into the COMPLETE lines of genuine linear output it contained, plus the
 * unterminated tail to carry into the next window.
 *
 * The rule is mechanical and has two halves. Text written after the cursor was moved, with no newline
 * since, is a repaint fragment and is dropped along with whatever else was on that line: a painted
 * screen writes cells at positions, so its characters never form a line. Text that reaches a newline
 * having never been repositioned is linear output and is kept. A newline restores a known position, so
 * it clears the suspicion; a lone carriage return rewrites the line, so it drops what was on it.
 *
 * A line left empty because something ERASED it contributed nothing and does not publish; a line that
 * was simply blank is real output and does, which is what keeps a paragraph break in a build log.
 */
function segmentLines(raw) {
  const text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
  const lines = [];
  let line = '';
  let repositioned = false;
  let poisoned = false;
  let erased = false;
  let carryStart = 0;

  function endLine() {
    if (!poisoned && (line || !erased)) lines.push(line);
    line = '';
    poisoned = false;
    repositioned = false;
    erased = false;
  }

  function writeRun(run) {
    // Split on lone carriage returns: each one restarts the line in place, the progress-bar idiom.
    const rewrites = run.split('\r');
    for (let index = 0; index < rewrites.length; index += 1) {
      if (index > 0) {
        line = '';
        poisoned = false;
        erased = true;
      }
      const piece = rewrites[index];
      if (!piece) continue;
      if (repositioned) {
        poisoned = true;
        continue;
      }
      line += piece;
      erased = false;
    }
  }

  // The offset is the chunk's position in the raw text, so the carry can be cut where the walk itself
  // saw the last newline rather than wherever a blind scan finds one.
  function consumeText(chunk, offset) {
    if (!chunk) return;
    const parts = chunk.split('\n');
    let consumed = 0;
    for (let index = 0; index < parts.length; index += 1) {
      writeRun(parts[index]);
      consumed += parts[index].length;
      if (index === parts.length - 1) continue;
      endLine();
      consumed += 1;
      carryStart = offset + consumed;
    }
  }

  function applyToken(match) {
    const groups = match.groups;
    if (groups.motion || groups.saveRestore) {
      repositioned = true;
      return;
    }
    if (groups.altScreen) {
      repositioned = true;
      line = '';
      poisoned = false;
      erased = true;
      return;
    }
    const erase = groups.eraseDisplay || groups.eraseLine;
    if (!erase || !erasesBehindCursor(erase)) return;
    line = '';
    poisoned = false;
    erased = true;
  }

  SEGMENT_PATTERN.lastIndex = 0;
  let cursor = 0;
  let match = SEGMENT_PATTERN.exec(text);
  while (match) {
    consumeText(text.slice(cursor, match.index), cursor);
    applyToken(match);
    cursor = match.index + match[0].length;
    match = SEGMENT_PATTERN.exec(text);
  }
  consumeText(text.slice(cursor), cursor);
  /*
   * The carry is the RAW tail after the last newline the walk CONSUMED AS TEXT, and the walk always
   * reaches that newline with every flag cleared, so re-reading the carry from a clean state next window
   * reproduces exactly this window's treatment of it. That is what lets the carry travel as bytes with
   * no state beside it. Taking the offset from the walk rather than scanning the raw text keeps the two
   * from disagreeing if a sequence ever comes to span a newline.
   */
  return { lines, carry: text.slice(carryStart) };
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
} = {}) {
  return {
    sessionId,
    root,
    maxAccumulatorBytes: positiveInt(accumulatorBytes, DEFAULT_ACCUMULATOR_BYTES),
    maxWindowBytes: positiveInt(windowBytes, DEFAULT_WINDOW_BYTES),
    maxSummaryChars: positiveInt(maxSummaryChars, MAX_SUMMARY_CHARS),
    pending: '',
    pendingBytes: 0,
    windowBytesSeen: 0,
    truncated: false,
    // A repainting TUI settles on the same screen over and over; publishing it once is enough.
    lastPublishedText: '',
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
  state.truncated = true;
  return state;
}

// The screen was rewritten, so pending bytes no longer describe appended output.
function rebaseline(state) {
  state.pending = '';
  state.pendingBytes = 0;
  state.windowBytesSeen = 0;
  state.truncated = false;
  // The gate suppresses a screen REPAINTING itself; a rewritten screen is a new stream, and the dead
  // one's last line must not mute the identical first line the restarted process writes.
  state.lastPublishedText = '';
  return state;
}

/**
 * One flush window drained into at most one event. A window whose bytes were all repaint, or all
 * escape sequence, or an unfinished line, publishes nothing at all rather than an empty event.
 *
 * The window BUDGET resets either way, because it measures backpressure over a flush interval. The
 * truncation flags do not: they describe the text still waiting in the accumulator, so they travel with
 * it until the line they belong to actually goes out.
 */
function flushAccumulator(state, { now = Date.now() } = {}) {
  const { lines, carry } = segmentLines(state.pending);
  // Only COMPLETE lines publish. The unterminated tail waits for the newline that finishes it, which is
  // also why a TUI that paints cells and never emits a newline publishes nothing at all.
  state.pending = carry;
  state.pendingBytes = Buffer.byteLength(carry, 'utf8');
  state.windowBytesSeen = 0;
  const truncated = state.truncated;
  /*
   * SCRUB BEFORE ANY SLICING. summarize() and the detail tail below both cut from the FRONT, and a cut
   * through `api_key=secret` strips the very name the scrub matches on, so scrubbing afterwards lets
   * the bare value through into the ring, the activity feed and the dispatch prompt's digest. The
   * publish-time scrub in ingest-core still runs behind this one; it cannot repair a cut already made.
   */
  const text = scrubText(cleanOutput(lines.join('\n')));
  if (!text) return null;
  // A screen that settles on what it already said is the same screen, not new output.
  if (text === state.lastPublishedText) return null;
  // The note is budgeted INTO the summary and appended after the slice, never past it: the ring's own
  // cap slices from the front and would otherwise cut the note off the one event that needed it.
  const note = truncated ? ` [${TRUNCATION_NOTE}]` : '';
  const summary = summarize(text, state.maxSummaryChars - note.length);
  if (!summary) return null;
  state.lastPublishedText = text;
  state.truncated = false;
  return {
    source: 'terminal',
    kind: 'output',
    ts: now,
    scope: { root: state.root, sessionId: state.sessionId },
    summary: `${summary}${note}`,
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
  segmentLines,
  stripAnsi,
  summarize,
};
