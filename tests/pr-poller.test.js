'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPrPoller } = require('../server/pr-poller');

const flush = async (n = 20) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

function ownPr(over = {}) {
  return {
    number: 7,
    headRefOid: 'sha1',
    headRefName: 'feature',
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    title: 't',
    isDraft: false,
    isCrossRepository: false,
    headOwner: 'me',
    author: { login: 'me', isBot: false },
    ...over,
  };
}

function makeGh(over = {}) {
  return {
    authOk: async () => true,
    repoSlug: async () => 'me/repo',
    listPrs: async () => [],
    viewHead: async () => 'sha1',
    touchesWorkflows: async () => false,
    checksStatus: async () => 'pending',
    merge: async () => ({ ok: true, err: '' }),
    deleteBranch: async () => ({ ok: true }),
    ...over,
  };
}

function makeWorkspace(over = {}) {
  return {
    listWorktreeBranches: async () => [],
    create: async () => ({ isGit: true, cwd: '/wt', branch: 'glissa/pr-review/pr-7', base: 'main' }),
    discard: async () => {},
    removeWorktreeByPath: async () => {},
    ...over,
  };
}

// Build poller deps with in-memory state + captured pings. `over.initialState` seeds the state store
// BEFORE construction (readState reads the store lazily, so seeding after would be ignored).
function harness(over = {}) {
  const pings = [];
  const stateStore = { value: over.initialState ? JSON.parse(JSON.stringify(over.initialState)) : {} };
  const noFireTimer = { unref() {} };
  const deps = {
    projects: ['p1'],
    getProjectPathById: () => '/repo',
    makePrGh: () => makeGh(over.gh),
    gitWorkspace: makeWorkspace(over.workspace),
    getWorktreeBase: () => '/wtbase',
    spawnReview: over.spawnReview || (async () => ({ verdict: 'CLEAN' })),
    telegram: (msg) => pings.push(msg),
    readState: async () => stateStore.value,
    writeState: async (s) => { stateStore.value = JSON.parse(JSON.stringify(s)); },
    setIntervalFn: over.setIntervalFn || (() => noFireTimer),
    clearIntervalFn: over.clearIntervalFn || (() => {}),
    setTimeoutFn: over.setTimeoutFn || (() => noFireTimer),
    clearTimeoutFn: () => {},
    sleep: async () => {},
    log: { warn() {} },
    maxConcurrentReviews: over.maxConcurrentReviews || 3,
    intervalMinutes: 15,
    mergeMethod: 'rebase',
  };
  return { deps, pings, stateStore, poller: createPrPoller(deps) };
}

test('start() runs an immediate tick, arms an unref-d interval, stop() clears it', async () => {
  let intervalCb = null;
  let cleared = false;
  const spawnCalls = [];
  const { poller, pings } = harness({
    gh: { listPrs: async () => [ownPr()] },
    spawnReview: async (a) => { spawnCalls.push(a); return { verdict: 'CLEAN' }; },
    setIntervalFn: (cb) => { intervalCb = cb; return { unref() {} }; },
    clearIntervalFn: () => { cleared = true; },
  });
  await poller.start();
  await flush();

  assert.equal(spawnCalls.length, 1, 'reviewed the one new PR');
  assert.equal(spawnCalls[0].pr.number, 7);
  assert.equal(poller._state()['me/repo#7'].phase, 'awaiting-checks');
  assert.equal(poller._state()['me/repo#7'].inFlight, false);
  assert.deepEqual(pings, [], 'a clean review is silent');
  assert.equal(typeof intervalCb, 'function', 'interval armed');

  poller.stop();
  assert.ok(cleared, 'stop cleared the interval');
});

test('stop() drains in-flight reviews before resolving; no new review spawns after stop', async () => {
  let resolveReview;
  let spawnCount = 0;
  const { poller } = harness({
    gh: { listPrs: async () => [ownPr()] },
    spawnReview: () => {
      spawnCount += 1;
      return new Promise((resolve) => { resolveReview = resolve; });
    },
  });
  await poller.start();
  await flush();
  assert.equal(spawnCount, 1, 'review in flight');
  assert.equal(poller._state()['me/repo#7'].inFlight, true);

  let stopSettled = false;
  const stopPromise = poller.stop().then(() => { stopSettled = true; });

  await flush();
  assert.equal(stopSettled, false, 'stop() waits for the in-flight review to settle, does not resolve early');

  resolveReview({ verdict: 'CLEAN' });
  await stopPromise;
  assert.equal(stopSettled, true, 'stop() resolves once the drained review settles');
  assert.equal(poller._state()['me/repo#7'].inFlight, false, 'the drained review finished normally');

  await poller.tick();
  await flush();
  assert.equal(spawnCount, 1, 'no new review spawns after stop (existing stopped guard)');
});

test('a PR is reviewed once per head SHA (dedupe)', async () => {
  const spawnCalls = [];
  const { poller } = harness({
    gh: { listPrs: async () => [ownPr()] },
    spawnReview: async (a) => { spawnCalls.push(a); return { verdict: 'CLEAN' }; },
  });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();
  assert.equal(spawnCalls.length, 1, 'unchanged head is not re-reviewed');
});

