export const TERMINAL_DELETE = '\x7f';
export const TERMINAL_WORD_DELETE = '\x1b\x7f';
export const TERMINAL_ENTER = '\r';

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

export function isImeProcessingKeydown(event: { keyCode?: number; key?: string } | null | undefined) {
  if (!event) return false;
  return event.keyCode === 229 || event.key === 'Process';
}

export function bytesForSoftKeyboardEdit(previousText: string | null | undefined, nextText: string | null | undefined) {
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
