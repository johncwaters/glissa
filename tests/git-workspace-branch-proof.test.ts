import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ancestryFromResult, buildTipProbe, proveMergedAcrossTips } from '../server/core/merge-proof-core.ts';
import type { MergeProof, MergeTreeOutcome } from '../server/core/merge-proof-core.ts';
import { createGitWorkspace } from '../server/git-workspace.ts';
import { hasGit, git } from './helpers/git-fixture.ts';

const GIT = hasGit();

function createRepository(): string {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-branch-proof-'));
  try { git(['init', '-b', 'main'], projectPath); } catch { git(['init'], projectPath); }
  git(['config', 'user.email', 'test@example.com'], projectPath);
  git(['config', 'user.name', 'Glissa Test'], projectPath);
  git(['config', 'commit.gpgsign', 'false'], projectPath);
  fs.writeFileSync(path.join(projectPath, 'message.txt'), 'base\n', 'utf8');
  git(['add', '-A'], projectPath);
  git(['commit', '-m', 'initial'], projectPath);
  return projectPath;
}

function removeRepository(projectPath: string): void {
  fs.rmSync(projectPath, { recursive: true, force: true });
}

function commitFile(projectPath: string, fileName: string, content: string, message: string): void {
  fs.writeFileSync(path.join(projectPath, fileName), content, 'utf8');
  git(['add', fileName], projectPath);
  git(['commit', '-m', message], projectPath);
}

async function mergeTreeProbe(projectPath: string, integrationSha: string, branchSha: string): Promise<{ ok: boolean; out: string; outcome: MergeTreeOutcome }> {
  const gitWorkspace = createGitWorkspace();
  const resolved = await gitWorkspace.resolveMergeProbeEnv({ projectPath });
  if (!resolved.ok) throw new Error(`the merge probe env failed to resolve: ${resolved.err}`);
  return gitWorkspace.writeMergedTree({ projectPath, integrationSha, branchSha, probeEnv: resolved.probeEnv });
}

async function proofFor(projectPath: string, branchSha: string, integrationSha: string): Promise<MergeProof> {
  const gitWorkspace = createGitWorkspace();
  const ancestor = await gitWorkspace.isAncestor({ projectPath, ancestorSha: branchSha, descendantSha: integrationSha });
  const integrationTree = await gitWorkspace.treeOid({ projectPath, sha: integrationSha });
  const mergeTree = await mergeTreeProbe(projectPath, integrationSha, branchSha);
  return proveMergedAcrossTips([buildTipProbe({
    isAncestor: ancestryFromResult(ancestor),
    integrationTree,
    mergeTree,
  })]);
}

function selectOursMergeDriverInAttributes(projectPath: string): void {
  fs.writeFileSync(path.join(projectPath, '.gitattributes'), '* merge=ours\n', 'utf8');
  git(['add', '-A'], projectPath);
  git(['commit', '-m', 'select the ours merge driver'], projectPath);
}

function commitConflictingEdits(projectPath: string): { branchSha: string; integrationSha: string } {
  git(['checkout', '-b', 'feature'], projectPath);
  commitFile(projectPath, 'message.txt', 'feature\n', 'feature edit');
  const branchSha = git(['rev-parse', 'HEAD'], projectPath).trim();
  git(['checkout', 'main'], projectPath);
  commitFile(projectPath, 'message.txt', 'trunk\n', 'trunk edit');
  return { branchSha, integrationSha: git(['rev-parse', 'main'], projectPath).trim() };
}

async function withEnvironmentVariables<T>(overrides: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const previousValues = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previousValues.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, previousValue] of previousValues) {
      if (previousValue === undefined) {
        delete process.env[key];
        continue;
      }
      process.env[key] = previousValue;
    }
  }
}

test('a rebased branch is tree-contained after its landing commits reach main', { skip: !GIT }, async () => {
  const projectPath = createRepository();
  try {
    git(['checkout', '-b', 'feature'], projectPath);
    commitFile(projectPath, 'feature.txt', 'feature\n', 'feature change');
    const originalTip = git(['rev-parse', 'HEAD'], projectPath).trim();
    git(['branch', 'remote-tip', originalTip], projectPath);
    git(['checkout', 'main'], projectPath);
    commitFile(projectPath, 'advance.txt', 'advance\n', 'advance main');
    git(['checkout', 'feature'], projectPath);
    git(['rebase', 'main'], projectPath);
    git(['checkout', 'main'], projectPath);
    git(['merge', '--ff-only', 'feature'], projectPath);

    const proof = await proofFor(projectPath, originalTip, git(['rev-parse', 'main'], projectPath).trim());

    assert.deepEqual(proof, { verdict: 'merged', reason: 'tree-contained' });
  } finally {
    removeRepository(projectPath);
  }
});

