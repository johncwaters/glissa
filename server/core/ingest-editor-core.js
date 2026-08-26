/*
 * Editor markers for the ingest feed (docs/plan-ingestion.md, M6 Sources): open, save and close, never
 * content, which already lives in the Visions lane. The buffer text is the one thing this source must
 * not carry: it would put the document a dispatch is about into that same dispatch's DATA section.
 */

'use strict';

const { normalizeShapePath, pathOfFileUri } = require('./visions-scope-core');

const SOURCE = 'editor';
const KIND_BY_METHOD = Object.freeze({
  'textDocument/didOpen': 'doc-open',
  'textDocument/didSave': 'doc-save',
  'textDocument/didClose': 'doc-close',
});
const VERB_BY_KIND = Object.freeze({ 'doc-open': 'opened', 'doc-save': 'saved', 'doc-close': 'closed' });

function createEditorState() {
  return { openUris: new Set() };
}

function isWithin(root, candidate) {
  if (!root || !candidate) return false;
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

// Deepest containing root wins, the same rule projectForUri applies: a checkout inside another owns its
// own files, and the shallower root would otherwise claim every one of them.
function rootForPath(normalizedPath, roots) {
  let owner = null;
  for (const raw of Array.isArray(roots) ? roots : []) {
    const root = normalizeShapePath(raw);
    if (!isWithin(root, normalizedPath)) continue;
    if (owner && owner.length >= root.length) continue;
    owner = root;
  }
  return owner;
}

function relativeTo(root, normalizedPath) {
  if (!root || root === normalizedPath) return normalizedPath.split('/').pop() || normalizedPath;
  return normalizedPath.slice(root.length + 1);
}

/**
 * One notification against the standing open set, as `{ state, event }`. A relay replays every open
 * document each time it reconnects, so an open the state already holds publishes nothing; a close for a
 * uri that was never open publishes nothing either. A save always publishes: it is the operator acting.
 */
function applyEditorNotification(state, { method, uri, roots = [], now = 0 } = {}) {
  const kind = KIND_BY_METHOD[method];
  if (!kind) return { state, event: null };
  const normalizedPath = normalizeShapePath(pathOfFileUri(uri));
  if (!normalizedPath) return { state, event: null };

  if (kind === 'doc-open' && state.openUris.has(uri)) return { state, event: null };
  if (kind === 'doc-close' && !state.openUris.has(uri)) return { state, event: null };
  if (kind === 'doc-open') state.openUris.add(uri);
  if (kind === 'doc-close') state.openUris.delete(uri);

  const root = rootForPath(normalizedPath, roots);
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

module.exports = { SOURCE, applyEditorNotification, createEditorState, rootForPath };
