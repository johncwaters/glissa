import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hasGit, git } from './helpers/git-fixture.ts';
import { BRANCH_GC_FETCH_TIMEOUT_MS, createBranchGcPoller } from '../server/branch-gc-poller.ts';
import type { BranchGcGitWorkspace } from '../server/branch-gc-poller.ts';
import { createBranchGcWiring } from '../server/branch-gc-wiring.ts';
import { DAY_MS } from '../server/core/branch-gc-core.ts';
import type { LocalWorktreeTip } from '../server/core/branch-gc-core.ts';
import type { MergeProbeEnvResult, MergeTreeOutcome } from '../server/core/merge-proof-core.ts';
import { createGitWorkspace } from '../server/git-workspace.ts';

const NOW_MS = Date.parse('2026-08-25T12:00:00Z');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function deletionsOfFirstProject(summary: Record<string, unknown> | undefined): string[] {
  const projects = summary?.projects;
  if (!Array.isArray(projects) || !isRecord(projects[0])) throw new Error('a tick summary lists its project summaries');
  const { deletions } = projects[0];
  if (!Array.isArray(deletions)) throw new Error('a project summary lists its deletions');
  return deletions.map(String);
}

const IDENTICAL_TREE_OID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function unreachableGitWorkspace(): BranchGcGitWorkspace {
  const refuse = () => Promise.reject(new Error('the faked poller never touches git'));
  return {
    fetchOrigin: refuse,
    listRemoteBranches: refuse,
    listIntegrationTips: refuse,
    isAncestor: refuse,
    resolveMergeProbeEnv: refuse,
    writeMergedTree: refuse,
    treeOid: refuse,
    deleteRemoteBranch: refuse,
    listWorktrees: refuse,
    probeWorktreeDirty: refuse,
    removeWorktreeByPath: refuse,
  };
}

function branchGcGitWorkspace(overrides: Partial<BranchGcGitWorkspace> = {}): BranchGcGitWorkspace {
  return {
    async fetchOrigin() { return { ok: true }; },
    async listRemoteBranches() { return { ok: true, branches: [] }; },
    async listIntegrationTips() { return { ok: true, integrationTips: [{ branch: 'main', sha: 'main-sha' }] }; },
    async isAncestor() { return { ok: true, isAncestor: false }; },
    async resolveMergeProbeEnv() { return { ok: true, probeEnv: {} }; },
    async writeMergedTree() { return { ok: true, out: IDENTICAL_TREE_OID, outcome: 'tree' }; },
    async treeOid() { return { ok: true, out: IDENTICAL_TREE_OID }; },
    async deleteRemoteBranch() { return { ok: true }; },
    async listWorktrees() { return []; },
    async probeWorktreeDirty() { return { ok: true, dirty: false }; },
    async removeWorktreeByPath() { return { ok: true }; },
    ...overrides,
  };
}

test('fetches before listing, deletes separately, continues after failure, and protects live sessions', async () => {
  const calls: (string | number | null | undefined)[][] = [];
  const traces: Record<string, unknown>[] = [];
  const mergedShas = new Set(['merged-sha', 'failed-delete-sha', 'live-sha']);
  const gitWorkspace = branchGcGitWorkspace({
    async fetchOrigin({ projectPath, timeoutMs }) {
      calls.push(['fetch', projectPath, timeoutMs]);
      return { ok: true };
    },
    async listRemoteBranches({ projectPath }) {
      calls.push(['list', projectPath]);
      return {
        ok: true,
        branches: [
          { name: 'glissa/session/merged', tipSha: 'merged-sha', tipCommitTimeMs: NOW_MS - DAY_MS },
          { name: 'glissa/session/failed-delete', tipSha: 'failed-delete-sha', tipCommitTimeMs: NOW_MS - DAY_MS },
          { name: 'glissa/session/stale', tipSha: 'stale-sha', tipCommitTimeMs: NOW_MS - 20 * DAY_MS },
          { name: 'glissa/session/live', tipSha: 'live-sha', tipCommitTimeMs: NOW_MS - 20 * DAY_MS },
          { name: 'glissa/session/fresh', tipSha: 'fresh-sha', tipCommitTimeMs: NOW_MS - DAY_MS },
        ],
      };
    },
    async listIntegrationTips({ projectPath, integrationBranch }) {
      calls.push(['tips', projectPath, integrationBranch]);
      return { ok: true, integrationTips: [{ branch: 'develop', sha: 'develop-sha' }] };
    },
    async isAncestor({ ancestorSha, descendantSha }) {
      calls.push(['ancestor', ancestorSha, descendantSha]);
      return { ok: true, isAncestor: mergedShas.has(ancestorSha) };
    },
    async resolveMergeProbeEnv() {
      return { ok: true, probeEnv: {} };
    },
    async writeMergedTree() {
      return { ok: true, out: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', outcome: 'tree' };
    },
    async treeOid() {
      return { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    },
    async deleteRemoteBranch({ projectPath, name, tipSha }) {
      calls.push(['delete', projectPath, name, tipSha]);
      if (name === 'glissa/session/failed-delete') return { ok: false, err: 'rejected' };
      return { ok: true };
    },
  });
  const statuses: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace,
    getConfig: () => ({
      integrationBranch: 'develop',
      projects: [{ id: 'project-uuid', path: '/repo' }],
    }),
    liveSessionIds: () => new Set(['live']),
    liveWorktreePaths: () => new Set(),
    now: () => NOW_MS,
    log: { warn: () => {} },
    decisionTrace: (entry) => traces.push(entry),
    onTickComplete: (status) => statuses.push(status),
  });

  await poller.tick();

  assert.deepEqual(calls.slice(0, 2), [['fetch', '/repo', BRANCH_GC_FETCH_TIMEOUT_MS], ['list', '/repo']]);
  assert.deepEqual(
    calls.filter(([operation]) => operation === 'delete'),
    [
      ['delete', '/repo', 'glissa/session/merged', 'merged-sha'],
      ['delete', '/repo', 'glissa/session/failed-delete', 'failed-delete-sha'],
      ['delete', '/repo', 'glissa/session/stale', 'stale-sha'],
    ],
  );
  assert.equal(calls.some((call) => call[0] === 'delete' && call[2] === 'glissa/session/live'), false);
  assert.ok(traces.some((entry) => entry.name === 'glissa/session/live' && entry.reason === 'live-session'));
  assert.ok(traces.some((entry) => entry.name === 'glissa/session/failed-delete' && entry.reason === 'delete-error'));
  assert.deepEqual(deletionsOfFirstProject(statuses[0]), [
    'glissa/session/merged',
    'glissa/session/stale',
  ]);
});

