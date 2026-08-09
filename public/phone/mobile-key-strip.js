// The touch key strip's DOM. A soft keyboard gives xterm printable characters only, so Esc / Tab /
// Ctrl+C / arrows have no other way in; byte catalog in ../mobile-keys.mjs.

import { el } from '../dom-helpers.js';
import { isClipboardKey, mobileKeyBytes, MOBILE_KEYS } from '../mobile-keys.mjs';
import { showErrorToast } from '../session-card/toast.js';

// send(data) writes into the currently shown session; the caller owns resolving that session, so the
// strip itself holds no session state and survives every session swap unchanged.
export function createMobileKeyStrip({ send }) {
  const strip = el('div', 'phone-key-strip');
  strip.setAttribute('role', 'toolbar');
  strip.setAttribute('aria-label', 'Terminal keys');

  for (const key of MOBILE_KEYS) {
    const btn = el('button', 'phone-key', key.label);
    btn.type = 'button';
    btn.dataset.key = key.id;
    btn.title = key.title;
    btn.addEventListener('click', () => pressKey(key, send));
    strip.appendChild(btn);
  }
  return strip;
}

function pressKey(key, send) {
  if (!isClipboardKey(key)) {
    // Through the tested accessor, so the unit-tested mapping is the one production ships.
    send(mobileKeyBytes(key.id));
    return;
  }
  // Reading the clipboard needs an explicit permission on most engines and is absent entirely in an
  // insecure context. A denial can arrive either way - some engines throw NotAllowedError
  // synchronously instead of rejecting - so both shapes are caught and both surface as a notice
  // rather than a silently dead button.
  let read = null;
  try {
    read = navigator.clipboard?.readText?.();
  } catch {
    showErrorToast('Paste needs clipboard permission');
    return;
  }
  if (!read) {
    showErrorToast('Paste is unavailable in this browser');
    return;
  }
  read
    .then((text) => { if (text) send(text); })
    .catch(() => showErrorToast('Paste needs clipboard permission'));
}
