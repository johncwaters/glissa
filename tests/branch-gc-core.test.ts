import test from 'node:test';
import assert from 'node:assert/strict';
import type { RemoteBranchTip } from '../server/core/branch-gc-core.ts';

import { DAY_MS, planBranchGc } from '../server/core/branch-gc-core.ts';

const NOW_MS = Date.parse('2026-08-25T12:00:00Z');

function branch(name: string, overrides: Partial<RemoteBranchTip> = {}) {
  return {
    name,
    tipSha: `${name}-sha`,
    tipCommitTimeMs: NOW_MS - DAY_MS,
    mergedIntoIntegration: false,
    ...overrides,
  };
}

test('deletes merged and stale orphaned session branches while preserving input order', () => {
  const planned = planBranchGc({
    remoteBranches: [
      branch('glissa/session/merged', { mergedIntoIntegration: true }),
      branch('glissa/session/stale', { tipCommitTimeMs: NOW_MS - 15 * DAY_MS }),
    ],
    integrationTips: [{ branch: 'develop', sha: 'develop-sha' }],
    liveSessionIds: new Set(),
    nowMs: NOW_MS,
  });

  assert.deepEqual(planned, {
    deletions: [
      { name: 'glissa/session/merged', reason: 'merged-into-integration', tipSha: 'glissa/session/merged-sha' },
      { name: 'glissa/session/stale', reason: 'stale-orphan', tipSha: 'glissa/session/stale-sha' },
    ],
    kept: [],
  });
});

test('a merged branch is deleted under the merge proof reason that decided it', () => {
  const planned = planBranchGc({
    remoteBranches: [
      branch('glissa/session/rebased', { mergedIntoIntegration: true, mergedReason: 'tree-contained' }),
      branch('glissa/session/landed', { mergedIntoIntegration: true, mergedReason: 'ancestor' }),
      branch('glissa/session/aged', {
        mergedIntoIntegration: false,
        mergedReason: 'unmerged-content',
        tipCommitTimeMs: NOW_MS - 15 * DAY_MS,
      }),
    ],
    integrationTips: [{ branch: 'develop', sha: 'develop-sha' }],
    liveSessionIds: new Set(),
    nowMs: NOW_MS,
  });

  assert.deepEqual(planned.deletions, [
    { name: 'glissa/session/rebased', reason: 'tree-contained', tipSha: 'glissa/session/rebased-sha' },
    { name: 'glissa/session/landed', reason: 'ancestor', tipSha: 'glissa/session/landed-sha' },
    { name: 'glissa/session/aged', reason: 'stale-orphan', tipSha: 'glissa/session/aged-sha' },
  ]);
});

test('a configured session branch is never deleted even when merged and stale', () => {
  const planned = planBranchGc({
    remoteBranches: [branch('glissa/session/live', {
      mergedIntoIntegration: true,
      tipCommitTimeMs: NOW_MS - 30 * DAY_MS,
    })],
    integrationTips: [{ branch: 'develop', sha: 'develop-sha' }],
    liveSessionIds: new Set(['live']),
    nowMs: NOW_MS,
  });

  assert.deepEqual(planned, {
    deletions: [],
    kept: [{ name: 'glissa/session/live', reason: 'live-session' }],
  });
});

test('a live session branch survives every configured prefix that lists it', () => {
  for (const prefixes of [['glissa/'], ['glissa/session'], ['glissa/session/'], ['glissa/', 'worktree-agent-']]) {
    const planned = planBranchGc({
      remoteBranches: [branch('glissa/session/live', {
        mergedIntoIntegration: true,
        tipCommitTimeMs: NOW_MS - 30 * DAY_MS,
      })],
      integrationTips: [{ branch: 'develop', sha: 'develop-sha' }],
      liveSessionIds: new Set(['live']),
      prefixes,
      nowMs: NOW_MS,
    });

    assert.deepEqual(planned, {
      deletions: [],
      kept: [{ name: 'glissa/session/live', reason: 'live-session' }],
    }, prefixes.join(','));
  }
});

