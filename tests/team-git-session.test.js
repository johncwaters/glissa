'use strict';

// Session worktree merge-back (the new default session lifecycle: worktree -> changes -> review ->
// merge into develop -> auto-cleanup). Exercises mergeBack's rebase-then-FF, the conflict-park path,
// the untracked-new-file case (a feature session's files MUST survive), and the junction-safe teardown
// (a node_modules junction must never let `worktree remove` delete the operator's real node_modules).
// Injected-git tests check the command sequence without a repo; real-git tests run against a temp repo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createGitWorkspace, linkNodeModules } = require('../teamlib/team-git');

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const GIT = hasGit();
const WIN = process.platform === 'win32';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A repo whose main checkout sits ON `develop` (the integration branch), with node_modules gitignored
// the way every Node repo has it (so mergeBack's `add -A` never stages a node_modules junction).
function initRepoOnDevelop() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-sess-'));
  try { git(['init', '-b', 'main'], dir); } catch { git(['init'], dir); }
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Glissa Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
  git(['branch', 'develop'], dir);
  git(['checkout', 'develop'], dir);
  return dir;
}

// A repo whose main checkout sits on `main` while `develop` has an EXTRA commit, so forking off
// develop is observably different from forking off HEAD (proves create({baseBranch}) uses the branch).
function initRepoMainWithDevelop() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-base-'));
  try { git(['init', '-b', 'main'], dir); } catch { git(['init'], dir); }
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Glissa Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
  git(['branch', 'develop'], dir);
  git(['checkout', 'develop'], dir);
  fs.writeFileSync(path.join(dir, 'on-develop.txt'), 'dev\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'develop only'], dir);
  const developSha = git(['rev-parse', 'develop'], dir).trim();
  git(['checkout', 'main'], dir); // operator's checkout is on MAIN, not develop
  return { dir, developSha };
}

// Recording fake git mirroring the exit behaviors mergeBack branches on:
//   - `diff --cached --quiet` throws {status:1} when there IS staged content (opts.staged, default true)
//   - `rev-parse --verify --quiet refs/heads/<t>` throws when the target is absent (opts.targetExists)
//   - `rebase <target>` throws {status:1} on conflict (opts.rebaseFails)
//   - `rev-parse --abbrev-ref HEAD` returns opts.head (the projectPath checkout)
function fakeSessionGit(cmds, opts = {}) {
  const { staged = true, rebaseFails = false, targetExists = true, head = 'develop' } = opts;
  return (args) => {
    cmds.push(args.join(' '));
    if (args[0] === 'diff' && args.includes('--cached')) {
      if (staged) { const e = new Error('staged'); e.status = 1; throw e; }
      return '';
    }
    if (args[0] === 'rev-parse' && args.includes('--verify')) {
      if (!targetExists) { const e = new Error('no ref'); e.status = 1; throw e; }
      return 'targetsha';
    }
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return head;
    if (args[0] === 'rebase' && args[1] !== '--abort') {
      if (rebaseFails) { const e = new Error('conflict'); e.status = 1; throw e; }
      return '';
    }
    return '';
  };
}

// --- Injected-git command-sequence tests ------------------------------------------------

test('mergeBack (injected): clean rebase + ff-only merge when target is checked out, then junction-safe teardown', () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { head: 'develop' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop', message: 'session abc' });

  assert.equal(r.merged, true);
  assert.equal(r.committed, true);
  assert.equal(r.branch, null);
  assert.ok(cmds.includes('add -A'), 'stages the whole session diff');
  assert.ok(cmds.some((c) => c.startsWith('commit -m')));
  assert.ok(cmds.includes('rebase develop'), 'rebases onto the integration branch');
  assert.ok(cmds.includes('merge --ff-only glissa/session/abc'), 'ff-only merge into the checked-out target');
  assert.ok(cmds.includes('worktree remove --force /wt'));
  assert.ok(cmds.includes('branch -D glissa/session/abc'));
  assert.ok(!cmds.some((c) => c.startsWith('fetch')), 'no ref-fetch when the target is checked out');
});

test('mergeBack (injected): updates the target ref via ff-only fetch when the target is NOT checked out', () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { head: 'main' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, true);
  assert.ok(cmds.includes('rebase develop'));
  assert.ok(cmds.includes('fetch . refs/heads/glissa/session/abc:refs/heads/develop'), 'ff-only ref update, no checkout needed');
  assert.ok(!cmds.some((c) => c.startsWith('merge --ff-only')), 'no working-tree merge when target not checked out');
  assert.ok(cmds.includes('worktree remove --force /wt'));
});

