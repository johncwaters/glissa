'use strict';

// Glissa edits config files the operator maintains, so these pin the two properties that make that
// safe: a second run changes nothing, and unwiring restores the file byte for byte.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  emacsMerge, emacsRemove, helixMerge, helixRemove, jsonSettingsMerge, jsonSettingsRemove, kateSettings,
  neovimDropIn, sublimeSettings,
} = require('../server/core/editor-wire-core');

const INVOCATION = { command: 'glissa', args: ['visions', 'relay'] };

test('the neovim drop-in is a whole file glissa owns', () => {
  const text = neovimDropIn(INVOCATION);
  assert.match(text, /Written by glissa/);
  assert.match(text, /vim\.lsp\.start\(\{ name = 'glissa-visions', cmd = \{ 'glissa', 'visions', 'relay' \} \}\)/);
  assert.match(text, /pattern = 'markdown'/);
});

test('helix with no config gets the server and a markdown language entry, once', () => {
  const first = helixMerge('', INVOCATION);
  assert.equal(first.changed, true);
  assert.match(first.text, /\[language-server\.glissa-visions\]/);
  assert.match(first.text, /language-servers = \["marksman", "glissa-visions"\]/);
  assert.equal(helixMerge(first.text, INVOCATION).changed, false);
});

test('an existing markdown entry keeps its own servers and settings', () => {
  const existing = '[[language]]\nname = "markdown"\nlanguage-servers = ["marksman"]\nauto-format = true\n';
  const merged = helixMerge(existing, INVOCATION);
  assert.match(merged.text, /language-servers = \["marksman", "glissa-visions"\]/);
  assert.match(merged.text, /auto-format = true/);
  // Only the server definition is ours here, since their language entry already exists.
  assert.equal(merged.text.match(/\[\[language\]\]/g).length, 1);
  assert.equal(helixMerge(merged.text, INVOCATION).changed, false);
  assert.equal(helixRemove(merged.text).text, existing);
});

test('an empty language-servers list takes our entry without a stray comma', () => {
  const existing = '[[language]]\nname = "markdown"\nlanguage-servers = []\n';
  const merged = helixMerge(existing, INVOCATION);
  assert.match(merged.text, /language-servers = \["glissa-visions"\]/);
  assert.equal(helixMerge(merged.text, INVOCATION).changed, false);
  assert.equal(helixRemove(merged.text).text.includes('glissa-visions'), false);
});

test('helix leaves other languages alone', () => {
  const existing = '[[language]]\nname = "rust"\nauto-format = true\n';
  const merged = helixMerge(existing, INVOCATION);
  assert.match(merged.text, /name = "rust"/);
  assert.match(merged.text, /name = "markdown"/);
  assert.equal(helixRemove(merged.text).text.includes('glissa-visions'), false);
});

test('an unterminated block is refused by both directions rather than guessed at', () => {
  const broken = '[[language]]\nname = "markdown"\nlanguage-servers = ["marksman", "glissa-visions"]\n# >>> glissa-visions\n[language-server.glissa-visions]\n';
  const merged = helixMerge(broken, INVOCATION);
  assert.equal(merged.changed, false);
  assert.equal(merged.reason, 'unterminated-block');

  // Removing here would strip our server from their list and leave the block that names it behind.
  const removed = helixRemove(broken);
  assert.equal(removed.changed, false);
  assert.equal(removed.text, broken);

  const brokenEmacs = ';; >>> glissa-visions\n(with-eval-after-load \'eglot)\n';
  assert.equal(emacsRemove(brokenEmacs).changed, false);
});

test('the emacs block appends, refreshes in place and removes cleanly', () => {
  const existing = '(setq inhibit-startup-message t)\n';
  const merged = emacsMerge(existing, INVOCATION);
  assert.match(merged.text, /eglot-server-programs/);
  assert.match(merged.text, /inhibit-startup-message/);
  assert.equal(emacsMerge(merged.text, INVOCATION).changed, false);
  assert.equal(emacsRemove(merged.text).text, existing);
});

test('json settings gain one key and lose exactly that key again', () => {
  const existing = '{\n  "log_debug": true\n}\n';
  const merged = jsonSettingsMerge(existing, sublimeSettings(INVOCATION));
  const parsed = JSON.parse(merged.text);
  assert.equal(parsed.log_debug, true);
  assert.deepEqual(parsed.clients['glissa-visions'].command, ['glissa', 'visions', 'relay']);
  assert.equal(jsonSettingsMerge(merged.text, sublimeSettings(INVOCATION)).changed, false);

  const removed = jsonSettingsRemove(merged.text, sublimeSettings(INVOCATION));
  assert.equal(JSON.parse(removed.text).log_debug, true);
  assert.equal(JSON.parse(removed.text).clients['glissa-visions'], undefined);
});

test('a settings file glissa cannot parse is left untouched', () => {
  const withComments = '// user comment\n{ "clients": {} }\n';
  const merged = jsonSettingsMerge(withComments, kateSettings(INVOCATION));
  assert.equal(merged.changed, false);
  assert.equal(merged.reason, 'unparseable');
  assert.equal(merged.text, withComments);
});
