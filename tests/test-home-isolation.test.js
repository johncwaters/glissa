'use strict';

/*
 * Guardrail: no test may resolve the OPERATOR's config. config-store falls back to ~/.glissa/config.json,
 * and everything sited beside it (the machine-wide database above all) then belongs to the carbon unit
 * running the suite, not to the test. That is how 42 fixture records landed in the live memory store
 * (audit 2026-08-25): fixture bodies, `sess-1` sources and a project key of `c:/repo`, durable.
 *
 * Two static rules, both about stating the location rather than inheriting it:
 *   - a test that boots a backend points GLISSA_CONFIG at a throwaway temp config first;
 *   - a test that opens the database passes an explicit dbPath.
 * The runtime half of the same rule is the refusal pinned by tests/db-path-guard.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;

const BACKEND_BOOT = /\bcreateBackend\s*\(/;
const SETS_CONFIG_ENV = /process\.env\.GLISSA_CONFIG\s*=/;
const OPENS_DB = /\b(?:createMemoryStore|createMemoryDb|openDatabase)\s*\(/;
// A mention is enough because shorthand (`createMemoryDb({ dbPath })`) is how half the suite states it.
const EXPLICIT_DB_PATH = /\bdbPath\b/;
const ARGUMENTLESS_OPEN = /\b(?:createMemoryStore|createMemoryDb|openDatabase)\s*\(\s*\)/;
const TEMP_ROOT = /\bmkdtempSync\s*\(|\bos\.tmpdir\s*\(/;

function collectTestFiles(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, acc);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.test.js')) acc.push(full);
  }
  return acc;
}

function readTestFiles() {
  const files = collectTestFiles(TESTS_DIR, []);
  assert.ok(files.length > 100, `expected to scan the suite, only found ${files.length} files`);
  return files.map((file) => ({ file: path.relative(TESTS_DIR, file), src: fs.readFileSync(file, 'utf8') }));
}

test('every backend-booting test points GLISSA_CONFIG at a throwaway config', () => {
  const offenders = [];
  for (const { file, src } of readTestFiles()) {
    if (!BACKEND_BOOT.test(src)) continue;
    if (!SETS_CONFIG_ENV.test(src)) offenders.push(`${file}: boots a backend without setting process.env.GLISSA_CONFIG`);
    if (SETS_CONFIG_ENV.test(src) && !TEMP_ROOT.test(src)) offenders.push(`${file}: sets GLISSA_CONFIG to a path outside os.tmpdir()`);
  }
  assert.deepEqual(offenders, [], `A backend booted on the resolved config writes into the operator's own ~/.glissa:\n  ${offenders.join('\n  ')}`);
});

test('every test that opens the database states its dbPath', () => {
  const offenders = [];
  for (const { file, src } of readTestFiles()) {
    if (!OPENS_DB.test(src)) continue;
    if (!EXPLICIT_DB_PATH.test(src)) offenders.push(`${file}: opens a memory database without an explicit dbPath`);
    if (ARGUMENTLESS_OPEN.test(src)) offenders.push(`${file}: opens a memory database with no arguments at all`);
  }
  assert.deepEqual(offenders, [], `An omitted dbPath used to resolve the operator's live store:\n  ${offenders.join('\n  ')}`);
});

test('createMemoryStore has no location defaults left to inherit', () => {
  const src = fs.readFileSync(path.join(TESTS_DIR, '..', 'server', 'memory-store.js'), 'utf8');
  assert.equal(/dir\s*=\s*defaultMemoryDir\(\)/.test(src), false, 'a default dir resolves the operator config');
  assert.equal(/dbPath\s*=\s*defaultDbPath\(\)/.test(src), false, 'a default dbPath resolves the operator config');
});
