'use strict';

// The gate only ever widens. Three escape hatches previously made it look stronger than it was: the
// checked set was pinned by glob (so nothing noticed public/ was absent entirely), server/backend.js and
// session/sessions.js each carried a `// @ts-nocheck` on line 1, which excused the two largest files in
// the repo from a gate reported as covering them, and a cast through `unknown` asserted a hand-written
// shape onto an imported factory without checking either side. All three are now failures, not omissions.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

const SERVER_INCLUDE_GLOBS = [
  'server/**/*.js',
  'server/**/*.ts',
  'session/**/*.js',
  'detection/**/*.js',
  'notifications/**/*.js',
  'shared/**/*.js',
  'shared/**/*.ts',
  'shared/**/*.d.ts',
];

const PUBLIC_INCLUDE_GLOBS = ['public/**/*.js', 'public/**/*.mjs', 'public/**/*.d.ts'];
const MILL_METRICS_INCLUDE = ['server/**/*.ts', 'shared/**/*.ts'];
const MILL_METRICS_PROBE = 'tests/fixtures/mill-metrics-typecheck-probe.ts';

// Turning any of these off makes tsc pass by checking less, not by the code being sound.
const REQUIRED_OPTIONS = {
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

const CHECKED_TREES = ['server', 'session', 'detection', 'notifications', 'shared', 'public'];
const SUPPRESSIONS = ['@ts-nocheck', '@ts-ignore', '@ts-expect-error'];

// `/** @type {X} */ (/** @type {unknown} */ (y))`, and its TypeScript spelling `y as unknown as X`,
// launder an unchecked assertion past the gate the way @ts-ignore does: they turn off checking of BOTH
// the value and the asserted shape, so the two drift apart in silence. A bare `/** @type {unknown} */`
// on a declaration, and a plain `as unknown`, are fine and stay legal here.
const UNKNOWN_LAUNDER = /@type\s*\{unknown\}\s*\*\/\s*\(|\bas\s+unknown\s+as\b/;

// node's require() is typed `any`, so the annotation on the binding is the ONLY thing making a
// cross-file call into a .ts module checked. Dropping it re-opens the hole the probe test closes,
// silently and one file at a time, which is why every such require is scanned rather than trusted.
const TS_REQUIRE = /require\(\s*['"][^'"]+\.ts['"]\s*\)/;
const TYPED_BINDING = /:\s*[A-Za-z_${][^=;]*=\s*$/;

function untypedTsRequires(source, label) {
  const lines = source.split('\n');
  const offenders = [];
  lines.forEach((line, index) => {
    const found = TS_REQUIRE.exec(line);
    if (!found) return;
    const declaration = `${index > 0 ? lines[index - 1] : ''}\n${line.slice(0, found.index)}`;
    if (declaration.includes('@type {') || TYPED_BINDING.test(declaration)) return;
    offenders.push(`${label}:${index + 1}`);
  });
  return offenders;
}

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

test('neither gate can be weakened into checking nothing', () => {
  for (const name of ['tsconfig.json', 'tsconfig.public.json']) {
    const { compilerOptions } = readConfig(name);
    for (const [option, required] of Object.entries(REQUIRED_OPTIONS)) {
      assert.equal(compilerOptions[option], required, `${name} must keep ${option}: ${required}`);
    }
  }
});

test('the server gate enforces Node-safe erasable TypeScript syntax', () => {
  assert.equal(readConfig('tsconfig.json').compilerOptions.erasableSyntaxOnly, true);
});

test('the Mill measurement beachhead has its own strict TypeScript gate', () => {
  const config = readConfig('tsconfig.mill-metrics.json');
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.allowJs, false);
  assert.equal(config.compilerOptions.checkJs, false);
  // Globs, not a file list: a .ts file added tomorrow is checked strictly without anyone remembering.
  assert.deepEqual(config.include, MILL_METRICS_INCLUDE);
});

// A CommonJS .ts module declares no exports to TypeScript, so a cross-file require() resolved to `any`
// and the strict gate only ever checked inside one file: a wrong-arity call across two of them
// compiled. The modules publish their surface as a global type instead, and this is the proof, because
// nothing else would notice the day that annotation is dropped.
test('a cross-file call into a Mill .ts module is checked, not any', () => {
  const probeConfig = readConfig('tsconfig.mill-metrics-probe.json');
  assert.equal(probeConfig.extends, './tsconfig.mill-metrics.json');
  assert.deepEqual(probeConfig.include, [...MILL_METRICS_INCLUDE, MILL_METRICS_PROBE]);
  assert.ok(fs.existsSync(path.join(repoRoot, MILL_METRICS_PROBE)), 'the compile-should-fail probe must exist');

  const run = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', 'tsconfig.mill-metrics-probe.json'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.notEqual(run.status, 0, 'tsc must reject the probe; the require binding is untyped again');
  assert.match(`${run.stdout}${run.stderr}`, /mill-metrics-typecheck-probe\.ts.*error TS2554/);
});

test('npm run typecheck leaves the compile-should-fail probe out of the gate', () => {
  const script = readConfig('package.json').scripts.typecheck;
  assert.doesNotMatch(script, /probe/);
  assert.deepEqual(readConfig('tsconfig.json').exclude.includes('tests/**'), true);
});

test('a require of a .ts module cannot enter a checked file untyped', () => {
  assert.deepEqual(
    untypedTsRequires("const { createMillMetricsStore } = require('./mill-metrics-store.ts');", 'negative.js'),
    ['negative.js:1'],
  );
  const annotated = [
    "const { mergeRecords }: MillMetricsCore = require('./core/mill-metrics-core.ts');",
    "const { createMillMetricsStore } = /** @type {MillMetricsStoreModule} */ (require('./mill-metrics-store.ts'));",
    "/** @type {MillMetricsCore} */\nconst { utcDay } = require('./core/mill-metrics-core.ts');",
    "const {\n  MAX_PACK_FILES_PER_SESSION,\n}: MillMetricsContracts = require('../shared/contracts/mill-metrics.ts');",
    "module.exports = {\n  ...(/** @type {MillMetricsContracts} */ (require('./mill-metrics.ts'))),\n};",
  ];
  for (const source of annotated) assert.deepEqual(untypedTsRequires(source, 'annotated.js'), []);

  const offenders = [];
  for (const tree of CHECKED_TREES) {
    for (const file of sourceFilesUnder(path.join(repoRoot, tree))) {
      offenders.push(...untypedTsRequires(fs.readFileSync(file, 'utf8'), path.relative(repoRoot, file)));
    }
  }
  assert.deepEqual(offenders, []);
});

// Node 22.18 is where type stripping stopped needing a flag; node:sqlite FTS5 (22.16) is below it.
test('the runtime floor keeps CommonJS TypeScript loading unflagged', () => {
  const packageManifest = readConfig('package.json');
  assert.equal(packageManifest.type, 'commonjs');
  assert.equal(packageManifest.engines.node, '>=22.18.0');
  assert.equal(readConfig('package-lock.json').packages[''].engines.node, packageManifest.engines.node);
});

// npm run typecheck is the single command the gate is claimed under; a config it never runs is not a gate.
test('npm run typecheck runs both gates', () => {
  const script = readConfig('package.json').scripts.typecheck;
  assert.match(script, /tsconfig\.json/);
  assert.match(script, /tsconfig\.mill-metrics\.json/);
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
