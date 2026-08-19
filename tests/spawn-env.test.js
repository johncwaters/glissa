'use strict';

// Unit tests for the pure spawn-environment builder extracted from Session._buildSpawnEnv.
// Asserts the 5-var scrub, the copy semantics (input never mutated), and the
// no-flicker flag behavior - the invariants the live spawn path depends on.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildSpawnEnv } = require('../session/core/spawn-env');

const SCRUBBED = [
  'CLAUDECODE',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'GLISSA_PORT',
  'GLISSA_CONFIG',
];

function fullBase() {
  return {
    PATH: '/usr/bin',
    HOME: '/home/u',
    CLAUDECODE: '1',
    CLAUDE_CODE_SSE_PORT: '7777',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    GLISSA_PORT: '3000',
    GLISSA_CONFIG: 'C:\\x\\config.json',
  };
}

test('scrubs all 5 inherited vars', () => {
  const env = buildSpawnEnv(fullBase());
  for (const k of SCRUBBED) {
    assert.ok(!(k in env), `${k} must be deleted from the spawn env`);
  }
});

test('negative: no CLAUDECODE-exact or GLISSA_* keys survive', () => {
  const env = buildSpawnEnv(fullBase());
  const keys = Object.keys(env);
  assert.equal(keys.includes('CLAUDECODE'), false);
  assert.equal(keys.some((k) => k.startsWith('GLISSA_')), false);
  // The two CLAUDE_CODE_* spawn vars are gone; the only CLAUDE_CODE_* key allowed is the
  // no-flicker flag (always set), never the inherited SSE_PORT/ENTRYPOINT.
  assert.equal(keys.includes('CLAUDE_CODE_SSE_PORT'), false);
  assert.equal(keys.includes('CLAUDE_CODE_ENTRYPOINT'), false);
});

test('preserves unrelated vars (including an inherited ANTHROPIC_BASE_URL)', () => {
  const env = buildSpawnEnv({ ...fullBase(), ANTHROPIC_BASE_URL: 'http://user-proxy:9999' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  // Glissa no longer injects or scrubs a proxy var; a user-level ANTHROPIC_BASE_URL passes through.
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://user-proxy:9999');
});

test('CLAUDE_CODE_NO_FLICKER is always set to "1"', () => {
  // No-flicker mode is always on; the flag is unconditionally injected.
  assert.equal(buildSpawnEnv(fullBase()).CLAUDE_CODE_NO_FLICKER, '1');
});

test('returns a COPY - baseEnv is never mutated', () => {
  const base = fullBase();
  const env = buildSpawnEnv(base);
  assert.notEqual(env, base, 'output must be a distinct object');
  // input retains every original key (none deleted on the source)
  assert.equal(base.CLAUDECODE, '1');
  assert.equal(base.GLISSA_PORT, '3000');
  assert.equal(base.CLAUDE_CODE_SSE_PORT, '7777');
  // the no-flicker flag is added to the output copy, not the source
  assert.ok(!('CLAUDE_CODE_NO_FLICKER' in base), 'flag must not leak back onto the source');
  assert.equal(env.CLAUDE_CODE_NO_FLICKER, '1', 'flag must be present on the output');
});

test('CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD is set only when a pack dir was added', () => {
  const KEY = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD';
  // Default and explicit-false must both leave today's env untouched (no packs, no flag).
  assert.equal(KEY in buildSpawnEnv(fullBase()), false);
  assert.equal(KEY in buildSpawnEnv(fullBase(), null, {}), false);
  assert.equal(KEY in buildSpawnEnv(fullBase(), null, { additionalDirsClaudeMd: false }), false);
  assert.equal(buildSpawnEnv(fullBase(), null, { additionalDirsClaudeMd: true })[KEY], '1');
});

test('the pack flag lands on the copy, never on the source env', () => {
  const base = fullBase();
  buildSpawnEnv(base, null, { additionalDirsClaudeMd: true });
  assert.ok(!('CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD' in base));
});

test('prependPathDir prepends to an existing Path key without adding PATH', () => {
  const base = { ...fullBase(), PATH: undefined, Path: `C:\\Windows${path.delimiter}C:\\Tools` };
  delete base.PATH;
  const env = buildSpawnEnv(base, null, { prependPathDir: 'C:\\Users\\johnw\\.glissa\\bin' });
  assert.equal(env.Path, `C:\\Users\\johnw\\.glissa\\bin${path.delimiter}C:\\Windows${path.delimiter}C:\\Tools`);
  assert.equal('PATH' in env, false);
});

test('prependPathDir prepends to an existing PATH key', () => {
  const env = buildSpawnEnv(fullBase(), null, { prependPathDir: '/home/u/.glissa/bin' });
  assert.equal(env.PATH, `/home/u/.glissa/bin${path.delimiter}/usr/bin`);
});

test('prependPathDir does not duplicate an existing path entry case-insensitively', () => {
  const existingPath = `C:\\Users\\johnw\\.glissa\\bin${path.delimiter}C:\\Windows`;
  const env = buildSpawnEnv({ ...fullBase(), PATH: existingPath }, null, {
    prependPathDir: 'c:\\users\\johnw\\.glissa\\bin',
  });
  assert.equal(env.PATH, existingPath);
});

test('prependPathDir sets PATH when no path variable exists', () => {
  const base = fullBase();
  delete base.PATH;
  const env = buildSpawnEnv(base, null, { prependPathDir: '/home/u/.glissa/bin' });
  assert.equal(env.PATH, '/home/u/.glissa/bin');
});

test('omitted or null prependPathDir leaves the path variable byte-identical', () => {
  const base = fullBase();
  assert.equal(buildSpawnEnv(base).PATH, base.PATH);
  assert.equal(buildSpawnEnv(base, null, { prependPathDir: null }).PATH, base.PATH);
});
