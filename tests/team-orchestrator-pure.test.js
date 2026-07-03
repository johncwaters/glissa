'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReadNames, selectReviseStages, allUnchanged, baseBranchBlockReason, formatRunVerdict,
} = require('../teamlib/team-orchestrator');

test('buildReadNames returns only stage.reads at round 0', () => {
  const stage = { reads: ['a.md', 'b.md'], reviseReads: ['c.md'] };
  assert.deepEqual(buildReadNames(stage, 0), ['a.md', 'b.md']);
});

test('buildReadNames unions reviseReads at round > 0, de-duplicated, base reads first', () => {
  const stage = { reads: ['a.md', 'b.md'], reviseReads: ['b.md', 'c.md'] };
  assert.deepEqual(buildReadNames(stage, 1), ['a.md', 'b.md', 'c.md']);
});

test('buildReadNames tolerates missing reads/reviseReads', () => {
  assert.deepEqual(buildReadNames({}, 0), []);
  assert.deepEqual(buildReadNames({}, 1), []);
});

test('selectReviseStages resolves ids to stage objects in order, dropping unknown ids', () => {
  const stages = [{ id: 'writer' }, { id: 'editor' }, { id: 'publisher' }];
  assert.deepEqual(selectReviseStages(stages, ['writer', 'ghost', 'editor']), [
    { id: 'writer' }, { id: 'editor' },
  ]);
});

test('selectReviseStages tolerates a missing ids array', () => {
  assert.deepEqual(selectReviseStages([{ id: 'writer' }], undefined), []);
});

test('allUnchanged is true only when every pair is byte-identical', () => {
  assert.equal(allUnchanged([{ before: 'x', after: 'x' }, { before: 'y', after: 'y' }]), true);
  assert.equal(allUnchanged([{ before: 'x', after: 'x' }, { before: 'y', after: 'z' }]), false);
  assert.equal(allUnchanged([]), true);
});

test('baseBranchBlockReason blocks only when a base branch is pinned and git isolation is unavailable', () => {
  const team = { runtime: { baseBranch: 'develop' } };
  assert.equal(
    baseBranchBlockReason(team, null),
    'base branch "develop" pinned but git isolation is unavailable',
  );
  assert.equal(baseBranchBlockReason(team, {}), null);
  assert.equal(baseBranchBlockReason({ runtime: {} }, null), null);
  assert.equal(baseBranchBlockReason({}, null), null);
});

test('formatRunVerdict still reports the bare verdict when no rounds ran', () => {
  assert.equal(formatRunVerdict({ verdict: 'SHIP', rounds: 0 }), 'SHIP');
  assert.equal(formatRunVerdict({}), 'DONE');
});

test('formatRunVerdict reports convergence, no-progress, and budget-exhausted forms', () => {
  assert.equal(
    formatRunVerdict({
      verdict: 'SHIP', initialVerdict: 'FIX', rounds: 1, maxRounds: 2,
    }),
    'FIX->SHIP (1 round)',
  );
  assert.equal(
    formatRunVerdict({
      verdict: 'FIX', initialVerdict: 'FIX', rounds: 1, noProgress: true, maxRounds: 2,
    }),
    'FIX (no-progress, round 1)',
  );
  assert.equal(
    formatRunVerdict({
      verdict: 'FIX', initialVerdict: 'FIX', rounds: 2, maxRounds: 2,
    }),
    'FIX (maxRounds 2)',
  );
});
