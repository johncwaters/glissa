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

test('applyDidChange applies incremental edits using UTF-16 positions', () => {
  const store = createDocStore();
  openDoc(store, 'file:///a.md', `alpha\nbeta\nomega`);
  const change = applyDidChange(store, {
    textDocument: { uri: 'file:///a.md', version: 2 },
    contentChanges: [{ range: { start: { line: 1, character: 1 }, end: { line: 1, character: 3 } }, text: 'EE' }],
  });
  assert.deepEqual(change, { applied: true });
  assert.equal(getDoc(store, 'file:///a.md').text, `alpha\nbEEa\nomega`);
});

test('applyDidChange applies incremental edits using CRLF line offsets', () => {
  const store = createDocStore();
  openDoc(store, 'file:///crlf.md', 'alpha\r\nbeta\r\nomega');
  const change = applyDidChange(store, {
    textDocument: { uri: 'file:///crlf.md', version: 2 },
    contentChanges: [{ range: { start: { line: 1, character: 1 }, end: { line: 1, character: 3 } }, text: 'EE' }],
  });
  assert.deepEqual(change, { applied: true });
  assert.equal(getDoc(store, 'file:///crlf.md').text, 'alpha\r\nbEEa\r\nomega');
});

test('applyDidChange keeps multibyte and astral UTF-16 offsets exact', () => {
  const store = createDocStore();
  openDoc(store, 'file:///emoji.md', 'a\ud83d\ude80b \u00e9clair');
  const change = applyDidChange(store, {
    textDocument: { uri: 'file:///emoji.md', version: 2 },
    contentChanges: [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 4 } }, text: 'B' }],
  });
  assert.deepEqual(change, { applied: true });
  assert.equal(getDoc(store, 'file:///emoji.md').text, 'a\ud83d\ude80B \u00e9clair');
});

test('applyDidChange supports multiple incremental entries in one version', () => {
  const store = createDocStore();
  openDoc(store, 'file:///a.md', 'abc\ndef');
  const change = applyDidChange(store, {
    textDocument: { uri: 'file:///a.md', version: 2 },
    contentChanges: [
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, text: 'B' },
      { range: { start: { line: 1, character: 3 }, end: { line: 1, character: 3 } }, text: '!' },
    ],
  });
  assert.deepEqual(change, { applied: true });
  assert.equal(getDoc(store, 'file:///a.md').text, 'aBc\ndef!');
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

test('applyDidChange reports invalid ranges without mutating', () => {
  const store = createDocStore();
  openDoc(store, 'file:///a.md', 'short');
  assert.deepEqual(applyDidChange(store, {
    textDocument: { uri: 'file:///a.md', version: 2 },
    contentChanges: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, text: 'x' }],
  }), { applied: false, reason: 'invalid-range' });
  assert.equal(getDoc(store, 'file:///a.md').text, 'short');
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
