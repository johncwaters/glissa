'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// focus-shortcuts is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/focus-view/focus-shortcuts.ts');

test('isFocusAltShortcut: matches the triage, merge, and prev/next nav keys', async () => {
  const { isFocusAltShortcut } = await importCore();
  assert.equal(isFocusAltShortcut('w'), true);
  assert.equal(isFocusAltShortcut('W'), true);
  assert.equal(isFocusAltShortcut('m'), true);
  assert.equal(isFocusAltShortcut('M'), true);
  assert.equal(isFocusAltShortcut('r'), true);
  assert.equal(isFocusAltShortcut('R'), true);
  assert.equal(isFocusAltShortcut('ArrowUp'), true);
  assert.equal(isFocusAltShortcut('ArrowDown'), true);
});

test('isFocusAltShortcut: matches the digit shortcuts 0-9', async () => {
  const { isFocusAltShortcut } = await importCore();
  for (const d of ['0', '1', '5', '9']) assert.equal(isFocusAltShortcut(d), true, d);
});

test('isFocusAltShortcut: rejects keys the terminal should keep', async () => {
  const { isFocusAltShortcut } = await importCore();
  // Plain letters (Alt+b/f word nav in readline), other arrows, and non-key strings stay with the PTY.
  for (const k of ['a', 'b', 'f', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', '', '10']) {
    assert.equal(isFocusAltShortcut(k), false, k);
  }
});
