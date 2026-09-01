import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TESTS_DIR = import.meta.dirname;

const BACKEND_BOOT = /\bcreateBackend\s*\(/;
const SETS_CONFIG_ENV = /process\.env\.GLISSA_CONFIG\s*=/;
const TEMP_ROOT = /\bmkdtempSync\s*\(|\bos\.tmpdir\s*\(/;

function collectTestFiles(dir: string, acc: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, acc);
      continue;
    }
    if (entry.isFile() && /\.test\.(js|ts)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

function readTestFiles(): { file: string; src: string }[] {
  const files = collectTestFiles(TESTS_DIR, []);
  assert.ok(files.length > 100, `expected to scan the suite, only found ${files.length} files`);
  return files.map((file) => ({ file: path.relative(TESTS_DIR, file), src: fs.readFileSync(file, 'utf8') }));
}

test('every backend-booting test points GLISSA_CONFIG at a throwaway config', () => {
  const offenders: string[] = [];
  for (const { file, src } of readTestFiles()) {
    if (!BACKEND_BOOT.test(src)) continue;
    if (!SETS_CONFIG_ENV.test(src)) offenders.push(`${file}: boots a backend without setting process.env.GLISSA_CONFIG`);
    if (SETS_CONFIG_ENV.test(src) && !TEMP_ROOT.test(src)) offenders.push(`${file}: sets GLISSA_CONFIG to a path outside os.tmpdir()`);
  }
  assert.deepEqual(offenders, [], `A backend booted on the resolved config writes into the operator's own ~/.glissa:\n  ${offenders.join('\n  ')}`);
});
