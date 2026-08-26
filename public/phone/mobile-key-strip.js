// The touch key strip's DOM. A soft keyboard gives xterm printable characters only, so Esc / Tab /
// Ctrl+C / arrows have no other way in; byte catalog in ../mobile-keys.mjs.

import { el } from '../dom-helpers.js';
import { isClipboardKey, isUploadKey, mobileKeyBytes, MOBILE_KEYS } from '../mobile-keys.mjs';
import { showErrorToast } from '../session-card/toast.js';

// send(data) writes into the currently shown session; getSessionId() names that session for the
// upload endpoint (the image travels over HTTP, not the data WS). The caller owns resolving both, so
// the strip itself holds no session state and survives every session swap unchanged.
export function createMobileKeyStrip({ send, getSessionId }) {
  const strip = el('div', 'phone-key-strip');
  strip.setAttribute('role', 'toolbar');
  strip.setAttribute('aria-label', 'Terminal keys');

  // Built on first use and kept in the strip so it stays in the document: a detached input's picker is
  // ignored by some mobile engines. The operator never sees it.
  /** @type {HTMLInputElement|null} */
  let filePicker = null;
  /** @type {HTMLButtonElement|null} */
  let pickingButton = null;

  for (const key of MOBILE_KEYS) {
    const btn = el('button', 'phone-key', key.label);
    btn.type = 'button';
    btn.dataset.key = key.id;
    btn.title = key.title;
    // A press must not move DOM focus off xterm's hidden textarea, or the soft keyboard closes on every
    // Esc or arrow tap; preventing the default on pointerdown blocks the focus change while leaving the
    // click that actually sends the bytes.
    btn.addEventListener('pointerdown', (event) => event.preventDefault());
    btn.addEventListener('click', () => pressKey(key, btn));
    strip.appendChild(btn);
  }

  function pressKey(key, btn) {
    if (isUploadKey(key)) {
      openImagePicker(btn);
      return;
    }
    if (isClipboardKey(key)) {
      pasteFromClipboard(send);
      return;
    }
    // Through the tested accessor, so the unit-tested mapping is the one production ships.
    send(mobileKeyBytes(key.id));
  }

  function openImagePicker(btn) {
    pickingButton = btn;
    if (!filePicker) {
      filePicker = el('input', 'phone-file-picker');
      filePicker.type = 'file';
      filePicker.accept = 'image/*';
      filePicker.hidden = true;
      filePicker.addEventListener('change', onImagePicked);
      strip.appendChild(filePicker);
    }
    filePicker.click();
  }

  function onImagePicked() {
    const picker = filePicker;
    if (!picker) return;
    const file = picker.files ? picker.files[0] : null;
    // Cleared immediately: re-picking the SAME photo fires no change event while its value is still set.
    picker.value = '';
    if (!file) return;
    const sessionId = getSessionId?.();
    if (!sessionId) {
      showErrorToast('No session is open to upload to');
      return;
    }
    uploadImage(sessionId, file, pickingButton);
  }

  // Same-origin relative URL (dev and prod serve this app off the same Express instance), and fetch's
  // default credentials carry the pairing cookie a remote phone needs. The server saves the bytes and
  // pastes the saved path into the session's terminal; nothing is echoed here.
  async function uploadImage(sessionId, file, btn) {
    // The label is constant and no spinner goes inside the button: the control just refuses a second
    // pick until this one lands.
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/upload/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        body: file,
        headers: { 'content-type': file.type },
      });
      if (!res.ok) showErrorToast(await uploadErrorText(res));
    } catch {
      showErrorToast('Image upload failed');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  return strip;
}

async function uploadErrorText(res) {
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') return `Image upload failed: ${body.error}`;
  } catch {
    // A non-JSON error body (a proxy's HTML page) carries nothing worth showing.
  }
  return 'Image upload failed';
}

function pasteFromClipboard(send) {
  // Reading the clipboard needs an explicit permission on most engines and is absent entirely in an
  // insecure context. A denial can arrive either way - some engines throw NotAllowedError
  // synchronously instead of rejecting - so both shapes are caught and both surface as a notice
  // rather than a silently dead button.
  /** @type {Promise<string>|null} */
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
