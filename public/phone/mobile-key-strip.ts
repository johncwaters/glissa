import { el } from '../dom-helpers.ts';
import type { MobileKey } from '../mobile-keys.ts';
import { isClipboardKey, isUploadKey, mobileKeyBytes, MOBILE_KEYS } from '../mobile-keys.ts';
import { showErrorToast } from '../session-card/toast.ts';

export function createMobileKeyStrip({ send, getSessionId }: { send: (data: string | null | undefined) => void; getSessionId?: () => string | null | undefined }) {
  const strip = el('div', 'phone-key-strip');
  strip.setAttribute('role', 'toolbar');
  strip.setAttribute('aria-label', 'Terminal keys');

  let filePicker: HTMLInputElement | null = null;
  let pickingButton: HTMLButtonElement | null = null;

  for (const key of MOBILE_KEYS) {
    const btn = el('button', 'phone-key', key.label);
    btn.type = 'button';
    btn.dataset.key = key.id;
    btn.title = key.title;

    btn.addEventListener('pointerdown', (event) => event.preventDefault());
    btn.addEventListener('click', () => pressKey(key, btn));
    strip.appendChild(btn);
  }

  function pressKey(key: Readonly<MobileKey>, btn: HTMLButtonElement) {
    if (isUploadKey(key)) {
      openUploadPicker(key, btn);
      return;
    }
    if (isClipboardKey(key)) {
      pasteFromClipboard(send);
      return;
    }

    send(mobileKeyBytes(key.id));
  }

  function openUploadPicker(key: Readonly<MobileKey>, btn: HTMLButtonElement) {
    pickingButton = btn;
    if (!filePicker) {
      filePicker = el('input', 'phone-file-picker');
      filePicker.type = 'file';
      filePicker.hidden = true;
      filePicker.addEventListener('change', onFilePicked);
      strip.appendChild(filePicker);
    }
    if (key.accept) filePicker.accept = key.accept;
    if (!key.accept) filePicker.removeAttribute('accept');
    filePicker.click();
  }

  function onFilePicked() {
    const picker = filePicker;
    if (!picker) return;
    const file = picker.files ? picker.files[0] : null;

    picker.value = '';
    if (!file) return;
    const sessionId = getSessionId?.();
    if (!sessionId) {
      showErrorToast('No session is open to upload to');
      return;
    }
    uploadFile(sessionId, file, pickingButton);
  }

  async function uploadFile(sessionId: string, file: File, btn: HTMLButtonElement | null) {
    if (btn) btn.disabled = true;
    const headers: Record<string, string> = { 'x-glissa-upload-name': encodeURIComponent(file.name) };
    if (file.type) headers['content-type'] = file.type;
    try {
      const res = await fetch(`/upload/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        body: file,
        headers,
      });
      if (!res.ok) showErrorToast(await uploadErrorText(res));
    } catch {
      showErrorToast('Upload failed');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  return strip;
}

async function uploadErrorText(res: Response) {
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    if (body && typeof body.error === 'string') return `Upload failed: ${body.error}`;
  } catch {
  }
  return 'Upload failed';
}

function pasteFromClipboard(send: (data: string) => void) {
  let read: Promise<string> | null | undefined = null;
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