test('mergeBack (injected): a rebase conflict aborts and PARKS the branch (worktree + branch preserved)', () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { rebaseFails: true }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, false);
  assert.equal(r.parked, true);
  assert.equal(r.reason, 'rebase-conflict');
  assert.equal(r.branch, 'glissa/session/abc');
  assert.ok(cmds.includes('rebase --abort'), 'the conflicted rebase is aborted');
  assert.ok(!cmds.some((c) => c.startsWith('worktree remove')), 'parked: worktree NOT removed');
  assert.ok(!cmds.some((c) => c.startsWith('branch -D')), 'parked: branch NOT deleted');
});

test('mergeBack (injected): nothing staged -> discards the worktree + branch, no merge', () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { staged: false }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, false);
  assert.equal(r.committed, false);
  assert.equal(r.reason, 'nothing-to-commit');
  assert.equal(r.branch, null);
  assert.ok(!cmds.some((c) => c.startsWith('rebase')), 'no rebase when there is nothing to merge');
  assert.ok(cmds.includes('worktree remove --force /wt'));
  assert.ok(cmds.includes('branch -D glissa/session/abc'));
});

test('mergeBack (injected): a missing target branch PARKS (Glissa never creates the integration branch)', () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { targetExists: false }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, false);
  assert.equal(r.reason, 'no-target-branch');
  assert.equal(r.parked, true);
  assert.ok(!cmds.some((c) => c.startsWith('worktree remove')), 'worktree preserved when the target is missing');
});

// --- Real-git end-to-end tests ----------------------------------------------------------

test('mergeBack (real git): a NEW untracked file lands on develop via rebase+ff, worktree cleaned', { skip: !GIT }, () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = gw.create({ projectPath: repo, teamId: 'session', label: 'abc', outputPath: '' });
    assert.equal(ws.isGit, true);
    assert.equal(ws.base, 'develop', 'worktree forks off the integration branch');
    // A feature session's deliverable is a brand-new (untracked) file — must survive the merge.
    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'module.exports = 42;\n', 'utf8');

    const r = gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop', message: 'add feature' });
    assert.equal(r.merged, true);
    assert.equal(r.branch, null);
    assert.ok(fs.existsSync(path.join(repo, 'feature.js')), 'the NEW file landed on develop');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim(), 'develop');
    assert.equal(git(['status', '--porcelain'], repo).trim(), '', 'working tree clean');
    assert.equal(git(['branch', '--list', ws.branch], repo).trim(), '', 'session branch deleted');
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack (real git): rebases onto a moved develop, then ff (both commits present)', { skip: !GIT }, () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = gw.create({ projectPath: repo, teamId: 'session', label: 'm1', outputPath: '' });
    // develop advances with a NON-conflicting change after the worktree was created.
    fs.writeFileSync(path.join(repo, 'other.js'), 'other\n', 'utf8');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'develop advances'], repo);
    // Session edits a different file.
    fs.writeFileSync(path.join(ws.cwd, 'session.js'), 'session\n', 'utf8');

    const r = gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop', message: 'session work' });
    assert.equal(r.merged, true);
    assert.ok(fs.existsSync(path.join(repo, 'session.js')), 'session change landed on develop');
    assert.ok(fs.existsSync(path.join(repo, 'other.js')), 'the concurrent develop commit is preserved');
    assert.equal(git(['status', '--porcelain'], repo).trim(), '', 'working tree clean');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack (real git): a rebase conflict parks the branch and leaves develop untouched', { skip: !GIT }, () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'base\n', 'utf8');
    git(['add', '-A'], repo); git(['commit', '-m', 'seed conflict file'], repo);

    const ws = gw.create({ projectPath: repo, teamId: 'session', label: 'cflt', outputPath: '' });
    // develop edits the file one way...
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'develop-side\n', 'utf8');
    git(['add', '-A'], repo); git(['commit', '-m', 'develop edits'], repo);
    const developSha = git(['rev-parse', 'develop'], repo).trim();
    // ...the session edits the same line the other way.
    fs.writeFileSync(path.join(ws.cwd, 'conflict.txt'), 'session-side\n', 'utf8');

    const r = gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop', message: 'conflicting' });
    assert.equal(r.merged, false);
    assert.equal(r.parked, true);
    assert.equal(r.reason, 'rebase-conflict');
    assert.ok(git(['branch', '--list', ws.branch], repo).trim(), 'parked branch still exists');
    assert.ok(fs.existsSync(ws.cwd), 'parked worktree preserved for manual resolution');
    assert.equal(git(['rev-parse', 'develop'], repo).trim(), developSha, 'develop untouched by the failed merge');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], ws.cwd).trim(), ws.branch, 'worktree back on its branch (rebase aborted cleanly)');
    gw.discard({ projectPath: repo, workspace: ws });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- Junction-safe teardown (the node_modules-deletion hazard) ---------------------------

