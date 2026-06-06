'use strict';

// Tests for the post-turn checker runner (post-turn-checker.js). The runner's
// git + fs IO is injected (deps) so the core is tested without real git, plus one
// guarded real-git smoke test. NO literal em/en dash or ellipsis in this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  runPostTurnChecks,
  resolveCheckConfig,
} = require('../post-turn-checker');

const EM_DASH = String.fromCharCode(0x2014);
const NL = String.fromCharCode(10);

// In-memory fake repo. files: { relPosixPath: content }.
function makeDeps(files, opts = {}) {
  const root = path.join(os.tmpdir(), 'pt-fake-root');
  const toRel = (abs) => path.relative(root, abs).split(path.sep).join('/');
  const writes = {};
  const statCalls = {};
  return {
    writes,
    deps: {
      gitRoot: async () => (opts.nonGit ? Promise.reject(new Error('not a git repo')) : root),
      listChangedFiles: async () => Object.keys(files),
      readFile: (abs) => Buffer.from(files[toRel(abs)] != null ? files[toRel(abs)] : '', 'utf8'),
      writeFile: (abs, content) => {
        writes[toRel(abs)] = content;
      },
      stat: (abs) => {
        const rel = toRel(abs);
        statCalls[rel] = (statCalls[rel] || 0) + 1;
        const size = Buffer.byteLength(files[rel] != null ? files[rel] : '', 'utf8');
        // Race simulation: a file listed in opts.raceFiles changes mtime each stat.
        const mtimeMs = opts.raceFiles && opts.raceFiles.includes(rel) ? statCalls[rel] : 7;
        return { mtimeMs, size };
      },
    },
  };
}

const fixCfg = resolveCheckConfig();

// --- resolveCheckConfig ---------------------------------------------------

test('resolveCheckConfig is enabled by default (no config at all)', () => {
  const cfg = resolveCheckConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.mode, 'fix');
  assert.equal(cfg.rules.dashes.enabled, true);
});

test('resolveCheckConfig: explicit enabled:false disables', () => {
  assert.equal(resolveCheckConfig({ enabled: false }).enabled, false);
});

test('resolveCheckConfig: per-project disables a single rule', () => {
  const cfg = resolveCheckConfig({}, { rules: { dashes: false } });
  assert.equal(cfg.rules.dashes.enabled, false);
  assert.equal(cfg.rules.trailingWs.enabled, true);
});

test('resolveCheckConfig: report mode propagates to rule modes', () => {
  const cfg = resolveCheckConfig({ mode: 'report' });
  assert.equal(cfg.mode, 'report');
  assert.equal(cfg.rules.dashes.mode, 'report');
});

test('resolveCheckConfig: arrays replace, project overrides global', () => {
  const cfg = resolveCheckConfig({ include: ['a/**'] }, { include: ['b/**'] });
  assert.deepEqual(cfg.include, ['b/**']);
});

// --- runPostTurnChecks (fix mode) ----------------------------------------

test('fixes changed files, skips excluded ones, returns a report', async () => {
  const files = {
    'a.js': `x ${NL}`, // trailing space
    'docs/note.md': `title ${EM_DASH} sub`, // em dash + no final newline
    'node_modules/dep.js': `bad ${NL}`, // excluded
    'pkg.lock': `y ${NL}`, // excluded (*.lock)
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
  // The em dash is gone and a final newline was added.
  assert.equal(writes['docs/note.md'].includes(EM_DASH), false);
  assert.equal(writes['docs/note.md'].endsWith(NL), true);
});

test('a glissa-no-fix file is left byte-identical', async () => {
  const files = { 'keep.md': `glissa-no-fix${NL}a ${EM_DASH} b   ` };
  const { deps, writes } = makeDeps(files);
  const report = await runPostTurnChecks({ cwd: '/x', config: fixCfg, deps });
  assert.equal(report.filesFixed, 0);
  assert.equal('keep.md' in writes, false);
});

test('report mode never writes but still lists findings', async () => {
  const files = { 'a.md': `a ${EM_DASH} b` };
  const { deps, writes } = makeDeps(files);
  const cfg = resolveCheckConfig({ mode: 'report' });
  const report = await runPostTurnChecks({ cwd: '/x', config: cfg, deps });
  assert.equal(report.mode, 'report');
  assert.equal(report.filesFixed, 0);
  assert.equal(Object.keys(writes).length, 0);
  assert.ok(report.findings.some((f) => f.rule === 'dashes'));
});

test('mtime race: a file changed between read and write is skipped, not clobbered', async () => {
  const files = { 'race.js': `x ${NL}` };
  const { deps, writes } = makeDeps(files, { raceFiles: ['race.js'] });
  const report = await runPostTurnChecks({ cwd: '/x', config: fixCfg, deps });
  assert.equal(report.filesFixed, 0);
  assert.equal('race.js' in writes, false);
  assert.ok(report.errors.some((e) => e.message === 'skipped-race'));
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

// --- real-git smoke (guarded) --------------------------------------------

function gitAvailable() {
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
    const run = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    run(['init']);
    run(['config', 'user.email', 't@t.t']);
    run(['config', 'user.name', 'T']);
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'seed\n');
    run(['add', '.']);
    run(['commit', '-m', 'seed']);
    // Now dirty it: trailing space + em dash + no final newline.
    fs.writeFileSync(file, `hello ${EM_DASH} world  `);

    const report = await runPostTurnChecks({ cwd: dir, config: fixCfg });
    assert.equal(report.skipped, null);
    assert.equal(report.filesFixed, 1);
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after.includes(EM_DASH), false);
    assert.equal(/[ \t]$/.test(after.replace(/\n$/, '')), false);
    assert.equal(after.endsWith('\n'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
