'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGitWorkspace } = require('../server/git-workspace');
const { git, hasGit } = require('./helpers/git-fixture');

const GIT = hasGit();

function configureRepository(repositoryPath) {
  git(['config', 'user.email', 'test@example.com'], repositoryPath);
  git(['config', 'user.name', 'Glissa Test'], repositoryPath);
  git(['config', 'commit.gpgsign', 'false'], repositoryPath);
}

function commitFile(repositoryPath, fileName, content, message) {
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

function pushCommit(writerPath, fileName, content, message) {
  commitFile(writerPath, fileName, content, message);
  git(['push', 'origin', 'main'], writerPath);
}

async function createSessionWorkspace(gitWorkspace, repositoryPath, label) {
  return gitWorkspace.create({
    projectPath: repositoryPath,
    teamId: 'session',
    label,
    baseBranch: null,
  });
}

function detectionWorkspace(outputs) {
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
    const gitWorkspace = createGitWorkspace();
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
    assert.equal(merged.warning, 'could not fetch origin/main; merged with local base');
    await gitWorkspace.discard({ projectPath: fixture.repositoryPath, workspace: created });
  } finally {
    fixture.cleanup();
  }
});

for (const method of ['mergeBack', 'mergeKeep']) {
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