test('a branch with an extra commit is not merged', { skip: !GIT }, async () => {
  const projectPath = createRepository();
  try {
    git(['checkout', '-b', 'feature'], projectPath);
    commitFile(projectPath, 'feature.txt', 'extra\n', 'extra content');
    const branchSha = git(['rev-parse', 'HEAD'], projectPath).trim();
    git(['checkout', 'main'], projectPath);
    commitFile(projectPath, 'advance.txt', 'advance\n', 'advance main');

    const proof = await proofFor(projectPath, branchSha, git(['rev-parse', 'main'], projectPath).trim());

    assert.deepEqual(proof, { verdict: 'not-merged', reason: 'unmerged-content' });
  } finally {
    removeRepository(projectPath);
  }
});

test('a whitespace-only branch variant is not merged', { skip: !GIT }, async () => {
  const projectPath = createRepository();
  try {
    git(['checkout', '-b', 'feature'], projectPath);
    commitFile(projectPath, 'message.txt', 'base \n', 'whitespace variant');
    const branchSha = git(['rev-parse', 'HEAD'], projectPath).trim();
    git(['checkout', 'main'], projectPath);
    commitFile(projectPath, 'advance.txt', 'advance\n', 'advance main');

    const proof = await proofFor(projectPath, branchSha, git(['rev-parse', 'main'], projectPath).trim());

    assert.deepEqual(proof, { verdict: 'not-merged', reason: 'unmerged-content' });
  } finally {
    removeRepository(projectPath);
  }
});

test('a merge commit with extra content is not merged', { skip: !GIT }, async () => {
  const projectPath = createRepository();
  try {
    git(['checkout', '-b', 'feature'], projectPath);
    git(['checkout', '-b', 'nested'], projectPath);
    commitFile(projectPath, 'merge-only.txt', 'merge only\n', 'nested content');
    git(['checkout', 'feature'], projectPath);
    git(['merge', '--no-ff', 'nested', '-m', 'merge nested'], projectPath);
    const branchSha = git(['rev-parse', 'HEAD'], projectPath).trim();
    git(['checkout', 'main'], projectPath);
    commitFile(projectPath, 'advance.txt', 'advance\n', 'advance main');

    const proof = await proofFor(projectPath, branchSha, git(['rev-parse', 'main'], projectPath).trim());

    assert.deepEqual(proof, { verdict: 'not-merged', reason: 'unmerged-content' });
  } finally {
    removeRepository(projectPath);
  }
});

test('a branch that reverts its only extra content is tree-contained', { skip: !GIT }, async () => {
  const projectPath = createRepository();
  try {
    git(['checkout', '-b', 'feature'], projectPath);
    commitFile(projectPath, 'reverted.txt', 'temporary\n', 'add temporary content');
    git(['revert', '--no-edit', 'HEAD'], projectPath);
    const branchSha = git(['rev-parse', 'HEAD'], projectPath).trim();
    git(['checkout', 'main'], projectPath);
    commitFile(projectPath, 'advance.txt', 'advance\n', 'advance main');

    const proof = await proofFor(projectPath, branchSha, git(['rev-parse', 'main'], projectPath).trim());

    assert.deepEqual(proof, { verdict: 'merged', reason: 'tree-contained' });
  } finally {
    removeRepository(projectPath);
  }
});

test('a repository whose ours merge driver hides a conflict still reports the branch unmerged', { skip: !GIT }, async () => {
  const projectPath = createRepository();
  try {
    selectOursMergeDriverInAttributes(projectPath);
    git(['config', 'merge.ours.driver', 'true'], projectPath);
    const { branchSha, integrationSha } = commitConflictingEdits(projectPath);

    const mergeTree = await mergeTreeProbe(projectPath, integrationSha, branchSha);
    const proof = await proofFor(projectPath, branchSha, integrationSha);

    assert.equal(mergeTree.outcome, 'conflicts');
    assert.deepEqual(proof, { verdict: 'not-merged', reason: 'unmerged-content' });
  } finally {
    removeRepository(projectPath);
  }
});

test('a merge driver reached only through an included config file still reports the branch unmerged', { skip: !GIT }, async () => {
  const projectPath = createRepository();
  try {
    selectOursMergeDriverInAttributes(projectPath);
    fs.writeFileSync(path.join(projectPath, '.git', 'merge-drivers.config'), '[merge "ours"]\n\tdriver = true\n', 'utf8');
    git(['config', '--local', 'include.path', 'merge-drivers.config'], projectPath);
    const { branchSha, integrationSha } = commitConflictingEdits(projectPath);

    const mergeTree = await mergeTreeProbe(projectPath, integrationSha, branchSha);
    const proof = await proofFor(projectPath, branchSha, integrationSha);

    assert.equal(mergeTree.outcome, 'conflicts');
    assert.deepEqual(proof, { verdict: 'not-merged', reason: 'unmerged-content' });
  } finally {
    removeRepository(projectPath);
  }
});

test('a worktree scoped merge driver still reports the branch unmerged', { skip: !GIT }, async () => {
  const projectPath = createRepository();
  try {
    selectOursMergeDriverInAttributes(projectPath);
    git(['config', '--local', 'extensions.worktreeConfig', 'true'], projectPath);
    git(['config', '--worktree', 'merge.ours.driver', 'true'], projectPath);
    const { branchSha, integrationSha } = commitConflictingEdits(projectPath);

    const mergeTree = await mergeTreeProbe(projectPath, integrationSha, branchSha);
    const proof = await proofFor(projectPath, branchSha, integrationSha);

    assert.equal(mergeTree.outcome, 'conflicts');
    assert.deepEqual(proof, { verdict: 'not-merged', reason: 'unmerged-content' });
  } finally {
    removeRepository(projectPath);
  }
});

