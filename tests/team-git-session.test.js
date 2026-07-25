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

const { createGitWorkspace } = require('../teamlib/team-git');

// Junction-setup helper for the teardown-safety tests below: the junction is what the live shareList
// path (populateWorktree) creates; these tests only need one to exist, however it got there.
function makeNodeModulesJunction(projectPath, wtDir) {
  execFileSync('cmd', ['/c', 'mklink', '/J', path.join(wtDir, 'node_modules'), path.join(projectPath, 'node_modules')], { stdio: 'ignore' });
  return fs.existsSync(path.join(wtDir, 'node_modules'));
}

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const GIT = hasGit();
const WIN = process.platform === 'win32';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A repo whose main checkout sits ON `develop` (the integration branch), with node_modules gitignored
// the way every Node repo has it (so a commit made in the worktree never stages a node_modules junction).
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

// Recording fake git mirroring the exit behaviors the committed-only merge core branches on:
//   - `rev-list --count <target>..<branch>` returns opts.ahead (the count of commits to merge; '0' = none)
//   - `status --porcelain` (in the worktree) returns opts.dirty ('' = clean, non-empty = uncommitted work)
//   - `rev-parse --verify --quiet refs/heads/<t>` throws when the target is absent (opts.targetExists)
//   - `rebase <target>` throws {status:1} on conflict (opts.rebaseFails)
//   - `merge --ff-only` / `fetch` throw {status:1} on a lost fast-forward (opts.ffFails)
//   - `rev-parse --abbrev-ref HEAD` returns opts.head (the projectPath checkout); a bare `rev-parse <t>`
//     returns the new integration tip
function fakeSessionGit(cmds, opts = {}) {
  const { ahead = '1', dirty = '', rebaseFails = false, ffFails = false, targetExists = true, head = 'develop', conflicts = [] } = opts;
  const fail = (msg) => { const e = new Error(msg); e.status = 1; throw e; };
  return (args) => {
    cmds.push(args.join(' '));
    if (args[0] === 'rev-list') return ahead;       // rev-list --count target..branch
    if (args[0] === 'status') return dirty;          // status --porcelain
    if (args[0] === 'diff') return (conflicts || []).join('\n'); // diff --name-only --diff-filter=U (conflict capture)
    if (args[0] === 'rev-parse' && args.includes('--verify')) {
      if (!targetExists) fail('no ref');
      return 'targetsha';
    }
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return head;
    if (args[0] === 'rev-parse') return 'newbase';   // bare rev-parse <target> -> integration tip
    if (args[0] === 'rebase' && args[1] !== '--abort') {
      if (rebaseFails) fail('conflict');
      return '';
    }
    if ((args[0] === 'merge' && args.includes('--ff-only')) || args[0] === 'fetch') {
      if (ffFails) fail('not-ff');
      return '';
    }
    return ''; // stash push/pop/drop, rebase --abort, ls-tree, ls-files, worktree remove/prune, branch -D
  };
}

// --- Injected-git command-sequence tests ------------------------------------------------

test('mergeBack (injected): committed-only rebase + ff-only merge when target is checked out, then junction-safe teardown', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { ahead: '1', dirty: '', head: 'develop' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, true);
  assert.equal(r.committed, true);
  assert.equal(r.branch, null);
  assert.ok(cmds.includes('rev-list --count develop..glissa/session/abc'), 'checks for commits to merge');
  assert.ok(!cmds.includes('add -A'), 'committed-only: never stages the whole working tree');
  assert.ok(!cmds.some((c) => c.startsWith('commit')), 'committed-only: never creates a commit');
  assert.ok(!cmds.some((c) => c.startsWith('stash')), 'a clean tree needs no stash');
  assert.ok(cmds.includes('rebase develop'), 'rebases onto the integration branch');
  assert.ok(cmds.includes('merge --ff-only glissa/session/abc'), 'ff-only merge into the checked-out target');
  assert.ok(cmds.includes('worktree remove --force /wt'));
  assert.ok(cmds.includes('branch -D glissa/session/abc'));
  assert.ok(!cmds.some((c) => c.startsWith('fetch')), 'no ref-fetch when the target is checked out');
});