test('dryRun traces and reports planned deletions without deleting remote branches', async () => {
  const deletedBranches: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const statuses: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: branchGcGitWorkspace({
      async listRemoteBranches() {
        return { ok: true, branches: [{ name: 'glissa/session/merged', tipSha: 'merged-sha', tipCommitTimeMs: NOW_MS - DAY_MS }] };
      },
      async listIntegrationTips() { return { ok: true, integrationTips: [{ branch: 'develop', sha: 'develop-sha' }] }; },
      async isAncestor() { return { ok: true, isAncestor: true }; },
      async deleteRemoteBranch({ name }) {
        deletedBranches.push(name);
        return { ok: true };
      },
    }),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    dryRun: true,
    now: () => NOW_MS,
    decisionTrace: (entry) => traces.push(entry),
    onTickComplete: (status) => statuses.push(status),
  });

  await poller.tick();

  assert.deepEqual(deletedBranches, []);
  assert.deepEqual(
    traces.filter((entry) => entry.name === 'glissa/session/merged'),
    [{ kind: 'branch-gc', ts: NOW_MS, projectPath: '/repo', name: 'glissa/session/merged', decision: 'would-delete', reason: 'ancestor' }],
  );
  assert.deepEqual(deletionsOfFirstProject(statuses[0]), ['glissa/session/merged']);
  assert.equal(statuses[0]?.dryRun, true);
  const [firstProject] = statuses[0]?.projects as Record<string, unknown>[];
  assert.deepEqual(Object.keys(firstProject).sort(), ['deletions', 'errors', 'kept', 'projectPath', 'worktreeRemovals', 'worktreesKept']);
});

function localWorktreeGitWorkspace(calls: string[], worktrees: LocalWorktreeTip[], overrides: Partial<BranchGcGitWorkspace> = {}): BranchGcGitWorkspace {
  return branchGcGitWorkspace({
    async listRemoteBranches() { return { ok: true, branches: [{ name: 'worktree-agent-remote', tipSha: 'remote-sha', tipCommitTimeMs: NOW_MS }] }; },
    async isAncestor() { return { ok: true, isAncestor: true }; },
    async deleteRemoteBranch() { calls.push('delete-remote'); return { ok: true }; },
    async listWorktrees() { calls.push('list-worktrees'); return worktrees; },
    async probeWorktreeDirty({ cwd }) { return { ok: true, dirty: false, headSha: worktrees.find((worktree) => worktree.cwd === cwd)?.tipSha ?? null }; },
    async removeWorktreeByPath({ cwd, branch }) { calls.push(`remove:${cwd}:${branch}`); return { ok: true }; },
    ...overrides,
  });
}

function localWorktree(overrides: Partial<LocalWorktreeTip> = {}): LocalWorktreeTip {
  return { cwd: '/agent', branch: 'worktree-agent-local', locked: false, dirty: false, tipSha: 'local-sha', integrationBranch: 'main', ...overrides };
}

