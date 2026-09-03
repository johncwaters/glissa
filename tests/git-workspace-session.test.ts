import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createGitWorkspace, createGitWorkspaceSync } from '../server/git-workspace.ts';
import type { WorkspaceHandle } from '../server/git-workspace.ts';
import { isSameDirectoryPath } from '../shared/paths.ts';
import { hasGit, git } from './helpers/git-fixture.ts';

function makeNodeModulesJunction(projectPath: string, wtDir: string): boolean {
  execFileSync('cmd', ['/c', 'mklink', '/J', path.join(wtDir, 'node_modules'), path.join(projectPath, 'node_modules')], { stdio: 'ignore' });
  return fs.existsSync(path.join(wtDir, 'node_modules'));
}

const GIT = hasGit();
const WIN = process.platform === 'win32';

function branchOf(workspace: WorkspaceHandle): string {
  if (!workspace.branch) throw new Error('this worktree carries no branch');
  return workspace.branch;
}

function initRepoOnMain(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { git(['init', '-b', 'main'], dir); } catch { git(['init'], dir); }
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Glissa Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

function initRepoOnDevelop(): string {
  const dir = initRepoOnMain('glissa-sess-');
  git(['branch', 'develop'], dir);
  git(['checkout', 'develop'], dir);
  return dir;
}

function initRepoMainOnly(): string {
  return initRepoOnMain('glissa-mainonly-');
}

function initRepoMainWithDevelop(): { dir: string; developSha: string } {
  const dir = initRepoOnMain('glissa-base-');
  git(['branch', 'develop'], dir);
  git(['checkout', 'develop'], dir);
  fs.writeFileSync(path.join(dir, 'on-develop.txt'), 'dev\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'develop only'], dir);
  const developSha = git(['rev-parse', 'develop'], dir).trim();
  git(['checkout', 'main'], dir);
  return { dir, developSha };
}

interface FakeGitOptions {
  ahead?: string;
  dirty?: string;
  rebaseFails?: boolean;
  ffFails?: boolean;
  targetExists?: boolean;
  head?: string;
  conflicts?: string[];
}

function fakeSessionGit(cmds: string[], opts: FakeGitOptions = {}): (rawArgs: string[]) => string {
  const { ahead = '1', dirty = '', rebaseFails = false, ffFails = false, targetExists = true, head = 'develop', conflicts = [] } = opts;
  const fail = (message: string): never => {
    const failure: Error & { status?: number } = new Error(message);
    failure.status = 1;
    throw failure;
  };
  return (rawArgs) => {
    cmds.push(rawArgs.join(' '));

    const args = rawArgs[0] === '-c' ? rawArgs.slice(2) : rawArgs;
    if (args[0] === 'rev-list') return ahead;
    if (args[0] === 'status') return dirty;
    if (args[0] === 'diff') return conflicts.join('\n');
    if (args[0] === 'rev-parse' && args.includes('REBASE_HEAD')) {
      if (!conflicts.length) fail('no REBASE_HEAD');
      return 'rebasehead';
    }
    if (args[0] === 'rev-parse' && args.includes('--verify')) {
      if (!targetExists) fail('no ref');
      return 'targetsha';
    }
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return head;
    if (args[0] === 'rev-parse') return 'newbase';
    if (args[0] === 'rebase' && args[1] !== '--abort') {
      if (rebaseFails) fail('conflict');
      return '';
    }
    if ((args[0] === 'merge' && args.includes('--ff-only')) || args[0] === 'fetch') {
      if (ffFails) fail('not-ff');
      return '';
    }
    return '';
  };
}

const ranRebaseOnto = (cmds: string[], target: string): boolean => cmds.some((command) => command.endsWith(`rebase ${target}`));
const ranNoRebase = (cmds: string[]): boolean => !cmds.some((command) => command.includes('rebase'));

test('base fetch is bounded and non-interactive', async () => {
  let fetchCall: { args: string[]; cwd: string; extra?: unknown } | null = null;
  const gitWorkspace = createGitWorkspace({
    git: (args, cwd, extra) => {
      fetchCall = { args, cwd, extra };
      return '';
    },
  });
  await gitWorkspace.fetchOrigin({ projectPath: '/repo', branch: 'main' });
  assert.deepEqual(fetchCall, {
    args: ['fetch', '--quiet', '--prune', 'origin', 'refs/heads/*:refs/remotes/origin/*'],
    cwd: '/repo',
    extra: { timeout: 8000, env: { GIT_TERMINAL_PROMPT: '0' } },
  });
});

test('a caller may raise the fetch budget above the interactive default', async () => {
  let fetchCall: { args: string[]; cwd: string; extra?: unknown } | null = null;
  const gitWorkspace = createGitWorkspace({
    git: (args, cwd, extra) => {
      fetchCall = { args, cwd, extra };
      return '';
    },
  });
  await gitWorkspace.fetchOrigin({ projectPath: '/repo', timeoutMs: 60000 });
  assert.deepEqual(fetchCall, {
    args: ['fetch', '--prune', 'origin'],
    cwd: '/repo',
    extra: { timeout: 60000, env: { GIT_TERMINAL_PROMPT: '0' } },
  });
});

test('a fetch killed by its timeout is reported as a timeout, not a bare command failure', async () => {
  const gitWorkspace = createGitWorkspace({
    git: () => {
      throw Object.assign(new Error('Command failed: git fetch --prune origin'), {
        killed: true,
        signal: 'SIGTERM',
        stderr: '',
        stdout: '',
      });
    },
  });
  const fetched = await gitWorkspace.fetchOrigin({ projectPath: '/repo' });
  assert.deepEqual(fetched, {
    ok: false,
    out: '',
    err: 'timed out (killed): Command failed: git fetch --prune origin',
  });
});

test('a git refusal keeps its stderr unmarked', async () => {
  const gitWorkspace = createGitWorkspace({
    git: () => {
      throw Object.assign(new Error('Command failed: git fetch --prune origin'), {
        stderr: 'fatal: could not read Username\n',
      });
    },
  });
  const fetched = await gitWorkspace.fetchOrigin({ projectPath: '/repo' });
  assert.deepEqual(fetched, { ok: false, out: '', err: 'fatal: could not read Username\n' });
});

test('mergeBack (injected): committed-only rebase + ff-only merge when target is checked out, then junction-safe teardown', async () => {
  const cmds: string[] = [];
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
  assert.ok(ranRebaseOnto(cmds, 'develop'), 'rebases onto the integration branch');
  assert.ok(cmds.includes('merge --ff-only glissa/session/abc'), 'ff-only merge into the checked-out target');
  assert.ok(cmds.includes('worktree remove --force /wt'));
  assert.ok(cmds.includes('branch -D glissa/session/abc'));
  assert.ok(
    cmds.includes('fetch --quiet --prune origin refs/heads/*:refs/remotes/origin/*'),
    'fetches the remote base before merging',
  );
});

test('resolveProjectPath matches a custom linked worktree through the shared git common dir', async () => {
  const calls: { args: string[]; cwd: string }[] = [];
  const git = async (args: string[], cwd: string) => {
    calls.push({ args, cwd });
    assert.deepEqual(args, ['rev-parse', '--git-common-dir']);
    if (cwd === '/custom/worktrees/glissa-feature') return '/repos/glissa/.git';
    if (cwd === '/repos/glissa') return '.git';
    throw new Error('not a git checkout');
  };
  const workspace = createGitWorkspace({ git });
  const knownProjects = [{ path: '/repos/glissa' }, { path: '/repos/other' }];

  assert.equal(await workspace.resolveProjectPath({
    cwd: '/custom/worktrees/glissa-feature', knownProjects,
  }), '/repos/glissa');
  assert.equal(await workspace.resolveProjectPath({
    cwd: '/custom/worktrees/glissa-feature', knownProjects,
  }), '/repos/glissa');
  assert.equal(calls.filter((call) => call.cwd === '/repos/glissa').length, 1);
});

test('mergeBack (injected): updates the target ref via ff-only fetch when the target is NOT checked out', async () => {
  const cmds: string[] = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { ahead: '1', head: 'main' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, true);
  assert.ok(ranRebaseOnto(cmds, 'develop'));
  assert.ok(cmds.includes('fetch . refs/heads/glissa/session/abc:refs/heads/develop'), 'ff-only ref update, no checkout needed');
  assert.ok(!cmds.some((c) => c.startsWith('merge --ff-only')), 'no working-tree merge when target not checked out');
  assert.ok(cmds.includes('worktree remove --force /wt'));
});

test('mergeBack (injected): a rebase conflict aborts and PARKS the branch (worktree + branch preserved)', async () => {
  const cmds: string[] = [];
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
  const cmds: string[] = [];
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
  const cmds: string[] = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { ahead: '0', dirty: '' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, false);
  assert.equal(r.committed, false);
  assert.equal(r.reason, 'nothing-to-commit');
  assert.equal(r.branch, null);
  assert.ok(ranNoRebase(cmds), 'no rebase when there is nothing to merge');
  assert.ok(cmds.includes('worktree remove --force /wt'));
  assert.ok(cmds.includes('branch -D glissa/session/abc'));
});

test('mergeBack (injected): a DIRTY worktree is refused and PARKED, never torn down (no data loss on finish)', async () => {

  const cmds: string[] = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { ahead: '1', dirty: ' M wip.js' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, false);
  assert.equal(r.committed, false);
  assert.equal(r.parked, true);
  assert.equal(r.reason, 'uncommitted-changes');
  assert.equal(r.branch, 'glissa/session/abc', 'branch retained so the uncommitted work is not lost');
  assert.ok(ranNoRebase(cmds), 'dirty: nothing is merged');
  assert.ok(!cmds.some((c) => c.startsWith('stash')), 'dirty: nothing is stashed/dropped');
  assert.ok(!cmds.some((c) => c.startsWith('worktree remove')), 'uncommitted work is never destroyed');
  assert.ok(!cmds.some((c) => c.startsWith('branch -D')), 'branch kept');
});

test('mergeBack (injected): a missing target branch PARKS (Glissa never creates the integration branch)', async () => {
  const cmds: string[] = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { targetExists: false }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeBack({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, false);
  assert.equal(r.reason, 'no-target-branch');
  assert.equal(r.parked, true);
  assert.ok(!cmds.some((c) => c.startsWith('worktree remove')), 'worktree preserved when the target is missing');
});

test('mergeKeep (injected): committed-only rebase + ff, then KEEPS the worktree and branch', async () => {
  const cmds: string[] = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { ahead: '1', dirty: '', head: 'develop' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeKeep({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, true);
  assert.equal(r.kept, true);
  assert.equal(r.branch, 'glissa/session/abc', 'session branch retained so the session keeps running');
  assert.equal(r.baseSha, 'newbase', 'reports the new integration tip the worktree sits on');
  assert.ok(!cmds.includes('add -A'), 'committed-only: never stages the whole working tree');
  assert.ok(!cmds.some((c) => c.startsWith('commit')), 'committed-only: never creates a commit');
  assert.ok(ranRebaseOnto(cmds, 'develop'), 'rebases the worktree onto develop');
  assert.ok(cmds.includes('merge --ff-only glissa/session/abc'), 'ff-only merge into develop');
  assert.ok(!cmds.some((c) => c.startsWith('worktree remove')), 'worktree is NOT torn down');
  assert.ok(!cmds.some((c) => c.startsWith('branch -D')), 'branch is NOT deleted');
});

test('mergeKeep (injected): a rebase conflict PARKS (worktree + branch preserved)', async () => {
  const cmds: string[] = [];
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
  const cmds: string[] = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { ahead: '0' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeKeep({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, false);
  assert.equal(r.committed, false);
  assert.equal(r.reason, 'nothing-to-commit');
  assert.equal(r.kept, true);
  assert.equal(r.branch, 'glissa/session/abc', 'branch retained (the live session continues)');
  assert.ok(ranNoRebase(cmds), 'no rebase when there is nothing to merge');
  assert.ok(!cmds.some((c) => c.startsWith('worktree remove')), 'worktree kept on nothing-to-commit');
});

test('mergeKeep (injected): uncommitted work is STASHED around the rebase, then restored (pop)', async () => {
  const cmds: string[] = [];
  const gw = createGitWorkspace({ git: fakeSessionGit(cmds, { ahead: '1', dirty: ' M f.js', head: 'develop' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/session/abc', base: 'develop' };
  const r = await gw.mergeKeep({ projectPath: '/repo', workspace: ws, targetBranch: 'develop' });

  assert.equal(r.merged, true);
  assert.equal(r.restoreConflict, false);
  assert.ok(cmds.includes('stash push --include-untracked -m glissa-merge'), 'stashes the uncommitted work');
  assert.ok(ranRebaseOnto(cmds, 'develop'), 'rebases on the now-clean tree');
  assert.ok(cmds.includes('stash pop'), 'restores the uncommitted work onto the rebased worktree');
  assert.ok(!cmds.includes('stash drop'), 'mergeKeep restores rather than drops');
});

test('mergeKeep (real git): lands on develop yet keeps the worktree alive for a second round', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'cont', baseBranch: 'develop' });
    assert.equal(ws.isGit, true);

    fs.writeFileSync(path.join(ws.cwd, 'a.js'), 'one\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'round 1'], ws.cwd);
    const r1 = await gw.mergeKeep({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r1.merged, true);
    assert.equal(r1.kept, true);
    assert.ok(fs.existsSync(path.join(repo, 'a.js')), 'round 1 landed on develop');
    assert.ok(fs.existsSync(ws.cwd), 'worktree preserved');
    assert.ok(git(['branch', '--list', branchOf(ws)], repo).trim(), 'session branch preserved');
    assert.equal(git(['status', '--porcelain'], ws.cwd).trim(), '', 'worktree clean after merge');
    const developTip = git(['rev-parse', 'develop'], repo).trim();
    assert.equal(git(['rev-parse', branchOf(ws)], repo).trim(), developTip, 'develop == session branch tip');
    assert.equal(r1.baseSha, developTip, 'baseSha reports the new develop tip the worktree sits on');

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

test('mergeKeep (real git): committed work merges; uncommitted work is preserved, never landed on develop', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'split', baseBranch: 'develop' });

    fs.writeFileSync(path.join(ws.cwd, 'committed.js'), 'shipped\n', 'utf8');
    git(['add', 'committed.js'], ws.cwd); git(['commit', '-m', 'committed work'], ws.cwd);
    fs.writeFileSync(path.join(ws.cwd, 'wip.js'), 'work in progress\n', 'utf8');

    const r = await gw.mergeKeep({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, true);
    assert.ok(fs.existsSync(path.join(repo, 'committed.js')), 'committed work landed on develop');
    assert.ok(!fs.existsSync(path.join(repo, 'wip.js')), 'uncommitted work did NOT land on develop');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'wip.js')), 'uncommitted work survives in the worktree');

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
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'wiponly', baseBranch: 'develop' });
    fs.writeFileSync(path.join(ws.cwd, 'wip.js'), 'wip\n', 'utf8');

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

test('mergeBack (real git): committed + uncommitted -> refuses (parks), destroying nothing', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'mixed', baseBranch: 'develop' });
    fs.writeFileSync(path.join(ws.cwd, 'committed.js'), 'done\n', 'utf8');
    git(['add', 'committed.js'], ws.cwd); git(['commit', '-m', 'committed work'], ws.cwd);
    fs.writeFileSync(path.join(ws.cwd, 'wip.js'), 'work in progress\n', 'utf8');

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, false);
    assert.equal(r.parked, true);
    assert.equal(r.reason, 'uncommitted-changes');
    assert.ok(fs.existsSync(ws.cwd), 'worktree preserved (never torn down while dirty)');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'wip.js')), 'uncommitted work survives');
    assert.ok(!fs.existsSync(path.join(repo, 'committed.js')), 'nothing merged while dirty (commit/discard the wip first)');
    assert.ok(git(['branch', '--list', branchOf(ws)], repo).trim(), 'parked branch preserved');
    await gw.removeWorktreeByPath({ projectPath: repo, cwd: ws.cwd, branch: ws.branch });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack (real git): a NEW committed file lands on develop via rebase+ff, worktree cleaned', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'abc', baseBranch: 'develop' });
    assert.equal(ws.isGit, true);
    assert.equal(ws.base, 'develop', 'worktree forks off the integration branch');

    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'module.exports = 42;\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'add feature'], ws.cwd);

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, true);
    assert.equal(r.branch, null);
    assert.ok(fs.existsSync(path.join(repo, 'feature.js')), 'the committed file landed on develop');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim(), 'develop');
    assert.equal(git(['status', '--porcelain'], repo).trim(), '', 'working tree clean');
    assert.equal(git(['branch', '--list', branchOf(ws)], repo).trim(), '', 'session branch deleted');
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack (real git): rebases onto a moved develop, then ff (both commits present)', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'm1', baseBranch: 'develop' });

    fs.writeFileSync(path.join(repo, 'other.js'), 'other\n', 'utf8');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'develop advances'], repo);

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

    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'cflt', baseBranch: 'develop' });

    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'develop-side\n', 'utf8');
    git(['add', '-A'], repo); git(['commit', '-m', 'develop edits'], repo);
    const developSha = git(['rev-parse', 'develop'], repo).trim();

    fs.writeFileSync(path.join(ws.cwd, 'conflict.txt'), 'session-side\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'conflicting'], ws.cwd);

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, false);
    assert.equal(r.parked, true);
    assert.equal(r.reason, 'rebase-conflict');
    assert.ok(git(['branch', '--list', branchOf(ws)], repo).trim(), 'parked branch still exists');
    assert.ok(fs.existsSync(ws.cwd), 'parked worktree preserved for manual resolution');
    assert.equal(git(['rev-parse', 'develop'], repo).trim(), developSha, 'develop untouched by the failed merge');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], ws.cwd).trim(), branchOf(ws), 'worktree back on its branch (rebase aborted cleanly)');
    await gw.discard({ projectPath: repo, workspace: ws });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('hasUnmergedWork (real git): a committed but CLEAN worktree reports work (the branch -D hazard)', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'ahead', baseBranch: 'develop' });
    assert.equal(await gw.hasUnmergedWork({ projectPath: repo, workspace: ws, integrationBranch: 'develop', configuredIntegrationBranch: 'develop' }), false,
      'a fresh worktree holds nothing: discardable');

    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'module.exports = 1;\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'session work'], ws.cwd);
    assert.equal(git(['status', '--porcelain'], ws.cwd).trim(), '', 'committing leaves the tree clean');

    assert.equal(await gw.hasUnmergedWork({ projectPath: repo, workspace: ws, integrationBranch: 'develop', configuredIntegrationBranch: 'develop' }), true,
      'a commit the integration branch lacks IS work');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('hasUnmergedWork (real git): uncommitted changes report work; a merged-away branch does not', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'dirty', baseBranch: 'develop' });
    fs.writeFileSync(path.join(ws.cwd, 'scratch.txt'), 'wip\n', 'utf8');
    assert.equal(await gw.hasUnmergedWork({ projectPath: repo, workspace: ws, integrationBranch: 'develop', configuredIntegrationBranch: 'develop' }), true,
      'an untracked new file counts: it is usually the whole deliverable');

    fs.rmSync(path.join(ws.cwd, 'scratch.txt'));
    fs.writeFileSync(path.join(ws.cwd, 'landed.js'), 'module.exports = 2;\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'work'], ws.cwd);
    git(['merge', '--ff-only', branchOf(ws)], repo);
    assert.equal(await gw.hasUnmergedWork({ projectPath: repo, workspace: ws, integrationBranch: 'develop', configuredIntegrationBranch: 'develop' }), false,
      'work already on the integration branch is not work: the empty worktree may be discarded');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('hasUnmergedWork (real git): an unresolvable integration branch reports work (fails safe)', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'safe', baseBranch: 'develop' });

    git(['config', `branch.${ws.branch}.glissa-integration`, 'no-such-branch'], repo);
    assert.equal(await gw.hasUnmergedWork({ projectPath: repo, workspace: ws, integrationBranch: 'develop', configuredIntegrationBranch: 'develop' }), true,
      'a failed rev-list keeps the worktree');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('hasUnmergedWork: an unusable workspace (no branch, not a repo) reports work rather than guessing', async () => {
  const gw = createGitWorkspace({ git: () => { throw new Error('git must not be reached'); } });
  assert.equal(await gw.hasUnmergedWork({ projectPath: 'C:/proj', workspace: null }), true);
  assert.equal(await gw.hasUnmergedWork({ projectPath: 'C:/proj', workspace: { cwd: 'C:/wt', isGit: false, branch: 'b' } }), true);
  assert.equal(await gw.hasUnmergedWork({ projectPath: 'C:/proj', workspace: { cwd: 'C:/wt', isGit: true } }), true);
});