test('mergeBack (injected): updates the target ref via ff-only fetch when the target is NOT checked out', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { ahead: '1', head: 'main' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, true);
  assert.ok(cmds.includes('rebase develop'));
  assert.ok(cmds.includes('fetch . refs/heads/glissa/session/abc:refs/heads/develop'), 'ff-only ref update, no checkout needed');
  assert.ok(!cmds.some((c) => c.startsWith('merge --ff-only')), 'no working-tree merge when target not checked out');
  assert.ok(cmds.includes('worktree remove --force /wt'));
});

test('mergeBack (injected): a rebase conflict aborts and PARKS the branch (worktree + branch preserved)', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { rebaseFails: true }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, false);
  assert.equal(r.parked, true);
  assert.equal(r.reason, 'rebase-conflict');
  assert.equal(r.branch, 'glissa/session/abc');
  assert.ok(cmds.includes('rebase --abort'), 'the conflicted rebase is aborted');
  assert.ok(!cmds.some((c) => c.startsWith('worktree remove')), 'parked: worktree NOT removed');
  assert.ok(!cmds.some((c) => c.startsWith('branch -D')), 'parked: branch NOT deleted');
});

test('mergeBack (injected): a rebase conflict captures the conflicting files BEFORE aborting (for the handoff prompt)', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { rebaseFails: true, conflicts: ['src/a.js', 'src/b.js'] }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.parked, true);
  assert.equal(r.reason, 'rebase-conflict');
  assert.deepEqual(r.conflicts, ['src/a.js', 'src/b.js'], 'conflicting files reported up for the prompt');
  const diffIdx = cmds.indexOf('diff --name-only --diff-filter=U');
  const abortIdx = cmds.indexOf('rebase --abort');
  assert.ok(diffIdx !== -1, 'the conflicting files are captured');
  assert.ok(diffIdx < abortIdx, 'captured BEFORE the abort restores a clean tree (which would lose them)');
});

test('mergeBack (injected): nothing committed + a clean tree -> discards the empty worktree + branch', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { ahead: '0', dirty: '' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, false);
  assert.equal(r.committed, false);
  assert.equal(r.reason, 'nothing-to-commit');
  assert.equal(r.branch, null);
  assert.ok(!cmds.some((c) => c.startsWith('rebase')), 'no rebase when there is nothing to merge');
  assert.ok(cmds.includes('worktree remove --force /wt'));
  assert.ok(cmds.includes('branch -D glissa/session/abc'));
});

test('mergeBack (injected): a DIRTY worktree is refused and PARKED, never torn down (no data loss on finish)', async () => {
  // Even with committed work to merge (ahead 1), a finish must not tear down a worktree holding
  // uncommitted changes - it parks instead, so the operator commits or discards them first.
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { ahead: '1', dirty: ' M wip.js' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, false);
  assert.equal(r.committed, false);
  assert.equal(r.parked, true);
  assert.equal(r.reason, 'uncommitted-changes');
  assert.equal(r.branch, 'glissa/session/abc', 'branch retained so the uncommitted work is not lost');
  assert.ok(!cmds.some((c) => c.startsWith('rebase')), 'dirty: nothing is merged');
  assert.ok(!cmds.some((c) => c.startsWith('stash')), 'dirty: nothing is stashed/dropped');
  assert.ok(!cmds.some((c) => c.startsWith('worktree remove')), 'uncommitted work is never destroyed');
  assert.ok(!cmds.some((c) => c.startsWith('branch -D')), 'branch kept');
});

test('mergeBack (injected): a missing target branch PARKS (Glissa never creates the integration branch)', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { targetExists: false }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, false);
  assert.equal(r.reason, 'no-target-branch');
  assert.equal(r.parked, true);
  assert.ok(!cmds.some((c) => c.startsWith('worktree remove')), 'worktree preserved when the target is missing');
});

// --- mergeKeep (merge as you go: merge into develop but KEEP the worktree + session running) ---------

