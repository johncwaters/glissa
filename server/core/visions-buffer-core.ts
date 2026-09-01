export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface ContentChange {
  range?: Range | null;
  text?: unknown;
}

export interface StoredDoc {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface DocStore {
  docsByUri: Record<string, StoredDoc>;
}

export interface AppliedChange {
  change: ContentChange;
  textBefore: string;
}

interface TextDocumentParams {
  textDocument?: {
    uri?: unknown;
    languageId?: unknown;
    version?: unknown;
    text?: unknown;
  } | null;
  contentChanges?: unknown;
}

function createDocStore(): DocStore {
  return {
    docsByUri: Object.create(null),
  };
}

function uriOfParams(params: TextDocumentParams | null | undefined): string | null {
  const uri = params?.textDocument?.uri;
  if (typeof uri === 'string' && uri !== '') return uri;
  return null;
}

function applyDidOpen(store: DocStore, params: TextDocumentParams | null | undefined) {
  const textDocument = params?.textDocument;
  if (!textDocument || typeof textDocument.uri !== 'string' || !textDocument.uri) {
    return { applied: false, reason: 'invalid-params' };
  }

  store.docsByUri[textDocument.uri] = {
    uri: textDocument.uri,
    languageId: typeof textDocument.languageId === 'string' ? textDocument.languageId : '',
    version: Number(textDocument.version),
    text: typeof textDocument.text === 'string' ? textDocument.text : '',
  };
  return { applied: true };
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n') starts.push(index + 1);

    if (char === '\r' && text[index + 1] !== '\n') starts.push(index + 1);
  }
  return starts;
}

function lineOfOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= offset) {
      low = middle;
      continue;
    }
    high = middle - 1;
  }
  return low + 1;
}

function isPositionShape(position: unknown): position is Position {
  if (!position || typeof position !== 'object') return false;
  const candidate = position as { line?: unknown; character?: unknown };
  if (typeof candidate.line !== 'number' || !Number.isInteger(candidate.line) || candidate.line < 0) return false;
  return typeof candidate.character === 'number' && Number.isInteger(candidate.character) && candidate.character >= 0;
}

function lineEndBeforeBreak(text: string, nextLineStart: number): number {
  const breakIndex = nextLineStart - 1;

  if (breakIndex > 0 && text[breakIndex] === '\n' && text[breakIndex - 1] === '\r') return breakIndex - 1;
  return breakIndex;
}

function offsetOfPosition(text: string, lineStarts: number[], position: Position): number {
  if (position.line >= lineStarts.length) return text.length;
  const lineStart = lineStarts[position.line];
  const nextLineStart = lineStarts[position.line + 1];
  const lineEnd = nextLineStart === undefined ? text.length : lineEndBeforeBreak(text, nextLineStart);
  return Math.min(lineStart + position.character, lineEnd);
}

function applyContentChange(
  text: string,
  change: ContentChange | null | undefined,
): { ok: true; text: string } | { ok: false; reason: string } {
  if (!change || typeof change !== 'object') return { ok: false, reason: 'invalid-range' };
  if (change.range === undefined || change.range === null) {
    return { ok: true, text: typeof change.text === 'string' ? change.text : '' };
  }
  const { range } = change;
  if (typeof range !== 'object' || !isPositionShape(range.start) || !isPositionShape(range.end)) {
    return { ok: false, reason: 'invalid-range' };
  }
  if (typeof change.text !== 'string') return { ok: false, reason: 'invalid-text' };
  const lineStarts = lineStartOffsets(text);
  const start = offsetOfPosition(text, lineStarts, range.start);
  const end = offsetOfPosition(text, lineStarts, range.end);
  if (start > end) return { ok: false, reason: 'invalid-range' };
  return { ok: true, text: text.slice(0, start) + change.text + text.slice(end) };
}

function formatRange(range: Range | null | undefined): string {
  if (!range || typeof range !== 'object') return '<none>';
  return `${formatPosition(range.start)}-${formatPosition(range.end)}`;
}

function formatPosition(position: Position | null | undefined): string {
  if (!position || typeof position !== 'object') return '?';
  return `${position.line}:${position.character}`;
}

function applyDidChange(store: DocStore, params: TextDocumentParams | null | undefined) {
  const textDocument = params?.textDocument;
  const uri = typeof textDocument?.uri === 'string' ? textDocument.uri : '';
  const doc = uri ? store.docsByUri[uri] : null;
  if (!doc) return { applied: false, reason: 'unknown-uri' };

  const version = textDocument?.version;
  if (typeof version !== 'number' || !Number.isFinite(version)) return { applied: false, reason: 'invalid-version' };
  if (typeof doc.version === 'number' && version <= doc.version) {
    return { applied: false, reason: 'stale-version', version, currentVersion: doc.version };
  }

  const changes: ContentChange[] = Array.isArray(params?.contentChanges) ? params.contentChanges : [];
  let text = doc.text;
  const applied: AppliedChange[] = [];
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    const spliced = applyContentChange(text, change);

    if (!spliced.ok) {
      return {
        applied: false, reason: spliced.reason, index, range: change?.range ?? null,
      };
    }
    applied.push({ change, textBefore: text });
    text = spliced.text;
  }

  store.docsByUri[uri] = {
    uri,
    languageId: doc.languageId,
    version,
    text,
  };
  return {
    applied: true, changeCount: changes.length, size: text.length, changes: applied,
  };
}