test('discard is junction-safe: the real node_modules survives worktree teardown', { skip: !GIT || !WIN }, async () => {
  const repo = initRepoOnDevelop();
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'KEEP ME\n', 'utf8');
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'nm', baseBranch: 'develop' });
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
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'nm2', baseBranch: 'develop' });
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

test('create (baseBranch): forks off the named branch even when the main checkout is on another branch', { skip: !GIT }, async () => {
  const { dir, developSha } = initRepoMainWithDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: dir, teamId: 'session', label: 'x1', baseBranch: 'develop' });
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

test('create (baseBranch): a missing local integration branch is auto-created from local main', { skip: !GIT }, async () => {
  const repo = initRepoMainOnly();
  try {
    const mainSha = git(['rev-parse', 'main'], repo).trim();
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'x2', baseBranch: 'develop' });
    assert.equal(ws.isGit, true);
    assert.equal(ws.base, 'develop');
    assert.equal(ws.baseSha, mainSha, 'new develop branch was seeded from main');
    assert.equal(git(['rev-parse', '--verify', '--quiet', 'refs/heads/develop'], repo).trim(), mainSha, 'local develop branch now exists, pointing at main');
    await gw.discard({ projectPath: repo, workspace: ws });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('create (baseBranch): a missing local integration branch prefers an existing origin/<branch> remote-tracking ref over main', { skip: !GIT }, async () => {
  const repo = initRepoMainOnly();
  try {
    const firstSha = git(['rev-parse', 'main'], repo).trim();
    fs.writeFileSync(path.join(repo, 'second.txt'), 'second\n', 'utf8');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'second commit'], repo);
    const secondSha = git(['rev-parse', 'main'], repo).trim();
    assert.notEqual(firstSha, secondSha);
    git(['update-ref', 'refs/remotes/origin/develop', firstSha], repo);

    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'x3', baseBranch: 'develop' });
    assert.equal(ws.isGit, true);
    assert.equal(ws.base, 'develop');
    assert.equal(ws.baseSha, firstSha, 'seeded from origin/develop, not the newer main');
    assert.equal(git(['rev-parse', '--verify', '--quiet', 'refs/heads/develop'], repo).trim(), firstSha);
    await gw.discard({ projectPath: repo, workspace: ws });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('create (baseBranch): a branch name git refuses to create still returns reason:no-base-branch and creates no worktree', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'x4', baseBranch: 'bad..name' });
    assert.equal(ws.isGit, false);
    assert.equal(ws.reason, 'no-base-branch');
    assert.equal(git(['worktree', 'list'], repo).trim().split(/\r?\n/).length, 1, 'no extra worktree created');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('create (real git): stamps the fork-base marker on the branch; branch delete drops it', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'mark1', baseBranch: 'develop' });
    assert.equal(ws.isGit, true);
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glissa-integration`], repo).trim(), 'develop');

    await gw.discard({ projectPath: repo, workspace: ws });
    assert.throws(() => git(['config', '--get', `branch.${ws.branch}.glissa-integration`], repo), 'git drops branch.<name>.* config on branch delete');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('listSessionWorktrees (real git): resolves integrationBranch from the marker, not the passed value, and computes hasWork against it', { skip: !GIT }, async () => {
  const { dir, developSha } = initRepoMainWithDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: dir, teamId: 'session', label: 'markresolve', baseBranch: 'develop' });
    assert.equal(ws.baseSha, developSha, 'worktree HEAD sits exactly on develop, no extra commits');

    const [entry] = await gw.listSessionWorktrees({ projectPath: dir, integrationBranch: 'main' });
    assert.equal(entry.integrationBranch, 'develop', 'resolved from the marker, not the passed integrationBranch');
    assert.equal(entry.hasWork, false, 'hasWork computed against the marker branch (develop), not the passed one (main)');

    await gw.discard({ projectPath: dir, workspace: ws });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create (injected git): a branch already checked out in another worktree returns reason branch-in-use, never adds a new worktree', async () => {
  const cmds: string[] = [];
  const fakeGit = (args: string[]): string => {
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
  const ws = await gw.create({ projectPath: '/repo', teamId: 'session', label: 'dup1', forkFromHead: true });
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
    const ws1 = await gw.create({ projectPath: repo, teamId: 'session', label: 'dup2', baseBranch: 'develop' });
    assert.equal(ws1.isGit, true);

    const ws2 = await gw.create({ projectPath: repo, teamId: 'session', label: 'dup2', baseBranch: 'develop' });
    assert.equal(ws2.isGit, false);
    assert.equal(ws2.reason, 'branch-in-use');

    assert.ok(isSameDirectoryPath(ws2.conflictPath, ws1.cwd),
      `conflictPath ${ws2.conflictPath} names the first worktree ${ws1.cwd}`);

    await gw.discard({ projectPath: repo, workspace: ws1 });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('create (worktreeBase + shareList): worktree lives under the base and gets the gitignored context', { skip: !GIT || !WIN }, async () => {
  const repo = initRepoOnDevelop();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-wtroot-'));

  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.omc/\n.env\n', 'utf8');
  git(['add', '.gitignore'], repo); git(['commit', '-m', 'ignore local context'], repo);
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep.txt'), 'real dep\n', 'utf8');
  fs.mkdirSync(path.join(repo, '.omc'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.omc', 'memory.json'), '{"k":1}\n', 'utf8');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n', 'utf8');

  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n', 'utf8');
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({
      projectPath: repo, teamId: 'session', label: 'ctx', baseBranch: 'develop',
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
      projectPath: repo, teamId: 'session', label: 'strip', baseBranch: 'develop',
      worktreeBase: base, shareList,
    });
    assert.equal(ws.isGit, true);

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

function initRepoWithLocalContext(ignoreText = 'node_modules\n.omc\n.env\n') {
  const repo = initRepoOnDevelop();
  fs.writeFileSync(path.join(repo, '.gitignore'), ignoreText, 'utf8');
  git(['add', '.gitignore'], repo);
  git(['commit', '-m', 'ignore local context'], repo);
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep.txt'), 'real dep\n', 'utf8');
  fs.mkdirSync(path.join(repo, '.omc'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.omc', 'memory.json'), '{"k":1}\n', 'utf8');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n', 'utf8');
  return repo;
}

test('create (worktreeBase + shareList, POSIX): dirs are SYMLINKED in, files copied, and teardown never follows the link', { skip: !GIT || WIN }, async () => {
  const repo = initRepoWithLocalContext();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-wtroot-'));
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({
      projectPath: repo, teamId: 'session', label: 'posixctx', baseBranch: 'develop',
      worktreeBase: base, shareList: ['node_modules', '.omc', '.env', 'tracked.txt', '.absent'],
    });
    assert.equal(ws.isGit, true);
    assert.ok(ws.cwd.startsWith(base), 'worktree lives under the configured base');

    const linked = path.join(ws.cwd, 'node_modules');
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), true, 'a shared DIR is a symlink, not a copy');
    assert.equal(fs.realpathSync(linked), fs.realpathSync(path.join(repo, 'node_modules')), 'and it points at the real one');
    assert.ok(fs.existsSync(path.join(linked, 'dep.txt')), 'the link resolves to the real content');
    assert.equal(fs.lstatSync(path.join(ws.cwd, '.omc')).isSymbolicLink(), true, '.omc symlinked in');
    assert.equal(fs.lstatSync(path.join(ws.cwd, '.env')).isSymbolicLink(), false, 'a shared FILE is copied, never linked');
    assert.equal(fs.readFileSync(path.join(ws.cwd, '.env'), 'utf8'), 'SECRET=1\n', '.env copied in');
    assert.ok(!fs.existsSync(path.join(ws.cwd, 'tracked.txt')), 'a NON-ignored entry is refused (no merge leak)');

    await gw.discard({ projectPath: repo, workspace: ws });

    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep.txt')), 'the REAL node_modules survived teardown');
    assert.ok(fs.existsSync(path.join(repo, '.omc', 'memory.json')), 'the REAL .omc survived teardown');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('mergeBack (POSIX): the shared symlink is never staged by `git add -A`, and the real dir survives the merge', { skip: !GIT || WIN }, async () => {
  const repo = initRepoWithLocalContext();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-wtroot-'));
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({
      projectPath: repo, teamId: 'session', label: 'posixstage', baseBranch: 'develop',
      worktreeBase: base, shareList: ['node_modules', '.omc'],
    });
    assert.equal(fs.lstatSync(path.join(ws.cwd, 'node_modules')).isSymbolicLink(), true, 'symlink in place');

    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'x\n', 'utf8');
    git(['add', '-A'], ws.cwd);
    assert.equal(git(['ls-files', 'node_modules', '.omc'], ws.cwd).trim(), '', '`git add -A` staged neither symlink');
    git(['commit', '-m', 'feat'], ws.cwd);

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, true);
    assert.ok(fs.existsSync(path.join(repo, 'feature.js')), 'the feature landed on develop');
    assert.equal(git(['ls-files', 'node_modules', '.omc'], repo).trim(), '', 'nothing symlinked was ever committed');
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep.txt')), 'real node_modules survived the merge teardown');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('create (shareList, POSIX): a trailing-slash ignore pattern cannot cover a symlink, so the share is refused', { skip: !GIT || WIN }, async () => {
  const repo = initRepoWithLocalContext('node_modules/\n.omc/\n.env\n');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-wtroot-'));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({
      projectPath: repo, teamId: 'session', label: 'posixslash', baseBranch: 'develop',
      worktreeBase: base, shareList: ['node_modules', '.omc', '.env'],
    });
    assert.equal(ws.isGit, true);
    assert.ok(!fs.existsSync(path.join(ws.cwd, 'node_modules')), 'the unignorable link is removed, not left to be committed');
    assert.ok(!fs.existsSync(path.join(ws.cwd, '.omc')), 'same for .omc');
    assert.equal(fs.readFileSync(path.join(ws.cwd, '.env'), 'utf8'), 'SECRET=1\n', 'a COPIED file is unaffected: the pattern matches it either way');
    assert.equal(warnings.filter((w) => w.includes('not sharing')).length, 2, 'each refusal is named so the operator can fix their .gitignore');

    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'x\n', 'utf8');
    git(['add', '-A'], ws.cwd);
    assert.equal(git(['ls-files', 'node_modules', '.omc'], ws.cwd).trim(), '', 'nothing outside the repo can be staged');

    await gw.discard({ projectPath: repo, workspace: ws });
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep.txt')), 'the real node_modules is untouched by the refusal');
    assert.ok(fs.existsSync(path.join(repo, '.omc', 'memory.json')), 'and so is the real .omc');
  } finally {
    console.warn = originalWarn;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('listSessionWorktrees flags uncommitted work; removeWorktreeByPath removes a specific worktree', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const clean = await gw.create({ projectPath: repo, teamId: 'session', label: 'clean', baseBranch: 'develop' });
    const dirty = await gw.create({ projectPath: repo, teamId: 'session', label: 'dirty', baseBranch: 'develop' });
    fs.writeFileSync(path.join(dirty.cwd, 'wip.js'), 'work in progress\n', 'utf8');

    const byId = Object.fromEntries(
      (await gw.listSessionWorktrees({ projectPath: repo, integrationBranch: 'develop' })).map((w) => [w.id, w]),
    );
    assert.equal(byId.clean.hasWork, false, 'a clean worktree has no work');
    assert.equal(byId.dirty.hasWork, true, 'uncommitted changes count as work');

    await gw.removeWorktreeByPath({ projectPath: repo, cwd: clean.cwd, branch: clean.branch });
    assert.ok(!fs.existsSync(clean.cwd), 'removeWorktreeByPath removes a specific worktree');
    assert.ok(fs.existsSync(path.join(dirty.cwd, 'wip.js')), 'the unmerged change is untouched');

    await gw.removeWorktreeByPath({ projectPath: repo, cwd: dirty.cwd, branch: dirty.branch });
    assert.ok(!fs.existsSync(dirty.cwd));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('listSessionWorktrees flags a parked (committed-ahead) worktree as work even when its working tree is clean', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'parked', baseBranch: 'develop' });
    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'done\n', 'utf8');
    git(['add', '-A'], ws.cwd);
    git(['commit', '-m', 'session work'], ws.cwd);
    assert.equal(git(['status', '--porcelain'], ws.cwd).trim(), '', 'working tree is clean');

    const listed = await gw.listSessionWorktrees({ projectPath: repo, integrationBranch: 'develop' });
    assert.equal(listed[0].hasWork, true, 'commits ahead of develop count as work');
    await gw.removeWorktreeByPath({ projectPath: repo, cwd: ws.cwd, branch: ws.branch });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function initRepoWithAbsorbedDevelop(): string {
  const dir = initRepoOnMain('glissa-stale-marker-');
  git(['branch', 'develop'], dir);
  fs.writeFileSync(path.join(dir, 'landed.txt'), 'landed\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'landed on main after develop was abandoned'], dir);
  return dir;
}

test('listSessionWorktrees (real git): an unconfigured base migrates a marker whose branch main already absorbed', { skip: !GIT }, async () => {
  const dir = initRepoWithAbsorbedDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: dir, teamId: 'session', label: 'stale', baseBranch: 'develop' });
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glissa-integration`], dir).trim(), 'develop');

    const [entry] = await gw.listSessionWorktrees({ projectPath: dir, integrationBranch: null });
    assert.equal(entry.integrationBranch, 'main', 'develop is an ancestor of main, so the base follows the default');
    assert.equal(entry.hasWork, false, 'hasWork computed against main, not the abandoned develop');
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glissa-integration`], dir).trim(), 'main', 'marker rewritten');
    await gw.discard({ projectPath: dir, workspace: ws });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listSessionWorktrees (real git, sync): the startup reconcile path migrates the stale marker too', { skip: !GIT }, async () => {
  const dir = initRepoWithAbsorbedDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: dir, teamId: 'session', label: 'stalesync', baseBranch: 'develop' });
    const [entry] = createGitWorkspaceSync().listSessionWorktrees({ projectPath: dir, integrationBranch: null });
    assert.equal(entry.integrationBranch, 'main');
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glissa-integration`], dir).trim(), 'main');
    await gw.discard({ projectPath: dir, workspace: ws });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listSessionWorktrees (real git): a marker whose branch holds commits main lacks is kept even when unconfigured', { skip: !GIT }, async () => {
  const { dir } = initRepoMainWithDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: dir, teamId: 'session', label: 'keepmarker', baseBranch: 'develop' });
    const [entry] = await gw.listSessionWorktrees({ projectPath: dir, integrationBranch: null });
    assert.equal(entry.integrationBranch, 'develop', 'develop is not an ancestor of main, so retargeting would show its commits as session work');
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glissa-integration`], dir).trim(), 'develop');
    await gw.discard({ projectPath: dir, workspace: ws });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create (real git): a branch-in-use adoption with no configured base reports the migrated marker', { skip: !GIT }, async () => {
  const dir = initRepoWithAbsorbedDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: dir, teamId: 'session', label: 'inuse', baseBranch: 'develop' });
    const adopted = await gw.create({ projectPath: dir, teamId: 'session', label: 'inuse', baseBranch: 'main', configuredIntegrationBranch: null });
    assert.equal(adopted.reason, 'branch-in-use');
    assert.equal(adopted.base, 'main');
    await gw.discard({ projectPath: dir, workspace: ws });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hasUnmergedWork (real git): an already-resolved base argument does not block the migration of a stale marker', { skip: !GIT }, async () => {
  const dir = initRepoWithAbsorbedDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: dir, teamId: 'session', label: 'unmerged', baseBranch: 'develop' });
    assert.equal(
      await gw.hasUnmergedWork({ projectPath: dir, workspace: ws, integrationBranch: 'develop', configuredIntegrationBranch: null }),
      false,
      'the worktree holds nothing main lacks',
    );
    assert.equal(
      git(['config', '--get', `branch.${ws.branch}.glissa-integration`], dir).trim(),
      'main',
      'the resolved base argument is a fallback, never a configured branch that pins the marker',
    );
    await gw.discard({ projectPath: dir, workspace: ws });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listSessionWorktrees (real git): a marker whose branch was deleted migrates to the detected default', { skip: !GIT }, async () => {
  const { dir } = initRepoMainWithDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: dir, teamId: 'session', label: 'gonebase', baseBranch: 'develop' });
    git(['branch', '-D', 'develop'], dir);
    fs.writeFileSync(path.join(ws.cwd, 'session.txt'), 'work\n', 'utf8');
    git(['add', '-A'], ws.cwd);
    git(['commit', '-m', 'session work'], ws.cwd);

    const [entry] = await gw.listSessionWorktrees({ projectPath: dir, integrationBranch: null });
    assert.equal(entry.integrationBranch, 'main', 'a marker that no longer resolves cannot measure anything');
    assert.equal(entry.hasWork, true, 'the commit counts against the default branch');
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glissa-integration`], dir).trim(), 'main');
    await gw.discard({ projectPath: dir, workspace: ws });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function initCloneWithOriginOnlyDevelop(): { rootDir: string; repoDir: string } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-origin-marker-'));
  const seedDir = initRepoMainWithDevelop().dir;
  const remoteDir = path.join(rootDir, 'origin.git');
  const repoDir = path.join(rootDir, 'repository');
  git(['clone', '--bare', seedDir, remoteDir], rootDir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remoteDir);
  git(['clone', remoteDir, repoDir], rootDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Glissa Test'], repoDir);
  git(['config', 'commit.gpgsign', 'false'], repoDir);
  git(['branch', 'develop', 'origin/develop'], repoDir);
  fs.rmSync(seedDir, { recursive: true, force: true });
  return { rootDir, repoDir };
}