test('discard is junction-safe: the real node_modules survives worktree teardown', { skip: !GIT || !WIN }, () => {
  const repo = initRepoOnDevelop();
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'KEEP ME\n', 'utf8');
  try {
    const gw = createGitWorkspace();
    const ws = gw.create({ projectPath: repo, teamId: 'session', label: 'nm', outputPath: '' });
    assert.equal(linkNodeModules(repo, ws.cwd), true, 'junction created');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'node_modules', 'sentinel.txt')), 'junction resolves to the real node_modules');

    gw.discard({ projectPath: repo, workspace: ws });

    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'sentinel.txt')), 'the REAL node_modules sentinel survived teardown');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack is junction-safe: the real node_modules survives a successful merge, and the junction is never committed', { skip: !GIT || !WIN }, () => {
  const repo = initRepoOnDevelop();
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'KEEP\n', 'utf8');
  try {
    const gw = createGitWorkspace();
    const ws = gw.create({ projectPath: repo, teamId: 'session', label: 'nm2', outputPath: '' });
    linkNodeModules(repo, ws.cwd);
    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'x\n', 'utf8');

    const r = gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop', message: 'feat' });
    assert.equal(r.merged, true);
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'sentinel.txt')), 'real node_modules survived');
    assert.ok(fs.existsSync(path.join(repo, 'feature.js')), 'the feature landed on develop');
    assert.equal(git(['ls-files', 'node_modules'], repo).trim(), '', 'the node_modules junction was never committed (gitignored)');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- create({ baseBranch }): fork off the integration branch regardless of the operator's checkout ---

test('create (baseBranch): forks off the named branch even when the main checkout is on another branch', { skip: !GIT }, () => {
  const { dir, developSha } = initRepoMainWithDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = gw.create({ projectPath: dir, teamId: 'session', label: 'x1', baseBranch: 'develop', outputPath: '' });
    assert.equal(ws.isGit, true);
    assert.equal(ws.base, 'develop');
    assert.equal(ws.baseSha, developSha, 'forked off develop HEAD, not main');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'on-develop.txt')), 'worktree contains the develop-only commit');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim(), 'main', 'operator checkout untouched (still on main)');
    gw.discard({ projectPath: dir, workspace: ws });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create (baseBranch): a missing integration branch returns reason:no-base-branch and creates no worktree', { skip: !GIT }, () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = gw.create({ projectPath: repo, teamId: 'session', label: 'x2', baseBranch: 'nonexistent', outputPath: '' });
    assert.equal(ws.isGit, false);
    assert.equal(ws.reason, 'no-base-branch');
    assert.equal(git(['worktree', 'list'], repo).trim().split(/\r?\n/).length, 1, 'no extra worktree created');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- sweepSessionWorktrees: crash-orphan cleanup scoped to the session namespace ---

test('sweepSessionWorktrees removes orphaned glissa/session/* worktrees but spares live team worktrees', { skip: !GIT }, () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const sess = gw.create({ projectPath: repo, teamId: 'session', label: 'orphan1', outputPath: '' });
    const team = gw.create({ projectPath: repo, teamId: 'marketing', label: 'live-run', outputPath: '' });
    assert.ok(fs.existsSync(sess.cwd) && fs.existsSync(team.cwd));

    const removed = gw.sweepSessionWorktrees({ projectPath: repo });
    assert.deepEqual(removed, ['glissa/session/orphan1']);
    assert.ok(!fs.existsSync(sess.cwd), 'orphan session worktree removed');
    assert.equal(git(['branch', '--list', sess.branch], repo).trim(), '', 'session branch deleted');
    assert.ok(fs.existsSync(team.cwd), 'live team worktree spared');
    assert.ok(git(['branch', '--list', team.branch], repo).trim(), 'team branch spared');
    gw.discard({ projectPath: repo, workspace: team });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('sweepSessionWorktrees is a no-op on a non-git directory', { skip: !GIT }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-nongit-'));
  try {
    const gw = createGitWorkspace();
    assert.deepEqual(gw.sweepSessionWorktrees({ projectPath: dir }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
