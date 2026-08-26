'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;

const BACKEND_BOOT = /\bcreateBackend\s*\(/;
const SETS_CONFIG_ENV = /process\.env\.GLISSA_CONFIG\s*=/;
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
