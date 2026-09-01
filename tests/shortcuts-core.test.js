'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// shortcuts is ESM (.mjs); dynamic-import it from this CJS test file.
const importData = () => import('../public/shortcuts.ts');

test('SHORTCUT_GROUPS: every group is well-formed', async () => {
  const { SHORTCUT_GROUPS } = await importData();
  assert.ok(Array.isArray(SHORTCUT_GROUPS) && SHORTCUT_GROUPS.length > 0);
  for (const group of SHORTCUT_GROUPS) {
    assert.equal(typeof group.title, 'string');
    assert.ok(group.title.length > 0, 'group title non-empty');
    assert.ok(Array.isArray(group.items) && group.items.length > 0, `group ${group.title} has items`);
    for (const item of group.items) {
      assert.equal(typeof item.label, 'string');
      assert.ok(item.label.length > 0, 'item label non-empty');
      assert.ok(Array.isArray(item.combos) && item.combos.length > 0, 'item has combos');
      for (const chord of item.combos) {
        assert.ok(Array.isArray(chord) && chord.length > 0, 'chord is a non-empty array');
        for (const cap of chord) {
          assert.equal(typeof cap, 'string');
          assert.ok(cap.length > 0, 'key caption non-empty');
        }
      }
    }
  }
});

test('SHORTCUT_GROUPS: documents the core bindings', async () => {
  const { SHORTCUT_GROUPS } = await importData();
  // Serialize every chord as "Cap+Cap" for easy membership checks.
  const chords = new Set();
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

test('SHORTCUT_GROUPS: no banned dash or ellipsis literals (no-dash repo)', async () => {
  const { SHORTCUT_GROUPS } = await importData();
  const banned = [0x2014, 0x2013, 0x2026].map((c) => String.fromCharCode(c)); // em dash, en dash, ellipsis
  const strings = [];
  for (const group of SHORTCUT_GROUPS) {
    strings.push(group.title);
    for (const item of group.items) {
      strings.push(item.label);
      for (const chord of item.combos) strings.push(...chord);
    }
  }
  for (const s of strings) {
    for (const bad of banned) {
      assert.ok(!s.includes(bad), `"${s}" must not contain a banned glyph`);
    }
  }
});
