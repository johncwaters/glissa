'use strict';

// The gate only ever widens. Three escape hatches previously made it look stronger than it was: the
// checked set was pinned by glob (so nothing noticed public/ was absent entirely), server/backend.js and
// session/sessions.ts each carried a `// @ts-nocheck` on line 1, which excused the two largest files in
// the repo from a gate reported as covering them, and a cast through `unknown` asserted a hand-written
// shape onto an imported factory without checking either side. All three are now failures, not omissions.
//
// During the TypeScript migration the gate is generic: every root tsconfig*.json must be run by
// `npm run typecheck`, the two loose (checkJs) projects keep their claimed trees and flag floor, and
// the strict project, once it exists, keeps full strictness. Converted `.ts` files are strict-checked
// automatically by the strict project's include glob; the loose globs shrink as files convert.

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

const PUBLIC_INCLUDE_GLOBS = ['public/**/*.js', 'public/**/*.mjs', 'public/**/*.ts', 'public/**/*.d.ts'];

// Turning any of these off makes tsc pass by checking less, not by the code being sound.
const LOOSE_REQUIRED_OPTIONS = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  strictNullChecks: true,
  strictBindCallApply: true,
  strictFunctionTypes: true,
  noImplicitThis: true,
  alwaysStrict: true,
  strictPropertyInitialization: true,
  noImplicitReturns: true,
};

// The strict project checks every migrated .ts file; weakening any of these reopens the migration.
const STRICT_REQUIRED_OPTIONS = {
  strict: true,
  noEmit: true,
  erasableSyntaxOnly: true,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  noImplicitReturns: true,
};

const CHECKED_TREES = ['server', 'session', 'detection', 'notifications', 'shared', 'public'];
const SUPPRESSIONS = ['@ts-nocheck', '@ts-ignore', '@ts-expect-error'];

// `/** @type {X} */ (/** @type {unknown} */ (y))` launders an unchecked assertion past the gate the
// way a suppression directive does: it turns off checking of BOTH the value and the asserted shape, so
// the two drift apart in silence. A bare `/** @type {unknown} */` on a declaration is fine here.
const UNKNOWN_LAUNDER = /@type\s*\{unknown\}\s*\*\/\s*\(/;

function readConfig(name) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, name), 'utf8'));
}

function rootTsconfigs() {
  return fs
    .readdirSync(repoRoot)
    .filter((name) => /^tsconfig(\..+)?\.json$/.test(name))
    .sort();
}

function mergedCompilerOptions(name) {
  const config = readConfig(name);
  const options = { ...config.compilerOptions };
  if (!config.extends) return options;
  return { ...mergedCompilerOptions(config.extends.replace(/^\.\//, '')), ...options };
}

function sourceFilesUnder(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFilesUnder(full));
      continue;
    }
    if (/\.(js|mjs|cjs|ts|mts|cts)$/.test(entry.name)) found.push(full);
  }
  return found;
}

test('the server typecheck gate keeps every tree it has claimed', () => {
  assert.deepEqual(readConfig('tsconfig.json').include, SERVER_INCLUDE_GLOBS);
});

test('the browser typecheck gate keeps every tree it has claimed', () => {
  assert.deepEqual(readConfig('tsconfig.public.json').include, PUBLIC_INCLUDE_GLOBS);
});

test('neither loose gate can be weakened into checking nothing', () => {
  for (const name of ['tsconfig.json', 'tsconfig.public.json']) {
    const options = mergedCompilerOptions(name);
    for (const [option, required] of Object.entries(LOOSE_REQUIRED_OPTIONS)) {
      assert.equal(options[option], required, `${name} must keep ${option}: ${required}`);
    }
  }
});

test('the strict gate, once present, keeps full strictness', () => {
  if (!fs.existsSync(path.join(repoRoot, 'tsconfig.strict.json'))) return;
  const options = mergedCompilerOptions('tsconfig.strict.json');
  for (const [option, required] of Object.entries(STRICT_REQUIRED_OPTIONS)) {
    assert.equal(options[option], required, `tsconfig.strict.json must keep ${option}: ${required}`);
  }
});

// npm run typecheck is the single command the gate is claimed under; a config it never runs is not a gate.
test('npm run typecheck runs every root tsconfig project', () => {
  const script = readConfig('package.json').scripts.typecheck;
  for (const name of rootTsconfigs()) {
    if (name === 'tsconfig.base.json') continue;
    assert.match(script, new RegExp(name.replace(/\./g, '\\.')), `typecheck script must run ${name}`);
  }
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