test('skips the local worktree pass when worktree pruning is switched off', async () => {
  const calls: string[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: localWorktreeGitWorkspace(calls, []),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    pruneWorktrees: false,
    now: () => NOW_MS,
  });
  await poller.tick();
  assert.equal(calls.includes('list-worktrees'), false);
});

test('the lane wiring injects worktree pruning from the branchGc worktrees setting', async () => {
  const pruneWorktreesByConfiguredValue: (boolean | undefined)[] = [];
  for (const worktrees of [undefined, true, false]) {
    const wiring = createBranchGcWiring({
      config: { branchGc: { worktrees }, projects: [] },
      gitWorkspace: unreachableGitWorkspace(),
      liveSessionIds: () => new Set<string>(),
      liveWorktreePaths: () => new Set<string>(),
      createPoller: (deps) => {
        pruneWorktreesByConfiguredValue.push(deps.pruneWorktrees);
        return { start: async () => {}, stop: async () => {}, tick: async () => {} };
      },
    });
    wiring.start();
    await new Promise((resolve) => setImmediate(resolve));
    await wiring.stop();
  }
  assert.deepEqual(pruneWorktreesByConfiguredValue, [true, true, false]);
});

test('removes a merged local worktree before deleting remote branches', async () => {
  const calls: string[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: localWorktreeGitWorkspace(calls, [localWorktree()]),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    now: () => NOW_MS,
  });
  await poller.tick();
  assert.ok(calls.indexOf('remove:/agent:worktree-agent-local') < calls.indexOf('delete-remote'));
});

test('a remote branch listing failure still lets the local worktree pass remove a merged worktree', async () => {
  const calls: string[] = [];
  const statuses: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: localWorktreeGitWorkspace(calls, [localWorktree()], {
      async listRemoteBranches() { return { ok: false, err: 'fatal: could not read from remote' }; },
    }),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    now: () => NOW_MS,
    log: { warn: () => {} },
    onTickComplete: (status) => statuses.push(status),
  });
  await poller.tick();
  const [project] = statuses[0]?.projects as Record<string, unknown>[];
  assert.deepEqual(calls.filter((call) => call.startsWith('remove:')), ['remove:/agent:worktree-agent-local']);
  assert.deepEqual(project.worktreeRemovals, [{ cwd: '/agent', branch: 'worktree-agent-local', reason: 'merged' }]);
  assert.equal(project.errors, 1);
});

test('local worktree dry run traces would-remove without removal', async () => {
  const calls: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: localWorktreeGitWorkspace(calls, [localWorktree()]),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    dryRun: true,
    now: () => NOW_MS,
    decisionTrace: (entry) => traces.push(entry),
  });
  await poller.tick();
  assert.equal(calls.some((call) => call.startsWith('remove:')), false);
  assert.ok(traces.some((entry) => entry.cwd === '/agent' && entry.decision === 'would-remove'));
});

test('a local worktree status probe failure stays kept and counts an error', async () => {
  const calls: string[] = [];
  const statuses: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: localWorktreeGitWorkspace(calls, [localWorktree({ dirty: null })]),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    now: () => NOW_MS,
    onTickComplete: (status) => statuses.push(status),
  });
  await poller.tick();
  const [project] = statuses[0]?.projects as Record<string, unknown>[];
  assert.equal(project.errors, 1);
  assert.deepEqual(project.worktreesKept, [{ cwd: '/agent', branch: 'worktree-agent-local', reason: 'status-probe-failed' }]);
});

test('a live session worktree path is kept rather than removed', async () => {
  const calls: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: localWorktreeGitWorkspace(calls, [localWorktree()]),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(['/agent']),
    now: () => NOW_MS,
    decisionTrace: (entry) => traces.push(entry),
  });
  await poller.tick();
  assert.equal(calls.some((call) => call.startsWith('remove:')), false);
  assert.ok(traces.some((entry) => entry.cwd === '/agent' && entry.decision === 'kept' && entry.reason === 'live-session'));
});

test('a refused worktree removal counts an error and is never reported as removed', async () => {
  const calls: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const statuses: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: localWorktreeGitWorkspace(calls, [localWorktree()], {
      async removeWorktreeByPath({ cwd, branch }) {
        calls.push(`remove:${cwd}:${branch}`);
        return { ok: false, err: 'fatal: worktree is dirty' };
      },
    }),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    now: () => NOW_MS,
    log: { warn: () => {} },
    decisionTrace: (entry) => traces.push(entry),
    onTickComplete: (status) => statuses.push(status),
  });
  await poller.tick();
  const [project] = statuses[0]?.projects as Record<string, unknown>[];
  assert.deepEqual(project.worktreeRemovals, []);
  assert.equal(project.errors, 1);
  assert.equal(traces.some((entry) => entry.decision === 'removed'), false);
  assert.ok(traces.some((entry) => entry.reason === 'remove-worktree-error'));
});

