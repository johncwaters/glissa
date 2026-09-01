import test from 'node:test';
import assert from 'node:assert/strict';

import { SHORTCUT_GROUPS } from '../public/shortcuts.ts';

function everyCaption(): string[] {
  const captions: string[] = [];
  for (const group of SHORTCUT_GROUPS) {
    captions.push(group.title);
    for (const item of group.items) {
      captions.push(item.label);
      for (const chord of item.combos) captions.push(...chord);
    }
  }
  return captions;
}

test('SHORTCUT_GROUPS: every group, item and chord carries renderable text', () => {
  assert.ok(SHORTCUT_GROUPS.length > 0);
  for (const group of SHORTCUT_GROUPS) {
    assert.ok(group.title.length > 0, 'group title non-empty');
    assert.ok(group.items.length > 0, `group ${group.title} has items`);
    for (const item of group.items) {
      assert.ok(item.label.length > 0, 'item label non-empty');
      assert.ok(item.combos.length > 0, 'item has combos');
      for (const chord of item.combos) {
        assert.ok(chord.length > 0, 'chord is a non-empty array');
        for (const caption of chord) assert.ok(caption.length > 0, 'key caption non-empty');
      }
    }
  }
});

test('SHORTCUT_GROUPS: documents the core bindings', () => {
  const chords = new Set<string>();
  for (const group of SHORTCUT_GROUPS) {
    for (const item of group.items) {
      for (const chord of item.combos) chords.add(chord.join('+'));
    }
  }
  const up = String.fromCharCode(0x2191);
  const down = String.fromCharCode(0x2193);
  for (const expected of [`Alt+${up}`, `Alt+${down}`, 'Alt+1-9', 'Alt+W', 'Alt+M', 'Alt+R', 'Alt+0', '?', 'Esc']) {
    assert.ok(chords.has(expected), `documents ${expected}`);
  }
});

test('SHORTCUT_GROUPS: no banned dash or ellipsis literals (no-dash repo)', () => {
  const banned = [0x2014, 0x2013, 0x2026].map((code) => String.fromCharCode(code));
  for (const caption of everyCaption()) {
    for (const glyph of banned) {
      assert.ok(!caption.includes(glyph), `"${caption}" must not contain a banned glyph`);
    }
  }
});
