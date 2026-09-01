import test from 'node:test';
import assert from 'node:assert/strict';
import type { EditorState } from '../server/core/ingest-editor-core.ts';

import { applyEditorNotification, createEditorState } from '../server/core/ingest-editor-core.ts';
import { deepestRootFor } from '../server/core/visions-scope-core.ts';

const ROOTS = ['/home/op/Projects/glissa', '/home/op/Projects/glissa/vendor/inner'];
const URI = 'file:///home/op/Projects/glissa/docs/plan.md';

function note(state: EditorState, method: string, uri = URI, now = 1) {
  return applyEditorNotification(state, { method, uri, roots: ROOTS, now });
}

test('an open, a save and a close each publish one marker carrying no buffer text', () => {
  const state = createEditorState();
  const opened = note(state, 'textDocument/didOpen').event;
  assert.equal(opened?.source, 'editor');
  assert.equal(opened?.kind, 'doc-open');
  assert.equal(opened?.summary, 'opened docs/plan.md');
  assert.equal(opened?.scope.root, '/home/op/Projects/glissa');
  assert.deepEqual(Object.keys(opened?.detail), ['path']);

  assert.equal(note(state, 'textDocument/didSave').event?.summary, 'saved docs/plan.md');
  assert.equal(note(state, 'textDocument/didClose').event?.kind, 'doc-close');
});

test('a replayed open publishes nothing, and so does a close for a uri that was never open', () => {
  const state = createEditorState();
  assert.notEqual(note(state, 'textDocument/didOpen').event, null);
  assert.equal(note(state, 'textDocument/didOpen').event, null);

  assert.notEqual(note(state, 'textDocument/didClose').event, null);
  assert.equal(note(state, 'textDocument/didClose').event, null);
});

test('a save always publishes, since it is the operator acting rather than a relay replaying', () => {
  const state = createEditorState();
  note(state, 'textDocument/didOpen');
  assert.notEqual(note(state, 'textDocument/didSave').event, null);
  assert.notEqual(note(state, 'textDocument/didSave').event, null);
});

test('the deepest containing root wins and a file under none is machine scope', () => {
  assert.equal(deepestRootFor('/home/op/Projects/glissa/vendor/inner/x.md', ROOTS), '/home/op/Projects/glissa/vendor/inner');
  assert.equal(deepestRootFor('/home/op/Projects/glissa/docs/x.md', ROOTS), '/home/op/Projects/glissa');
  assert.equal(deepestRootFor('/tmp/x.md', ROOTS), null);

  const state = createEditorState();
  const outside = applyEditorNotification(state, { method: 'textDocument/didSave', uri: 'file:///tmp/secret-project/notes.md', roots: ROOTS, now: 1 }).event;
  assert.equal(outside?.scope.root, null);

  assert.equal(outside?.summary, 'saved notes.md');
});

test('a method the source does not publish, and an unusable uri, are both nothing', () => {
  const state = createEditorState();
  assert.equal(note(state, 'textDocument/didChange').event, null);
  assert.equal(applyEditorNotification(state, { method: 'textDocument/didOpen', uri: 'untitled:Untitled-1', roots: ROOTS }).event, null);
  assert.equal(applyEditorNotification(state, {}).event, null);
});