test('a worktree that turned dirty after planning is kept instead of removed', async () => {
  const calls: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const statuses: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: localWorktreeGitWorkspace(calls, [localWorktree()], {
      async probeWorktreeDirty() { return { ok: true, dirty: true }; },
    }),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    now: () => NOW_MS,
    decisionTrace: (entry) => traces.push(entry),
    onTickComplete: (status) => statuses.push(status),
  });
  await poller.tick();
  const [project] = statuses[0]?.projects as Record<string, unknown>[];
  assert.equal(calls.some((call) => call.startsWith('remove:')), false);
  assert.deepEqual(project.worktreesKept, [{ cwd: '/agent', branch: 'worktree-agent-local', reason: 'became-dirty' }]);
  assert.ok(traces.some((entry) => entry.decision === 'kept' && entry.reason === 'became-dirty'));
});

test('a worktree whose head moved after the merge proof is kept instead of force-removed', async () => {
  const calls: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const statuses: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: localWorktreeGitWorkspace(calls, [localWorktree()], {
      async probeWorktreeDirty() { return { ok: true, dirty: false, headSha: 'landed-after-the-proof-sha' }; },
    }),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    now: () => NOW_MS,
    decisionTrace: (entry) => traces.push(entry),
    onTickComplete: (status) => statuses.push(status),
  });
  await poller.tick();
  const [project] = statuses[0]?.projects as Record<string, unknown>[];
  assert.equal(calls.some((call) => call.startsWith('remove:')), false);
  assert.deepEqual(project.worktreesKept, [{ cwd: '/agent', branch: 'worktree-agent-local', reason: 'tip-moved' }]);
  assert.ok(traces.some((entry) => entry.decision === 'kept' && entry.reason === 'tip-moved'));
});

test('a worktree sitting on its integration tip is kept as having no commits', async () => {
  const calls: string[] = [];
  const statuses: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: localWorktreeGitWorkspace(calls, [localWorktree({ tipSha: 'main-sha' })]),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    now: () => NOW_MS,
    onTickComplete: (status) => statuses.push(status),
  });
  await poller.tick();
  const [project] = statuses[0]?.projects as Record<string, unknown>[];
  assert.equal(calls.some((call) => call.startsWith('remove:')), false);
  assert.deepEqual(project.worktreesKept, [{ cwd: '/agent', branch: 'worktree-agent-local', reason: 'no-commits' }]);
  assert.equal(project.errors, 0);
});

test('a prunable worktree is reported as missing-directory without an error', async () => {
  const calls: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const statuses: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: localWorktreeGitWorkspace(calls, [localWorktree({ prunable: true, dirty: null, integrationBranch: null })]),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    now: () => NOW_MS,
    decisionTrace: (entry) => traces.push(entry),
    onTickComplete: (status) => statuses.push(status),
  });
  await poller.tick();
  const [project] = statuses[0]?.projects as Record<string, unknown>[];
  assert.equal(project.errors, 0);
  assert.deepEqual(project.worktreesKept, [{ cwd: '/agent', branch: 'worktree-agent-local', reason: 'missing-directory' }]);
  assert.ok(traces.some((entry) => entry.decision === 'kept' && entry.reason === 'missing-directory'));
});

function initRepoWithOrigin(): { repo: string; origin: string } {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-branch-gc-origin-'));
  try { git(['init', '--bare', '-b', 'main'], origin); } catch { git(['init', '--bare'], origin); }
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-branch-gc-repo-'));
  try { git(['init', '-b', 'main'], repo); } catch { git(['init'], repo); }
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Glissa Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n', 'utf8');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  git(['remote', 'add', 'origin', origin], repo);
  git(['push', '-u', 'origin', 'main'], repo);
  return { repo, origin };
}