function isNewlineWithOptionalIndent(text: unknown): text is string {
  return typeof text === 'string' && /^\r?\n[ \t]*$/.test(text);
}

function isLineBlankAtOffset(text: string, offset: number): boolean {
  const lineStarts = lineStartOffsets(text);
  let lineIndex = lineStarts.length - 1;
  for (let index = 0; index < lineStarts.length; index += 1) {
    const nextLineStart = lineStarts[index + 1];
    if (nextLineStart !== undefined && offset >= nextLineStart) continue;
    lineIndex = index;
    break;
  }
  const lineStart = lineStarts[lineIndex];
  const nextLineStart = lineStarts[lineIndex + 1];
  const lineEnd = nextLineStart === undefined ? text.length : lineEndBeforeBreak(text, nextLineStart);
  return /^[ \t]*$/.test(text.slice(lineStart, lineEnd));
}

function isBoundaryInsertion(
  previousText: string,
  nextText: string,
  insertionOffset: number,
  insertedText: unknown,
): boolean {
  if (!isNewlineWithOptionalIndent(insertedText)) return false;
  if (nextText !== previousText.slice(0, insertionOffset) + insertedText + previousText.slice(insertionOffset)) {
    return false;
  }
  return isLineBlankAtOffset(nextText, insertionOffset + insertedText.length);
}

function replacedSpanOfWholeTextChange(
  previousText: unknown,
  nextText: unknown,
): { offset: number; removedText: string; insertedText: string } | null {
  if (typeof previousText !== 'string' || typeof nextText !== 'string') return null;
  if (previousText === nextText) return null;
  let prefixLength = 0;
  while (
    prefixLength < previousText.length
    && prefixLength < nextText.length
    && previousText[prefixLength] === nextText[prefixLength]
  ) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  while (
    suffixLength < previousText.length - prefixLength
    && suffixLength < nextText.length - prefixLength
    && previousText[previousText.length - 1 - suffixLength] === nextText[nextText.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }
  return {
    offset: prefixLength,
    removedText: previousText.slice(prefixLength, previousText.length - suffixLength),
    insertedText: nextText.slice(prefixLength, nextText.length - suffixLength),
  };
}

function insertionFromWholeTextChange(previousText: string, nextText: string): { offset: number; text: string } | null {
  if (nextText.length <= previousText.length) return null;
  const span = replacedSpanOfWholeTextChange(previousText, nextText);
  if (!span || span.removedText !== '') return null;
  return { offset: span.offset, text: span.insertedText };
}

function detectBlankLineBoundary({ previousText, nextText, changes }: {
  previousText?: unknown;
  nextText?: unknown;
  changes?: unknown;
}): boolean {
  if (typeof previousText !== 'string' || typeof nextText !== 'string') return false;
  if (previousText === nextText) return false;
  if (!Array.isArray(changes) || changes.length !== 1) return false;
  const [change] = changes;
  if (!change || typeof change !== 'object') return false;
  if (change.range === undefined || change.range === null) {
    const insertion = insertionFromWholeTextChange(previousText, nextText);
    if (!insertion) return false;
    return isBoundaryInsertion(previousText, nextText, insertion.offset, insertion.text);
  }
  const { range } = change;
  if (typeof range !== 'object' || !isPositionShape(range.start) || !isPositionShape(range.end)) return false;
  if (range.start.line !== range.end.line || range.start.character !== range.end.character) return false;
  const insertionOffset = offsetOfPosition(previousText, lineStartOffsets(previousText), range.start);
  return isBoundaryInsertion(previousText, nextText, insertionOffset, change.text);
}

function applyDidClose(store: DocStore, params: TextDocumentParams | null | undefined) {
  const textDocument = params?.textDocument;
  const uri = typeof textDocument?.uri === 'string' ? textDocument.uri : '';
  if (!uri || !store.docsByUri[uri]) return { applied: false, reason: 'unknown-uri' };
  delete store.docsByUri[uri];
  return { applied: true };
}

function getDoc(store: DocStore, uri: string): StoredDoc | null {
  const doc = store.docsByUri[uri];
  if (!doc) return null;
  return { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text };
}

function listDocs(store: DocStore): Array<StoredDoc | null> {
  return Object.keys(store.docsByUri).map((uri) => getDoc(store, uri));
}

export { createDocStore, detectBlankLineBoundary, uriOfParams, applyContentChange, applyDidOpen, applyDidChange, applyDidClose, formatRange, getDoc, lineOfOffset, lineStartOffsets, listDocs, offsetOfPosition, replacedSpanOfWholeTextChange };
