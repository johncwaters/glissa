'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGitWorkspace } = require('../server/git-workspace');
const { hasGit, git } = require('./helpers/git-fixture');

const GIT = hasGit();

function configureRepository(directory) {
  git(['config', 'user.email', 'test@example.com'], directory);
  git(['config', 'user.name', 'Glissa Test'], directory);
  git(['config', 'commit.gpgsign', 'false'], directory);
}

function createFixture() {
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

// The engine's default runner is promisified execFile, whose error carries the exit code on `.code`;
// isAncestor reads exactly that to tell "not an ancestor" (exit 1) from "the probe could not run".
// execFileSync parks the code on `.status` instead, so a test that injects a real-git runner has to
// normalize or every ancestry probe reads as unreadable and the classification silently changes.
// `hijack` runs BEFORE the command, which is how a test lands an operator action mid-sequence.
function realGitRunner(hijack) {
  return (args, cwd) => {
    if (hijack) hijack(args, cwd);
    try {
      return git(args, cwd);
    } catch (err) {
      throw Object.assign(err, { code: err.code ?? err.status });
    }
  };
}

function advanceRemote(publisher, name) {
  fs.writeFileSync(path.join(publisher, name), `${name}\n`, 'utf8');
  git(['add', '-A'], publisher);
  git(['commit', '-m', `add ${name}`], publisher);
  git(['push', 'origin', 'develop'], publisher);
  return git(['rev-parse', 'HEAD'], publisher).trim();
}

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

// The TOCTOU the porcelain pre-check cannot close: the branch is free when the check runs and checked
// out by the time the mutation does. update-ref would move it anyway and strand a live index against a
// tree it no longer describes, so the mutation is a local fetch, which git itself refuses. The operator's
// checkout is simulated by hijacking the runner just before that fetch.
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

// The pre-check classifies, the fetch enforces. A branch that raced to the remote tip between the two
// (a sibling worktree engine, the operator's own pull) is reported for what it is, not as a fork.
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

// The refusal that is NOT a fork: a stale refs/heads/<branch>.lock (a crashed git, a concurrent ref
// transaction) refuses a fast-forward that is still perfectly legal. Calling that 'diverged' would tell
// the operator their integration branch forked, sending them to resolve a history problem they do not
// have; it is operational, retried on the next start, and carries git's own error line.
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
    assert.match(synced.error, /cannot lock ref|unable to update local ref/i, 'git says why, verbatim');
    assert.equal(git(['rev-parse', 'develop'], fixture.repo).trim(), localSha, 'the ref did not move');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

// The ancestry probe is re-run AFTER the refusal, not reused from the pre-check: a branch that really
// forked in the meantime is still reported as the fork it is.
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

// The pre-update twin of the stale-lock case: the ancestry probe itself fails (an unreadable object
// store, a git that cannot run), so Glissa knows nothing about the two branches' relationship. Reporting
// diverged there would send the operator to resolve a fork that may not exist.
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
    assert.match(synced.error, /unable to read object store/, 'the probe failure is reported verbatim');
    assert.equal(git(['rev-parse', 'develop'], fixture.repo).trim(), localSha, 'and nothing was moved on a guess');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

// A probe that runs and answers "no" is the one thing that earns the word diverged, and it still does.
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