test('a dry run tick leaves the admin entry of a hand-deleted worktree on disk', { skip: !hasGit() }, async () => {
  const { repo, origin } = initRepoWithOrigin();
  const vanishedWorktree = path.join(repo, '.claude', 'worktrees', 'agent-gone');
  const adminDir = path.join(repo, '.git', 'worktrees');
  try {
    fs.mkdirSync(path.dirname(vanishedWorktree), { recursive: true });
    git(['worktree', 'add', '-b', 'worktree-agent-gone', vanishedWorktree], repo);
    const adminEntriesBefore = fs.readdirSync(adminDir);
    fs.rmSync(vanishedWorktree, { recursive: true, force: true });
    const statuses: Record<string, unknown>[] = [];
    const poller = createBranchGcPoller({
      gitWorkspace: createGitWorkspace(),
      getConfig: () => ({ integrationBranch: 'main', projects: [{ path: repo }] }),
      liveSessionIds: () => new Set(),
      liveWorktreePaths: () => new Set(),
      dryRun: true,
      prefixes: ['worktree-agent-'],
      now: () => NOW_MS,
      log: { warn: () => {} },
      onTickComplete: (status) => statuses.push(status),
    });

    await poller.tick();

    const [project] = statuses[0]?.projects as Record<string, unknown>[];
    const worktreesKept = project?.worktreesKept as { branch: string; reason: string }[];
    assert.deepEqual(worktreesKept.map(({ branch, reason }) => ({ branch, reason })), [
      { branch: 'worktree-agent-gone', reason: 'missing-directory' },
    ]);
    assert.deepEqual(fs.readdirSync(adminDir), adminEntriesBefore);
    assert.equal(git(['worktree', 'list', '--porcelain'], repo).includes('worktree-agent-gone'), true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(origin, { recursive: true, force: true });
  }
});

test('an undecidable worktree merge proof is kept as merge-proof-failed', async () => {
  const calls: string[] = [];
  const statuses: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: localWorktreeGitWorkspace(calls, [localWorktree()], {
      async isAncestor() { return { ok: false, err: 'bad object' }; },
      async treeOid() { return { ok: false, err: 'missing tree' }; },
    }),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    now: () => NOW_MS,
    log: { warn: () => {} },
    onTickComplete: (status) => statuses.push(status),
  });
  await poller.tick();
  const [project] = statuses[0]?.projects as Record<string, unknown>[];
  assert.equal(calls.some((call) => call.startsWith('remove:')), false);
  assert.deepEqual(project.worktreesKept, [{ cwd: '/agent', branch: 'worktree-agent-local', reason: 'merge-proof-failed' }]);
});

test('the worktree pass reuses the integration tips and tree oids already resolved this tick', async () => {
  const calls: string[] = [];
  const integrationBranchesAsked: (string | null)[] = [];
  const treeShas: string[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: localWorktreeGitWorkspace(
      calls,
      [localWorktree({ cwd: '/agent-one', branch: 'worktree-agent-one' }), localWorktree({ cwd: '/agent-two', branch: 'worktree-agent-two' })],
      {
        async listRemoteBranches() { return { ok: true, branches: [] }; },
        async isAncestor() { return { ok: true, isAncestor: false }; },
        async listIntegrationTips({ integrationBranch }) {
          integrationBranchesAsked.push(integrationBranch);
          return { ok: true, integrationTips: [{ branch: 'main', sha: 'main-sha' }] };
        },
        async treeOid({ sha }) {
          treeShas.push(sha);
          return { ok: true, out: IDENTICAL_TREE_OID };
        },
      },
    ),
    getConfig: () => ({ integrationBranch: 'main', projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    now: () => NOW_MS,
  });
  await poller.tick();
  assert.deepEqual(integrationBranchesAsked, ['main']);
  assert.deepEqual(treeShas, ['main-sha']);
});

async function deletionsAfterTick({ branchIds, configuredProjectIds, injectedLiveSessionIds }: {
  branchIds: string[];
  configuredProjectIds: string[];
  injectedLiveSessionIds: string[];
}): Promise<string[]> {
  const deletedBranches: string[] = [];
  const gitWorkspace = branchGcGitWorkspace({
    async listRemoteBranches() {
      return {
        ok: true,
        branches: branchIds.map((branchId) => ({
          name: `glissa/session/${branchId}`,
          tipSha: `${branchId}-sha`,
          tipCommitTimeMs: NOW_MS - DAY_MS,
        })),
      };
    },
    async listIntegrationTips() {
      return { ok: true, integrationTips: [{ branch: 'develop', sha: 'develop-sha' }] };
    },
    async isAncestor() {
      return { ok: true, isAncestor: true };
    },
    async deleteRemoteBranch({ name }) {
      deletedBranches.push(name);
      return { ok: true };
    },
  });
  const poller = createBranchGcPoller({
    gitWorkspace,
    getConfig: () => ({
      integrationBranch: 'develop',
      projects: configuredProjectIds.map((projectId) => ({ id: projectId, path: '/repo' })),
    }),
    liveSessionIds: () => new Set(injectedLiveSessionIds),
    liveWorktreePaths: () => new Set(),
    now: () => NOW_MS,
  });

  await poller.tick();

  return deletedBranches;
}

test('keeps a merged branch whose id is only a configured project id', async () => {
  const deletedBranches = await deletionsAfterTick({
    branchIds: ['project-uuid'],
    configuredProjectIds: ['project-uuid'],
    injectedLiveSessionIds: [],
  });

  assert.deepEqual(deletedBranches, []);
});

test('keeps a merged branch whose id is only in the injected live session ids', async () => {
  const deletedBranches = await deletionsAfterTick({
    branchIds: ['injected-session'],
    configuredProjectIds: ['project-uuid'],
    injectedLiveSessionIds: ['injected-session'],
  });

  assert.deepEqual(deletedBranches, []);
});

test('deletes a merged branch whose id is neither configured nor injected', async () => {
  const deletedBranches = await deletionsAfterTick({
    branchIds: ['abandoned-session'],
    configuredProjectIds: ['project-uuid'],
    injectedLiveSessionIds: ['injected-session'],
  });

  assert.deepEqual(deletedBranches, ['glissa/session/abandoned-session']);
});

function branchProofGitWorkspace({ mergeTreeResult, treeResult, tipCommitTimeMs = NOW_MS - DAY_MS, probeEnvResult = { ok: true, probeEnv: {} } }: {
  mergeTreeResult: { ok: boolean; out?: string; err?: string; outcome: MergeTreeOutcome };
  treeResult: { ok: boolean; out?: string; err?: string };
  tipCommitTimeMs?: number;
  probeEnvResult?: MergeProbeEnvResult;
}): BranchGcGitWorkspace {
  return branchGcGitWorkspace({
    async listRemoteBranches() {
      return {
        ok: true,
        branches: [{ name: 'glissa/session/abandoned', tipSha: 'branch-sha', tipCommitTimeMs }],
      };
    },
    async resolveMergeProbeEnv() {
      return probeEnvResult;
    },
    async writeMergedTree() {
      return mergeTreeResult;
    },
    async treeOid() {
      return treeResult;
    },
  });
}

test('tree containment deletes a rebased branch with its proof reason in the trace', async () => {
  const traces: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: branchProofGitWorkspace({
      mergeTreeResult: { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', outcome: 'tree' },
      treeResult: { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    }),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    decisionTrace: (entry) => traces.push(entry),
    now: () => NOW_MS,
  });

  await poller.tick();

  assert.ok(traces.some((entry) => entry.decision === 'deleted' && entry.reason === 'tree-contained'));
});

test('a merge-tree conflict keeps the branch without an error', async () => {
  const statuses: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: branchProofGitWorkspace({
      mergeTreeResult: { ok: false, err: 'CONFLICT (content)', outcome: 'conflicts' },
      treeResult: { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    }),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    onTickComplete: (status) => statuses.push(status),
    now: () => NOW_MS,
  });

  await poller.tick();

  assert.deepEqual(deletionsOfFirstProject(statuses[0]), []);
  assert.equal((statuses[0]?.projects as { errors: number }[])[0]?.errors, 0);
});

