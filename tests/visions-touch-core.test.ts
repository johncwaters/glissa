import test from 'node:test';
import assert from 'node:assert/strict';

import { applyDidChange, applyDidOpen, createDocStore } from '../server/core/visions-buffer-core.ts';
import {
  consumeReviewRanges, createTouchState, formatTouchedRanges, mergeRanges, recordChanges, resetUri, restoreReviewRanges, shiftLines,
  touchedLineCount, touchedRangesFor,
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

test('touchedLineCount sums the lines every range covers', () => {
  assert.equal(touchedLineCount([{ start: 3, end: 5 }, { start: 12, end: 12 }]), 4);
  assert.equal(touchedLineCount([]), 0);
  assert.equal(touchedLineCount(null), 0);
});

function shifted(text: string, contentChanges: unknown[], lines: number[]): number[] {
  const store = createDocStore();
  applyDidOpen(store, { textDocument: { uri: URI, languageId: 'markdown', version: 1, text } });
  const result = applyDidChange(store, { textDocument: { uri: URI, version: 2 }, contentChanges });
  assert.equal(result.applied, true, JSON.stringify(result));
  return shiftLines(lines, result.changes, store.docsByUri[URI].text);
}

test('shiftLines moves anchors below an inserted line and leaves those above alone', () => {
  const text = 'one\ntwo\nthree\nfour\n';
  assert.deepEqual(shifted(text, [{ range: range(1, 3, 1, 3), text: '\nadded' }], [1, 2, 3, 4]), [1, 2, 4, 5]);
});

test('shiftLines pushes the anchored line down when whole lines are inserted before it', () => {
  const text = 'one\ntwo\nthree\n';
  assert.deepEqual(shifted(text, [{ range: range(0, 0, 0, 0), text: 'intro\n' }], [1, 2]), [2, 3]);
  assert.deepEqual(shifted(text, [{ range: range(1, 0, 1, 0), text: 'a\nb\n' }], [1, 2, 3]), [1, 4, 5]);
});

test('shiftLines keeps an anchor on a line edited in place', () => {
  const text = 'one\ntwo\nthree\n';
  assert.deepEqual(shifted(text, [{ range: range(1, 0, 1, 3), text: 'TWO' }], [2, 3]), [2, 3]);
  assert.deepEqual(shifted(text, [{ range: range(1, 1, 1, 1), text: '\n' }], [2, 3]), [2, 4]);
});

test('shiftLines collapses anchors inside a deleted span onto the surviving line and clamps to the buffer', () => {
  const text = 'one\ntwo\nthree\nfour\nfive\n';
  assert.deepEqual(shifted(text, [{ range: range(1, 0, 3, 0), text: '' }], [1, 2, 3, 4, 5]), [1, 2, 2, 2, 3]);
  assert.deepEqual(shifted(text, [{ text: 'one\n' }], [5]), [1]);
});

test('shiftLines applies a whole-text change by its common prefix and suffix', () => {
  const text = 'one\ntwo\nthree\n';
  assert.deepEqual(shifted(text, [{ text: 'zero\none\ntwo\nthree\n' }], [1, 3]), [2, 4]);
  assert.deepEqual(shifted(text, [{ text: 'one\nthree\n' }], [1, 2, 3]), [1, 2, 2]);
});

test('shiftLines pushes an anchor past a whole-text list continuation sharing a prefix with the line below', () => {
  assert.deepEqual(shifted('# List\n\n- alpha\n- beta\n', [{ text: '# List\n\n- alpha\n- \n- beta\n' }], [4]), [5]);
});

test('shiftLines pushes an anchor past a whole-text heading inserted above one with the same marker', () => {
  assert.deepEqual(shifted('# A\n## B\n', [{ text: '# A\n## \n## B\n' }], [2]), [3]);
});

test('shiftLines clamps an anchor inside a deleted tail to the last content line', () => {
  assert.deepEqual(shifted('# List\n\n- alpha\n- beta\n', [{ text: '# List\n\n- alpha\n' }], [4]), [3]);
});

test('shiftLines keeps an anchor on the line below a replacement that ends at column zero', () => {
  assert.deepEqual(shifted('one\ntwo\nthree\n', [{ range: range(1, 0, 2, 0), text: 'TWO\n' }], [3]), [3]);
});

test('shiftLines clamps between the changes of a batch so a later change cannot lift an anchor off a deleted tail', () => {
  const text = 'l1\nl2\nl3\nl4\nl5\nl6\n';
  const deleteTail = { range: range(3, 0, 6, 0), text: '' };
  const appendThreeLines = { range: range(3, 0, 3, 0), text: 'n1\nn2\nn3\n' };
  assert.deepEqual(shifted(text, [deleteTail, appendThreeLines], [5]), [3]);
});

test('the review set covers only the changes since it was last consumed while the session set keeps growing', () => {
  const doc = editor('one\ntwo\nthree\nfour\nfive\n');
  doc.change([{ range: range(1, 0, 1, 3), text: 'TWO' }]);
  assert.deepEqual(touchedRangesFor(doc.touch, URI, 'review'), [{ start: 2, end: 2 }]);
  consumeReviewRanges(doc.touch, URI);
  assert.deepEqual(touchedRangesFor(doc.touch, URI, 'review'), []);
  assert.deepEqual(touchedRangesFor(doc.touch, URI), [{ start: 2, end: 2 }]);

  doc.change([{ range: range(3, 0, 3, 4), text: 'FOUR' }]);
  assert.deepEqual(touchedRangesFor(doc.touch, URI, 'review'), [{ start: 4, end: 4 }]);
  assert.deepEqual(touchedRangesFor(doc.touch, URI), [{ start: 2, end: 2 }, { start: 4, end: 4 }]);
});

test('both sets shift identically through an insertion above them', () => {
  const doc = editor('one\ntwo\nthree\n');
  doc.change([{ range: range(2, 0, 2, 5), text: 'THREE' }]);
  doc.change([{ range: range(0, 0, 0, 0), text: 'intro\n' }]);
  assert.deepEqual(touchedRangesFor(doc.touch, URI), [{ start: 1, end: 1 }, { start: 4, end: 4 }]);
  assert.deepEqual(touchedRangesFor(doc.touch, URI, 'review'), [{ start: 1, end: 1 }, { start: 4, end: 4 }]);
});

test('restoreReviewRanges folds a consumed snapshot through the edits made meanwhile and merges it back', () => {
  const doc = editor('one\ntwo\nthree\nfour\n');
  doc.change([{ range: range(2, 0, 2, 5), text: 'THREE' }]);
  const snapshot = touchedRangesFor(doc.touch, URI, 'review');
  consumeReviewRanges(doc.touch, URI);

  const store = createDocStore();
  applyDidOpen(store, { textDocument: { uri: URI, languageId: 'markdown', version: 1, text: doc.text } });
  const meanwhile = applyDidChange(store, { textDocument: { uri: URI, version: 2 }, contentChanges: [{ range: range(0, 0, 0, 0), text: 'intro\n' }] });
  doc.change([{ range: range(0, 0, 0, 0), text: 'intro\n' }]);
  assert.deepEqual(touchedRangesFor(doc.touch, URI, 'review'), [{ start: 1, end: 1 }]);

  const restored = restoreReviewRanges(doc.touch, URI, snapshot, meanwhile.changes, doc.text);
  assert.deepEqual(restored, [{ start: 1, end: 1 }, { start: 4, end: 4 }]);
});

test('resetUri clears both sets', () => {
  const doc = editor('one\ntwo\n');
  doc.change([{ range: range(0, 0, 0, 3), text: 'ONE' }]);
  resetUri(doc.touch, URI);
  assert.deepEqual(touchedRangesFor(doc.touch, URI), []);
  assert.deepEqual(touchedRangesFor(doc.touch, URI, 'review'), []);
});
