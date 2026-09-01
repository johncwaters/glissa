import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const SOURCE_DIRS = ['server', 'session', 'shared', 'public'];
const HARDCODED_BRANCH = /['"`]develop['"`]|into develop/g;

function collectSourceFiles(directory: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(entryPath, files);
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith('.test.ts')) continue;
    files.push(entryPath);
  }
  return files;
}

test('runtime sources contain no hardcoded integration branch', () => {
  const offenders: string[] = [];
  for (const sourceDir of SOURCE_DIRS) {
    for (const file of collectSourceFiles(path.join(ROOT, sourceDir))) {
      const source = fs.readFileSync(file, 'utf8');
      const matches = source.match(HARDCODED_BRANCH) || [];
      if (matches.length > 0) offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('L6 hardcoded branch gate catches quoted, template, and prose forms', () => {
  const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-hardcoded-branch-'));
  const scratchFile = path.join(scratchDirectory, 'scratch.js');
  try {
    fs.writeFileSync(scratchFile, "'develop'\n\"develop\"\n`develop`\ninto develop\n", 'utf8');
    const source = fs.readFileSync(scratchFile, 'utf8');
    assert.deepEqual(source.match(HARDCODED_BRANCH), ["'develop'", '"develop"', '`develop`', 'into develop']);
  } finally {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
  }
});