test('a merge-tree operational failure keeps the branch and increments errors', async () => {
  const statuses: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: branchProofGitWorkspace({
      mergeTreeResult: { ok: false, err: 'timed out', outcome: 'failed' },
      treeResult: { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      tipCommitTimeMs: NOW_MS - 20 * DAY_MS,
    }),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    log: { warn: () => {} },
    onTickComplete: (status) => statuses.push(status),
    now: () => NOW_MS,
  });

  await poller.tick();

  assert.deepEqual(deletionsOfFirstProject(statuses[0]), []);
  assert.equal((statuses[0]?.projects as { errors: number }[])[0]?.errors, 1);
});

test('a stale unmerged branch is deleted with a staleness reason rather than a merge reason', async () => {
  const traces: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: branchProofGitWorkspace({
      mergeTreeResult: { ok: false, err: 'CONFLICT (content)', outcome: 'conflicts' },
      treeResult: { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      tipCommitTimeMs: NOW_MS - 20 * DAY_MS,
    }),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    decisionTrace: (entry) => traces.push(entry),
    now: () => NOW_MS,
  });

  await poller.tick();

  assert.deepEqual(
    traces.filter((entry) => entry.decision === 'deleted'),
    [{ kind: 'branch-gc', ts: NOW_MS, projectPath: '/repo', name: 'glissa/session/abandoned', decision: 'deleted', reason: 'stale-orphan' }],
  );
});

test('each integration tip tree and the merge probe env are resolved once per tick rather than once per branch', async () => {
  const treeShas: string[] = [];
  const probeEnvProjectPaths: string[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: branchGcGitWorkspace({
      async listRemoteBranches() {
        return {
          ok: true,
          branches: [
            { name: 'glissa/session/one', tipSha: 'one-sha', tipCommitTimeMs: NOW_MS - DAY_MS },
            { name: 'glissa/session/two', tipSha: 'two-sha', tipCommitTimeMs: NOW_MS - DAY_MS },
            { name: 'glissa/session/three', tipSha: 'three-sha', tipCommitTimeMs: NOW_MS - DAY_MS },
          ],
        };
      },
      async listIntegrationTips() {
        return {
          ok: true,
          integrationTips: [
            { branch: 'develop', sha: 'develop-sha' },
            { branch: 'main', sha: 'main-sha' },
            { branch: 'master', sha: null },
          ],
        };
      },
      async resolveMergeProbeEnv({ projectPath }) {
        probeEnvProjectPaths.push(projectPath);
        return { ok: true, probeEnv: {} };
      },
      async writeMergedTree() {
        return { ok: true, out: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', outcome: 'tree' };
      },
      async treeOid({ sha }) {
        treeShas.push(sha);
        return { ok: true, out: IDENTICAL_TREE_OID };
      },
    }),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    now: () => NOW_MS,
  });

  await poller.tick();

  assert.deepEqual(treeShas, ['develop-sha', 'main-sha']);
  assert.deepEqual(probeEnvProjectPaths, ['/repo']);
});