test('a merge driver injected through the inherited git config environment still reports the branch unmerged', { skip: !GIT }, async () => {
  const projectPath = createRepository();
  try {
    selectOursMergeDriverInAttributes(projectPath);
    const { branchSha, integrationSha } = commitConflictingEdits(projectPath);

    const proof = await withEnvironmentVariables({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'merge.ours.driver',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_PARAMETERS: "'merge.ours.driver=true'",
    }, async () => {
      const mergeTree = await mergeTreeProbe(projectPath, integrationSha, branchSha);
      assert.equal(mergeTree.outcome, 'conflicts');
      return proofFor(projectPath, branchSha, integrationSha);
    });

    assert.deepEqual(proof, { verdict: 'not-merged', reason: 'unmerged-content' });
  } finally {
    removeRepository(projectPath);
  }
});

test('an orphan branch is decided rather than left permanently undecidable', { skip: !GIT }, async () => {
  const projectPath = createRepository();
  try {
    git(['checkout', '--orphan', 'orphan'], projectPath);
    git(['rm', '-rq', '--cached', '.'], projectPath);
    fs.rmSync(path.join(projectPath, 'message.txt'));
    commitFile(projectPath, 'orphan.txt', 'orphan\n', 'orphan root');
    const branchSha = git(['rev-parse', 'HEAD'], projectPath).trim();
    git(['checkout', '-f', 'main'], projectPath);
    const integrationSha = git(['rev-parse', 'main'], projectPath).trim();

    const mergeTree = await mergeTreeProbe(projectPath, integrationSha, branchSha);
    const proof = await proofFor(projectPath, branchSha, integrationSha);

    assert.equal(mergeTree.outcome, 'tree');
    assert.deepEqual(proof, { verdict: 'not-merged', reason: 'unmerged-content' });
  } finally {
    removeRepository(projectPath);
  }
});

test('a branch deletion the built in union driver would swallow still reports the branch unmerged', { skip: !GIT }, async () => {
  const projectPath = createRepository();
  try {
    fs.writeFileSync(path.join(projectPath, 'lines.txt'), 'a\nb\nc\n', 'utf8');
    fs.writeFileSync(path.join(projectPath, '.gitattributes'), '* merge=union\n', 'utf8');
    git(['add', '-A'], projectPath);
    git(['commit', '-m', 'select the union merge driver'], projectPath);
    git(['checkout', '-b', 'feature'], projectPath);
    commitFile(projectPath, 'lines.txt', 'a\nc\n', 'branch deletes the middle line');
    const branchSha = git(['rev-parse', 'HEAD'], projectPath).trim();
    git(['checkout', 'main'], projectPath);
    commitFile(projectPath, 'lines.txt', 'a\nrewritten\nc\n', 'trunk rewrites the middle line');
    const integrationSha = git(['rev-parse', 'main'], projectPath).trim();

    const mergeTree = await mergeTreeProbe(projectPath, integrationSha, branchSha);
    const proof = await proofFor(projectPath, branchSha, integrationSha);

    assert.equal(mergeTree.outcome, 'conflicts');
    assert.deepEqual(proof, { verdict: 'not-merged', reason: 'unmerged-content' });
  } finally {
    removeRepository(projectPath);
  }
});

test('a repository git reads as dubiously owned is still probed through the inherited safe directory list', { skip: !GIT }, async () => {
  const projectPath = createRepository();
  try {
    selectOursMergeDriverInAttributes(projectPath);
    git(['config', '--local', 'merge.ours.driver', 'true'], projectPath);
    const { branchSha, integrationSha } = commitConflictingEdits(projectPath);
    const globalConfigPath = path.join(projectPath, '.git', 'inherited-global.config');
    fs.writeFileSync(globalConfigPath, `[safe]\n\tdirectory = ${projectPath}\n`, 'utf8');

    const mergeTree = await withEnvironmentVariables({
      GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
      GIT_CONFIG_GLOBAL: globalConfigPath,
    }, () => mergeTreeProbe(projectPath, integrationSha, branchSha));

    assert.equal(mergeTree.outcome, 'conflicts');
  } finally {
    removeRepository(projectPath);
  }
});

test('an enumeration exit of one reads as no drivers while any other failure leaves the probe env unresolved', async () => {
  const workspaceWithFailure = (exitCode: number) => createGitWorkspace({
    git: async (args: string[]) => {
      if (!args.includes('--get-regexp')) return '';
      throw Object.assign(new Error('git config failed'), { code: exitCode, stderr: 'fatal: bad config line' });
    },
  });

  assert.equal((await workspaceWithFailure(1).resolveMergeProbeEnv({ projectPath: '/repo' })).ok, true);
  assert.equal((await workspaceWithFailure(128).resolveMergeProbeEnv({ projectPath: '/repo' })).ok, false);
});
