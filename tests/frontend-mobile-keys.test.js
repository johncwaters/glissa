'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// mobile-keys is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/mobile-keys.mjs');

test('MOBILE_KEYS: the strip carries exactly the six touch controls, in order', async () => {
  const { MOBILE_KEYS } = await importCore();
  assert.deepEqual(MOBILE_KEYS.map((k) => k.id), ['esc', 'tab', 'ctrl-c', 'up', 'down', 'paste']);
});

test('MOBILE_KEYS: every label is a constant action name, never a state or a count', async () => {
  const { MOBILE_KEYS } = await importCore();
  assert.deepEqual(MOBILE_KEYS.map((k) => k.label), ['Esc', 'Tab', 'Ctrl+C', 'Up', 'Down', 'Paste']);
});

test('mobileKeyBytes: sends the exact control bytes the keyboard paths send', async () => {
  const { mobileKeyBytes } = await importCore();
  assert.equal(mobileKeyBytes('esc'), '\x1b');
  assert.equal(mobileKeyBytes('tab'), '\x09');
  assert.equal(mobileKeyBytes('ctrl-c'), '\x03');
  assert.equal(mobileKeyBytes('up'), '\x1b[A');
  assert.equal(mobileKeyBytes('down'), '\x1b[B');
});

test('mobileKeyBytes: the clipboard key and unknown ids carry no bytes', async () => {
  const { mobileKeyBytes } = await importCore();
  assert.equal(mobileKeyBytes('paste'), null);
  assert.equal(mobileKeyBytes('nope'), null);
});

test('isClipboardKey: only the paste entry is a clipboard read', async () => {
  const { isClipboardKey, MOBILE_KEYS } = await importCore();
  const byId = new Map(MOBILE_KEYS.map((k) => [k.id, k]));
  assert.equal(isClipboardKey(byId.get('paste')), true);
  assert.equal(isClipboardKey(byId.get('esc')), false);
  assert.equal(isClipboardKey(undefined), false);
});
