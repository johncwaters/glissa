'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');

// The release profile ran this only at publish time, so a require added mid-cycle shipped a broken
// tarball until the next release. Gate it per commit instead.
test('every locally required file is listed in the package.json files array', () => {
  const result = (() => {
    try {
      execFileSync(process.execPath, ['scripts/check-package-files.js'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return null;
    } catch (err) {
      return `${err.stdout || ''}${err.stderr || ''}`.trim();
    }
  })();
  assert.equal(result, null, `scripts/check-package-files.js failed:\n${result}`);
});
