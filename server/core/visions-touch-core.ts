import type { ContentChange } from './visions-buffer-core.ts';
import {
  lineOfOffset, lineStartOffsets, offsetOfPosition, replacedSpanOfWholeTextChange,
} from './visions-buffer-core.ts';

export interface TouchedRange {
  start: number;
  end: number;
}

export interface TouchState {
  touchedByUri: Map<string, TouchedRange[]>;
}

interface ChangeSpan {
  replacedStart: number;
  replacedEnd: number;
  lastLineLosingText: number;
  producedStart: number;
  producedEnd: number;
  delta: number;
  insertsWholeLinesBefore: boolean;
}

function createTouchState(): TouchState {
  return { touchedByUri: new Map<string, TouchedRange[]>() };
}

function lineBreakCount(text: unknown): number {
  return lineStartOffsets(typeof text === 'string' ? text : '').length - 1;
}

function endsWithLineBreak(text: unknown): boolean {
  return typeof text === 'string' && /(?:\r\n|\r|\n)$/.test(text);
}

function contentLineCount(text: unknown): number {
  const value = typeof text === 'string' ? text : '';
  if (!value) return 0;
  const counted = value.endsWith('\n') ? value.slice(0, -1) : value;
  if (!counted) return 1;
  return counted.split('\n').length;
}

function producedEndOf({ producedEnd, producedStart, insertedText, insertedAtLineStart }: {
  producedEnd: number;
  producedStart: number;
  insertedText: unknown;
  insertedAtLineStart: boolean;
}): number {
  if (!endsWithLineBreak(insertedText) || !insertedAtLineStart) return producedEnd;
  return Math.max(producedStart, producedEnd - 1);
}

function lastLineLosingTextOf({ beforeStarts, replacedStart, replacedEnd, removedLength, removedEndOffset }: {
  beforeStarts: number[];
  replacedStart: number;
  replacedEnd: number;
  removedLength: number;
  removedEndOffset: number;
}): number {
  if (removedLength <= 0) return replacedEnd;
  if (!beforeStarts.includes(removedEndOffset)) return replacedEnd;
  return Math.max(replacedStart, replacedEnd - 1);
}

function insertionRotatedToLineStart({ textBefore, beforeStarts, offset, insertedText }: {
  textBefore: string;
  beforeStarts: number[];
  offset: number;
  insertedText: string;
}): { offset: number; insertedText: string } {
  let rotatedOffset = offset;
  let rotatedText = insertedText;
  while (rotatedOffset > 0 && !beforeStarts.includes(rotatedOffset)) {
    const lastInsertedChar = rotatedText.at(-1);
    if (lastInsertedChar === undefined || textBefore[rotatedOffset - 1] !== lastInsertedChar) break;
    rotatedText = `${lastInsertedChar}${rotatedText.slice(0, -1)}`;
    rotatedOffset -= 1;
  }
  return { offset: rotatedOffset, insertedText: rotatedText };
}

