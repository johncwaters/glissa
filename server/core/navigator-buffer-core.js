/*
 * Pure document store for the navigator lane. The relay advertises FULL textDocumentSync, so a
 * didChange carries the whole buffer and there are no ranges to splice: the wiring re-sweeps the whole
 * document on every applied change anyway, so incremental offsets only bought CRLF edge cases.
 */

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
    text = typeof change.text === 'string' ? change.text : '';
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

module.exports = {
  createDocStore,
  uriOfParams,
  applyDidOpen,
  applyDidChange,
  applyDidClose,
  getDoc,
  listDocs,
};
