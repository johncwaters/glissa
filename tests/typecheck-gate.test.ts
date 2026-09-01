import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '..');

const SERVER_INCLUDE_GLOBS = [
  'server/**/*.ts',
  'session/**/*.ts',
  'detection/**/*.ts',
  'notifications/**/*.ts',
  'shared/**/*.ts',
  'bin/**/*.ts',
  'scripts/**/*.ts',
  'tools/**/*.ts',
  'test/**/*.ts',
  'tests/**/*.ts',
  '*.ts',
];

const PUBLIC_INCLUDE_GLOBS = ['public/**/*.ts', 'public/**/*.d.ts'];

const STRICT_REQUIRED_OPTIONS: Record<string, boolean> = {
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
const CAST_ESCAPES = [/\bas\s+any\b/, /\bas\s+unknown\s+as\b/];
const COMMENT_LINE = /^\s*(\/\/|\/\*)/;
const SELF_EXEMPT = ['typecheck-gate.test', 'slop-code-patterns.test'];

interface TsconfigShape {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
  include?: string[];
}

function readConfig(name: string): TsconfigShape {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, name), 'utf8')) as TsconfigShape;
}

function rootTsconfigs(): string[] {
  return fs
    .readdirSync(repoRoot)
    .filter((name) => /^tsconfig(\..+)?\.json$/.test(name))
    .sort();
}

function mergedCompilerOptions(name: string): Record<string, unknown> {
  const config = readConfig(name);
  const options = { ...config.compilerOptions };
  if (!config.extends) return options;
  return { ...mergedCompilerOptions(config.extends.replace(/^\.\//, '')), ...options };
}

function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFilesUnder(full));
      continue;
    }
    if (/\.(js|mjs|cjs|ts|mts|cts)$/.test(entry.name)) found.push(full);
  }
  return found;
}

function isSelfExempt(file: string): boolean {
  return SELF_EXEMPT.some((name) => path.basename(file).startsWith(name));
}

test('the package is ESM', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { type?: string };
  assert.equal(raw.type, 'module');
});

test('the server typecheck gate keeps every tree it has claimed', () => {
  assert.deepEqual(readConfig('tsconfig.json').include, SERVER_INCLUDE_GLOBS);
});

test('the browser typecheck gate keeps every tree it has claimed', () => {
  assert.deepEqual(readConfig('tsconfig.public.json').include, PUBLIC_INCLUDE_GLOBS);
});

test('neither gate can be weakened out of full strictness', () => {
  for (const name of ['tsconfig.json', 'tsconfig.public.json']) {
    const options = mergedCompilerOptions(name);
    for (const [option, required] of Object.entries(STRICT_REQUIRED_OPTIONS)) {
      assert.equal(options[option], required, `${name} must keep ${option}: ${required}`);
    }
  }
});

test('the browser gate checks against a real DOM', () => {
  const options = mergedCompilerOptions('tsconfig.public.json');
  const libs = (options.lib as string[] | undefined) ?? [];
  assert.ok(libs.includes('DOM'), 'tsconfig.public.json must keep the DOM lib');
  assert.deepEqual(options.types, [], 'node types must not leak into browser code');
});

test('npm run typecheck runs every root tsconfig project', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const script = raw.scripts.typecheck;
  for (const name of rootTsconfigs()) {
    if (name === 'tsconfig.base.json') continue;
    assert.match(script, new RegExp(name.replace(/\./g, '\\.')), `typecheck script must run ${name}`);
  }
});

test('no source tree holds a non-TypeScript module', () => {
  const allowedPlainJs = new Set(['scripts/prepare-build.js', 'scripts/postinstall.mjs', 'scripts/build.mjs', 'test/container/ws-check.js']);
  const offenders: string[] = [];
  for (const tree of CHECKED_TREES) {
    for (const file of sourceFilesUnder(path.join(repoRoot, tree))) {
      if (/\.ts$|\.mts$|\.cts$/.test(file)) continue;
      const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
      if (allowedPlainJs.has(rel)) continue;
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], 'source is TypeScript; the allowlisted npm-lifecycle scripts are the only plain JS');
});

test('no checked file opts itself out of the gate', () => {
  const offenders: string[] = [];
  for (const tree of CHECKED_TREES) {
    for (const file of sourceFilesUnder(path.join(repoRoot, tree))) {
      if (isSelfExempt(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const suppression of SUPPRESSIONS) {
        if (source.includes(suppression)) offenders.push(`${path.relative(repoRoot, file)}: ${suppression}`);
      }
      for (const castEscape of CAST_ESCAPES) {
        if (castEscape.test(source)) offenders.push(`${path.relative(repoRoot, file)}: ${castEscape.source}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('no checked file carries a comment', () => {
  const offenders: string[] = [];
  for (const tree of CHECKED_TREES) {
    for (const file of sourceFilesUnder(path.join(repoRoot, tree))) {
      if (isSelfExempt(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!COMMENT_LINE.test(line)) return;
        offenders.push(`${path.relative(repoRoot, file)}:${index + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [], 'code comments are banned; name or restructure instead');
});
