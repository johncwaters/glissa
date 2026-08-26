'use strict';

// The gate only ever widens. Three escape hatches previously made it look stronger than it was: the
// checked set was pinned by glob (so nothing noticed public/ was absent entirely), server/backend.js and
// session/sessions.js each carried a `// @ts-nocheck` on line 1, which excused the two largest files in
// the repo from a gate reported as covering them, and a cast through `unknown` asserted a hand-written
// shape onto an imported factory without checking either side. All three are now failures, not omissions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

const SERVER_INCLUDE_GLOBS = [
  'server/**/*.js',
  'session/**/*.js',
  'detection/**/*.js',
  'notifications/**/*.js',
  'shared/**/*.js',
  'shared/**/*.d.ts',
];

const PUBLIC_INCLUDE_GLOBS = ['public/**/*.js', 'public/**/*.mjs', 'public/**/*.d.ts'];

// Turning any of these off makes tsc pass by checking less, not by the code being sound.
const REQUIRED_OPTIONS = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  strictNullChecks: true,
  strictBindCallApply: true,
  noImplicitThis: true,
  alwaysStrict: true,
  strictPropertyInitialization: true,
  noImplicitReturns: true,
};

const CHECKED_TREES = ['server', 'session', 'detection', 'notifications', 'shared', 'public'];
const SUPPRESSIONS = ['@ts-nocheck', '@ts-ignore', '@ts-expect-error'];

// `/** @type {X} */ (/** @type {unknown} */ (y))` launders an unchecked assertion past the gate the way
// @ts-ignore does: it turns off checking of BOTH the value and the asserted shape, so the two drift
// apart in silence. A bare `/** @type {unknown} */` on a declaration is fine, and stays legal here.
const UNKNOWN_LAUNDER = /@type\s*\{unknown\}\s*\*\/\s*\(/;

function readConfig(name) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, name), 'utf8'));
}

function sourceFilesUnder(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFilesUnder(full));
      continue;
    }
    if (/\.(js|mjs|cjs)$/.test(entry.name)) found.push(full);
  }
  return found;
}

test('the server typecheck gate keeps every tree it has claimed', () => {
  assert.deepEqual(readConfig('tsconfig.json').include, SERVER_INCLUDE_GLOBS);
});

test('the browser typecheck gate keeps every tree it has claimed', () => {
  assert.deepEqual(readConfig('tsconfig.public.json').include, PUBLIC_INCLUDE_GLOBS);
});

test('neither gate can be weakened into checking nothing', () => {
  for (const name of ['tsconfig.json', 'tsconfig.public.json']) {
    const { compilerOptions } = readConfig(name);
    for (const [option, required] of Object.entries(REQUIRED_OPTIONS)) {
      assert.equal(compilerOptions[option], required, `${name} must keep ${option}: ${required}`);
    }
  }
});

// npm run typecheck is the single command the gate is claimed under; a config it never runs is not a gate.
test('npm run typecheck runs both gates', () => {
  const script = readConfig('package.json').scripts.typecheck;
  assert.match(script, /tsconfig\.json/);
  assert.match(script, /tsconfig\.public\.json/);
});

test('no checked file launders an assertion through unknown', () => {
  const offenders = [];
  for (const tree of CHECKED_TREES) {
    for (const file of sourceFilesUnder(path.join(repoRoot, tree))) {
      const source = fs.readFileSync(file, 'utf8');
      if (UNKNOWN_LAUNDER.test(source)) offenders.push(path.relative(repoRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('no checked file opts itself out of the gate', () => {
  const offenders = [];
  for (const tree of CHECKED_TREES) {
    for (const file of sourceFilesUnder(path.join(repoRoot, tree))) {
      const source = fs.readFileSync(file, 'utf8');
      for (const suppression of SUPPRESSIONS) {
        if (source.includes(suppression)) offenders.push(`${path.relative(repoRoot, file)}: ${suppression}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