test('a failed ancestry probe leaves the branch undecidable rather than reading it as unmerged', async () => {
  const statuses: Record<string, unknown>[] = [];
  const traces: Record<string, unknown>[] = [];
  const deletedBranches: string[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: {
      ...branchProofGitWorkspace({
        mergeTreeResult: { ok: true, out: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', outcome: 'tree' },
        treeResult: { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        tipCommitTimeMs: NOW_MS - 20 * DAY_MS,
      }),
      async isAncestor() {
        return { ok: false, err: 'bad object' };
      },
      async deleteRemoteBranch({ name }) {
        deletedBranches.push(name);
        return { ok: true };
      },
    },
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    log: { warn: () => {} },
    decisionTrace: (entry) => traces.push(entry),
    onTickComplete: (status) => statuses.push(status),
    now: () => NOW_MS,
  });

  await poller.tick();

  assert.deepEqual(deletedBranches, []);
  assert.deepEqual(deletionsOfFirstProject(statuses[0]), []);
  assert.equal((statuses[0]?.projects as { errors: number }[])[0]?.errors, 1);
  assert.ok(traces.some((entry) => entry.name === 'glissa/session/abandoned' && entry.reason === 'ancestor-check-error'));
});

test('a tree probe failure keeps the branch, names it in the trace, and increments errors', async () => {
  const statuses: Record<string, unknown>[] = [];
  const traces: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: branchProofGitWorkspace({
      mergeTreeResult: { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', outcome: 'tree' },
      treeResult: { ok: false, err: 'missing tree' },
    }),
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    log: { warn: () => {} },
    decisionTrace: (entry) => traces.push(entry),
    onTickComplete: (status) => statuses.push(status),
    now: () => NOW_MS,
  });

  await poller.tick();

  assert.deepEqual(deletionsOfFirstProject(statuses[0]), []);
  assert.equal((statuses[0]?.projects as { errors: number }[])[0]?.errors, 1);
  assert.ok(traces.some((entry) => entry.name === 'glissa/session/abandoned' && entry.reason === 'tree-check-error'));
});

