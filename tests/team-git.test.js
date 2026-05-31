'use strict';

// Worktree isolation for team runs. The fast-forward / not-fast-forward / discard paths are exercised
// against a REAL temporary git repo (skipped if git is unavailable); a final case drives the merge
// sequence through an injected git so the command order is checked even without git.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createGitWorkspace } = require('../teamlib/team-git');

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const GIT = hasGit();

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-gitrepo-'));
  try { git(['init', '-b', 'main'], dir); } catch { git(['init'], dir); }
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Glissa Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

test('create + integrate fast-forwards the run onto the base branch and cleans up', { skip: !GIT }, () => {
  const repo = initRepo();
  try {
    const gw = createGitWorkspace();
    const ws = gw.create({ projectPath: repo, teamId: 'marketing', label: '2026-06-02-tue', outputPath: 'team/marketing' });
    assert.equal(ws.isGit, true);
    assert.ok(ws.cwd && ws.cwd !== repo, 'runs in a separate worktree directory');

    const runRel = 'team/marketing/runs/2026-06-02-tue';
    fs.mkdirSync(path.join(ws.cwd, runRel), { recursive: true });
    fs.writeFileSync(path.join(ws.cwd, runRel, 'brief.md'), '## Topic\nx\n', 'utf8');

    const r = gw.integrate({ projectPath: repo, workspace: ws, message: 'marketing run', addPaths: [runRel] });
    assert.equal(r.committed, true);
    assert.equal(r.merged, true);
    assert.equal(r.branch, null, 'branch deleted after a successful merge');

    assert.ok(fs.existsSync(path.join(repo, runRel, 'brief.md')), 'run is merged into the working tree');
    assert.equal(git(['status', '--porcelain'], repo).trim(), '', 'working tree clean after merge');
    assert.equal(git(['branch', '--list', ws.branch], repo).trim(), '', 'run branch deleted');
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('integrate keeps the run on its branch when the base moved (not a fast-forward)', { skip: !GIT }, () => {
  const repo = initRepo();
  try {
    const gw = createGitWorkspace();
    const ws = gw.create({ projectPath: repo, teamId: 'marketing', label: 'r1', outputPath: 'team/marketing' });

    // Base advances after the worktree was created, so a fast-forward is no longer possible.
    fs.writeFileSync(path.join(repo, 'other.md'), 'changed\n', 'utf8');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'base advances'], repo);

    const runRel = 'team/marketing/runs/r1';
    fs.mkdirSync(path.join(ws.cwd, runRel), { recursive: true });
    fs.writeFileSync(path.join(ws.cwd, runRel, 'brief.md'), 'x', 'utf8');

    const r = gw.integrate({ projectPath: repo, workspace: ws, message: 'run', addPaths: [runRel] });
    assert.equal(r.committed, true);
    assert.equal(r.merged, false);
    assert.equal(r.reason, 'not-fast-forward');
    assert.equal(r.branch, ws.branch, 'run kept on its branch for a manual merge');
    assert.ok(git(['branch', '--list', ws.branch], repo).trim(), 'branch still exists');
    assert.ok(!fs.existsSync(path.join(repo, runRel, 'brief.md')), 'unmerged run is not in the working tree');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('discard removes the worktree and the branch', { skip: !GIT }, () => {
  const repo = initRepo();
  try {
    const gw = createGitWorkspace();
    const ws = gw.create({ projectPath: repo, teamId: 'marketing', label: 'r2', outputPath: 'team/marketing' });
    assert.ok(fs.existsSync(ws.cwd));
    gw.discard({ projectPath: repo, workspace: ws });
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
    assert.equal(git(['branch', '--list', ws.branch], repo).trim(), '', 'branch deleted');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('create falls back to in-place for a non-git directory', { skip: !GIT }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-nongit-'));
  try {
    const gw = createGitWorkspace();
    const ws = gw.create({ projectPath: dir, teamId: 'marketing', label: 'r', outputPath: 'team/marketing' });
    assert.equal(ws.isGit, false);
    assert.equal(ws.cwd, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('integrate (injected git) commits, ff-merges, removes the worktree, deletes the branch', () => {
  const cmds = [];
  const fakeGit = (args) => {
    cmds.push(args.join(' '));
    // `git diff --cached --quiet` exits non-zero when there are staged changes.
    if (args[0] === 'diff' && args.includes('--cached')) { const e = new Error('staged'); e.status = 1; throw e; }
    return '';
  };
  const gw = createGitWorkspace({ git: fakeGit });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/marketing/r', base: 'main' };
  const r = gw.integrate({ projectPath: '/repo', workspace: ws, message: 'm', addPaths: ['team/marketing/runs/r'] });

  assert.equal(r.committed, true);
  assert.equal(r.merged, true);
  assert.equal(r.branch, null);
  assert.ok(cmds.includes('add -- team/marketing/runs/r'));
  assert.ok(cmds.some((c) => c.startsWith('commit -m')));
  assert.ok(cmds.includes('merge --ff-only glissa/marketing/r'));
  assert.ok(cmds.includes('worktree remove --force /wt'));
  assert.ok(cmds.includes('branch -D glissa/marketing/r'));
});
