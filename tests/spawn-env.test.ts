// Unit tests for the pure spawn-environment builder extracted from Session._buildSpawnEnv.
// Asserts the 6-var scrub, the copy semantics (input never mutated), and the
// no-flicker flag behavior - the invariants the live spawn path depends on.
//
// The core is agent-neutral, so every pin runs it against the Claude Code adapter's OWN env profile:
// the scrub list under test is the one the live spawn path passes, not a copy restated here.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildAgentEnv } from '../session/core/spawn-env.ts';
import type { AgentEnvOptions, SpawnEnv } from '../session/core/spawn-env.ts';
import claudeCodeAdapter from '../session/adapters/claude-code.ts';

function claudeSpawnEnv(baseEnv: SpawnEnv, extraEnv?: SpawnEnv | null, options?: AgentEnvOptions) {
  return buildAgentEnv(baseEnv, extraEnv, claudeCodeAdapter.envProfile, options);
}

const SCRUBBED = [
  'CLAUDECODE',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'GLISSA_PORT',
  'GLISSA_CONFIG',
];

function fullBase(): SpawnEnv {
  return {
    PATH: '/usr/bin',
    HOME: '/home/u',
    CLAUDECODE: '1',
    CLAUDE_CODE_SSE_PORT: '7777',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    // Inherited marker that disables transcript saving in the child (live-probed 2.1.235).
    CLAUDE_CODE_CHILD_SESSION: '1',
    GLISSA_PORT: '3000',
    GLISSA_CONFIG: 'C:\\x\\config.json',
  };
}

test('scrubs all 6 inherited vars', () => {
  const env = claudeSpawnEnv(fullBase());
  for (const k of SCRUBBED) {
    assert.ok(!(k in env), `${k} must be deleted from the spawn env`);
  }
});

test('negative: no CLAUDECODE-exact or GLISSA_* keys survive', () => {
  const env = claudeSpawnEnv(fullBase());
  const keys = Object.keys(env);
  assert.equal(keys.includes('CLAUDECODE'), false);
  assert.equal(keys.some((k) => k.startsWith('GLISSA_')), false);
  // The two CLAUDE_CODE_* spawn vars are gone; the only CLAUDE_CODE_* key allowed is the
  // no-flicker flag (always set), never the inherited SSE_PORT/ENTRYPOINT.
  assert.equal(keys.includes('CLAUDE_CODE_SSE_PORT'), false);
  assert.equal(keys.includes('CLAUDE_CODE_ENTRYPOINT'), false);
});

test('preserves unrelated vars (including an inherited ANTHROPIC_BASE_URL)', () => {
  const env = claudeSpawnEnv({ ...fullBase(), ANTHROPIC_BASE_URL: 'http://user-proxy:9999' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  // Glissa no longer injects or scrubs a proxy var; a user-level ANTHROPIC_BASE_URL passes through.
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://user-proxy:9999');
});

test('CLAUDE_CODE_NO_FLICKER is always set to "1"', () => {
  // No-flicker mode is always on; the flag is unconditionally injected.
  assert.equal(claudeSpawnEnv(fullBase()).CLAUDE_CODE_NO_FLICKER, '1');
});

test('returns a COPY - baseEnv is never mutated', () => {
  const base = fullBase();
  const env = claudeSpawnEnv(base);
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
  assert.equal(KEY in claudeSpawnEnv(fullBase()), false);
  assert.equal(KEY in claudeSpawnEnv(fullBase(), null, {}), false);
  assert.equal(KEY in claudeSpawnEnv(fullBase(), null, { additionalDirsClaudeMd: false }), false);
  assert.equal(claudeSpawnEnv(fullBase(), null, { additionalDirsClaudeMd: true })[KEY], '1');
});

test('an inherited pack flag is scrubbed when no pack dir was added', () => {
  const KEY = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD';
  const inherited = { ...fullBase(), [KEY]: '1' };
  assert.equal(KEY in claudeSpawnEnv(inherited, null, { additionalDirsClaudeMd: false }), false);
  assert.equal(claudeSpawnEnv(inherited, null, { additionalDirsClaudeMd: true })[KEY], '1');
});

test('the pack flag lands on the copy, never on the source env', () => {
  const base = fullBase();
  claudeSpawnEnv(base, null, { additionalDirsClaudeMd: true });
  assert.ok(!('CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD' in base));
});

test('prependPathDir prepends to an existing Path key without adding PATH', () => {
  const base: SpawnEnv = { ...fullBase(), Path: `C:\\Windows${path.delimiter}C:\\Tools` };
  delete base.PATH;
  const env = claudeSpawnEnv(base, null, { prependPathDir: 'C:\\Users\\johnw\\.glissa\\bin' });
  assert.equal(env.Path, `C:\\Users\\johnw\\.glissa\\bin${path.delimiter}C:\\Windows${path.delimiter}C:\\Tools`);
  assert.equal('PATH' in env, false);
});

test('prependPathDir prepends to an existing PATH key', () => {
  const env = claudeSpawnEnv(fullBase(), null, { prependPathDir: '/home/u/.glissa/bin' });
  assert.equal(env.PATH, `/home/u/.glissa/bin${path.delimiter}/usr/bin`);
});

test('prependPathDir does not duplicate an existing path entry case-insensitively', () => {
  const existingPath = `C:\\Users\\johnw\\.glissa\\bin${path.delimiter}C:\\Windows`;
  const env = claudeSpawnEnv({ ...fullBase(), PATH: existingPath }, null, {
    prependPathDir: 'c:\\users\\johnw\\.glissa\\bin',
  });
  assert.equal(env.PATH, existingPath);
});

test('prependPathDir does not duplicate an entry that differs only in slash direction', () => {
  const existingPath = `C:/Users/johnw/.glissa/bin${path.delimiter}C:\\Windows`;
  const env = claudeSpawnEnv({ ...fullBase(), PATH: existingPath }, null, {
    prependPathDir: 'C:\\Users\\johnw\\.glissa\\bin',
  });
  assert.equal(env.PATH, existingPath);
});

test('prependPathDir keeps a Windows drive-letter entry whole in a colon-delimited PATH', () => {
  const existingPath = `/usr/bin${path.delimiter}C:\\Users\\johnw\\.glissa\\bin`;
  const env = claudeSpawnEnv({ ...fullBase(), PATH: existingPath }, null, {
    prependPathDir: 'C:\\Users\\johnw\\.glissa\\bin',
  });
  assert.equal(env.PATH, existingPath);
});

test('prependPathDir prepends ahead of a Windows drive-letter entry without splitting it', () => {
  const existingPath = `/usr/bin${path.delimiter}C:\\Windows\\bin`;
  const env = claudeSpawnEnv({ ...fullBase(), PATH: existingPath }, null, {
    prependPathDir: '/home/u/.glissa/bin',
  });
  assert.equal(env.PATH, `/home/u/.glissa/bin${path.delimiter}${existingPath}`);
});

test('prependPathDir sets PATH when no path variable exists', () => {
  const base = fullBase();
  delete base.PATH;
  const env = claudeSpawnEnv(base, null, { prependPathDir: '/home/u/.glissa/bin' });
  assert.equal(env.PATH, '/home/u/.glissa/bin');
});

test('omitted or null prependPathDir leaves the path variable byte-identical', () => {
  const base = fullBase();
  assert.equal(claudeSpawnEnv(base).PATH, base.PATH);
  assert.equal(claudeSpawnEnv(base, null, { prependPathDir: null }).PATH, base.PATH);
});