test('a merge probe env that never resolves keeps the branch and increments errors', async () => {
  const statuses: Record<string, unknown>[] = [];
  const traces: Record<string, unknown>[] = [];
  const mergedTreeCalls: string[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: {
      ...branchProofGitWorkspace({
        mergeTreeResult: { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', outcome: 'tree' },
        treeResult: { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        probeEnvResult: { ok: false, err: 'fatal: bad config line' },
      }),
      async writeMergedTree({ branchSha }) {
        mergedTreeCalls.push(branchSha);
        return { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', outcome: 'tree' };
      },
    },
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    log: { warn: () => {} },
    decisionTrace: (entry) => traces.push(entry),
    onTickComplete: (status) => statuses.push(status),
    now: () => NOW_MS,
  });

  await poller.tick();

  assert.deepEqual(mergedTreeCalls, []);
  assert.deepEqual(deletionsOfFirstProject(statuses[0]), []);
  assert.equal((statuses[0]?.projects as { errors: number }[])[0]?.errors, 1);
  assert.ok(traces.some((entry) => entry.name === 'glissa/session/abandoned' && entry.reason === 'merge-probe-env-error'));
});

test('git helpers normalize remote refs, retain unresolved protected names, and delete one ref', async () => {
  const calls: { args: string[]; cwd: string; extra?: { maxBuffer?: number } }[] = [];
  const gitWorkspace = createGitWorkspace({
    git: async (args, cwd, extra) => {
      calls.push({ args, cwd, extra });
      if (args[0] === 'for-each-ref' && args[1] === 'refs/remotes/origin/') {
        return [
          'refs/remotes/origin/HEAD main-sha 1700000000 refs/remotes/origin/main',
          'refs/remotes/origin/glissa/session/abc abc-sha 1700000000 ',
          'refs/remotes/origin/worktree-agent-123 agent-sha 1700000100 ',
          'refs/remotes/origin/release/x release-sha 1700000200 ',
        ].join('\n');
      }
      if (args[0] === 'for-each-ref') {
        return [
          'refs/remotes/origin/develop develop-sha',
          'refs/heads/main main-sha',
        ].join('\n');
      }
      if (args[0] === 'merge-base') {
        const error: Error & { code?: number } = new Error('not an ancestor');
        error.code = 1;
        throw error;
      }
      return '';
    },
  });

  const branches = await gitWorkspace.listRemoteBranches({ projectPath: '/repo', prefixes: ['glissa/session/', 'worktree-agent-'] });
  const tips = await gitWorkspace.listIntegrationTips({ projectPath: '/repo', integrationBranch: 'develop' });
  const ancestor = await gitWorkspace.isAncestor({
    projectPath: '/repo',
    ancestorSha: 'abc-sha',
    descendantSha: 'develop-sha',
  });
  await gitWorkspace.fetchOrigin({ projectPath: '/repo' });
  await gitWorkspace.deleteRemoteBranch({ projectPath: '/repo', name: 'glissa/session/abc', tipSha: 'abc-sha' });

  assert.deepEqual(branches, {
    ok: true,
    branches: [
      { name: 'glissa/session/abc', tipSha: 'abc-sha', tipCommitTimeMs: 1700000000000 },
      { name: 'worktree-agent-123', tipSha: 'agent-sha', tipCommitTimeMs: 1700000100000 },
    ],
  });
  assert.deepEqual(tips, {
    ok: true,
    integrationTips: [
      { branch: 'develop', sha: 'develop-sha' },
      { branch: 'main', sha: 'main-sha' },
      { branch: 'master', sha: null },
    ],
  });
  assert.deepEqual(ancestor, { ok: true, isAncestor: false });
  assert.ok(calls.some(({ args }) => args.join(' ') === 'fetch --prune origin'));
  assert.ok(calls.some(({ args }) => args.join(' ') === 'for-each-ref refs/remotes/origin/ --format=%(refname) %(objectname) %(committerdate:unix) %(symref)'));
  assert.equal(calls.find(({ args }) => args[0] === 'for-each-ref' && args[1] === 'refs/remotes/origin/')?.extra?.maxBuffer, 64 * 1024 * 1024);
  assert.ok(calls.some(({ args }) => args.join(' ') === 'push origin --force-with-lease=refs/heads/glissa/session/abc:abc-sha :refs/heads/glissa/session/abc'));
});

test('an empty prefix list lists no branches and never runs git', async () => {
  const calls: string[][] = [];
  const gitWorkspace = createGitWorkspace({
    git: async (args) => {
      calls.push(args);
      return '';
    },
  });

  assert.deepEqual(await gitWorkspace.listRemoteBranches({ projectPath: '/repo', prefixes: [] }), { ok: true, branches: [] });
  assert.deepEqual(await gitWorkspace.listRemoteBranches({ projectPath: '/repo', prefixes: [''] }), { ok: true, branches: [] });
  assert.deepEqual(calls, []);
});

test('integration tips include the detected default when branch config is auto', async () => {
  const gitWorkspace = createGitWorkspace({
    git: async (args) => {
      if (args[0] === 'symbolic-ref') return 'origin/trunk';
      if (args[0] === 'for-each-ref') return 'refs/remotes/origin/trunk trunk-sha';
      return '';
    },
  });
  assert.deepEqual(await gitWorkspace.listIntegrationTips({ projectPath: '/repo', integrationBranch: null }), {
    ok: true,
    integrationTips: [
      { branch: 'trunk', sha: 'trunk-sha' },
      { branch: 'main', sha: null },
      { branch: 'master', sha: null },
    ],
  });
});

test('default config constructs and starts the lane poller', async () => {
  let createCount = 0;
  const wiring = createBranchGcWiring({
    config: { projects: [] },
    gitWorkspace: unreachableGitWorkspace(),
    liveSessionIds: () => new Set<string>(),
    liveWorktreePaths: () => new Set(),
    createPoller: () => {
      createCount += 1;
      return { start: async () => {}, stop: async () => {}, tick: async () => {} };
    },
  });

  wiring.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(createCount, 1);
  assert.equal(wiring.getStatus().configured, true);
  await wiring.stop();
});

test('disabled config never constructs or starts the lane poller', async () => {
  let createCount = 0;
  const wiring = createBranchGcWiring({
    config: { branchGc: { enabled: false }, projects: [] },
    gitWorkspace: unreachableGitWorkspace(),
    liveSessionIds: () => new Set<string>(),
    liveWorktreePaths: () => new Set(),
    createPoller: () => {
      createCount += 1;
      return { start: async () => {}, stop: async () => {}, tick: async () => {} };
    },
  });

  wiring.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(createCount, 0);
  assert.equal(wiring.getStatus().configured, false);
  await wiring.stop();
});
