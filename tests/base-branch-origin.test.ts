import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGitWorkspace } from '../server/git-workspace.ts';
import type { GitWorkspaceInstance, WorkspaceHandle } from '../server/git-workspace.ts';
import { git, hasGit } from './helpers/git-fixture.ts';

const GIT = hasGit();

function configureRepository(repositoryPath: string): void {
  git(['config', 'user.email', 'test@example.com'], repositoryPath);
  git(['config', 'user.name', 'Glissa Test'], repositoryPath);
  git(['config', 'commit.gpgsign', 'false'], repositoryPath);
}

function commitFile(repositoryPath: string, fileName: string, content: string, message: string): void {
  fs.writeFileSync(path.join(repositoryPath, fileName), content, 'utf8');
  git(['add', '--', fileName], repositoryPath);
  git(['commit', '-m', message], repositoryPath);
}

function createRemoteFixture() {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-base-origin-'));
  const seedPath = path.join(rootPath, 'seed');
  const remotePath = path.join(rootPath, 'origin.git');
  const repositoryPath = path.join(rootPath, 'repository');
  const writerPath = path.join(rootPath, 'writer');
  fs.mkdirSync(seedPath);
  git(['init', '-b', 'main'], seedPath);
  configureRepository(seedPath);
  commitFile(seedPath, 'seed.txt', 'seed\n', 'seed');
  git(['clone', '--bare', seedPath, remotePath], rootPath);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath);
  git(['clone', remotePath, repositoryPath], rootPath);
  git(['clone', remotePath, writerPath], rootPath);
  configureRepository(repositoryPath);
  configureRepository(writerPath);
  return {
    remotePath,
    repositoryPath,
    writerPath,
    cleanup: () => fs.rmSync(rootPath, { recursive: true, force: true }),
  };
}

function pushCommit(writerPath: string, fileName: string, content: string, message: string): void {
  commitFile(writerPath, fileName, content, message);
  git(['push', 'origin', 'main'], writerPath);
}

async function createSessionWorkspace(gitWorkspace: GitWorkspaceInstance, repositoryPath: string, label: string): Promise<WorkspaceHandle> {
  return gitWorkspace.create({
    projectPath: repositoryPath,
    teamId: 'session',
    label,
    baseBranch: null,
  });
}