test('mergeKeep (injected): committed-only rebase + ff, then KEEPS the worktree and branch', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { ahead: '1', dirty: '', head: 'develop' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeKeep({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, true);
  assert.equal(r.kept, true);
  assert.equal(r.branch, 'glissa/session/abc', 'session branch retained so the session keeps running');
  assert.equal(r.baseSha, 'newbase', 'reports the new integration tip the worktree sits on');
  assert.ok(!cmds.includes('add -A'), 'committed-only: never stages the whole working tree');
  assert.ok(!cmds.some((c) => c.startsWith('commit')), 'committed-only: never creates a commit');
  assert.ok(cmds.includes('rebase develop'), 'rebases the worktree onto develop');
  assert.ok(cmds.includes('merge --ff-only glissa/session/abc'), 'ff-only merge into develop');
  assert.ok(!cmds.some((c) => c.startsWith('worktree remove')), 'worktree is NOT torn down');
  assert.ok(!cmds.some((c) => c.startsWith('branch -D')), 'branch is NOT deleted');
});

test('mergeKeep (injected): a rebase conflict PARKS (worktree + branch preserved)', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { rebaseFails: true }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeKeep({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, false);
  assert.equal(r.parked, true);
  assert.equal(r.reason, 'rebase-conflict');
  assert.ok(cmds.includes('rebase --abort'));
  assert.ok(!cmds.some((c) => c.startsWith('worktree remove')), 'parked: worktree preserved');
});

test('mergeKeep (injected): nothing committed is a no-op that KEEPS the worktree (no teardown, no rebase)', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { ahead: '0' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeKeep({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, false);
  assert.equal(r.committed, false);
  assert.equal(r.reason, 'nothing-to-commit');
  assert.equal(r.kept, true);
  assert.equal(r.branch, 'glissa/session/abc', 'branch retained (the live session continues)');
  assert.ok(!cmds.some((c) => c.startsWith('rebase')), 'no rebase when there is nothing to merge');
  assert.ok(!cmds.some((c) => c.startsWith('worktree remove')), 'worktree kept on nothing-to-commit');
});

test('mergeKeep (injected): uncommitted work is STASHED around the rebase, then restored (pop)', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { ahead: '1', dirty: ' M f.js', head: 'develop' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeKeep({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, true);
  assert.equal(r.restoreConflict, false);
  assert.ok(cmds.includes('stash push --include-untracked -m glissa-merge'), 'stashes the uncommitted work');
  assert.ok(cmds.includes('rebase develop'), 'rebases on the now-clean tree');
  assert.ok(cmds.includes('stash pop'), 'restores the uncommitted work onto the rebased worktree');
  assert.ok(!cmds.includes('stash drop'), 'mergeKeep restores rather than drops');
});

test('mergeKeep (real git): lands on develop yet keeps the worktree alive for a second round', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'cont', outputPath: '' });
    assert.equal(ws.isGit, true);

    // Round 1: a new file COMMITTED in the worktree, merge-and-keep.
    fs.writeFileSync(path.join(ws.cwd, 'a.js'), 'one\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'round 1'], ws.cwd);
    const r1 = await gw.mergeKeep({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r1.merged, true);
    assert.equal(r1.kept, true);
    assert.ok(fs.existsSync(path.join(repo, 'a.js')), 'round 1 landed on develop');
    assert.ok(fs.existsSync(ws.cwd), 'worktree preserved');
    assert.ok(git(['branch', '--list', ws.branch], repo).trim(), 'session branch preserved');
    assert.equal(git(['status', '--porcelain'], ws.cwd).trim(), '', 'worktree clean after merge');
    const developTip = git(['rev-parse', 'develop'], repo).trim();
    assert.equal(git(['rev-parse', ws.branch], repo).trim(), developTip, 'develop == session branch tip');
    assert.equal(r1.baseSha, developTip, 'baseSha reports the new develop tip the worktree sits on');

    // Round 2: keep working in the SAME worktree, commit again, merge again.
    fs.writeFileSync(path.join(ws.cwd, 'b.js'), 'two\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'round 2'], ws.cwd);
    const r2 = await gw.mergeKeep({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r2.merged, true);
    assert.ok(fs.existsSync(path.join(repo, 'b.js')), 'round 2 landed on develop too');
    assert.ok(fs.existsSync(path.join(repo, 'a.js')), 'round 1 file still present on develop');
    assert.ok(fs.existsSync(ws.cwd), 'worktree still alive after the second merge');

    await gw.discard({ projectPath: repo, workspace: ws });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// The committed/uncommitted boundary, end to end: a merge moves the COMMITTED change into develop and
// leaves UNCOMMITTED work behind in the worktree (stashed around the rebase, then restored), never on
// develop. This is the behavior the review sidebar's committed/uncommitted split is built on.
test('mergeKeep (real git): committed work merges; uncommitted work is preserved, never landed on develop', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'split', outputPath: '' });
    // One committed file (mergeable) and one still-uncommitted file (must NOT merge, must survive).
    fs.writeFileSync(path.join(ws.cwd, 'committed.js'), 'shipped\n', 'utf8');
    git(['add', 'committed.js'], ws.cwd); git(['commit', '-m', 'committed work'], ws.cwd);
    fs.writeFileSync(path.join(ws.cwd, 'wip.js'), 'work in progress\n', 'utf8');

    const r = await gw.mergeKeep({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, true);
    assert.ok(fs.existsSync(path.join(repo, 'committed.js')), 'committed work landed on develop');
    assert.ok(!fs.existsSync(path.join(repo, 'wip.js')), 'uncommitted work did NOT land on develop');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'wip.js')), 'uncommitted work survives in the worktree');
    // Normalize EOL: git stash round-trips through core.autocrlf on Windows, which is not what we assert.
    assert.equal(fs.readFileSync(path.join(ws.cwd, 'wip.js'), 'utf8').replace(/\r\n/g, '\n'), 'work in progress\n', 'restored intact');
    assert.ok(git(['status', '--porcelain'], ws.cwd).includes('wip.js'), 'and it is still uncommitted after the merge');
    await gw.discard({ projectPath: repo, workspace: ws });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack (real git): only-uncommitted work cannot merge and is preserved (parked)', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'wiponly', outputPath: '' });
    fs.writeFileSync(path.join(ws.cwd, 'wip.js'), 'wip\n', 'utf8'); // never committed

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, false);
    assert.equal(r.parked, true);
    assert.equal(r.reason, 'uncommitted-changes');
    assert.ok(fs.existsSync(ws.cwd), 'worktree preserved (uncommitted work is never destroyed)');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'wip.js')), 'the uncommitted file survives');
    assert.ok(!fs.existsSync(path.join(repo, 'wip.js')), 'nothing landed on develop');
    await gw.removeWorktreeByPath({ projectPath: repo, cwd: ws.cwd, branch: ws.branch });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// Regression for the finish-time data-loss hole: a finishing mergeBack tears the worktree down, so it
