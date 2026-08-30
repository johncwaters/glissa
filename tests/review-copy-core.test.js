'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('review copy names the effective base and its push action', async () => {
  const { baseLabel, mergeActionTitle, mergeTargetText, parkedStatusText } = await import('../public/sidebar/review-copy-core.mjs');
  assert.equal(baseLabel('trunk'), 'trunk');
  assert.equal(baseLabel(null), 'base');
  assert.match(mergeActionTitle('trunk'), /Merge into trunk, push it/);
  assert.match(mergeActionTitle(null), /Merge into base, push it/);
  assert.equal(mergeTargetText('trunk'), 'merges into trunk');
  assert.equal(mergeTargetText(null), 'merges into base');
  assert.match(parkedStatusText('base-diverged'), /Resync the base branch by hand, then Merge again/);
});

test('H1 base-diverged park keeps Merge rendered and enabled', async () => {
  const { decideMergeAction } = await import('../public/sidebar/review-copy-core.mjs');
  assert.deepEqual(decideMergeAction('parked', 'base-diverged', true), {
    isRendered: true,
    isEnabled: true,
  });
  assert.deepEqual(decideMergeAction('parked', 'rebase-conflict', true), {
    isRendered: false,
    isEnabled: false,
  });
});

test('base-diverged rendered Merge explains why it is disabled', async () => {
  const { decideMergeAction, mergeDisabledReason } = await import('../public/sidebar/review-copy-core.mjs');
  assert.deepEqual(decideMergeAction('parked', 'base-diverged', false), {
    isRendered: true,
    isEnabled: false,
  });
  assert.match(mergeDisabledReason({
    status: 'parked',
    mergeReason: 'base-diverged',
    fetched: true,
    hasCommits: true,
    live: true,
    state: 'COMPLETE',
  }), /Resync the base branch by hand/);
});

test('loading, no changes, and inactive session outrank base-diverged copy', async () => {
  const { mergeDisabledReason } = await import('../public/sidebar/review-copy-core.mjs');
  const baseDiverged = {
    status: 'parked', mergeReason: 'base-diverged', fetched: true, hasCommits: true, live: true,
    state: 'COMPLETE',
  };
  assert.equal(mergeDisabledReason({ ...baseDiverged, fetched: false }), 'Checking for changes...');
  assert.equal(mergeDisabledReason({ ...baseDiverged, hasCommits: false }), null);
  assert.equal(mergeDisabledReason({ ...baseDiverged, live: false }), 'Session ended.');
});
