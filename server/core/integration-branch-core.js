'use strict';

function configuredIntegrationBranch(config) {
  const configuredBranch = config?.integrationBranch;
  if (typeof configuredBranch !== 'string') return null;
  return configuredBranch || null;
}

module.exports = { configuredIntegrationBranch };
