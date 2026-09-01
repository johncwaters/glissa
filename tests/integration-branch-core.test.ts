import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredIntegrationBranch } from '../server/core/integration-branch-core.ts';

test('configuredIntegrationBranch returns a configured branch name', () => {
  assert.equal(configuredIntegrationBranch({ integrationBranch: 'release' }), 'release');
});

test('configuredIntegrationBranch returns null for auto values', () => {
  assert.equal(configuredIntegrationBranch({ integrationBranch: null }), null);
  assert.equal(configuredIntegrationBranch({ integrationBranch: '' }), null);
  assert.equal(configuredIntegrationBranch({}), null);
});