function detectionWorkspace(outputs: Record<string, string | Error>) {
  return createGitWorkspace({
    git: (args) => {
      const command = args.join(' ');
      if (Object.hasOwn(outputs, command)) {
        const output = outputs[command];
        if (output instanceof Error) throw output;
        return output;
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });
}

test('detectDefaultBranch prefers origin HEAD', async () => {
  const workspace = detectionWorkspace({
    'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/trunk',
  });
  assert.equal(await workspace.detectDefaultBranch({ projectPath: '/repo' }), 'trunk');
});

test('detectDefaultBranch lets origin HEAD disagree with local main', async () => {
  const workspace = detectionWorkspace({
    'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/release',
    'rev-parse --verify --quiet refs/heads/main': 'main-sha',
  });
  assert.equal(await workspace.detectDefaultBranch({ projectPath: '/repo' }), 'release');
});

test('detectDefaultBranch falls back to local main', async () => {
  const workspace = detectionWorkspace({
    'rev-parse --verify --quiet refs/heads/main': 'main-sha',
  });
  assert.equal(await workspace.detectDefaultBranch({ projectPath: '/repo' }), 'main');
});

test('detectDefaultBranch falls back to local master', async () => {
  const workspace = detectionWorkspace({
    'rev-parse --verify --quiet refs/heads/master': 'master-sha',
  });
  assert.equal(await workspace.detectDefaultBranch({ projectPath: '/repo' }), 'master');
});

test('detectDefaultBranch returns null when no candidate exists', async () => {
  const workspace = detectionWorkspace({});
  assert.equal(await workspace.detectDefaultBranch({ projectPath: '/repo' }), null);
});

test('auto create writes the detected marker and an existing worktree keeps it', { skip: !GIT }, async () => {
  const fixture = createRemoteFixture();
  try {
    const gitWorkspace = createGitWorkspace();
    const created = await createSessionWorkspace(gitWorkspace, fixture.repositoryPath, 'stable');
    assert.equal(created.base, 'main');
    assert.equal(
      git(['config', '--get', `branch.${created.branch}.glissa-integration`], fixture.repositoryPath).trim(),
      'main',
    );
    const adopted = await gitWorkspace.create({
      projectPath: fixture.repositoryPath,
      teamId: 'session',
      label: 'stable',
      baseBranch: 'master',
    });
    assert.equal(adopted.reason, 'branch-in-use');
    assert.equal(adopted.base, 'main');
    await gitWorkspace.discard({ projectPath: fixture.repositoryPath, workspace: created });
  } finally {
    fixture.cleanup();
  }
});

test('merge continues with a warning when the base fetch fails', { skip: !GIT }, async () => {
  const fixture = createRemoteFixture();
  try {
    const gitWorkspace = createGitWorkspace({ log: { warn() {} } });
    const created = await createSessionWorkspace(gitWorkspace, fixture.repositoryPath, 'offline-merge');
    commitFile(created.cwd, 'session.txt', 'session\n', 'session work');
    git(['remote', 'set-url', 'origin', path.join(path.dirname(fixture.remotePath), 'missing.git')], fixture.repositoryPath);
    const merged = await gitWorkspace.mergeKeep({
      projectPath: fixture.repositoryPath,
      workspace: created,
      targetBranch: null,
    });
    assert.equal(merged.merged, true);
    assert.equal(merged.pushed, false);
    assert.match(merged.warning ?? '', /^could not fetch origin\/main; merged with local base: fatal:/);
    await gitWorkspace.discard({ projectPath: fixture.repositoryPath, workspace: created });
  } finally {
    fixture.cleanup();
  }
});

test('M2 no-origin fork and merge skip sync without an operator warning', { skip: !GIT }, async () => {
  const fixture = createRemoteFixture();
  try {
    git(['remote', 'remove', 'origin'], fixture.repositoryPath);
    const serverWarnings: string[] = [];
    const gitWorkspace = createGitWorkspace({ log: { warn: (message) => serverWarnings.push(message) } });
    const created = await gitWorkspace.create({
      projectPath: fixture.repositoryPath,
      teamId: 'session',
      label: 'local-only',
    });
    assert.equal(created.warning, undefined);
    commitFile(created.cwd, 'session.txt', 'session\n', 'session work');
    const merged = await gitWorkspace.mergeKeep({
      projectPath: fixture.repositoryPath,
      workspace: created,
      targetBranch: null,
    });
    assert.equal(merged.merged, true);
    assert.equal(merged.warning, undefined);
    assert.equal(merged.pushed, false);
    assert.deepEqual(serverWarnings, []);
    await gitWorkspace.discard({ projectPath: fixture.repositoryPath, workspace: created });
  } finally {
    fixture.cleanup();
  }
});

test('M3 merge does not publish a local-only base branch', { skip: !GIT }, async () => {
  const fixture = createRemoteFixture();
  try {
    git(['branch', 'local-base'], fixture.repositoryPath);
    const gitWorkspace = createGitWorkspace();
    const created = await gitWorkspace.create({
      projectPath: fixture.repositoryPath,
      teamId: 'session',
      label: 'unpublished-base',
      baseBranch: 'local-base',
    });
    assert.equal(created.warning, undefined);
    commitFile(created.cwd, 'session.txt', 'session\n', 'session work');
    const merged = await gitWorkspace.mergeKeep({
      projectPath: fixture.repositoryPath,
      workspace: created,
      targetBranch: null,
    });
    assert.equal(merged.merged, true);
    assert.equal(merged.pushed, false);
    assert.throws(() => git([
      'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/local-base',
    ], fixture.repositoryPath));
    await gitWorkspace.discard({ projectPath: fixture.repositoryPath, workspace: created });
  } finally {
    fixture.cleanup();
  }
});

test('merge fast-forwards and pushes a published base fetched outside a narrow remote refspec', { skip: !GIT }, async () => {
  const fixture = createRemoteFixture();
  try {
    git(['checkout', '-b', 'published-base'], fixture.writerPath);
    commitFile(fixture.writerPath, 'published.txt', 'published\n', 'publish base');
    git(['push', 'origin', 'published-base'], fixture.writerPath);

    git(['config', '--unset-all', 'remote.origin.fetch'], fixture.repositoryPath);
    git(['config', '--add', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main'], fixture.repositoryPath);
    git(['fetch', 'origin', 'published-base'], fixture.repositoryPath);
    git(['branch', 'published-base', 'FETCH_HEAD'], fixture.repositoryPath);
    assert.throws(() => git([
      'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/published-base',
    ], fixture.repositoryPath));

    const gitWorkspace = createGitWorkspace();
    const created = await gitWorkspace.create({
      projectPath: fixture.repositoryPath,
      teamId: 'session',
      label: 'narrow-published-base',
      baseBranch: 'published-base',
    });
    commitFile(created.cwd, 'session.txt', 'session\n', 'session work');
    commitFile(fixture.writerPath, 'remote.txt', 'remote advance\n', 'remote advance');
    git(['push', 'origin', 'published-base'], fixture.writerPath);
    const merged = await gitWorkspace.mergeKeep({
      projectPath: fixture.repositoryPath,
      workspace: created,
      targetBranch: null,
    });

    assert.equal(merged.merged, true);
    assert.equal(merged.pushed, true);
    const remoteSha = git(['ls-remote', 'origin', 'refs/heads/published-base'], fixture.repositoryPath)
      .trim()
      .split(/\s/)[0];
    assert.equal(remoteSha, git(['rev-parse', 'published-base'], fixture.repositoryPath).trim());
    assert.equal(git(['show', 'published-base:remote.txt'], fixture.repositoryPath), 'remote advance\n');
    assert.equal(git(['show', 'published-base:session.txt'], fixture.repositoryPath), 'session\n');
    await gitWorkspace.discard({ projectPath: fixture.repositoryPath, workspace: created });
  } finally {
    fixture.cleanup();
  }
});

test('merge does not recreate a remotely deleted base from a stale tracking ref', { skip: !GIT }, async () => {
  const fixture = createRemoteFixture();
  try {
    git(['checkout', '-b', 'published-base'], fixture.writerPath);
    commitFile(fixture.writerPath, 'published.txt', 'published\n', 'publish base');
    git(['push', 'origin', 'published-base'], fixture.writerPath);
    git(['fetch', 'origin', 'published-base'], fixture.repositoryPath);
    git(['branch', 'published-base', 'origin/published-base'], fixture.repositoryPath);
    git(['push', 'origin', '--delete', 'published-base'], fixture.writerPath);
    assert.doesNotThrow(() => git([
      'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/published-base',
    ], fixture.repositoryPath));

    const gitWorkspace = createGitWorkspace();
    const created = await gitWorkspace.create({
      projectPath: fixture.repositoryPath,
      teamId: 'session',
      label: 'deleted-published-base',
      baseBranch: 'published-base',
    });
    commitFile(created.cwd, 'session.txt', 'session\n', 'session work');
    const merged = await gitWorkspace.mergeKeep({
      projectPath: fixture.repositoryPath,
      workspace: created,
      targetBranch: null,
    });

    assert.equal(merged.merged, true);
    assert.equal(merged.pushed, false);
    assert.equal(git(['ls-remote', 'origin', 'refs/heads/published-base'], fixture.repositoryPath).trim(), '');
    await gitWorkspace.discard({ projectPath: fixture.repositoryPath, workspace: created });
  } finally {
    fixture.cleanup();
  }
});

test('plain post-merge push is rejected when origin moves', { skip: !GIT }, async () => {
  const fixture = createRemoteFixture();
  try {
    const capturedPushArguments: string[][] = [];
    const workspaceGit = (args: string[], cwd: string) => {
      if (args[0] === 'push' && capturedPushArguments.length === 0) {
        capturedPushArguments.push([...args]);
        pushCommit(fixture.writerPath, 'remote-after-advertisement.txt', 'remote advance\n', 'remote advance');
      }
      return git(args, cwd);
    };
    const gitWorkspace = createGitWorkspace({ git: workspaceGit });
    const created = await createSessionWorkspace(gitWorkspace, fixture.repositoryPath, 'advertised-race');
    commitFile(created.cwd, 'session.txt', 'session\n', 'session work');
    const merged = await gitWorkspace.mergeKeep({
      projectPath: fixture.repositoryPath,
      workspace: created,
      targetBranch: null,
    });

    assert.equal(merged.merged, true);
    assert.equal(merged.pushed, false);
    assert.deepEqual(capturedPushArguments[0], ['push', 'origin', 'main']);
    assert.equal(capturedPushArguments[0]?.includes('--force'), false);
    assert.equal(capturedPushArguments[0]?.some((argument) => argument.startsWith('--force-with-lease')), false);
    assert.equal(
      git(['ls-remote', 'origin', 'refs/heads/main'], fixture.repositoryPath).trim().split(/\s/)[0],
      git(['rev-parse', 'main'], fixture.writerPath).trim(),
    );
    await gitWorkspace.discard({ projectPath: fixture.repositoryPath, workspace: created });
  } finally {
    fixture.cleanup();
  }
});

test('M4 omitted base options auto-detect instead of forking from HEAD', { skip: !GIT }, async () => {
  const fixture = createRemoteFixture();
  try {
    git(['checkout', '-b', 'topic'], fixture.repositoryPath);
    commitFile(fixture.repositoryPath, 'topic.txt', 'topic\n', 'topic work');
    const topicSha = git(['rev-parse', 'HEAD'], fixture.repositoryPath).trim();
    const mainSha = git(['rev-parse', 'main'], fixture.repositoryPath).trim();
    const gitWorkspace = createGitWorkspace();
    const created = await gitWorkspace.create({
      projectPath: fixture.repositoryPath,
      teamId: 'session',
      label: 'auto-default',
    });
    assert.equal(created.base, 'main');
    assert.equal(created.baseSha, mainSha);
    assert.notEqual(created.baseSha, topicSha);
    await gitWorkspace.discard({ projectPath: fixture.repositoryPath, workspace: created });
  } finally {
    fixture.cleanup();
  }
});

test('L5 forkFromHead isolates a detached checkout at its exact SHA', { skip: !GIT }, async () => {
  const fixture = createRemoteFixture();
  try {
    git(['checkout', '--detach'], fixture.repositoryPath);
    const detachedSha = git(['rev-parse', 'HEAD'], fixture.repositoryPath).trim();
    const gitWorkspace = createGitWorkspace();
    const created = await gitWorkspace.create({
      projectPath: fixture.repositoryPath,
      teamId: 'pr-review',
      label: 'detached',
      forkFromHead: true,
    });
    assert.equal(created.isGit, true);
    assert.equal(created.base, 'HEAD');
    assert.equal(created.baseSha, detachedSha);
    assert.equal(git(['rev-parse', 'HEAD'], created.cwd).trim(), detachedSha);
    await gitWorkspace.discard({ projectPath: fixture.repositoryPath, workspace: created });
  } finally {
    fixture.cleanup();
  }
});

for (const method of ['mergeBack', 'mergeKeep'] as const) {
  test(`${method} fast-forwards a behind base, lands the session, and pushes`, { skip: !GIT }, async () => {
    const fixture = createRemoteFixture();
    try {
      const gitWorkspace = createGitWorkspace();
      const created = await createSessionWorkspace(gitWorkspace, fixture.repositoryPath, `${method}-behind`);
      commitFile(created.cwd, 'session.txt', 'session\n', 'session work');
      pushCommit(fixture.writerPath, 'remote.txt', 'remote\n', 'remote advance');
      const merged = await gitWorkspace[method]({
        projectPath: fixture.repositoryPath,
        workspace: created,
        targetBranch: null,
      });
      assert.equal(merged.merged, true);
      assert.equal(merged.pushed, true);
      assert.equal(git(['rev-parse', 'main'], fixture.repositoryPath).trim(), git(['ls-remote', 'origin', 'refs/heads/main'], fixture.repositoryPath).trim().split(/\s/)[0]);
      assert.equal(fs.readFileSync(path.join(fixture.repositoryPath, 'remote.txt'), 'utf8'), 'remote\n');
      assert.equal(fs.readFileSync(path.join(fixture.repositoryPath, 'session.txt'), 'utf8'), 'session\n');
      if (method === 'mergeKeep') await gitWorkspace.discard({ projectPath: fixture.repositoryPath, workspace: created });
    } finally {
      fixture.cleanup();
    }
  });

  test(`${method} parks a diverged base without changing the base or worktree`, { skip: !GIT }, async () => {
    const fixture = createRemoteFixture();
    try {
      const gitWorkspace = createGitWorkspace();
      const created = await createSessionWorkspace(gitWorkspace, fixture.repositoryPath, `${method}-diverged`);
      commitFile(created.cwd, 'session.txt', 'session\n', 'session work');
      commitFile(fixture.repositoryPath, 'local.txt', 'local\n', 'local advance');
      pushCommit(fixture.writerPath, 'remote.txt', 'remote\n', 'remote advance');
      const baseSha = git(['rev-parse', 'main'], fixture.repositoryPath).trim();
      const worktreeSha = git(['rev-parse', 'HEAD'], created.cwd).trim();
      const merged = await gitWorkspace[method]({
        projectPath: fixture.repositoryPath,
        workspace: created,
        targetBranch: null,
      });
      assert.equal(merged.merged, false);
      assert.equal(merged.parked, true);
      assert.equal(merged.reason, 'base-diverged');
      assert.equal(git(['rev-parse', 'main'], fixture.repositoryPath).trim(), baseSha);
      assert.equal(git(['rev-parse', 'HEAD'], created.cwd).trim(), worktreeSha);
      await gitWorkspace.discard({ projectPath: fixture.repositoryPath, workspace: created });
    } finally {
      fixture.cleanup();
    }
  });

  test(`${method} reports success when the post-merge push is rejected`, { skip: !GIT }, async () => {
    const fixture = createRemoteFixture();
    try {
      const gitWorkspace = createGitWorkspace();
      const created = await createSessionWorkspace(gitWorkspace, fixture.repositoryPath, `${method}-rejected`);
      commitFile(created.cwd, 'session.txt', 'session\n', 'session work');
      const hookPath = path.join(fixture.remotePath, 'hooks', 'pre-receive');
      fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', 'utf8');
      fs.chmodSync(hookPath, 0o755);
      const merged = await gitWorkspace[method]({
        projectPath: fixture.repositoryPath,
        workspace: created,
        targetBranch: null,
      });
      assert.equal(merged.merged, true);
      assert.equal(merged.pushed, false);
      assert.equal(git(['rev-list', '--count', 'origin/main..main'], fixture.repositoryPath).trim(), '1');
      if (method === 'mergeKeep') await gitWorkspace.discard({ projectPath: fixture.repositoryPath, workspace: created });
    } finally {
      fixture.cleanup();
    }
  });
}
