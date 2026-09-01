export const CLIPBOARD_ACTION = 'clipboard';

export const UPLOAD_ACTION = 'upload';

export interface MobileKey {
  id: string;
  label: string;
  bytes: string | null;
  action?: string;
  title: string;
}

export const MOBILE_KEYS: readonly Readonly<MobileKey>[] = Object.freeze([
  Object.freeze({ id: 'esc', label: 'Esc', bytes: '\x1b', title: 'Send Escape' }),
  Object.freeze({ id: 'tab', label: 'Tab', bytes: '\x09', title: 'Send Tab' }),
  Object.freeze({ id: 'ctrl-c', label: 'Ctrl+C', bytes: '\x03', title: 'Interrupt the running command' }),
  Object.freeze({ id: 'up', label: 'Up', bytes: '\x1b[A', title: 'Arrow up' }),
  Object.freeze({ id: 'down', label: 'Down', bytes: '\x1b[B', title: 'Arrow down' }),
  Object.freeze({ id: 'paste', label: 'Paste', bytes: null, action: CLIPBOARD_ACTION, title: 'Paste from the clipboard' }),
  Object.freeze({ id: 'upload-image', label: 'Image', bytes: null, action: UPLOAD_ACTION, title: 'Upload an image to this session' }),
]);

export function mobileKeyBytes(id: string) {
  const key = MOBILE_KEYS.find((k) => k.id === id);
  if (!key) return null;
  return key.bytes;
}

export function isClipboardKey(key: Pick<MobileKey, 'action'> | null | undefined) {
  return !!key && key.action === CLIPBOARD_ACTION;
}

export function isUploadKey(key: Pick<MobileKey, 'action'> | null | undefined) {
  return !!key && key.action === UPLOAD_ACTION;
}