test('CHANGES verdict -> done + a changes ping', async () => {
  const { poller, pings } = harness({
    gh: { listPrs: async () => [ownPr()] },
    spawnReview: async () => ({ verdict: 'CHANGES', summary: 'fix the thing' }),
  });
  await poller.start();
  await flush();
  assert.equal(poller._state()['me/repo#7'].phase, 'done');
  assert.equal(pings.length, 1);
  assert.match(pings[0], /changes requested on me\/repo#7/);
});

test('a hung review session is force-resolved to ERROR by the timeout and frees its slot', async () => {
  let spawnCount = 0;
  const { poller, pings } = harness({
    gh: { listPrs: async () => [ownPr()] },
    spawnReview: () => { spawnCount += 1; return new Promise(() => {}); },
    setTimeoutFn: (cb) => { cb(); return { unref() {} }; },
    maxConcurrentReviews: 1,
  });
  await poller.start();
  await flush();
  assert.equal(spawnCount, 1);
  assert.equal(poller._state()['me/repo#7'].phase, 'error');
  assert.equal(poller._state()['me/repo#7'].inFlight, false, 'slot freed');
  assert.equal(pings.length, 1);
  assert.match(pings[0], /error on me\/repo#7/);
});

test('conflict lane: branch checked out locally -> ERROR, no worktree, no spawn', async () => {
  let created = 0;
  let spawned = 0;
  const { poller, pings } = harness({
    gh: { listPrs: async () => [ownPr({ mergeable: 'CONFLICTING' })] },
    workspace: {
      listWorktreeBranches: async () => [{ cwd: '/main', branch: 'feature' }],
      create: async () => { created += 1; return { isGit: true, cwd: '/wt' }; },
    },
    spawnReview: async () => { spawned += 1; return { verdict: 'RESOLVED' }; },
  });
  await poller.start();
  await flush();
  assert.equal(created, 0, 'never created a worktree');
  assert.equal(spawned, 0, 'never spawned a doomed session');
  assert.equal(poller._state()['me/repo#7'].phase, 'error');
  assert.match(pings[0], /error on me\/repo#7/);
});

test('conflict lane: resolved in worktree -> discard + leaked branch delete + resolved ping', async () => {
  let discarded = 0;
  const deletedBranches = [];
  const { poller, pings } = harness({
    gh: {
      listPrs: async () => [ownPr({ mergeable: 'CONFLICTING' })],
      viewHead: async () => 'sha2',
      deleteBranch: async (ref) => { deletedBranches.push(ref); return { ok: true }; },
    },
    workspace: {
      listWorktreeBranches: async () => [],
      discard: async () => { discarded += 1; },
    },
    spawnReview: async (a) => {
      assert.equal(a.cwd, '/wt', 'ran in the worktree');
      assert.equal(a.conflicting, true);
      return { verdict: 'RESOLVED' };
    },
  });
  await poller.start();
  await flush();
  const entry = poller._state()['me/repo#7'];
  assert.equal(entry.phase, 'awaiting-checks');
  assert.equal(entry.reviewedHead, 'sha2', 'recorded the re-queried post-push head');
  assert.equal(discarded, 1, 'worktree discarded');
  assert.deepEqual(deletedBranches, ['feature'], 'leaked pr-head branch deleted');
  assert.match(pings[0], /conflicts resolved on me\/repo#7/);
});

test('conflict lane: non-git project -> ERROR, no spawn', async () => {
  let spawned = 0;
  const { poller } = harness({
    gh: { listPrs: async () => [ownPr({ mergeable: 'CONFLICTING' })] },
    workspace: { create: async () => ({ isGit: false, reason: 'no-base-branch' }) },
    spawnReview: async () => { spawned += 1; return { verdict: 'RESOLVED' }; },
  });
  await poller.start();
  await flush();
  assert.equal(spawned, 0);
  assert.equal(poller._state()['me/repo#7'].phase, 'error');
});

const AWAITING = { 'me/repo#7': { phase: 'awaiting-checks', reviewedHead: 'sha1' } };

test('merge-on-green: green + no workflow files -> rebase merge + merged ping', async () => {
  let merged = null;
  const { poller, pings } = harness({
    initialState: AWAITING,
    gh: {
      listPrs: async () => [ownPr()],
      checksStatus: async () => 'green',
      touchesWorkflows: async () => false,
      merge: async (n, m) => { merged = { n, m }; return { ok: true }; },
    },
  });
  await poller.start();
  await flush();
  assert.deepEqual(merged, { n: 7, m: 'rebase' });
  assert.equal(poller._state()['me/repo#7'].phase, 'merged');
  assert.match(pings[0], /merged me\/repo#7/);
});

test('merge gate: none (no checks) is non-mergeable -> error ping once, never merges', async () => {
  let mergeCalls = 0;
  const { poller, pings } = harness({
    initialState: AWAITING,
    gh: { listPrs: async () => [ownPr()], checksStatus: async () => 'none', merge: async () => { mergeCalls += 1; return { ok: true }; } },
  });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();
  assert.equal(mergeCalls, 0, 'never merged a no-checks PR');
  assert.equal(pings.length, 1, 'error pinged once, not per tick');
  assert.match(pings[0], /no CI checks/);
});

test('merge gate: failing checks -> no merge, error ping once', async () => {
  let mergeCalls = 0;
  const { poller, pings } = harness({
    initialState: AWAITING,
    gh: { listPrs: async () => [ownPr()], checksStatus: async () => 'failing', merge: async () => { mergeCalls += 1; return { ok: true }; } },
  });
  await poller.start();
  await flush();
  assert.equal(mergeCalls, 0);
  assert.equal(pings.length, 1);
});

test('merge gate: pending -> no merge, no ping, stays awaiting-checks', async () => {
  let mergeCalls = 0;
  const { poller, pings } = harness({
    initialState: AWAITING,
    gh: { listPrs: async () => [ownPr()], checksStatus: async () => 'pending', merge: async () => { mergeCalls += 1; return { ok: true }; } },
  });
  await poller.start();
  await flush();
  assert.equal(mergeCalls, 0);
  assert.equal(pings.length, 0);
  assert.equal(poller._state()['me/repo#7'].phase, 'awaiting-checks');
});

test('merge gate: green but touches workflow files -> no merge, downgrade to done + one error ping', async () => {
  let mergeCalls = 0;
  const { poller, pings } = harness({
    initialState: AWAITING,
    gh: { listPrs: async () => [ownPr()], checksStatus: async () => 'green', touchesWorkflows: async () => true, merge: async () => { mergeCalls += 1; return { ok: true }; } },
  });
  await poller.start();
  await flush();
  assert.equal(mergeCalls, 0);
  assert.equal(poller._state()['me/repo#7'].phase, 'done');
  assert.match(pings[0], /workflow/);
});

test('merge gate: a head advanced past the reviewed head is NOT merged (re-reviewed instead)', async () => {
  let mergeCalls = 0;
  let spawned = 0;
  const { poller } = harness({
    initialState: AWAITING, // reviewedHead 'sha1'
    gh: {
      listPrs: async () => [ownPr({ headRefOid: 'sha2' })], // a new commit landed after review
      checksStatus: async () => 'green',
      touchesWorkflows: async () => false,
      merge: async () => { mergeCalls += 1; return { ok: true }; },
    },
    spawnReview: async () => { spawned += 1; return { verdict: 'CLEAN' }; },
  });
  await poller.start();
  await flush();
  assert.equal(mergeCalls, 0, 'never merges an unreviewed head');
  assert.equal(spawned, 1, 're-reviews the new head instead');
});

test('merge gate: an unknown workflow-files result (gh error) fails closed - no merge, no downgrade', async () => {
  let mergeCalls = 0;
  const { poller, pings } = harness({
    initialState: AWAITING,
    gh: {
      listPrs: async () => [ownPr()],
      checksStatus: async () => 'green',
      touchesWorkflows: async () => null, // gh files query failed
      merge: async () => { mergeCalls += 1; return { ok: true }; },
    },
  });
  await poller.start();
  await flush();
  assert.equal(mergeCalls, 0, 'never merges when the workflow-file check is unknown');
  assert.equal(poller._state()['me/repo#7'].phase, 'awaiting-checks', 'not downgraded; retried next tick');
  assert.equal(pings.length, 0);
});

test('a PR that vanished from the open list is pruned with no ping', async () => {
  const { poller, pings } = harness({ initialState: AWAITING, gh: { listPrs: async () => [] } });
  await poller.start();
  await flush();
  assert.equal(poller._state()['me/repo#7'], undefined, 'state entry pruned');
  assert.equal(pings.length, 0);
});

test('maxConcurrentReviews caps in-flight spawns per tick', async () => {
  let spawned = 0;
  const { poller } = harness({
    gh: { listPrs: async () => [ownPr({ number: 1, headRefName: 'a' }), ownPr({ number: 2, headRefName: 'b' })] },
    spawnReview: () => { spawned += 1; return new Promise(() => {}); },
    maxConcurrentReviews: 1,
  });
  await poller.start();
  await flush();
  assert.equal(spawned, 1, 'only one review spawned under the cap');
});

test('re-entrancy guard: an overlapping tick returns early', async () => {
  let listCalls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { poller } = harness({
    gh: { listPrs: async () => { listCalls += 1; await gate; return []; } },
  });
  const first = poller.tick();
  const second = poller.tick();
  await second;
  assert.equal(listCalls, 1, 'second tick short-circuited while the first was running');
  release();
  await first;
});

test('filtered PRs (draft) are neither reviewed nor merged', async () => {
  let spawned = 0;
  const { poller } = harness({
    gh: { listPrs: async () => [ownPr({ isDraft: true })] },
    spawnReview: async () => { spawned += 1; return { verdict: 'CLEAN' }; },
  });
  await poller.start();
  await flush();
  assert.equal(spawned, 0);
});
