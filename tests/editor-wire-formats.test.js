'use strict';

// Real editors parse these files, so a real parser checks them rather than a regex.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { execFileSync } = require('node:child_process');
const { helixMerge, jsonSettingsMerge, kateSettings, sublimeSettings } = require('../server/core/editor-wire-core');

const INVOCATION = { command: 'glissa', args: ['visions', 'relay'] };

function pythonWithTomllib() {
  for (const candidate of ['python3', 'python']) {
    try {
      execFileSync(candidate, ['-c', 'import tomllib'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try the next spelling; a host without either simply skips the TOML case.
    }
  }
  return null;
}

function parseToml(python, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-toml-'));
  const file = path.join(dir, 'languages.toml');
  fs.writeFileSync(file, text, 'utf8');
  try {
    const out = execFileSync(python, ['-c', 'import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))', file], { encoding: 'utf8' });
    return JSON.parse(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const python = pythonWithTomllib();

test('the helix block is valid TOML and leaves the operator\'s own languages alone', { skip: python ? false : 'no python with tomllib' }, () => {
  const existing = '[[language]]\nname = "rust"\nauto-format = true\n';
  const merged = helixMerge(existing, INVOCATION);
  const parsed = parseToml(python, merged.text);

  assert.deepEqual(parsed['language-server']['glissa-visions'], { command: 'glissa', args: ['visions', 'relay'] });
  const markdown = parsed.language.find((entry) => entry.name === 'markdown');
  assert.deepEqual(markdown['language-servers'], ['marksman', 'glissa-visions']);
  const rust = parsed.language.find((entry) => entry.name === 'rust');
  assert.equal(rust['auto-format'], true);
});

test('adding to an existing markdown entry stays valid TOML', { skip: python ? false : 'no python with tomllib' }, () => {
  const existing = '[[language]]\nname = "markdown"\nlanguage-servers = ["marksman"]\ntext-width = 100\n';
  const parsed = parseToml(python, helixMerge(existing, INVOCATION).text);
  const markdown = parsed.language.find((entry) => entry.name === 'markdown');
  assert.deepEqual(markdown['language-servers'], ['marksman', 'glissa-visions']);
  assert.equal(markdown['text-width'], 100);
  assert.equal(parsed.language.length, 1);
});

test('an empty language-servers list stays valid TOML once ours is in it', { skip: python ? false : 'no python with tomllib' }, () => {
  const parsed = parseToml(python, helixMerge('[[language]]\nname = "markdown"\nlanguage-servers = []\n', INVOCATION).text);
  assert.deepEqual(parsed.language[0]['language-servers'], ['glissa-visions']);
});

test('the sublime and kate settings stay valid JSON with their own keys intact', () => {
  const sublime = jsonSettingsMerge('{\n  "log_debug": true\n}\n', sublimeSettings(INVOCATION));
  const parsedSublime = JSON.parse(sublime.text);
  assert.equal(parsedSublime.log_debug, true);
  assert.equal(parsedSublime.clients['glissa-visions'].selector, 'text.html.markdown');

  const kate = jsonSettingsMerge('{\n  "servers": {\n    "python": { "command": ["pylsp"] }\n  }\n}\n', kateSettings(INVOCATION));
  const parsedKate = JSON.parse(kate.text);
  assert.deepEqual(parsedKate.servers.python.command, ['pylsp']);
  assert.deepEqual(parsedKate.servers.markdown.command, ['glissa', 'visions', 'relay']);
});
