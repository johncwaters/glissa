// Markers only: buffer text here would put the document a dispatch is about into that dispatch's own
// DATA section (docs/plan-ingestion.md, M6 Sources).

'use strict';

const { deepestRootFor, normalizeShapePath, pathOfFileUri } = require('./visions-scope-core');

const SOURCE = 'editor';
// The one notification for a buffer the lane does not mirror; both ends key on this constant.
const ACTIVITY_METHOD = 'visions/editorActivity';
const KIND_BY_METHOD = Object.freeze({
  'textDocument/didOpen': 'doc-open',
  'textDocument/didSave': 'doc-save',
  'textDocument/didClose': 'doc-close',
});
const VERB_BY_KIND = Object.freeze({ 'doc-open': 'opened', 'doc-save': 'saved', 'doc-close': 'closed' });

/** @typedef {{ method?: string, uri?: string, roots?: string[], now?: number }} EditorNotification */

function createEditorState() {
  return { openUris: new Set() };
}

function relativeTo(root, normalizedPath) {
  if (!root || root === normalizedPath) return normalizedPath.split('/').pop() || normalizedPath;
  return normalizedPath.slice(root.length + 1);
}

// A relay replays every open document on each reconnect, so a repeat open is not an event; a save is,
// every time, because it is the operator acting.
/**
 * @param {{ openUris: Set<string> }} state
 * @param {EditorNotification} notification
 */
function applyEditorNotification(state, { method, uri, roots = [], now = 0 } = {}) {
  if (typeof method !== 'string' || typeof uri !== 'string') return { state, event: null };
  const kind = KIND_BY_METHOD[method];
  if (!kind) return { state, event: null };
  const normalizedPath = normalizeShapePath(pathOfFileUri(uri));
  if (!normalizedPath) return { state, event: null };

  if (kind === 'doc-open' && state.openUris.has(uri)) return { state, event: null };
  if (kind === 'doc-close' && !state.openUris.has(uri)) return { state, event: null };
  if (kind === 'doc-open') state.openUris.add(uri);
  if (kind === 'doc-close') state.openUris.delete(uri);

  const root = deepestRootFor(normalizedPath, roots);
  return {
    state,
    event: {
      source: SOURCE,
      kind,
      ts: now,
      scope: { root: root || null, sessionId: null },
      summary: `${VERB_BY_KIND[kind]} ${relativeTo(root, normalizedPath)}`,
      detail: { path: relativeTo(root, normalizedPath) },
    },
  };
}

module.exports = { ACTIVITY_METHOD, SOURCE, applyEditorNotification, createEditorState };