// must REFUSE while uncommitted work is present even when there is committed work to merge - otherwise the
// uncommitted part would be destroyed by the teardown. It parks instead; nothing is merged or lost.
test('mergeBack (real git): committed + uncommitted -> refuses (parks), destroying nothing', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'mixed', outputPath: '' });
    fs.writeFileSync(path.join(ws.cwd, 'committed.js'), 'done\n', 'utf8');
    git(['add', 'committed.js'], ws.cwd); git(['commit', '-m', 'committed work'], ws.cwd);
    fs.writeFileSync(path.join(ws.cwd, 'wip.js'), 'work in progress\n', 'utf8'); // uncommitted

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, false);
    assert.equal(r.parked, true);
    assert.equal(r.reason, 'uncommitted-changes');
    assert.ok(fs.existsSync(ws.cwd), 'worktree preserved (never torn down while dirty)');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'wip.js')), 'uncommitted work survives');
    assert.ok(!fs.existsSync(path.join(repo, 'committed.js')), 'nothing merged while dirty (commit/discard the wip first)');
    assert.ok(git(['branch', '--list', ws.branch], repo).trim(), 'parked branch preserved');
    await gw.removeWorktreeByPath({ projectPath: repo, cwd: ws.cwd, branch: ws.branch });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- Real-git end-to-end tests ----------------------------------------------------------

