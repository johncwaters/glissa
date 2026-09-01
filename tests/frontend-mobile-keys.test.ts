import test from 'node:test';
import assert from 'node:assert/strict';

const importCore = () => import('../public/mobile-keys.ts');

test('MOBILE_KEYS: the strip carries exactly the seven touch controls, in order', async () => {
  const { MOBILE_KEYS } = await importCore();
  assert.deepEqual(MOBILE_KEYS.map((k) => k.id), ['esc', 'tab', 'ctrl-c', 'up', 'down', 'paste', 'upload-image']);
});

test('MOBILE_KEYS: every label is a constant action name, never a state or a count', async () => {
  const { MOBILE_KEYS } = await importCore();
  assert.deepEqual(MOBILE_KEYS.map((k) => k.label), ['Esc', 'Tab', 'Ctrl+C', 'Up', 'Down', 'Paste', 'Image']);
});

test('mobileKeyBytes: sends the exact control bytes the keyboard paths send', async () => {
  const { mobileKeyBytes } = await importCore();
  assert.equal(mobileKeyBytes('esc'), '\x1b');
  assert.equal(mobileKeyBytes('tab'), '\x09');
  assert.equal(mobileKeyBytes('ctrl-c'), '\x03');
  assert.equal(mobileKeyBytes('up'), '\x1b[A');
  assert.equal(mobileKeyBytes('down'), '\x1b[B');
});

test('mobileKeyBytes: the action keys and unknown ids carry no bytes', async () => {
  const { mobileKeyBytes } = await importCore();
  assert.equal(mobileKeyBytes('paste'), null);
  assert.equal(mobileKeyBytes('upload-image'), null, 'the image travels over HTTP, not as key bytes');
  assert.equal(mobileKeyBytes('nope'), null);
});

test('isClipboardKey: only the paste entry is a clipboard read', async () => {
  const { isClipboardKey, MOBILE_KEYS } = await importCore();
  const byId = new Map(MOBILE_KEYS.map((k) => [k.id, k]));
  assert.equal(isClipboardKey(byId.get('paste')), true);
  assert.equal(isClipboardKey(byId.get('esc')), false);
  assert.equal(isClipboardKey(byId.get('upload-image')), false);
  assert.equal(isClipboardKey(undefined), false);
});

test('isUploadKey: only the image entry opens the file picker', async () => {
  const { isUploadKey, MOBILE_KEYS, UPLOAD_ACTION } = await importCore();
  const byId = new Map(MOBILE_KEYS.map((k) => [k.id, k]));
  assert.equal(isUploadKey(byId.get('upload-image')), true);
  assert.equal(byId.get('upload-image')?.action, UPLOAD_ACTION);
  assert.equal(isUploadKey(byId.get('paste')), false);
  assert.equal(isUploadKey(byId.get('ctrl-c')), false);
  assert.equal(isUploadKey(undefined), false);
});
