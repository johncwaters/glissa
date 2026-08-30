'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBranchGcPoller } = require('../server/branch-gc-poller');
const { createBranchGcWiring } = require('../server/branch-gc-wiring');
const { DAY_MS } = require('../server/core/branch-gc-core');
const { createGitWorkspace } = require('../server/git-workspace');

const NOW_MS = Date.parse('2026-08-25T12:00:00Z');

test('fetches before listing, deletes separately, continues after failure, and protects live sessions', async () => {
  const calls = [];
  const traces = [];
  const mergedShas = new Set(['merged-sha', 'failed-delete-sha', 'live-sha']);
  const gitWorkspace = {
    async fetchOrigin({ projectPath }) {
      calls.push(['fetch', projectPath]);
      return { ok: true };
    },
    async listRemoteSessionBranches({ projectPath }) {
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
    async deleteRemoteBranch({ projectPath, name }) {
      calls.push(['delete', projectPath, name]);
      if (name === 'glissa/session/failed-delete') return { ok: false, err: 'rejected' };
      return { ok: true };
    },
  };
  const statuses = [];
  const poller = createBranchGcPoller({
    gitWorkspace,
    getConfig: () => ({
      integrationBranch: 'develop',
      projects: [{ id: 'live', path: '/repo' }],
    }),
    now: () => NOW_MS,
    log: { warn: () => {} },
    decisionTrace: (entry) => traces.push(entry),
    onTickComplete: (status) => statuses.push(status),
  });

  await poller.tick();

  assert.deepEqual(calls.slice(0, 2), [['fetch', '/repo'], ['list', '/repo']]);
  assert.deepEqual(
    calls.filter(([operation]) => operation === 'delete'),
    [
      ['delete', '/repo', 'glissa/session/merged'],
      ['delete', '/repo', 'glissa/session/failed-delete'],
      ['delete', '/repo', 'glissa/session/stale'],
    ],
  );
  assert.equal(calls.some((call) => call[0] === 'delete' && call[2] === 'glissa/session/live'), false);
  assert.ok(traces.some((entry) => entry.name === 'glissa/session/live' && entry.reason === 'live-session'));
  assert.ok(traces.some((entry) => entry.name === 'glissa/session/failed-delete' && entry.reason === 'delete-error'));
  assert.deepEqual(statuses[0].projects[0].deletions, [
    'glissa/session/merged',
    'glissa/session/stale',
  ]);
});

test('git helpers normalize remote refs, retain unresolved protected names, and delete one ref', async () => {
  const calls = [];
  const gitWorkspace = createGitWorkspace({
    git: async (args, cwd) => {
      calls.push([args, cwd]);
      if (args[0] === 'for-each-ref' && args[1] === 'refs/remotes/origin/glissa/session/') {
        return 'origin/glissa/session/abc abc-sha 1700000000\n';
      }
      if (args[0] === 'for-each-ref') {
        return [
          'refs/remotes/origin/develop develop-sha',
          'refs/heads/main main-sha',
        ].join('\n');
      }
      if (args[0] === 'merge-base') {
        const error = new Error('not an ancestor');
        error.code = 1;
        throw error;
      }
      return '';
    },
  });

  const branches = await gitWorkspace.listRemoteSessionBranches({ projectPath: '/repo' });
  const tips = await gitWorkspace.listIntegrationTips({ projectPath: '/repo', integrationBranch: 'develop' });
  const ancestor = await gitWorkspace.isAncestor({
    projectPath: '/repo',
    ancestorSha: 'abc-sha',
    descendantSha: 'develop-sha',
  });
  await gitWorkspace.fetchOrigin({ projectPath: '/repo' });
  await gitWorkspace.deleteRemoteBranch({ projectPath: '/repo', name: 'glissa/session/abc' });

  assert.deepEqual(branches, {
    ok: true,
    branches: [{ name: 'glissa/session/abc', tipSha: 'abc-sha', tipCommitTimeMs: 1700000000000 }],
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
  assert.ok(calls.some(([args]) => args.join(' ') === 'fetch --prune origin'));
  assert.ok(calls.some(([args]) => args.join(' ') === 'push origin --delete glissa/session/abc'));
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
    gitWorkspace: {},
    createPoller: () => {
      createCount += 1;
      return { start: async () => {}, stop: async () => {} };
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
    gitWorkspace: {},
    createPoller: () => {
      createCount += 1;
      return { start: async () => {}, stop: async () => {} };
    },
  });

  wiring.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(createCount, 0);
  assert.equal(wiring.getStatus().configured, false);
  await wiring.stop();
});