test('mergeBack (real git): a NEW committed file lands on develop via rebase+ff, worktree cleaned', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'abc', outputPath: '' });
    assert.equal(ws.isGit, true);
    assert.equal(ws.base, 'develop', 'worktree forks off the integration branch');
    // A feature session's deliverable is a brand-new file - COMMITTED in the worktree, it must merge.
    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'module.exports = 42;\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'add feature'], ws.cwd);

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, true);
    assert.equal(r.branch, null);
    assert.ok(fs.existsSync(path.join(repo, 'feature.js')), 'the committed file landed on develop');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim(), 'develop');
    assert.equal(git(['status', '--porcelain'], repo).trim(), '', 'working tree clean');
    assert.equal(git(['branch', '--list', ws.branch], repo).trim(), '', 'session branch deleted');
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack (real git): rebases onto a moved develop, then ff (both commits present)', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'm1', outputPath: '' });
    // develop advances with a NON-conflicting change after the worktree was created.
    fs.writeFileSync(path.join(repo, 'other.js'), 'other\n', 'utf8');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'develop advances'], repo);
    // Session commits a change to a different file.
    fs.writeFileSync(path.join(ws.cwd, 'session.js'), 'session\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'session work'], ws.cwd);

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, true);
    assert.ok(fs.existsSync(path.join(repo, 'session.js')), 'session change landed on develop');
    assert.ok(fs.existsSync(path.join(repo, 'other.js')), 'the concurrent develop commit is preserved');
    assert.equal(git(['status', '--porcelain'], repo).trim(), '', 'working tree clean');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack (real git): a rebase conflict parks the branch and leaves develop untouched', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'base\n', 'utf8');
    git(['add', '-A'], repo); git(['commit', '-m', 'seed conflict file'], repo);

    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'cflt', outputPath: '' });
    // develop edits the file one way...
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'develop-side\n', 'utf8');
    git(['add', '-A'], repo); git(['commit', '-m', 'develop edits'], repo);
    const developSha = git(['rev-parse', 'develop'], repo).trim();
    // ...the session commits the same line edited the other way.
    fs.writeFileSync(path.join(ws.cwd, 'conflict.txt'), 'session-side\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'conflicting'], ws.cwd);

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, false);
    assert.equal(r.parked, true);
    assert.equal(r.reason, 'rebase-conflict');
    assert.ok(git(['branch', '--list', ws.branch], repo).trim(), 'parked branch still exists');
    assert.ok(fs.existsSync(ws.cwd), 'parked worktree preserved for manual resolution');
    assert.equal(git(['rev-parse', 'develop'], repo).trim(), developSha, 'develop untouched by the failed merge');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], ws.cwd).trim(), ws.branch, 'worktree back on its branch (rebase aborted cleanly)');
    await gw.discard({ projectPath: repo, workspace: ws });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- Junction-safe teardown (the node_modules-deletion hazard) ---------------------------

test('discard is junction-safe: the real node_modules survives worktree teardown', { skip: !GIT || !WIN }, async () => {
  const repo = initRepoOnDevelop();
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'KEEP ME\n', 'utf8');
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'nm', outputPath: '' });
    assert.equal(makeNodeModulesJunction(repo, ws.cwd), true, 'junction created');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'node_modules', 'sentinel.txt')), 'junction resolves to the real node_modules');

    await gw.discard({ projectPath: repo, workspace: ws });

    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'sentinel.txt')), 'the REAL node_modules sentinel survived teardown');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack is junction-safe: the real node_modules survives a successful merge, and the junction is never committed', { skip: !GIT || !WIN }, async () => {
  const repo = initRepoOnDevelop();
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'KEEP\n', 'utf8');
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'nm2', outputPath: '' });
    makeNodeModulesJunction(repo, ws.cwd);
    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'x\n', 'utf8');
    git(['add', 'feature.js'], ws.cwd); git(['commit', '-m', 'feat'], ws.cwd);

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
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

