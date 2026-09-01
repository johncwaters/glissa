import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGitWorkspace } from '../server/git-workspace.ts';
import { hasGit, git } from './helpers/git-fixture.ts';

const GIT = hasGit();

interface Fixture {
  root: string;
  repo: string;
  publisher: string;
}

type GitFailure = Error & { code?: unknown; status?: unknown };
type GitRunner = (args: string[], cwd: string) => string;
type GitHijack = (args: string[], cwd: string) => void;

function configureRepository(directory: string): void {
  git(['config', 'user.email', 'test@example.com'], directory);
  git(['config', 'user.name', 'Glissa Test'], directory);
  git(['config', 'commit.gpgsign', 'false'], directory);
}

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-integration-sync-'));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  const publisher = path.join(root, 'publisher');
  fs.mkdirSync(repo);
  git(['init', '--bare', remote], root);
  try { git(['init', '-b', 'main'], repo); } catch { git(['init'], repo); }
  configureRepository(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n', 'utf8');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'initial'], repo);
  git(['branch', 'develop'], repo);
  git(['remote', 'add', 'origin', remote], repo);
  git(['push', '-u', 'origin', 'develop'], repo);
  git(['clone', remote, publisher], root);
  configureRepository(publisher);
  git(['checkout', 'develop'], publisher);
  return { root, repo, publisher };
}

function realGitRunner(hijack: GitHijack | null): GitRunner {
  return (args, cwd) => {
    if (hijack) hijack(args, cwd);
    try {
      return git(args, cwd);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const failure: GitFailure = error;
      if (failure.code === undefined) failure.code = failure.status;
      throw failure;
    }
  };
}

function advanceRemote(publisher: string, name: string): string {
  fs.writeFileSync(path.join(publisher, name), `${name}\n`, 'utf8');
  git(['add', '-A'], publisher);
  git(['commit', '-m', `add ${name}`], publisher);
  git(['push', 'origin', 'develop'], publisher);
  return git(['rev-parse', 'HEAD'], publisher).trim();
}

