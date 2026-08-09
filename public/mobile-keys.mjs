// Pure catalog of the touch key strip's controls: the byte sequence each button writes into the PTY.
// A phone has no physical Esc / Tab / Ctrl / arrow keys, and xterm's soft-keyboard textarea never
// produces them, so this strip is the only way a touch operator can interrupt a run, indent, or walk
// shell history. DOM-free so the mapping is unit-testable; the strip element itself is built by
// phone/mobile-key-strip.js and the bytes go out through terminal.js sendTerminalInput.

// Paste carries no fixed bytes: its payload is whatever the clipboard holds at press time.
export const CLIPBOARD_ACTION = 'clipboard';

export const MOBILE_KEYS = Object.freeze([
  Object.freeze({ id: 'esc', label: 'Esc', bytes: '\x1b', title: 'Send Escape' }),
  Object.freeze({ id: 'tab', label: 'Tab', bytes: '\x09', title: 'Send Tab' }),
  Object.freeze({ id: 'ctrl-c', label: 'Ctrl+C', bytes: '\x03', title: 'Interrupt the running command' }),
  Object.freeze({ id: 'up', label: 'Up', bytes: '\x1b[A', title: 'Arrow up' }),
  Object.freeze({ id: 'down', label: 'Down', bytes: '\x1b[B', title: 'Arrow down' }),
  Object.freeze({ id: 'paste', label: 'Paste', bytes: null, action: CLIPBOARD_ACTION, title: 'Paste from the clipboard' }),
]);

// Bytes for a key id, or null for an id that has none (the clipboard action) and for an unknown id.
export function mobileKeyBytes(id) {
  const key = MOBILE_KEYS.find((k) => k.id === id);
  if (!key) return null;
  return key.bytes;
}

export function isClipboardKey(key) {
  return !!key && key.action === CLIPBOARD_ACTION;
}