function mergeRanges(ranges: TouchedRange[]): TouchedRange[] {
  const sorted = ranges
    .filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 1 && range.end >= range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TouchedRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

function spanOfChange(change: ContentChange | null | undefined, textBefore: string): ChangeSpan | null {
  if (!change || typeof change !== 'object') return null;
  if (change.range === undefined || change.range === null) {
    const nextText = typeof change.text === 'string' ? change.text : '';
    const span = replacedSpanOfWholeTextChange(textBefore, nextText);
    if (!span) return null;
    const beforeStarts = lineStartOffsets(textBefore);
    const afterStarts = lineStartOffsets(nextText);
    const isPureInsertion = span.removedText.length === 0;
    const insertion = isPureInsertion
      ? insertionRotatedToLineStart({
        textBefore, beforeStarts, offset: span.offset, insertedText: span.insertedText,
      })
      : { offset: span.offset, insertedText: span.insertedText };
    const start = lineOfOffset(beforeStarts, insertion.offset);
    const removedEndOffset = span.offset + span.removedText.length;
    const replacedEnd = lineOfOffset(beforeStarts, removedEndOffset);
    const insertedAtLineStart = beforeStarts.includes(insertion.offset);
    return {
      replacedStart: start,
      replacedEnd,
      lastLineLosingText: lastLineLosingTextOf({
        beforeStarts, replacedStart: start, replacedEnd, removedLength: span.removedText.length, removedEndOffset,
      }),
      producedStart: start,
      producedEnd: producedEndOf({
        producedStart: start,
        producedEnd: lineOfOffset(afterStarts, insertion.offset + insertion.insertedText.length),
        insertedText: insertion.insertedText,
        insertedAtLineStart,
      }),
      delta: afterStarts.length - beforeStarts.length,
      insertsWholeLinesBefore: insertedAtLineStart && isPureInsertion && endsWithLineBreak(insertion.insertedText),
    };
  }
  const { range } = change;
  const beforeStarts = lineStartOffsets(textBefore);
  const startOffset = offsetOfPosition(textBefore, beforeStarts, range.start);
  const endOffset = offsetOfPosition(textBefore, beforeStarts, range.end);
  const replacedStart = lineOfOffset(beforeStarts, startOffset);
  const replacedEnd = lineOfOffset(beforeStarts, endOffset);
  const insertedBreaks = lineBreakCount(change.text);
  const insertedAtLineStart = beforeStarts.includes(startOffset);
  return {
    replacedStart,
    replacedEnd,
    lastLineLosingText: lastLineLosingTextOf({
      beforeStarts, replacedStart, replacedEnd, removedLength: endOffset - startOffset, removedEndOffset: endOffset,
    }),
    producedStart: replacedStart,
    producedEnd: producedEndOf({
      producedStart: replacedStart,
      producedEnd: replacedStart + insertedBreaks,
      insertedText: change.text,
      insertedAtLineStart,
    }),
    delta: insertedBreaks - (replacedEnd - replacedStart),
    insertsWholeLinesBefore: insertedAtLineStart && startOffset === endOffset && endsWithLineBreak(change.text),
  };
}

function shiftLine(line: number, span: ChangeSpan): number {
  if (line < span.replacedStart) return line;
  if (line > span.lastLineLosingText) return line + span.delta;
  if (span.insertsWholeLinesBefore) return line + span.delta;
  return Math.min(line, span.producedEnd);
}

function clampLinesToText(lines: number[], text: unknown): number[] {
  const lineCount = contentLineCount(text);
  return lines.map((line) => Math.max(1, Math.min(line, lineCount)));
}

function shiftLines(
  lines: number[],
  pairs: Array<{ change?: ContentChange; textBefore?: unknown }> | null | undefined,
  nextText: unknown,
): number[] {
  const changePairs = Array.isArray(pairs) ? pairs : [];
  let shifted = lines.slice();
  for (let index = 0; index < changePairs.length; index += 1) {
    const pair = changePairs[index];
    const span = spanOfChange(pair?.change, typeof pair?.textBefore === 'string' ? pair.textBefore : '');
    if (!span) continue;
    shifted = shifted.map((line) => shiftLine(line, span));
    const textAfterChange = changePairs[index + 1]?.textBefore;
    if (typeof textAfterChange !== 'string') continue;
    shifted = clampLinesToText(shifted, textAfterChange);
  }
  return clampLinesToText(shifted, nextText);
}

function shiftRanges(ranges: TouchedRange[], span: ChangeSpan): TouchedRange[] {
  const shifted: TouchedRange[] = [];
  for (const range of ranges) {
    if (range.end < span.replacedStart) {
      shifted.push(range);
      continue;
    }
    if (range.start > span.replacedEnd) {
      shifted.push({ start: range.start + span.delta, end: range.end + span.delta });
      continue;
    }
    shifted.push({ start: Math.min(range.start, span.producedStart), end: Math.max(range.end + span.delta, span.producedEnd) });
  }
  return shifted;
}

function clampRanges(ranges: TouchedRange[], lineCount: number): TouchedRange[] {
  if (!Number.isInteger(lineCount) || lineCount < 1) return ranges;
  return ranges
    .map((range) => ({ start: Math.min(range.start, lineCount), end: Math.min(range.end, lineCount) }))
    .filter((range) => range.end >= range.start);
}

function recordChanges(
  state: TouchState,
  uri: string,
  pairs: Array<{ change?: ContentChange; textBefore?: unknown }> | null | undefined,
  nextText: unknown,
): TouchedRange[] {
  if (!uri) return [];
  let ranges = state.touchedByUri.get(uri) || [];
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const span = spanOfChange(pair?.change, typeof pair?.textBefore === 'string' ? pair.textBefore : '');
    if (!span) continue;
    ranges = mergeRanges([...shiftRanges(ranges, span), { start: span.producedStart, end: span.producedEnd }]);
  }
  const lineCount = lineStartOffsets(typeof nextText === 'string' ? nextText : '').length;
  ranges = mergeRanges(clampRanges(ranges, lineCount));
  if (ranges.length === 0) {
    state.touchedByUri.delete(uri);
    return [];
  }
  state.touchedByUri.set(uri, ranges);
  return ranges.map((range) => ({ ...range }));
}

function touchedRangesFor(state: TouchState, uri: string): TouchedRange[] {
  const ranges = state.touchedByUri.get(uri) || [];
  return ranges.map((range) => ({ ...range }));
}

function resetUri(state: TouchState, uri: string | null): TouchState {
  if (!uri) return state;
  state.touchedByUri.delete(uri);
  return state;
}

function touchedLineCount(ranges: unknown): number {
  return (Array.isArray(ranges) ? ranges : [])
    .reduce((total: number, range: TouchedRange) => total + (range.end - range.start + 1), 0);
}

function formatTouchedRanges(ranges: unknown): string {
  return (Array.isArray(ranges) ? ranges : [])
    .map((range: TouchedRange) => (range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`))
    .join(', ');
}

export { createTouchState, formatTouchedRanges, mergeRanges, recordChanges, resetUri, shiftLines, touchedLineCount, touchedRangesFor };
