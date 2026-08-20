'use strict';

function createDocStore() {
  return {
    docsByUri: Object.create(null),
  };
}

function uriOfParams(params) {
  const uri = params?.textDocument?.uri;
  if (typeof uri === 'string' && uri !== '') return uri;
  return null;
}

function applyDidOpen(store, params) {
  const textDocument = params && params.textDocument;
  if (!textDocument || !textDocument.uri) return { applied: false, reason: 'invalid-params' };

  store.docsByUri[textDocument.uri] = {
    uri: textDocument.uri,
    languageId: textDocument.languageId || '',
    version: textDocument.version,
    text: textDocument.text || '',
  };
  return { applied: true };
}

function applyDidChange(store, params) {
  const textDocument = params && params.textDocument;
  const uri = textDocument && textDocument.uri;
  const doc = uri ? store.docsByUri[uri] : null;
  if (!doc) return { applied: false, reason: 'unknown-uri' };

  const version = textDocument.version;
  if (!Number.isFinite(version)) return { applied: false, reason: 'invalid-version' };
  if (typeof doc.version === 'number' && version <= doc.version) {
    return { applied: false, reason: 'stale-version' };
  }

  const changes = Array.isArray(params.contentChanges) ? params.contentChanges : [];
  let text = doc.text;
  for (const change of changes) {
    const changedText = typeof change.text === 'string' ? change.text : '';
    if (!change.range) {
      text = changedText;
      continue;
    }

    const start = offsetAt(text, change.range.start);
    const end = offsetAt(text, change.range.end);
    if (start === null || end === null || end < start) {
      return { applied: false, reason: 'invalid-range' };
    }
    text = text.slice(0, start) + changedText + text.slice(end);
  }

  store.docsByUri[uri] = {
    uri,
    languageId: doc.languageId,
    version,
    text,
  };
  return { applied: true };
}

function applyDidClose(store, params) {
  const textDocument = params && params.textDocument;
  const uri = textDocument && textDocument.uri;
  if (!uri || !store.docsByUri[uri]) return { applied: false, reason: 'unknown-uri' };
  delete store.docsByUri[uri];
  return { applied: true };
}

function getDoc(store, uri) {
  const doc = store.docsByUri[uri];
  if (!doc) return null;
  return { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text };
}

function listDocs(store) {
  return Object.keys(store.docsByUri).map((uri) => getDoc(store, uri));
}

function offsetAt(text, position) {
  if (!position || position.line < 0 || position.character < 0) return null;

  let line = 0;
  let offset = 0;
  while (line < position.line) {
    const nextNewline = text.indexOf('\n', offset);
    if (nextNewline === -1) return null;
    offset = nextNewline + 1;
    line++;
  }

  const lineEnd = text.indexOf('\n', offset);
  const end = lineEnd === -1 ? text.length : crlfAwareLineEnd(text, lineEnd);
  const target = offset + position.character;
  if (target > end) return null;
  return target;
}

function crlfAwareLineEnd(text, lineEnd) {
  if (lineEnd > 0 && text[lineEnd - 1] === '\r') return lineEnd - 1;
  return lineEnd;
}

module.exports = {
  createDocStore,
  uriOfParams,
  applyDidOpen,
  applyDidChange,
  applyDidClose,
  getDoc,
  listDocs,
};
