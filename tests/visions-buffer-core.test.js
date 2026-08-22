'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyDidChange,
  applyDidClose,
  applyDidOpen,
  createDocStore,
  detectBlankLineBoundary,
  getDoc,
  listDocs,
  uriOfParams,
} = require('../server/core/visions-buffer-core');

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
  assert.deepEqual(change, { applied: true, changeCount: 1, size: 'new text'.length });
  assert.equal(getDoc(store, 'file:///a.md').text, 'new text');
});

test('applyDidChange drops stale versions and unknown uris', () => {
  const store = createDocStore();
  openDoc(store, 'file:///a.md', 'fresh', 5);
  assert.deepEqual(applyDidChange(store, {
    textDocument: { uri: 'file:///a.md', version: 5 },
    contentChanges: [{ text: 'stale' }],
  }), {
    applied: false, reason: 'stale-version', version: 5, currentVersion: 5,
  });
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

// --- Incremental sync: LSP ranges spliced into the mirrored buffer ---

function range(startLine, startCharacter, endLine, endCharacter) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

// One didChange carrying whatever changes the test names, at the next version.
function change(store, uri, contentChanges, version = 2) {
  return applyDidChange(store, { textDocument: { uri, version }, contentChanges });
}

function boundary(previousText, nextText, changes) {
  return detectBlankLineBoundary({ previousText, nextText, changes });
}

function textAfter(store, uri, contentChanges, opened) {
  openDoc(store, uri, opened);
  const result = change(store, uri, contentChanges);
  return { result, text: getDoc(store, uri) ? getDoc(store, uri).text : null };
}

test('a single character insert splices at the range and leaves the rest alone', () => {
  const store = createDocStore();
  const { result, text } = textAfter(store, 'file:///a.md', [
    { range: range(1, 5, 1, 5), text: 'X' },
  ], '# Title\nhello world\n');
  assert.equal(result.applied, true);
  assert.equal(text, '# Title\nhelloX world\n');
});

test('detectBlankLineBoundary accepts typed newline inserts that leave a blank cursor line', () => {
  assert.equal(boundary('A thought', 'A thought\n', [
    { range: range(0, 9, 0, 9), text: '\n' },
  ]), true);
  assert.equal(boundary('A thought', 'A thought\r\n', [
    { range: range(0, 9, 0, 9), text: '\r\n' },
  ]), true);
  assert.equal(boundary('A thought', 'A thought\n  ', [
    { range: range(0, 9, 0, 9), text: '\n  ' },
  ]), true);
});

test('detectBlankLineBoundary accepts whole-text newline insertions that leave a blank cursor line', () => {
  assert.equal(boundary('A thought', 'A thought\n', [{ text: 'A thought\n' }]), true);
  assert.equal(boundary('A thought', 'A thought\r\n', [{ text: 'A thought\r\n' }]), true);
  assert.equal(boundary('A thought', 'A thought\n\t', [{ text: 'A thought\n\t' }]), true);
});

test('detectBlankLineBoundary rejects edits that are not typed blank-line boundaries', () => {
  assert.equal(boundary('A thought', 'A thXought', [
    { range: range(0, 4, 0, 4), text: 'X' },
  ]), false, 'mid-line edit');
  assert.equal(boundary('A thought', 'A ', [
    { range: range(0, 2, 0, 9), text: '' },
  ]), false, 'deletion');
  assert.equal(boundary('A thought', 'A thought\n\nPasted block', [
    { range: range(0, 9, 0, 9), text: '\n\nPasted block' },
  ]), false, 'multi-line paste');
  assert.equal(boundary('A thought', 'A \nthought', [
    { range: range(0, 2, 0, 2), text: '\n' },
  ]), false, 'enter created a non-empty line');
  assert.equal(boundary('A thought', 'A thought\n\n', [
    { range: range(0, 9, 0, 9), text: '\n' },
    { range: range(1, 0, 1, 0), text: '\n' },
  ]), false, 'multiple changes');
  assert.equal(boundary('A thought', 'A thought', [
    { range: range(0, 9, 0, 9), text: '' },
  ]), false, 'unchanged text');
  assert.equal(boundary('A thought', 'A thought\nNext', [{ text: 'A thought\nNext' }]), false, 'whole-text non-empty line');
});

test('changes in one batch apply in order, each against the text the previous one left', () => {
  const store = createDocStore();
  // The second range only names the right characters once the first insert has already landed.
  const { result, text } = textAfter(store, 'file:///a.md', [
    { range: range(0, 5, 0, 5), text: 'BIG ' },
    { range: range(0, 0, 0, 9), text: 'a ' },
  ], 'the  cat\n');
  assert.equal(result.applied, true);
  assert.equal(result.changeCount, 2);
  assert.equal(text, 'a cat\n');
});

test('a deletion spanning lines joins the surviving halves', () => {
  const store = createDocStore();
  const { text } = textAfter(store, 'file:///a.md', [
    { range: range(0, 3, 2, 4), text: '' },
  ], 'one line\ntwo line\nthree line\n');
  assert.equal(text, 'onee line\n');
});

test('CRLF line breaks do not shift the offsets by their carriage returns', () => {
  const store = createDocStore();
  const { text } = textAfter(store, 'file:///a.md', [
    { range: range(2, 0, 2, 5), text: 'THIRD' },
  ], 'first\r\nsecond\r\nthird\r\n');
  assert.equal(text, 'first\r\nsecond\r\nTHIRD\r\n');
});

/*
 * VS Code's document model splits on \r\n, a lone \r, or a lone \n. Counting only \n would leave every
 * line after a lone \r shifted, and the splice would land at the wrong offset while reporting success.
 */
test('a lone carriage return ends a line, so later lines keep their numbers', () => {
  const store = createDocStore();
  const { result, text } = textAfter(store, 'file:///a.md', [
    { range: range(2, 0, 2, 1), text: 'C' },
  ], 'a\rb\nc\nd');
  assert.equal(result.applied, true);
  assert.equal(text, 'a\rb\nC\nd');
});

test('a CR-only document addresses its lines like any other', () => {
  const store = createDocStore();
  const { text } = textAfter(store, 'file:///a.md', [
    { range: range(1, 0, 1, 3), text: 'BBB' },
  ], 'aaa\rbbb\rccc');
  assert.equal(text, 'aaa\rBBB\rccc', 'the edit replaced line 1 rather than appending at the end');
});

// The \r\n step-back in the clamp: without it an over-long character lands BETWEEN the \r and the \n.
test('a character past the end of a CRLF line clamps before the carriage return', () => {
  const store = createDocStore();
  const { text } = textAfter(store, 'file:///a.md', [
    { range: range(0, 99, 0, 99), text: '!' },
  ], 'hello\r\nworld\r\n');
  assert.equal(text, 'hello!\r\nworld\r\n', 'the insert never splits the \\r\\n pair');
});

test('a surrogate pair before the edit counts as the two UTF-16 units LSP says it is', () => {
  const store = createDocStore();
  // One astral character, two code units, so the word after it starts at character 2.
  const astral = String.fromCodePoint(0x1f600);
  const { text } = textAfter(store, 'file:///a.md', [
    { range: range(0, 2, 0, 6), text: 'moon' },
  ], `${astral}star\n`);
  assert.equal(text, `${astral}moon\n`);
});

test('an end position at the line length is clamped rather than refused', () => {
  const store = createDocStore();
  // VS Code legitimately sends an end at the line's length, which is one past its last character.
  const { result, text } = textAfter(store, 'file:///a.md', [
    { range: range(0, 0, 0, 5), text: 'bye' },
  ], 'hello\nworld\n');
  assert.equal(result.applied, true);
  assert.equal(text, 'bye\nworld\n');
});

test('a character past the end of its line clamps to the line break, never into the next line', () => {
  const store = createDocStore();
  const { text } = textAfter(store, 'file:///a.md', [
    { range: range(0, 99, 0, 99), text: '!' },
  ], 'hello\nworld\n');
  assert.equal(text, 'hello!\nworld\n');
});

test('a line past the end of the document clamps to the end of the document', () => {
  const store = createDocStore();
  const { result, text } = textAfter(store, 'file:///a.md', [
    { range: range(9, 0, 9, 0), text: 'tail' },
  ], 'hello\n');
  assert.equal(result.applied, true);
  assert.equal(text, 'hello\ntail');
});

test('a range whose start is after its end is refused and changes nothing', () => {
  const store = createDocStore();
  const { result, text } = textAfter(store, 'file:///a.md', [
    { range: range(1, 0, 0, 0), text: 'corrupt' },
  ], 'first\nsecond\n');
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'invalid-range');
  assert.equal(result.index, 0);
  assert.equal(text, 'first\nsecond\n', 'the mirror keeps the text it had');
  assert.equal(getDoc(store, 'file:///a.md').version, 1, 'and the version it had');
});

test('a malformed position shape is refused, a clamped one is not', () => {
  const store = createDocStore();
  openDoc(store, 'file:///a.md', 'hello\n');
  const malformed = [
    range(-1, 0, 0, 0),
    range(0, -2, 0, 0),
    { start: { line: 0, character: 0 }, end: { line: Number.NaN, character: 0 } },
    { start: { line: 0.5, character: 0 }, end: { line: 1, character: 0 } },
    { start: null, end: { line: 0, character: 0 } },
  ];
  for (const bad of malformed) {
    const result = change(store, 'file:///a.md', [{ range: bad, text: 'x' }]);
    assert.equal(result.reason, 'invalid-range', `expected a refusal for ${JSON.stringify(bad)}`);
  }
  assert.equal(getDoc(store, 'file:///a.md').text, 'hello\n');
});

test('a replacement at the very start and one at the very end both land', () => {
  const store = createDocStore();
  const { text } = textAfter(store, 'file:///a.md', [
    { range: range(0, 0, 0, 0), text: '> ' },
    { range: range(1, 0, 1, 0), text: 'end' },
  ], 'quote\n');
  assert.equal(text, '> quote\nend');
});

test('an empty change text is a pure deletion', () => {
  const store = createDocStore();
  const { text } = textAfter(store, 'file:///a.md', [
    { range: range(0, 5, 0, 11), text: '' },
  ], 'hello world\n');
  assert.equal(text, 'hello\n');
});

test('a full text change after a ranged one in the same batch replaces everything', () => {
  const store = createDocStore();
  const { result, text } = textAfter(store, 'file:///a.md', [
    { range: range(0, 0, 0, 5), text: 'ignored' },
    { text: '# Wholesale\n' },
  ], 'hello\n');
  assert.equal(result.applied, true);
  assert.equal(text, '# Wholesale\n');
});

// Coercing a missing text to '' would turn "replace this range" into "delete this range" silently.
test('a ranged change with no string to splice is refused, never applied as a deletion', () => {
  const store = createDocStore();
  openDoc(store, 'file:///a.md', 'hello world\n');
  const textless = [undefined, null, 42, {}, ['x']];
  for (const bad of textless) {
    const result = change(store, 'file:///a.md', [{ range: range(0, 0, 0, 5), text: bad }]);
    assert.equal(result.applied, false, `expected a refusal for ${JSON.stringify(bad)}`);
    assert.equal(result.reason, 'invalid-text');
    assert.equal(result.index, 0);
  }
  assert.equal(getDoc(store, 'file:///a.md').text, 'hello world\n');

  // The whole-buffer path keeps its long-standing tolerance, since there is no range to mis-delete.
  const full = change(store, 'file:///a.md', [{ text: undefined }]);
  assert.equal(full.applied, true);
  assert.equal(getDoc(store, 'file:///a.md').text, '');
});

test('rangeLength is ignored rather than validated against the range', () => {
  const store = createDocStore();
  const { result, text } = textAfter(store, 'file:///a.md', [
    { range: range(0, 0, 0, 5), rangeLength: 999, text: 'bye' },
  ], 'hello\n');
  assert.equal(result.applied, true);
  assert.equal(text, 'bye\n');
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
