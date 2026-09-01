import test from 'node:test';
import assert from 'node:assert/strict';

import { applyDidChange, applyDidOpen, createDocStore } from '../server/core/visions-buffer-core.ts';
import {
  createTouchState, formatTouchedRanges, mergeRanges, recordChanges, resetUri, touchedRangesFor,
} from '../server/core/visions-touch-core.ts';

const URI = 'file:///tmp/plan.md';

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } };
}

function editor(text: string) {
  const store = createDocStore();
  const touch = createTouchState();
  let version = 1;
  applyDidOpen(store, { textDocument: { uri: URI, languageId: 'markdown', version, text } });
  return {
    change(contentChanges: unknown[]) {
      version += 1;
      const result = applyDidChange(store, { textDocument: { uri: URI, version }, contentChanges });
      assert.equal(result.applied, true, JSON.stringify(result));
      return recordChanges(touch, URI, result.changes, store.docsByUri[URI].text);
    },
    get text() { return store.docsByUri[URI].text; },
    touch,
  };
}

test('a fresh state has no touched range, and an unknown uri reads empty', () => {
  const touch = createTouchState();
  assert.deepEqual(touchedRangesFor(touch, URI), []);
  assert.deepEqual(recordChanges(touch, URI, [], '# Title\n'), []);
});

test('a ranged insert marks the lines it produced, one-based and inclusive', () => {
  const doc = editor('# Title\n\nline three\nline four\n');
  assert.deepEqual(doc.change([{ range: range(2, 4, 2, 4), text: ' edited' }]), [{ start: 3, end: 3 }]);
  assert.deepEqual(doc.change([{ range: range(3, 0, 3, 0), text: 'a\nb\n' }]), [{ start: 3, end: 5 }], 'adjacent ranges merge, and the pushed-down line is not a produced one');
  assert.deepEqual(doc.change([{ range: range(0, 3, 0, 3), text: 'x\n' }]), [{ start: 1, end: 2 }, { start: 4, end: 6 }], 'a break typed mid-line touches both halves');
});

test('overlapping and adjacent ranges merge, and disjoint ones stay apart', () => {
  assert.deepEqual(mergeRanges([{ start: 5, end: 6 }, { start: 1, end: 2 }, { start: 3, end: 3 }, { start: 4, end: 4 }, { start: 9, end: 9 }]), [
    { start: 1, end: 6 }, { start: 9, end: 9 },
  ]);
  assert.deepEqual(mergeRanges([{ start: 1, end: 2 }, { start: 4, end: 4 }]), [{ start: 1, end: 2 }, { start: 4, end: 4 }]);
  assert.deepEqual(mergeRanges([{ start: 0, end: 2 }, { start: 3, end: 1 }]), [], 'malformed ranges are dropped');
});

test('an insert above a range shifts it down, and a delete above shifts it up', () => {
  const doc = editor('one\ntwo\nthree\nfour\nfive\n');
  assert.deepEqual(doc.change([{ range: range(3, 0, 3, 4), text: 'FOUR' }]), [{ start: 4, end: 4 }]);
  assert.deepEqual(doc.change([{ range: range(0, 0, 0, 0), text: 'zero\n' }]), [{ start: 1, end: 1 }, { start: 5, end: 5 }]);
  assert.equal(doc.text.split('\n')[4], 'FOUR', 'the shifted range still points at the edited prose');
  assert.deepEqual(doc.change([{ range: range(0, 0, 2, 0), text: '' }]), [{ start: 1, end: 1 }, { start: 3, end: 3 }]);
  assert.equal(doc.text.split('\n')[2], 'FOUR');
});

test('a whole-buffer replacement marks the minimal changed span, not every line', () => {
  const doc = editor('# Title\n\nA line.\n\nAnother line.\n');
  assert.deepEqual(doc.change([{ text: '# Title\n\nA line, edited.\n\nAnother line.\n' }]), [{ start: 3, end: 3 }]);
  assert.deepEqual(doc.change([{ text: '# Title\n\nA line, edited.\n\nAnother line.\nA new last line.\n' }]), [
    { start: 3, end: 3 }, { start: 6, end: 6 },
  ]);
  assert.deepEqual(doc.change([{ text: '# Title\n\nA line, edited.\n\nAnother line.\nA new last line.\n' }]), [
    { start: 3, end: 3 }, { start: 6, end: 6 },
  ], 'an identical replacement touches nothing');
});

test('a whole-buffer deletion above a range shifts it, and a range that shrinks clamps to the buffer', () => {
  const doc = editor('one\ntwo\nthree\nfour\n');
  assert.deepEqual(doc.change([{ range: range(3, 0, 3, 4), text: 'FOUR' }]), [{ start: 4, end: 4 }]);
  assert.deepEqual(doc.change([{ text: 'one\nthree\nFOUR\n' }]), [{ start: 2, end: 3 }]);
  assert.deepEqual(doc.change([{ text: 'one\n' }]), [{ start: 2, end: 2 }]);
});

test('a batch applies each change against the text the previous one left', () => {
  const doc = editor('the  cat\nsat\n');
  assert.deepEqual(doc.change([
    { range: range(0, 5, 0, 5), text: 'BIG ' },
    { range: range(1, 0, 1, 0), text: 'then\n' },
  ]), [{ start: 1, end: 2 }]);
  assert.equal(doc.text, 'the  BIG cat\nthen\nsat\n');
});

test('resetting a uri forgets its ranges and leaves the others alone', () => {
  const touch = createTouchState();
  recordChanges(touch, URI, [{ change: { range: range(0, 0, 0, 0), text: 'x' }, textBefore: 'a\nb\n' }], 'xa\nb\n');
  recordChanges(touch, 'file:///tmp/other.md', [{ change: { range: range(1, 0, 1, 0), text: 'x' }, textBefore: 'a\nb\n' }], 'a\nxb\n');
  resetUri(touch, URI);
  assert.deepEqual(touchedRangesFor(touch, URI), []);
  assert.deepEqual(touchedRangesFor(touch, 'file:///tmp/other.md'), [{ start: 2, end: 2 }]);
  touchedRangesFor(touch, 'file:///tmp/other.md')[0].start = 99;
  assert.deepEqual(touchedRangesFor(touch, 'file:///tmp/other.md'), [{ start: 2, end: 2 }], 'a read is a copy');
});

test('ranges format as the one line the prompt carries', () => {
  assert.equal(formatTouchedRanges([{ start: 3, end: 5 }, { start: 12, end: 12 }]), '3-5, 12');
  assert.equal(formatTouchedRanges([]), '');
  assert.equal(formatTouchedRanges(null), '');
});
