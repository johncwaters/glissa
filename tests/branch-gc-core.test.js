'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DAY_MS, planBranchGc } = require('../server/core/branch-gc-core');

const NOW_MS = Date.parse('2026-08-25T12:00:00Z');

function branch(name, overrides = {}) {
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
    deletions: ['glissa/session/merged', 'glissa/session/stale'],
    kept: [],
  });
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
