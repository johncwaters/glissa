'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ime-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/session-card/ime-core.mjs');

const DEL = '\x7f';

test('bytesForSoftKeyboardEdit: typing a character sends just that character', async () => {
  const { bytesForSoftKeyboardEdit } = await importCore();
  assert.equal(bytesForSoftKeyboardEdit('', 'a'), 'a');
  assert.equal(bytesForSoftKeyboardEdit('hell', 'hello'), 'o');
});

test('bytesForSoftKeyboardEdit: an unchanged buffer sends nothing', async () => {
  const { bytesForSoftKeyboardEdit } = await importCore();
  assert.equal(bytesForSoftKeyboardEdit('hello', 'hello'), '');
  assert.equal(bytesForSoftKeyboardEdit('', ''), '');
});

test('bytesForSoftKeyboardEdit: a suggestion that extends the word types only the new tail', async () => {
  const { bytesForSoftKeyboardEdit } = await importCore();
  assert.equal(bytesForSoftKeyboardEdit('wor', 'world'), 'ld');
});

test('bytesForSoftKeyboardEdit: autocorrect erases the replaced tail before typing the correction', async () => {
  const { bytesForSoftKeyboardEdit } = await importCore();
  // xterm 6.0.0 sends "the" straight after "teh" here and the line reads "tehthe".
  assert.equal(bytesForSoftKeyboardEdit('teh', 'the'), `${DEL}${DEL}he`);
});

test('bytesForSoftKeyboardEdit: deleting a word costs one delete per character removed', async () => {
  const { bytesForSoftKeyboardEdit } = await importCore();
  // xterm 6.0.0 collapses any shrink to a single DEL regardless of how much went away.
  assert.equal(bytesForSoftKeyboardEdit('hello', ''), DEL.repeat(5));
  assert.equal(bytesForSoftKeyboardEdit('git status', 'git '), DEL.repeat(6));
});

test('bytesForSoftKeyboardEdit: a same-length rewrite deletes back to the shared prefix', async () => {
  const { bytesForSoftKeyboardEdit } = await importCore();
  assert.equal(bytesForSoftKeyboardEdit('cat', 'car'), `${DEL}r`);
});

test('bytesForSoftKeyboardEdit: an astral character costs one delete, not two', async () => {
  const { bytesForSoftKeyboardEdit } = await importCore();
  const astral = String.fromCodePoint(0x1d400);
  assert.equal(bytesForSoftKeyboardEdit(`a${astral}`, 'a'), DEL);
  assert.equal(bytesForSoftKeyboardEdit('a', `a${astral}`), astral);
});

test('bytesForSoftKeyboardEdit: an inserted line break becomes a carriage return', async () => {
  const { bytesForSoftKeyboardEdit } = await importCore();
  assert.equal(bytesForSoftKeyboardEdit('ls', 'ls\n'), '\r');
  assert.equal(bytesForSoftKeyboardEdit('', 'a\r\nb'), 'a\rb');
});

test('bytesForSoftKeyboardEdit: absent text reads as empty rather than throwing', async () => {
  const { bytesForSoftKeyboardEdit } = await importCore();
  assert.equal(bytesForSoftKeyboardEdit(undefined, 'a'), 'a');
  assert.equal(bytesForSoftKeyboardEdit('a', undefined), DEL);
});

test('isTypedInputType: the fragile keyboard edits count as typing', async () => {
  const { isTypedInputType } = await importCore();
  assert.equal(isTypedInputType('insertText'), true);
  assert.equal(isTypedInputType('insertReplacementText'), true);
  assert.equal(isTypedInputType('insertCompositionText'), true);
  assert.equal(isTypedInputType('deleteContentBackward'), true);
  assert.equal(isTypedInputType('deleteWordBackward'), true);
});

test('isTypedInputType: text the terminal was already handed directly is not typing', async () => {
  const { isTypedInputType } = await importCore();
  assert.equal(isTypedInputType('insertFromPaste'), false);
  assert.equal(isTypedInputType('insertFromPasteAsQuotation'), false);
  assert.equal(isTypedInputType('insertFromDrop'), false);
  assert.equal(isTypedInputType('insertFromYank'), false);
  assert.equal(isTypedInputType('historyUndo'), false);
  assert.equal(isTypedInputType('historyRedo'), false);
});

test('isTypedInputType: a missing inputType falls back to typing', async () => {
  const { isTypedInputType } = await importCore();
  assert.equal(isTypedInputType(undefined), true);
  assert.equal(isTypedInputType(''), true);
  assert.equal(isTypedInputType(null), true);
});

test('bytesForBackwardDeletion: a delete with nothing left to diff falls back to one delete', async () => {
  const { bytesForBackwardDeletion } = await importCore();
  assert.equal(bytesForBackwardDeletion('deleteContentBackward'), DEL);
  assert.equal(bytesForBackwardDeletion('deleteByComposition'), DEL);
  assert.equal(bytesForBackwardDeletion('deleteCompositionText'), DEL);
});

test('bytesForBackwardDeletion: a word-wide delete falls back to the word delete sequence', async () => {
  const { bytesForBackwardDeletion } = await importCore();
  assert.equal(bytesForBackwardDeletion('deleteWordBackward'), '\x1b\x7f');
  assert.equal(bytesForBackwardDeletion('deleteSoftLineBackward'), '\x1b\x7f');
  assert.equal(bytesForBackwardDeletion('deleteHardLineBackward'), '\x1b\x7f');
});

test('bytesForBackwardDeletion: anything that is not a backward delete carries no bytes', async () => {
  const { bytesForBackwardDeletion } = await importCore();
  assert.equal(bytesForBackwardDeletion('deleteContentForward'), '');
  assert.equal(bytesForBackwardDeletion('deleteWordForward'), '');
  assert.equal(bytesForBackwardDeletion('insertText'), '');
  assert.equal(bytesForBackwardDeletion('insertReplacementText'), '');
  assert.equal(bytesForBackwardDeletion(undefined), '');
});

test('isImeProcessingKeydown: only the IME placeholder keydown matches', async () => {
  const { isImeProcessingKeydown } = await importCore();
  assert.equal(isImeProcessingKeydown({ keyCode: 229, key: 'Unidentified' }), true);
  assert.equal(isImeProcessingKeydown({ keyCode: 0, key: 'Process' }), true);
  assert.equal(isImeProcessingKeydown({ keyCode: 13, key: 'Enter' }), false);
  assert.equal(isImeProcessingKeydown({ keyCode: 8, key: 'Backspace' }), false);
  assert.equal(isImeProcessingKeydown({ keyCode: 65, key: 'a' }), false);
  assert.equal(isImeProcessingKeydown(null), false);
});
