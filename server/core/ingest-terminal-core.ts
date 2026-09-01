
import { MAX_SUMMARY_CHARS as RING_SUMMARY_CHARS, SOURCE_DEFAULTS, scrubText } from './ingest-core.ts';
import { positiveInt } from './ingest-number-core.ts';

const DEFAULT_ACCUMULATOR_BYTES = SOURCE_DEFAULTS.terminal.accumulatorBytes;
const DEFAULT_WINDOW_BYTES = SOURCE_DEFAULTS.terminal.windowBytes;
const DEFAULT_FLUSH_MS = SOURCE_DEFAULTS.terminal.flushMs;
const MAX_SUMMARY_CHARS = RING_SUMMARY_CHARS;
const MAX_TEXT_CHARS = 1000;
const TRUNCATION_NOTE = 'output truncated';

export interface TerminalAccumulator {
  sessionId: string | null;
  root: string | null;
  maxAccumulatorBytes: number;
  maxWindowBytes: number;
  maxSummaryChars: number;
  maxTextChars: number;
  pending: string;
  pendingBytes: number;
  windowBytesSeen: number;
  droppedBytes: number;
  truncated: boolean;
  lastPublishedText: string;
}

export type TerminalIngestEvent = {
  source: string;
  kind: string;
  ts: number;
  scope: { root: string | null; sessionId: string | null };
  summary: string;
  detail: { text: string; truncated: boolean; droppedBytes: number };
}

const OSC_SEQUENCE = '(?:\\u001B\\]|\\u009D)[^\\u0007\\u001B\\n]*(?:\\u0007|\\u001B\\\\)?';
const CSI_SEQUENCE = '(?:\\u001B\\[|\\u009B)[0-9:;<=>?]*[ -/]*[@-~]';
const CHARSET_SEQUENCE = '\\u001B[()#%][0-9A-Za-z]';
const SIMPLE_ESCAPE = '\\u001B[@-Z\\\\-_=><]';
const ANSI_PATTERN = new RegExp(
  [OSC_SEQUENCE, CSI_SEQUENCE, CHARSET_SEQUENCE, SIMPLE_ESCAPE].join('|'),
  'g',
);
const CONTROL_RANGES = ['\\u0000-\\u0008', '\\u000B-\\u001F', '\\u007F'];
const CONTROL_PATTERN = new RegExp(`[${CONTROL_RANGES.join('')}]`, 'g');

const CSI_INTRO = '(?:\\u001B\\[|\\u009B)';
const MOTION_FINALS = 'A-GHIZSTabdef\\u0060rsu';
const CURSOR_MOTION_SEQUENCE = `${CSI_INTRO}[0-9;]*[${MOTION_FINALS}]`;
const ALT_SCREEN_SEQUENCE = `${CSI_INTRO}\\?(?:1049|1047|47)[hl]`;
const SAVE_RESTORE_SEQUENCE = '\\u001B[78]';
const ERASE_DISPLAY_SEQUENCE = `${CSI_INTRO}[0-9;]*J`;
const ERASE_LINE_SEQUENCE = `${CSI_INTRO}[0-9;]*K`;

const SEGMENT_PATTERN = new RegExp([
  `(?:${OSC_SEQUENCE})`,
  `(?<altScreen>${ALT_SCREEN_SEQUENCE})`,
  `(?<eraseDisplay>${ERASE_DISPLAY_SEQUENCE})`,
  `(?<eraseLine>${ERASE_LINE_SEQUENCE})`,
  `(?<motion>${CURSOR_MOTION_SEQUENCE})`,
  `(?<saveRestore>${SAVE_RESTORE_SEQUENCE})`,
  `(?:${CSI_SEQUENCE}|${CHARSET_SEQUENCE}|${SIMPLE_ESCAPE})`,
].join('|'), 'g');

const ERASE_PARAMETERS = new RegExp(`^${CSI_INTRO}(?<parameters>[0-9;]*)[JK]$`);

function erasesBehindCursor(sequence: string): boolean {
  const match = ERASE_PARAMETERS.exec(sequence);
  if (!match) return false;
  if (!match.groups) return false;
  const firstParameter = match.groups.parameters.split(';')[0];
  return Number(firstParameter || 0) >= 1;
}

function segmentLines(raw: unknown): { lines: string[]; carry: string } {
  const text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
  const lines: string[] = [];
  let line = '';
  let repositioned = false;
  let poisoned = false;
  let erased = false;
  let carryStart = 0;

  function endLine(): void {
    if (!poisoned && (line || !erased)) lines.push(line);
    line = '';
    poisoned = false;
    repositioned = false;
    erased = false;
  }

  function writeRun(run: string): void {
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

  function consumeText(chunk: string, offset: number): void {
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

  function applyToken(match: RegExpExecArray): void {
    const groups = match.groups ?? {};
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
  return { lines, carry: text.slice(carryStart) };
}

function stripAnsi(text: unknown): string {
  const value = typeof text === 'string' ? text : '';
  if (!value) return '';
  return value.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '');
}

function collapseCarriageReturns(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const lastReturn = line.lastIndexOf('\r');
      if (lastReturn === -1) return line;
      return line.slice(lastReturn + 1);
    })
    .join('\n');
}

function cleanOutput(raw: unknown): string {
  return stripAnsi(collapseCarriageReturns(typeof raw === 'string' ? raw : ''))
    .split('\n')
    .map((line) => line.replace(/\t/g, '  ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function summarize(text: string, maxChars: number = MAX_SUMMARY_CHARS): string {
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
}: {
  sessionId?: string | null;
  root?: string | null;
  accumulatorBytes?: number;
  windowBytes?: number;
  maxSummaryChars?: number;
  maxTextChars?: number;
} = {}): TerminalAccumulator {
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
    lastPublishedText: '',
  };
}

function trimLeadingContinuation(buffer: Buffer): Buffer {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xC0) === 0x80) start += 1;
  return buffer.subarray(start);
}

function dropPartialFirstLine(text: string): string {
  const firstBreak = text.indexOf('\n');
  if (firstBreak === -1) return text;
  return text.slice(firstBreak + 1) || text;
}

function appendChunk(state: TerminalAccumulator, chunk: unknown): TerminalAccumulator {
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

function rebaseline(state: TerminalAccumulator): TerminalAccumulator {
  state.pending = '';
  state.pendingBytes = 0;
  state.windowBytesSeen = 0;
  state.droppedBytes = 0;
  state.truncated = false;
  state.lastPublishedText = '';
  return state;
}

function flushAccumulator(
  state: TerminalAccumulator,
  { now = Date.now() }: { now?: number } = {},
): TerminalIngestEvent | null {
  const { lines, carry } = segmentLines(state.pending);
  state.pending = carry;
  state.pendingBytes = Buffer.byteLength(carry, 'utf8');
  state.windowBytesSeen = 0;
  const truncated = state.truncated;
  const droppedBytes = state.droppedBytes;
  const text = scrubText(cleanOutput(lines.join('\n')));
  if (!text) return null;
  if (text === state.lastPublishedText) return null;
  const note = truncated ? ` [${TRUNCATION_NOTE}]` : '';
  const summary = summarize(text, state.maxSummaryChars - note.length);
  if (!summary) return null;
  state.lastPublishedText = text;
  state.truncated = false;
  state.droppedBytes = 0;
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

export {
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
