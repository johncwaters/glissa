import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { runPostTurnChecks, resolveCheckConfig } from '../server/post-turn-checker.ts';
import type { PostTurnDependencies } from '../server/post-turn-checker.ts';

const NL = String.fromCharCode(10);

interface FakeRepoOptions {
  nonGit?: boolean;
  raceFiles?: string[];
}

function makeDeps(files: Record<string, string>, opts: FakeRepoOptions = {}) {
  const root = path.join(os.tmpdir(), 'pt-fake-root');
  const toRel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
  const writes: Record<string, string> = {};
  const statCalls: Record<string, number> = {};
  const deps: PostTurnDependencies = {
    gitRoot: async () => {
      if (opts.nonGit) throw new Error('not a git repo');
      return root;
    },
    listChangedFiles: async () => Object.keys(files),
    readFile: (abs) => Buffer.from(files[toRel(abs)] ?? '', 'utf8'),
    writeFile: (abs, content) => {
      writes[toRel(abs)] = content;
    },
    stat: (abs) => {
      const rel = toRel(abs);
      statCalls[rel] = (statCalls[rel] ?? 0) + 1;
      const size = Buffer.byteLength(files[rel] ?? '', 'utf8');

      const mtimeMs = opts.raceFiles?.includes(rel) ? statCalls[rel] : 7;
      return { mtimeMs, size };
    },
  };
  return { writes, deps };
}

const fixCfg = resolveCheckConfig();

test('resolveCheckConfig is enabled by default (no config at all)', () => {
  const cfg = resolveCheckConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.mode, 'fix');
  assert.equal(cfg.rules.trailingWs?.enabled, true);
});

test('resolveCheckConfig: explicit enabled:false disables', () => {
  assert.equal(resolveCheckConfig({ enabled: false }).enabled, false);
});

test('resolveCheckConfig: per-project disables a single rule', () => {
  const cfg = resolveCheckConfig({}, { rules: { bom: false } });
  assert.equal(cfg.rules.bom?.enabled, false);
  assert.equal(cfg.rules.trailingWs?.enabled, true);
});

test('resolveCheckConfig: report mode propagates to rule modes', () => {
  const cfg = resolveCheckConfig({ mode: 'report' });
  assert.equal(cfg.mode, 'report');
  assert.equal(cfg.rules.trailingWs?.mode, 'report');
});

test('resolveCheckConfig: arrays replace, project overrides global', () => {
  const cfg = resolveCheckConfig({ include: ['a/**'] }, { include: ['b/**'] });
  assert.deepEqual(cfg.include, ['b/**']);
});

test('fixes changed files, skips excluded ones, returns a report', async () => {
  const files = {
    'a.js': `x ${NL}`,
    'docs/note.md': 'title sub',
    'node_modules/dep.js': `bad ${NL}`,
    'pkg.lock': `y ${NL}`,
  };
  const { deps, writes } = makeDeps(files);
  const report = await runPostTurnChecks({ cwd: '/whatever', config: fixCfg, deps });

  assert.equal(report.ok, true);
  assert.equal(report.skipped, null);
  assert.equal(report.filesFixed, 2);
  assert.equal('a.js' in writes, true);
  assert.equal('docs/note.md' in writes, true);
  assert.equal('node_modules/dep.js' in writes, false);
  assert.equal('pkg.lock' in writes, false);
  assert.equal(writes['docs/note.md']?.endsWith(NL), true);
});

test('a glissa-no-fix file is left byte-identical', async () => {
  const files = { 'keep.md': `glissa-no-fix${NL}a b   ` };
  const { deps, writes } = makeDeps(files);
  const report = await runPostTurnChecks({ cwd: '/x', config: fixCfg, deps });
  assert.equal(report.filesFixed, 0);
  assert.equal('keep.md' in writes, false);
});

test('report mode never writes but still lists findings', async () => {
  const files = { 'a.md': 'a b   ' };
  const { deps, writes } = makeDeps(files);
  const cfg = resolveCheckConfig({ mode: 'report' });
  const report = await runPostTurnChecks({ cwd: '/x', config: cfg, deps });
  assert.equal(report.mode, 'report');
  assert.equal(report.filesFixed, 0);
  assert.equal(Object.keys(writes).length, 0);
  assert.ok(report.findings.some((finding) => finding.rule === 'trailingWs'));
});

test('mtime race: a file changed between read and write is skipped, not clobbered', async () => {
  const files = { 'race.js': `x ${NL}` };
  const { deps, writes } = makeDeps(files, { raceFiles: ['race.js'] });
  const report = await runPostTurnChecks({ cwd: '/x', config: fixCfg, deps });
  assert.equal(report.filesFixed, 0);
  assert.equal('race.js' in writes, false);
  assert.ok(report.errors.some((error) => error.message === 'skipped-race'));
});

test('slop rule (enabled) flags a code file but never rewrites it, even in fix mode', async () => {
  const files = { 'a.js': `console.log(1)${NL}` };
  const { deps, writes } = makeDeps(files);
  const cfg = resolveCheckConfig({ mode: 'fix', rules: { slop: true } });
  const report = await runPostTurnChecks({ cwd: '/x', config: cfg, deps });
  assert.equal(report.filesFixed, 0);
  assert.equal('a.js' in writes, false);
  assert.ok(report.findings.some((finding) => finding.file === 'a.js' && finding.rule === 'slop'));
});

test('slop rule stays off by default (not in the default rule set)', async () => {
  const files = { 'a.js': `console.log(1)${NL}` };
  const { deps } = makeDeps(files);
  const report = await runPostTurnChecks({ cwd: '/x', config: fixCfg, deps });
  assert.equal(report.findings.some((finding) => finding.rule === 'slop'), false);
});

test('non-git cwd: skipped no-git, nothing written', async () => {
  const { deps, writes } = makeDeps({ 'a.js': `x ${NL}` }, { nonGit: true });
  const report = await runPostTurnChecks({ cwd: '/x', config: fixCfg, deps });
  assert.equal(report.skipped, 'no-git');
  assert.equal(Object.keys(writes).length, 0);
});

test('no changed files: skipped no-changes', async () => {
  const { deps } = makeDeps({});
  const report = await runPostTurnChecks({ cwd: '/x', config: fixCfg, deps });
  assert.equal(report.skipped, 'no-changes');
});

test('disabled config: skipped disabled', async () => {
  const { deps, writes } = makeDeps({ 'a.js': `x ${NL}` });
  const cfg = resolveCheckConfig({ enabled: false });
  const report = await runPostTurnChecks({ cwd: '/x', config: cfg, deps });
  assert.equal(report.skipped, 'disabled');
  assert.equal(Object.keys(writes).length, 0);
});

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('real git: fixes a dirty file in a temp repo', { skip: !gitAvailable() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-git-'));
  try {
    const run = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    run(['init']);
    run(['config', 'user.email', 't@t.t']);
    run(['config', 'user.name', 'T']);
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'seed\n');
    run(['add', '.']);
    run(['commit', '-m', 'seed']);

    fs.writeFileSync(file, 'hello world  ');

    const report = await runPostTurnChecks({ cwd: dir, config: fixCfg });
    assert.equal(report.skipped, null);
    assert.equal(report.filesFixed, 1);
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(/[ \t]$/.test(after.replace(/\n$/, '')), false);
    assert.equal(after.endsWith('\n'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
