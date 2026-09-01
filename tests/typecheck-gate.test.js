'use strict';

// The gate only ever widens. Three escape hatches previously made it look stronger than it was: the
// checked set was pinned by glob (so nothing noticed public/ was absent entirely), server/backend.js and
// session/sessions.ts each carried a `// @ts-nocheck` on line 1, which excused the two largest files in
// the repo from a gate reported as covering them, and a cast through `unknown` asserted a hand-written
// shape onto an imported factory without checking either side. All three are now failures, not omissions.
//
// During the TypeScript migration the gate is generic: every root tsconfig*.json must be run by
// `npm run typecheck`, the remaining loose (checkJs) project keeps its claimed tree and flag floor, and
// the strict projects keep full strictness. public/ finished converting, so tsconfig.public.json moved
// from the loose set to the strict one and its include globs now name only .ts sources.

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

const PUBLIC_INCLUDE_GLOBS = ['public/**/*.ts', 'public/**/*.d.ts'];

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

// The strict projects check every migrated .ts file; weakening any of these reopens the migration.
const STRICT_REQUIRED_OPTIONS = {
  strict: true,
  noEmit: true,
  erasableSyntaxOnly: true,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  noImplicitReturns: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
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

test('the loose gate cannot be weakened into checking nothing', () => {
  const options = mergedCompilerOptions('tsconfig.json');
  for (const [option, required] of Object.entries(LOOSE_REQUIRED_OPTIONS)) {
    assert.equal(options[option], required, `tsconfig.json must keep ${option}: ${required}`);
  }
});

test('every strict gate keeps full strictness', () => {
  for (const name of ['tsconfig.strict.json', 'tsconfig.public.json']) {
    if (!fs.existsSync(path.join(repoRoot, name))) continue;
    const options = mergedCompilerOptions(name);
    for (const [option, required] of Object.entries(STRICT_REQUIRED_OPTIONS)) {
      assert.equal(options[option], required, `${name} must keep ${option}: ${required}`);
    }
  }
});

// The browser project is checked, not merely listed: a lib set without DOM would typecheck none of it.
test('the browser gate keeps the DOM lib set and no node types', () => {
  const options = mergedCompilerOptions('tsconfig.public.json');
  assert.deepEqual(options.lib, ['ES2023', 'DOM', 'DOM.Iterable']);
  assert.deepEqual(options.types, []);
});

// public/ finished its migration, so a reintroduced .js or .mjs there would fall outside every project.
test('the browser tree holds no unchecked JavaScript', () => {
  const offenders = sourceFilesUnder(path.join(repoRoot, 'public'))
    .filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`))
    .filter((file) => /\.(js|mjs|cjs)$/.test(file))
    .map((file) => path.relative(repoRoot, file));
  assert.deepEqual(offenders, []);
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