test('keeps fresh unmerged session branches and uses 14 stale days by default', () => {
  const planned = planBranchGc({
    remoteBranches: [
      branch('glissa/session/fresh'),
      branch('glissa/session/boundary', { tipCommitTimeMs: NOW_MS - 14 * DAY_MS }),
    ],
    integrationTips: [],
    liveSessionIds: new Set(),
    nowMs: NOW_MS,
  });

  assert.deepEqual(planned, {
    deletions: [],
    kept: [
      { name: 'glissa/session/fresh', reason: 'not-merged-and-fresh' },
      { name: 'glissa/session/boundary', reason: 'not-merged-and-fresh' },
    ],
  });
});

test('foreign, mainline, and configured integration branch names are never deleted', () => {
  const planned = planBranchGc({
    remoteBranches: [
      branch('feature/old', { mergedIntoIntegration: true, tipCommitTimeMs: 0 }),
      branch('main', { mergedIntoIntegration: true, tipCommitTimeMs: 0 }),
      branch('master', { mergedIntoIntegration: true, tipCommitTimeMs: 0 }),
      branch('glissa/session/integration', { mergedIntoIntegration: true, tipCommitTimeMs: 0 }),
    ],
    integrationTips: [{ branch: 'glissa/session/integration', sha: null }],
    liveSessionIds: new Set(),
    nowMs: NOW_MS,
  });

  assert.deepEqual(planned, {
    deletions: [],
    kept: [
      { name: 'feature/old', reason: 'foreign-prefix' },
      { name: 'main', reason: 'foreign-prefix' },
      { name: 'master', reason: 'foreign-prefix' },
      { name: 'glissa/session/integration', reason: 'not-merged-and-fresh' },
    ],
  });
});

test('the default prefixes include worktree-agent branches and custom prefixes fail closed', () => {
  const underDefaults = planBranchGc({
    remoteBranches: [branch('worktree-agent-x')],
    nowMs: NOW_MS,
  });
  const underSessionPrefixOnly = planBranchGc({
    remoteBranches: [branch('worktree-agent-x', { mergedIntoIntegration: true, tipCommitTimeMs: 0 })],
    prefixes: ['glissa/session/'],
    nowMs: NOW_MS,
  });

  assert.deepEqual(underDefaults.kept, [{ name: 'worktree-agent-x', reason: 'not-merged-and-fresh' }]);
  assert.deepEqual(underSessionPrefixOnly.kept, [{ name: 'worktree-agent-x', reason: 'foreign-prefix' }]);
});

test('prefix rejection precedes protected and live-session guards', () => {
  const planned = planBranchGc({
    remoteBranches: [branch('glissa/session/guarded', { mergedIntoIntegration: true, tipCommitTimeMs: 0 })],
    integrationTips: [{ branch: 'glissa/session/guarded', sha: 'guarded-sha' }],
    liveSessionIds: new Set(['guarded']),
    prefixes: ['worktree-agent-'],
    nowMs: NOW_MS,
  });

  assert.deepEqual(planned.kept, [{ name: 'glissa/session/guarded', reason: 'foreign-prefix' }]);
});

test('every deletion carries the listed tip sha that leases its removal', () => {
  const planned = planBranchGc({
    remoteBranches: [
      { name: 'glissa/session/merged', tipSha: 'merged-tip', tipCommitTimeMs: NOW_MS, mergedIntoIntegration: true },
      { name: 'glissa/session/stale', tipSha: 'stale-tip', tipCommitTimeMs: NOW_MS - 30 * DAY_MS },
    ],
    nowMs: NOW_MS,
  });

  assert.deepEqual(planned.deletions.map((deletion) => deletion.tipSha), ['merged-tip', 'stale-tip']);
});

test('an empty prefix never makes every remote branch eligible', () => {
  const planned = planBranchGc({
    remoteBranches: [branch('release/x', { mergedIntoIntegration: true, tipCommitTimeMs: 0 })],
    prefixes: [''],
    nowMs: NOW_MS,
  });

  assert.deepEqual(planned, {
    deletions: [],
    kept: [{ name: 'release/x', reason: 'foreign-prefix' }],
  });
});

test('a non-finite commit time fails closed as fresh', () => {
  const planned = planBranchGc({
    remoteBranches: [branch('glissa/session/unknown-time', { tipCommitTimeMs: Number.NaN })],
    integrationTips: [],
    liveSessionIds: new Set(),
    nowMs: NOW_MS,
    staleDays: 1,
  });

  assert.deepEqual(planned.kept, [
    { name: 'glissa/session/unknown-time', reason: 'not-merged-and-fresh' },
  ]);
});
