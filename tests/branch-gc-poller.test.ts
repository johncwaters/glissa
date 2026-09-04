import test from 'node:test';
import assert from 'node:assert/strict';

import { BRANCH_GC_FETCH_TIMEOUT_MS, createBranchGcPoller } from '../server/branch-gc-poller.ts';
import type { BranchGcGitWorkspace } from '../server/branch-gc-poller.ts';
import { createBranchGcWiring } from '../server/branch-gc-wiring.ts';
import { DAY_MS } from '../server/core/branch-gc-core.ts';
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
  };
}

test('fetches before listing, deletes separately, continues after failure, and protects live sessions', async () => {
  const calls: (string | number | null | undefined)[][] = [];
  const traces: Record<string, unknown>[] = [];
  const mergedShas = new Set(['merged-sha', 'failed-delete-sha', 'live-sha']);
  const gitWorkspace: BranchGcGitWorkspace = {
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
  };
  const statuses: Record<string, unknown>[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace,
    getConfig: () => ({
      integrationBranch: 'develop',
      projects: [{ id: 'project-uuid', path: '/repo' }],
    }),
    liveSessionIds: () => new Set(['live']),
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
    gitWorkspace: {
      async fetchOrigin() { return { ok: true }; },
      async listRemoteBranches() {
        return { ok: true, branches: [{ name: 'glissa/session/merged', tipSha: 'merged-sha', tipCommitTimeMs: NOW_MS - DAY_MS }] };
      },
      async listIntegrationTips() { return { ok: true, integrationTips: [{ branch: 'develop', sha: 'develop-sha' }] }; },
      async isAncestor() { return { ok: true, isAncestor: true }; },
      async resolveMergeProbeEnv() { return { ok: true, probeEnv: {} }; },
      async writeMergedTree() { return { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', outcome: 'tree' as const }; },
      async treeOid() { return { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }; },
      async deleteRemoteBranch({ name }) {
        deletedBranches.push(name);
        return { ok: true };
      },
    },
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
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
  assert.deepEqual(Object.keys(firstProject).sort(), ['deletions', 'errors', 'kept', 'projectPath']);
});

async function deletionsAfterTick({ branchIds, configuredProjectIds, injectedLiveSessionIds }: {
  branchIds: string[];
  configuredProjectIds: string[];
  injectedLiveSessionIds: string[];
}): Promise<string[]> {
  const deletedBranches: string[] = [];
  const gitWorkspace: BranchGcGitWorkspace = {
    async fetchOrigin() {
      return { ok: true };
    },
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
    async resolveMergeProbeEnv() {
      return { ok: true, probeEnv: {} };
    },
    async writeMergedTree() {
      return { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', outcome: 'tree' };
    },
    async treeOid() {
      return { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    },
    async deleteRemoteBranch({ name }) {
      deletedBranches.push(name);
      return { ok: true };
    },
  };
  const poller = createBranchGcPoller({
    gitWorkspace,
    getConfig: () => ({
      integrationBranch: 'develop',
      projects: configuredProjectIds.map((projectId) => ({ id: projectId, path: '/repo' })),
    }),
    liveSessionIds: () => new Set(injectedLiveSessionIds),
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
  return {
    async fetchOrigin() {
      return { ok: true };
    },
    async listRemoteBranches() {
      return {
        ok: true,
        branches: [{ name: 'glissa/session/abandoned', tipSha: 'branch-sha', tipCommitTimeMs }],
      };
    },
    async listIntegrationTips() {
      return { ok: true, integrationTips: [{ branch: 'main', sha: 'main-sha' }] };
    },
    async isAncestor() {
      return { ok: true, isAncestor: false };
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
    async deleteRemoteBranch() {
      return { ok: true };
    },
  };
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
    gitWorkspace: {
      async fetchOrigin() {
        return { ok: true };
      },
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
      async isAncestor() {
        return { ok: true, isAncestor: false };
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
        return { ok: true, out: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
      },
      async deleteRemoteBranch() {
        return { ok: true };
      },
    },
    getConfig: () => ({ projects: [{ path: '/repo' }] }),
    liveSessionIds: () => new Set(),
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
