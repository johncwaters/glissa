'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIRS = ['server', 'session', 'shared', 'public'];
const TEMPORARY_MIGRATION_DEFAULT = "integrationBranch: 'develop',";
const HARDCODED_BRANCH = /['"]develop['"]|into develop/g;

function collectSourceFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(entryPath, files);
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith('.test.js')) continue;
    files.push(entryPath);
  }
  return files;
}

test('runtime sources contain no hardcoded integration branch outside the migration default', () => {
  const offenders = [];
  for (const sourceDir of SOURCE_DIRS) {
    for (const file of collectSourceFiles(path.join(ROOT, sourceDir))) {
      const source = fs.readFileSync(file, 'utf8');
      const matches = source.match(HARDCODED_BRANCH) || [];
      const permittedMatches = file === path.join(ROOT, 'server', 'config-store.js')
        && source.includes(TEMPORARY_MIGRATION_DEFAULT) ? 1 : 0;
      if (matches.length > permittedMatches) offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});
