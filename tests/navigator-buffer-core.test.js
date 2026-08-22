'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyDidChange,
  applyDidClose,
  applyDidOpen,
  createDocStore,
  getDoc,
  listDocs,
  uriOfParams,
} = require('../server/core/navigator-buffer-core');

function openDoc(store, uri, text, version = 1) {
  return applyDidOpen(store, {
    textDocument: { uri, languageId: 'markdown', version, text },
  });
}

test('applyDidOpen stores snapshots and listDocs returns open docs', () => {
  const store = createDocStore();
  assert.deepEqual(openDoc(store, 'file:///a.md', 'hello'), { applied: true });
  assert.deepEqual(getDoc(store, 'file:///a.md'), {
    uri: 'file:///a.md',
    languageId: 'markdown',
    version: 1,
    text: 'hello',
  });
  assert.deepEqual(listDocs(store), [getDoc(store, 'file:///a.md')]);
});

test('uriOfParams returns a text document uri or null', () => {
  assert.equal(uriOfParams({ textDocument: { uri: 'file:///a.md' } }), 'file:///a.md');
  assert.equal(uriOfParams({ textDocument: { uri: '' } }), null);
  assert.equal(uriOfParams({}), null);
});

test('applyDidChange supports full text replacement', () => {
  const store = createDocStore();
  openDoc(store, 'file:///a.md', 'old');
  const change = applyDidChange(store, {
    textDocument: { uri: 'file:///a.md', version: 2 },
    contentChanges: [{ text: 'new text' }],
  });
  assert.deepEqual(change, { applied: true });
  assert.equal(getDoc(store, 'file:///a.md').text, 'new text');
});

test('applyDidChange drops stale versions and unknown uris', () => {
  const store = createDocStore();
  openDoc(store, 'file:///a.md', 'fresh', 5);
  assert.deepEqual(applyDidChange(store, {
    textDocument: { uri: 'file:///a.md', version: 5 },
    contentChanges: [{ text: 'stale' }],
  }), { applied: false, reason: 'stale-version' });
  assert.deepEqual(applyDidChange(store, {
    textDocument: { uri: 'file:///missing.md', version: 1 },
    contentChanges: [{ text: 'missing' }],
  }), { applied: false, reason: 'unknown-uri' });
  assert.equal(getDoc(store, 'file:///a.md').text, 'fresh');
});

test('applyDidChange rejects missing or nonnumeric versions', () => {
  const store = createDocStore();
  openDoc(store, 'file:///a.md', 'fresh', 5);
  assert.deepEqual(applyDidChange(store, {
    textDocument: { uri: 'file:///a.md' },
    contentChanges: [{ text: 'missing version' }],
  }), { applied: false, reason: 'invalid-version' });
  assert.deepEqual(applyDidChange(store, {
    textDocument: { uri: 'file:///a.md', version: '6' },
    contentChanges: [{ text: 'string version' }],
  }), { applied: false, reason: 'invalid-version' });
  assert.equal(getDoc(store, 'file:///a.md').text, 'fresh');
});

test('applyDidClose removes documents and reports unknown uris', () => {
  const store = createDocStore();
  openDoc(store, 'file:///a.md', 'bye');
  assert.deepEqual(applyDidClose(store, { textDocument: { uri: 'file:///a.md' } }), { applied: true });
  assert.equal(getDoc(store, 'file:///a.md'), null);
  assert.deepEqual(applyDidClose(store, { textDocument: { uri: 'file:///a.md' } }), {
    applied: false,
    reason: 'unknown-uri',
  });
});
