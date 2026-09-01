'use strict';

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

const CHECKED_TREES = ['server', 'session', 'detection', 'notifications', 'shared', 'public', 'bin', 'scripts', 'tools', 'test', 'tests'];
const SUPPRESSIONS = ['nocheck', 'ignore', 'expect-error'].map((tail) => `@ts-${tail}`).concat(['biome-' + 'ignore']);

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

test('the browser gate keeps the DOM lib set and no node types', () => {
  const options = mergedCompilerOptions('tsconfig.public.json');
  assert.deepEqual(options.lib, ['ES2023', 'DOM', 'DOM.Iterable']);
  assert.deepEqual(options.types, []);
});

test('the browser tree holds no unchecked JavaScript', () => {
  const offenders = sourceFilesUnder(path.join(repoRoot, 'public'))
    .filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`))
    .filter((file) => /\.(js|mjs|cjs)$/.test(file))
    .map((file) => path.relative(repoRoot, file));
  assert.deepEqual(offenders, []);
});

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
      if (path.basename(file).startsWith('typecheck-gate.test')) continue;
      if (path.basename(file).startsWith('slop-code-patterns.test')) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const suppression of SUPPRESSIONS) {
        if (source.includes(suppression)) offenders.push(`${path.relative(repoRoot, file)}: ${suppression}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