test('syncIntegrationBranch skips a repository without origin', { skip: !GIT }, async () => {
  const fixture = createFixture();
  try {
    git(['remote', 'remove', 'origin'], fixture.repo);
    const developSha = git(['rev-parse', 'develop'], fixture.repo).trim();
    const gitWorkspace = createGitWorkspace();

    const synced = await gitWorkspace.syncIntegrationBranch({ projectPath: fixture.repo, branch: 'develop' });

    assert.deepEqual(synced, { outcome: 'no-remote', from: null, to: null });
    assert.equal(git(['rev-parse', 'develop'], fixture.repo).trim(), developSha);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('syncIntegrationBranch fetch is bounded and non-interactive', async () => {
  let fetchCall: { args: string[]; cwd: string; extra?: unknown } | null = null;
  const gitWorkspace = createGitWorkspace({
    git: (args, cwd, extra) => {
      if (args.join(' ') === 'remote get-url origin') return 'remote.git';
      if (args[0] === 'fetch' && args[1] === '--prune') fetchCall = { args, cwd, extra };
      return '';
    },
  });

  await gitWorkspace.syncIntegrationBranch({ projectPath: '/repo', branch: 'main' });

  assert.deepEqual(fetchCall, {
    args: ['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
    cwd: '/repo',
    extra: { timeout: 8000, env: { GIT_TERMINAL_PROMPT: '0' } },
  });
});

test('syncIntegrationBranch fast-forwards an unchecked local integration branch', { skip: !GIT }, async () => {
  const fixture = createFixture();
  try {
    const originalSha = git(['rev-parse', 'develop'], fixture.repo).trim();
    const remoteSha = advanceRemote(fixture.publisher, 'remote.txt');
    const gitWorkspace = createGitWorkspace();

    const synced = await gitWorkspace.syncIntegrationBranch({ projectPath: fixture.repo, branch: 'develop' });

    assert.deepEqual(synced, { outcome: 'updated', from: originalSha, to: remoteSha });
    assert.equal(git(['rev-parse', 'develop'], fixture.repo).trim(), remoteSha);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('syncIntegrationBranch reports an integration branch already at the remote tip', { skip: !GIT }, async () => {
  const fixture = createFixture();
  try {
    const developSha = git(['rev-parse', 'develop'], fixture.repo).trim();
    const gitWorkspace = createGitWorkspace();

    const synced = await gitWorkspace.syncIntegrationBranch({ projectPath: fixture.repo, branch: 'develop' });

    assert.deepEqual(synced, { outcome: 'up-to-date', from: developSha, to: developSha });
    assert.equal(git(['rev-parse', 'develop'], fixture.repo).trim(), developSha);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('syncIntegrationBranch leaves a diverged local integration branch untouched', { skip: !GIT }, async () => {
  const fixture = createFixture();
  try {
    git(['checkout', 'develop'], fixture.repo);
    fs.writeFileSync(path.join(fixture.repo, 'local.txt'), 'local\n', 'utf8');
    git(['add', '-A'], fixture.repo);
    git(['commit', '-m', 'local develop'], fixture.repo);
    const localSha = git(['rev-parse', 'HEAD'], fixture.repo).trim();
    git(['checkout', 'main'], fixture.repo);
    const remoteSha = advanceRemote(fixture.publisher, 'remote.txt');
    const gitWorkspace = createGitWorkspace();

    const synced = await gitWorkspace.syncIntegrationBranch({ projectPath: fixture.repo, branch: 'develop' });

    assert.deepEqual(synced, { outcome: 'diverged', from: localSha, to: remoteSha });
    assert.equal(git(['rev-parse', 'develop'], fixture.repo).trim(), localSha);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('syncIntegrationBranch refuses to move a checked-out integration branch', { skip: !GIT }, async () => {
  const fixture = createFixture();
  try {
    git(['checkout', 'develop'], fixture.repo);
    const localSha = git(['rev-parse', 'HEAD'], fixture.repo).trim();
    const remoteSha = advanceRemote(fixture.publisher, 'remote.txt');
    const gitWorkspace = createGitWorkspace();

    const synced = await gitWorkspace.syncIntegrationBranch({ projectPath: fixture.repo, branch: 'develop' });

    assert.deepEqual(synced, { outcome: 'checked-out', from: localSha, to: remoteSha });
    assert.equal(git(['rev-parse', 'develop'], fixture.repo).trim(), localSha);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('syncIntegrationBranch refuses to move an integration branch checked out in a LINKED worktree', { skip: !GIT }, async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.root, 'linked');
  try {
    git(['worktree', 'add', linked, 'develop'], fixture.repo);
    const localSha = git(['rev-parse', 'develop'], fixture.repo).trim();
    const remoteSha = advanceRemote(fixture.publisher, 'remote.txt');
    const gitWorkspace = createGitWorkspace();

    const synced = await gitWorkspace.syncIntegrationBranch({ projectPath: fixture.repo, branch: 'develop' });

    assert.deepEqual(synced, { outcome: 'checked-out', from: localSha, to: remoteSha });
    assert.equal(git(['rev-parse', 'develop'], fixture.repo).trim(), localSha, 'the ref did not move');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('syncIntegrationBranch does not move a branch checked out between the check and the mutation', { skip: !GIT }, async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.root, 'linked');
  try {
    const localSha = git(['rev-parse', 'develop'], fixture.repo).trim();
    const remoteSha = advanceRemote(fixture.publisher, 'remote.txt');
    let hijacked = false;
    const gitWorkspace = createGitWorkspace({
      git: realGitRunner((args) => {
        if (hijacked || args[0] !== 'fetch' || args[1] !== '.') return;
        hijacked = true;
        git(['worktree', 'add', linked, 'develop'], fixture.repo);
      }),
    });

    const synced = await gitWorkspace.syncIntegrationBranch({ projectPath: fixture.repo, branch: 'develop' });

    assert.equal(hijacked, true, 'the mutation really was a local fetch, the seam this test hangs on');
    assert.deepEqual(synced, { outcome: 'checked-out', from: localSha, to: remoteSha });
    assert.equal(git(['rev-parse', 'develop'], fixture.repo).trim(), localSha, 'the ref did not move');
    assert.equal(git(['rev-parse', 'HEAD'], linked).trim(), localSha, 'and the checked-out index still matches it');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a sync refused after the branch already reached the remote tip reports up-to-date', { skip: !GIT }, async () => {
  const fixture = createFixture();
  try {
    const remoteSha = advanceRemote(fixture.publisher, 'remote.txt');
    let hijacked = false;
    const gitWorkspace = createGitWorkspace({
      git: realGitRunner((args) => {
        if (hijacked || args[0] !== 'fetch' || args[1] !== '.') return;
        hijacked = true;
        git(['fetch', '.', 'refs/remotes/origin/develop:refs/heads/develop'], fixture.repo);
        throw Object.assign(new Error('refused'), { stdout: '', stderr: 'refusing' });
      }),
    });

    const synced = await gitWorkspace.syncIntegrationBranch({ projectPath: fixture.repo, branch: 'develop' });

    assert.equal(synced.outcome, 'up-to-date');
    assert.equal(synced.to, remoteSha);
    assert.equal(git(['rev-parse', 'develop'], fixture.repo).trim(), remoteSha);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a sync refused by a stale ref lock reports update-failed, never diverged', { skip: !GIT }, async () => {
  const fixture = createFixture();
  try {
    const localSha = git(['rev-parse', 'develop'], fixture.repo).trim();
    const remoteSha = advanceRemote(fixture.publisher, 'remote.txt');
    fs.mkdirSync(path.join(fixture.repo, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(fixture.repo, '.git', 'refs', 'heads', 'develop.lock'), '', 'utf8');
    const gitWorkspace = createGitWorkspace();

    const synced = await gitWorkspace.syncIntegrationBranch({ projectPath: fixture.repo, branch: 'develop' });

    assert.equal(synced.outcome, 'update-failed');
    assert.equal(synced.from, localSha);
    assert.equal(synced.to, remoteSha);
    assert.match(String(synced.error), /cannot lock ref|unable to update local ref/i, 'git says why, verbatim');
    assert.equal(git(['rev-parse', 'develop'], fixture.repo).trim(), localSha, 'the ref did not move');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a sync refused after the branch really forked is still reported as diverged', { skip: !GIT }, async () => {
  const fixture = createFixture();
  try {
    const remoteSha = advanceRemote(fixture.publisher, 'remote.txt');
    let hijacked = false;
    const gitWorkspace = createGitWorkspace({
      git: realGitRunner((args) => {
        if (hijacked || args[0] !== 'fetch' || args[1] !== '.') return;
        hijacked = true;
        git(['checkout', 'develop'], fixture.repo);
        fs.writeFileSync(path.join(fixture.repo, 'fork.txt'), 'fork\n', 'utf8');
        git(['add', '-A'], fixture.repo);
        git(['commit', '-m', 'forked'], fixture.repo);
        git(['checkout', 'main'], fixture.repo);
        throw Object.assign(new Error('refused'), { stdout: '', stderr: 'non-fast-forward' });
      }),
    });

    const synced = await gitWorkspace.syncIntegrationBranch({ projectPath: fixture.repo, branch: 'develop' });

    assert.equal(synced.outcome, 'diverged');
    assert.equal(synced.to, remoteSha);
    assert.equal(synced.from, git(['rev-parse', 'develop'], fixture.repo).trim(), 'from is the sha the branch actually holds now');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a sync whose ancestry probe fails reports update-failed, never diverged', { skip: !GIT }, async () => {
  const fixture = createFixture();
  try {
    const localSha = git(['rev-parse', 'develop'], fixture.repo).trim();
    const remoteSha = advanceRemote(fixture.publisher, 'remote.txt');
    const gitWorkspace = createGitWorkspace({
      git: realGitRunner((args) => {
        if (args[0] !== 'merge-base') return;
        throw Object.assign(new Error('fatal: unable to read object store'), { code: 128, stdout: '', stderr: 'fatal: unable to read object store' });
      }),
    });

    const synced = await gitWorkspace.syncIntegrationBranch({ projectPath: fixture.repo, branch: 'develop' });

    assert.equal(synced.outcome, 'update-failed');
    assert.deepEqual([synced.from, synced.to], [localSha, remoteSha]);
    assert.match(String(synced.error), /unable to read object store/, 'the probe failure is reported verbatim');
    assert.equal(git(['rev-parse', 'develop'], fixture.repo).trim(), localSha, 'and nothing was moved on a guess');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a real fork still reports diverged once the probe answers', { skip: !GIT }, async () => {
  const fixture = createFixture();
  try {
    git(['checkout', 'develop'], fixture.repo);
    fs.writeFileSync(path.join(fixture.repo, 'local.txt'), 'local\n', 'utf8');
    git(['add', '-A'], fixture.repo);
    git(['commit', '-m', 'local develop'], fixture.repo);
    git(['checkout', 'main'], fixture.repo);
    const localSha = git(['rev-parse', 'develop'], fixture.repo).trim();
    const remoteSha = advanceRemote(fixture.publisher, 'remote.txt');
    const gitWorkspace = createGitWorkspace({ git: realGitRunner(null) });

    const synced = await gitWorkspace.syncIntegrationBranch({ projectPath: fixture.repo, branch: 'develop' });

    assert.deepEqual(synced, { outcome: 'diverged', from: localSha, to: remoteSha });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