test('create (baseBranch): forks off the named branch even when the main checkout is on another branch', { skip: !GIT }, async () => {
  const { dir, developSha } = initRepoMainWithDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: dir, teamId: 'session', label: 'x1', baseBranch: 'develop', outputPath: '' });
    assert.equal(ws.isGit, true);
    assert.equal(ws.base, 'develop');
    assert.equal(ws.baseSha, developSha, 'forked off develop HEAD, not main');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'on-develop.txt')), 'worktree contains the develop-only commit');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim(), 'main', 'operator checkout untouched (still on main)');
    await gw.discard({ projectPath: dir, workspace: ws });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create (baseBranch): a missing integration branch returns reason:no-base-branch and creates no worktree', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'x2', baseBranch: 'nonexistent', outputPath: '' });
    assert.equal(ws.isGit, false);
    assert.equal(ws.reason, 'no-base-branch');
    assert.equal(git(['worktree', 'list'], repo).trim().split(/\r?\n/).length, 1, 'no extra worktree created');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- fork-base git-config marker: stamped at create, read back by listSessionWorktrees, dropped with the branch ---

test('create (real git): stamps the fork-base marker on the branch; branch delete drops it', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'mark1', baseBranch: 'develop', outputPath: '' });
    assert.equal(ws.isGit, true);
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glissa-integration`], repo).trim(), 'develop');

    await gw.discard({ projectPath: repo, workspace: ws }); // deletes the branch
    assert.throws(() => git(['config', '--get', `branch.${ws.branch}.glissa-integration`], repo), 'git drops branch.<name>.* config on branch delete');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('listSessionWorktrees (real git): resolves integrationBranch from the marker, not the passed value, and computes hasWork against it', { skip: !GIT }, async () => {
  const { dir, developSha } = initRepoMainWithDevelop(); // main = initial commit; develop = initial + 1 commit
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: dir, teamId: 'session', label: 'markresolve', baseBranch: 'develop', outputPath: '' });
    assert.equal(ws.baseSha, developSha, 'worktree HEAD sits exactly on develop, no extra commits');

    // Pass the WRONG integration branch ('main'): if hasWork used it, ahead(main..branch) would be 1 (the
    // develop-only commit) and wrongly report work. The marker (develop) must win, giving ahead 0.
    const [entry] = await gw.listSessionWorktrees({ projectPath: dir, integrationBranch: 'main' });
    assert.equal(entry.integrationBranch, 'develop', 'resolved from the marker, not the passed integrationBranch');
    assert.equal(entry.hasWork, false, 'hasWork computed against the marker branch (develop), not the passed one (main)');

    await gw.discard({ projectPath: dir, workspace: ws });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- branch-in-use domain error: a pre-check before `git worktree add`/`branch -D` ---

test('create (injected git): a branch already checked out in another worktree returns reason branch-in-use, never adds a new worktree', async () => {
  const cmds = [];
  const fakeGit = (args) => {
    cmds.push(args.join(' '));
    if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) return 'true';
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return 'main';
    if (args[0] === 'rev-parse') return 'headsha';
    if (args[0] === 'worktree' && args[1] === 'list') {
      return 'worktree /repo\nbranch refs/heads/main\n\nworktree /other/wt\nbranch refs/heads/glissa/session/dup1\n\n';
    }
    return '';
  };
  const gw = createGitWorkspace({ git: fakeGit });
  const ws = await gw.create({ projectPath: '/repo', teamId: 'session', label: 'dup1', outputPath: '' });
  assert.equal(ws.isGit, false);
  assert.equal(ws.reason, 'branch-in-use');
  assert.equal(ws.conflictPath, '/other/wt');
  assert.equal(ws.branch, 'glissa/session/dup1', 'result names the conflicting branch so the caller can self-adopt');
  assert.ok(!cmds.some((c) => c.startsWith('worktree add')), 'never adds a new worktree over an in-use branch');
  assert.ok(!cmds.some((c) => c.startsWith('branch -D')), 'never attempts to drop the conflicting branch');
});

test('create (real git): creating the same session branch twice returns branch-in-use on the second attempt', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws1 = await gw.create({ projectPath: repo, teamId: 'session', label: 'dup2', outputPath: '' });
    assert.equal(ws1.isGit, true);

    const ws2 = await gw.create({ projectPath: repo, teamId: 'session', label: 'dup2', outputPath: '' });
    assert.equal(ws2.isGit, false);
    assert.equal(ws2.reason, 'branch-in-use');
    // git's porcelain output uses forward slashes on Windows; normalize before comparing to ws1.cwd.
    assert.equal(path.resolve(ws2.conflictPath), path.resolve(ws1.cwd));

    await gw.discard({ projectPath: repo, workspace: ws1 });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- sweepSessionWorktrees: crash-orphan cleanup scoped to the session namespace ---

test('sweepSessionWorktrees removes orphaned glissa/session/* worktrees but spares live team worktrees', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const sess = await gw.create({ projectPath: repo, teamId: 'session', label: 'orphan1', outputPath: '' });
    const team = await gw.create({ projectPath: repo, teamId: 'marketing', label: 'live-run', outputPath: '' });
    assert.ok(fs.existsSync(sess.cwd) && fs.existsSync(team.cwd));

    const removed = await gw.sweepSessionWorktrees({ projectPath: repo });
    assert.deepEqual(removed, ['glissa/session/orphan1']);
    assert.ok(!fs.existsSync(sess.cwd), 'orphan session worktree removed');
    assert.equal(git(['branch', '--list', sess.branch], repo).trim(), '', 'session branch deleted');
    assert.ok(fs.existsSync(team.cwd), 'live team worktree spared');
    assert.ok(git(['branch', '--list', team.branch], repo).trim(), 'team branch spared');
    await gw.discard({ projectPath: repo, workspace: team });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- Seamless worktrees: stable location + gitignored local context brought in (junction-safe, no leak) ---

test('create (worktreeBase + shareList): worktree lives under the base and gets the gitignored context', { skip: !GIT || !WIN }, async () => {
  const repo = initRepoOnDevelop();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-wtroot-'));
  // Gitignore the local context so it can be brought in (and can never be staged/merged).
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.omc/\n.env\n', 'utf8');
  git(['add', '.gitignore'], repo); git(['commit', '-m', 'ignore local context'], repo);
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep.txt'), 'real dep\n', 'utf8');
  fs.mkdirSync(path.join(repo, '.omc'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.omc', 'memory.json'), '{"k":1}\n', 'utf8');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n', 'utf8');
  // A non-ignored entry must be REFUSED (leak guard).
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n', 'utf8');
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({
      projectPath: repo, teamId: 'session', label: 'ctx', baseBranch: 'develop', outputPath: '',
      worktreeBase: base, shareList: ['node_modules', '.omc', '.env', 'tracked.txt', '.absent'],
    });
    assert.equal(ws.isGit, true);
    assert.ok(ws.cwd.startsWith(base), 'worktree lives under the configured base, not system-temp');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'node_modules', 'dep.txt')), 'node_modules junctioned in');
    assert.ok(fs.existsSync(path.join(ws.cwd, '.omc', 'memory.json')), '.omc junctioned in');
    assert.equal(fs.readFileSync(path.join(ws.cwd, '.env'), 'utf8'), 'SECRET=1\n', '.env copied in');
    assert.ok(!fs.existsSync(path.join(ws.cwd, 'tracked.txt')), 'a NON-ignored entry is refused (no merge leak)');

    await gw.discard({ projectPath: repo, workspace: ws });
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep.txt')), 'real node_modules survived (junction-safe)');
    assert.ok(fs.existsSync(path.join(repo, '.omc', 'memory.json')), 'real .omc survived (junction-safe)');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('populate re-shares stripped junctions into a surviving worktree (adopt-after-failed-removal)', { skip: !GIT || !WIN }, async () => {
  const repo = initRepoOnDevelop();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-wtroot-'));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\n', 'utf8');
  git(['add', '.gitignore'], repo); git(['commit', '-m', 'ignore local context'], repo);
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep.txt'), 'real dep\n', 'utf8');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n', 'utf8');
  try {
    const gw = createGitWorkspace();
    const shareList = ['node_modules', '.env', 'tracked.txt'];
    const ws = await gw.create({
      projectPath: repo, teamId: 'session', label: 'strip', baseBranch: 'develop', outputPath: '',
      worktreeBase: base, shareList,
    });
    assert.equal(ws.isGit, true);
    // Simulate a failed removal: removeWorktreeLinks stripped the junctions, then `worktree remove` failed.
    fs.rmSync(path.join(ws.cwd, 'node_modules'), { recursive: false, force: true });
    assert.ok(!fs.existsSync(path.join(ws.cwd, 'node_modules')), 'junction stripped');

    await gw.populate({ projectPath: repo, wtDir: ws.cwd, shareList });
    assert.ok(fs.existsSync(path.join(ws.cwd, 'node_modules', 'dep.txt')), 'junction re-shared');
    assert.equal(fs.readFileSync(path.join(ws.cwd, '.env'), 'utf8'), 'SECRET=1\n', 'existing copy untouched');
    assert.ok(!fs.existsSync(path.join(ws.cwd, 'tracked.txt')), 'an entry git does not IGNORE is still refused');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep.txt')), 'real node_modules untouched');

    await gw.discard({ projectPath: repo, workspace: ws });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('sweepSessionWorktrees is a no-op on a non-git directory', { skip: !GIT }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-nongit-'));
  try {
    const gw = createGitWorkspace();
    assert.deepEqual(await gw.sweepSessionWorktrees({ projectPath: dir }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Restart safety: the sweep PRESERVES unmerged work (no data loss across a restart) ---

test('listSessionWorktrees flags uncommitted work; sweep preserves it and removes only the clean orphan', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const clean = await gw.create({ projectPath: repo, teamId: 'session', label: 'clean', outputPath: '' });
    const dirty = await gw.create({ projectPath: repo, teamId: 'session', label: 'dirty', outputPath: '' });
    fs.writeFileSync(path.join(dirty.cwd, 'wip.js'), 'work in progress\n', 'utf8'); // a pending-review session

    const byId = Object.fromEntries(
      (await gw.listSessionWorktrees({ projectPath: repo, integrationBranch: 'develop' })).map((w) => [w.id, w]),
    );
    assert.equal(byId.clean.hasWork, false, 'a clean worktree has no work');
    assert.equal(byId.dirty.hasWork, true, 'uncommitted changes count as work');

    const removed = await gw.sweepSessionWorktrees({ projectPath: repo, integrationBranch: 'develop' });
    assert.deepEqual(removed, ['glissa/session/clean'], 'only the clean orphan is swept');
    assert.ok(!fs.existsSync(clean.cwd), 'clean orphan removed');
    assert.ok(fs.existsSync(path.join(dirty.cwd, 'wip.js')), 'the unmerged change survives the sweep');

    await gw.removeWorktreeByPath({ projectPath: repo, cwd: dirty.cwd, branch: dirty.branch });
    assert.ok(!fs.existsSync(dirty.cwd), 'removeWorktreeByPath removes a specific worktree');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('sweep preserves a parked (committed-ahead) worktree even when its working tree is clean', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'parked', outputPath: '' });
    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'done\n', 'utf8');
    git(['add', '-A'], ws.cwd);
    git(['commit', '-m', 'session work'], ws.cwd);
    assert.equal(git(['status', '--porcelain'], ws.cwd).trim(), '', 'working tree is clean');

    const listed = await gw.listSessionWorktrees({ projectPath: repo, integrationBranch: 'develop' });
    assert.equal(listed[0].hasWork, true, 'commits ahead of develop count as work');
    assert.deepEqual(await gw.sweepSessionWorktrees({ projectPath: repo, integrationBranch: 'develop' }), [], 'a parked worktree is never swept');
    await gw.removeWorktreeByPath({ projectPath: repo, cwd: ws.cwd, branch: ws.branch });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
