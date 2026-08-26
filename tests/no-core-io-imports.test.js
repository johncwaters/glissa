'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE_DIRECTORIES = [path.join(ROOT, 'server', 'core'), path.join(ROOT, 'session', 'core')];
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const FORBIDDEN_NODE_MODULES = new Set([
  'node:fs',
  'node:child_process',
  'node:os',
  'node:http',
  'node:https',
  'node:net',
]);
const CALL_IMPORT = /\b(?:require|import)\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const STATIC_IMPORT = /\bimport(?:\s+[^'"]*?\s+from\s*)?\s*(['"])([^'"]+)\1/g;

function collectSourceFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(absolutePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    files.push(absolutePath);
  }
  return files;
}

function importedSpecifiers(line) {
  const specifiers = [];
  for (const pattern of [CALL_IMPORT, STATIC_IMPORT]) {
    pattern.lastIndex = 0;
    for (const match of line.matchAll(pattern)) specifiers.push(match[2]);
  }
  return specifiers;
}

function isForbiddenSpecifier(specifier) {
  if (FORBIDDEN_NODE_MODULES.has(specifier)) return true;
  return specifier.startsWith('../../server/');
}

test('pure cores do not import IO modules or server shells', () => {
  const offenders = [];
  const files = CORE_DIRECTORIES.flatMap((directory) => collectSourceFiles(directory));
  assert.ok(files.length > 20, `expected to scan pure cores, only found ${files.length} files`);

  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const forbidden = importedSpecifiers(line).find(isForbiddenSpecifier);
      if (!forbidden) return;
      offenders.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Pure cores must receive IO through injected seams:\n  ${offenders.join('\n  ')}`,
  );
});