test('listSessionWorktrees (real git): a marker branch alive only on origin keeps the marker', { skip: !GIT }, async () => {
  const { rootDir, repoDir } = initCloneWithOriginOnlyDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repoDir, teamId: 'session', label: 'originbase', baseBranch: 'develop' });
    git(['branch', '-D', 'develop'], repoDir);
    fs.writeFileSync(path.join(ws.cwd, 'session.txt'), 'work\n', 'utf8');
    git(['add', '-A'], ws.cwd);
    git(['commit', '-m', 'session work'], ws.cwd);

    const [entry] = await gw.listSessionWorktrees({ projectPath: repoDir, integrationBranch: null });
    assert.equal(entry.integrationBranch, 'develop', 'the base stays a plain branch name that a later create can fork from');
    assert.equal(entry.hasWork, true, 'the session commit is measured against the remote-tracking ref that resolved');
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glissa-integration`], repoDir).trim(), 'develop', 'marker left alone');
    assert.throws(
      () => git(['rev-parse', '--verify', '--quiet', 'refs/heads/origin/develop'], repoDir),
      Error,
      'no local branch was fabricated under the remote-tracking short name',
    );
    await gw.discard({ projectPath: repoDir, workspace: ws });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('listSessionWorktrees (injected git): a failing status keeps the worktree even when rev-list counts zero', async () => {
  const failingStatusGit = (args: string[]): string => {
    if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) return 'true';
    if (args[0] === 'worktree' && args[1] === 'list') {
      return 'worktree /repo\nbranch refs/heads/main\n\nworktree /wt/corrupt\nbranch refs/heads/glissa/session/corrupt\n\n';
    }
    if (args[0] === 'config') return 'main';
    if (args[0] === 'status') {
      const failure: Error & { status?: number } = new Error('fatal: unable to read index file');
      failure.status = 128;
      throw failure;
    }
    if (args[0] === 'rev-list') return '0';
    return '';
  };
  const gw = createGitWorkspace({ git: failingStatusGit });
  const [entry] = await gw.listSessionWorktrees({ projectPath: '/repo', integrationBranch: 'main', configuredIntegrationBranch: 'main' });
  assert.equal(entry.hasWork, true, 'a status that never ran cannot prove the worktree is empty, so it is never discarded');
});
