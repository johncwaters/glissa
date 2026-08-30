'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configuredIntegrationBranch } = require('../server/core/integration-branch-core');

test('configuredIntegrationBranch returns a configured branch name', () => {
  assert.equal(configuredIntegrationBranch({ integrationBranch: 'release' }), 'release');
});

test('configuredIntegrationBranch returns null for auto values', () => {
  assert.equal(configuredIntegrationBranch({ integrationBranch: null }), null);
  assert.equal(configuredIntegrationBranch({ integrationBranch: '' }), null);
  assert.equal(configuredIntegrationBranch({}), null);
});
