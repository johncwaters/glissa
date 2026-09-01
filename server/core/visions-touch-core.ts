/*
 * Which lines of an open buffer the carbon unit has edited since it was opened (docs/plan-visions-4-focus.md,
 * M19). Pure: the wiring feeds it the applied changes of each didChange batch and reads the ranges back
 * at dispatch time. Ranges are 1-based inclusive line numbers, merged when they overlap or touch, and
 * shifted when a later edit above them moves the prose they point at.
 */

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
  producedStart: number;
  producedEnd: number;
  delta: number;
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

// Whole new lines inserted at a line start push the old line down intact, so it is not a produced line.
function producedEndOf({ producedEnd, producedStart, insertedText, insertedAtLineStart }: {
  producedEnd: number;
  producedStart: number;
  insertedText: unknown;
  insertedAtLineStart: boolean;
}): number {
  if (!endsWithLineBreak(insertedText) || !insertedAtLineStart) return producedEnd;
  return Math.max(producedStart, producedEnd - 1);
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

/*
 * One change, as the lines it replaced in the text before it and the lines it produced in the text
 * after it. The delta is what every range below the replaced span shifts by.
 */
function spanOfChange(change: ContentChange | null | undefined, textBefore: string): ChangeSpan | null {
  if (!change || typeof change !== 'object') return null;
  if (change.range === undefined || change.range === null) {
    const nextText = typeof change.text === 'string' ? change.text : '';
    const span = replacedSpanOfWholeTextChange(textBefore, nextText);
    if (!span) return null;
    const beforeStarts = lineStartOffsets(textBefore);
    const afterStarts = lineStartOffsets(nextText);
    const start = lineOfOffset(beforeStarts, span.offset);
    return {
      replacedStart: start,
      replacedEnd: lineOfOffset(beforeStarts, span.offset + span.removedText.length),
      producedStart: start,
      producedEnd: producedEndOf({
        producedStart: start,
        producedEnd: lineOfOffset(afterStarts, span.offset + span.insertedText.length),
        insertedText: span.insertedText,
        insertedAtLineStart: beforeStarts.includes(span.offset),
      }),
      delta: afterStarts.length - beforeStarts.length,
    };
  }
  const { range } = change;
  const beforeStarts = lineStartOffsets(textBefore);
  const startOffset = offsetOfPosition(textBefore, beforeStarts, range.start);
  const endOffset = offsetOfPosition(textBefore, beforeStarts, range.end);
  const replacedStart = lineOfOffset(beforeStarts, startOffset);
  const replacedEnd = lineOfOffset(beforeStarts, endOffset);
  const insertedBreaks = lineBreakCount(change.text);
  return {
    replacedStart,
    replacedEnd,
    producedStart: replacedStart,
    producedEnd: producedEndOf({
      producedStart: replacedStart,
      producedEnd: replacedStart + insertedBreaks,
      insertedText: change.text,
      insertedAtLineStart: beforeStarts.includes(startOffset),
    }),
    delta: insertedBreaks - (replacedEnd - replacedStart),
  };
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

// `3-5, 12`: the one line the edit prompt carries, and the log line beside it.
function formatTouchedRanges(ranges: unknown): string {
  return (Array.isArray(ranges) ? ranges : [])
    .map((range: TouchedRange) => (range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`))
    .join(', ');
}

export { createTouchState, formatTouchedRanges, mergeRanges, recordChanges, resetUri, touchedRangesFor };
