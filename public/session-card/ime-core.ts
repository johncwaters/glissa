// Pure translation of a soft-keyboard edit of xterm's helper textarea into terminal bytes.
// The caret in that textarea is always at the end, so a shared-prefix diff is the whole model:
// whatever the previous text lost past the shared prefix comes back as deletes, and whatever the
// next text adds past it is typed. This is what makes an autocorrect or suggestion pick (which
// rewrites the tail rather than appending to it) survive, and what makes a word-length delete cost
// as many deletes as it removed characters.

export const TERMINAL_DELETE = '\x7f';
export const TERMINAL_WORD_DELETE = '\x1b\x7f';
export const TERMINAL_ENTER = '\r';

// A deletion the textarea cannot express, because it is already empty: the keyboard is deleting text
// that only ever existed on the terminal's own input line. Nothing is left to diff, so the intent has
// to come from the inputType alone.
const BACKWARD_DELETION_BYTES = new Map([
  ['deleteContentBackward', TERMINAL_DELETE],
  ['deleteByComposition', TERMINAL_DELETE],
  ['deleteCompositionText', TERMINAL_DELETE],
  ['deleteWordBackward', TERMINAL_WORD_DELETE],
  ['deleteSoftLineBackward', TERMINAL_WORD_DELETE],
  ['deleteHardLineBackward', TERMINAL_WORD_DELETE],
]);

export function bytesForBackwardDeletion(inputType: string) {
  return BACKWARD_DELETION_BYTES.get(inputType) ?? '';
}

// Text that reached the textarea through a path the terminal was already given directly. xterm's own
// paste handler triggers the data event and blanks the textarea before the browser inserts the same
// text, so diffing these would send the payload a second time.
const ALREADY_DELIVERED_INPUT_TYPES = new Set([
  'insertFromPaste',
  'insertFromPasteAsQuotation',
  'insertFromDrop',
  'insertFromYank',
  'historyUndo',
  'historyRedo',
]);

export function isTypedInputType(inputType: unknown) {
  if (typeof inputType !== 'string' || inputType === '') return true;
  return !ALREADY_DELIVERED_INPUT_TYPES.has(inputType);
}

// keyCode 229 is the IME's "still processing" keydown, and it is the only keydown Android keyboards
// give for predictive text. 'Process' is the UI Events name for the same thing.
export function isImeProcessingKeydown(event: { keyCode?: number; key?: string } | null | undefined) {
  if (!event) return false;
  return event.keyCode === 229 || event.key === 'Process';
}

export function bytesForSoftKeyboardEdit(previousText: string | null | undefined, nextText: string | null | undefined) {
  // Diffed by code point so one astral character costs one delete and no surrogate pair is split.
  const previous = Array.from(previousText ?? '');
  const next = Array.from(nextText ?? '');
  const shortest = Math.min(previous.length, next.length);
  let sharedPrefixLength = 0;
  while (sharedPrefixLength < shortest && previous[sharedPrefixLength] === next[sharedPrefixLength]) {
    sharedPrefixLength++;
  }
  const deletes = TERMINAL_DELETE.repeat(previous.length - sharedPrefixLength);
  const typed = next.slice(sharedPrefixLength).join('').replace(/\r\n|\n|\r/g, TERMINAL_ENTER);
  return deletes + typed;
}
