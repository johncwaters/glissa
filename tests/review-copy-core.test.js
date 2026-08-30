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
