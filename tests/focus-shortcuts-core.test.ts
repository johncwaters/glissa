import test from 'node:test';
import assert from 'node:assert/strict';

import { isFocusAltShortcut } from '../public/focus-view/focus-shortcuts.ts';

test('isFocusAltShortcut: matches the triage, merge, and prev/next nav keys', () => {
  assert.equal(isFocusAltShortcut('w'), true);
  assert.equal(isFocusAltShortcut('W'), true);
  assert.equal(isFocusAltShortcut('m'), true);
  assert.equal(isFocusAltShortcut('M'), true);
  assert.equal(isFocusAltShortcut('r'), true);
  assert.equal(isFocusAltShortcut('R'), true);
  assert.equal(isFocusAltShortcut('ArrowUp'), true);
  assert.equal(isFocusAltShortcut('ArrowDown'), true);
});

test('isFocusAltShortcut: matches the digit shortcuts 0-9', () => {
  for (const d of ['0', '1', '5', '9']) assert.equal(isFocusAltShortcut(d), true, d);
});

test('isFocusAltShortcut: rejects keys the terminal should keep', () => {
  for (const k of ['a', 'b', 'f', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', '', '10']) {
    assert.equal(isFocusAltShortcut(k), false, k);
  }
});
