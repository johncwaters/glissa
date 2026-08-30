'use strict';

/**
 * @typedef {'updated' | 'up-to-date' | 'diverged' | 'checked-out' | 'no-remote' | 'fetch-failed' | 'update-failed' | 'missing'} IntegrationSyncOutcome
 */

/**
 * @param {{ localSha: string | null, remoteSha: string | null, isAncestor: boolean | null, checkedOut: boolean }} options
 * @returns {{ action: 'none' | 'update', outcome: IntegrationSyncOutcome }}
 */
function decideIntegrationSync({ localSha, remoteSha, isAncestor, checkedOut }) {
  if (!remoteSha) return { action: 'none', outcome: 'no-remote' };
  if (!localSha) return { action: 'none', outcome: 'missing' };
  if (localSha === remoteSha) return { action: 'none', outcome: 'up-to-date' };
  if (isAncestor === false) return { action: 'none', outcome: 'diverged' };
  if (isAncestor !== true) return { action: 'none', outcome: 'update-failed' };
  if (checkedOut) return { action: 'none', outcome: 'checked-out' };
  return { action: 'update', outcome: 'updated' };
}

/**
 * @param {{ currentSha: string | null, remoteSha: string | null, isAncestor: boolean | null, checkedOut: boolean }} options
 * @returns {{ outcome: IntegrationSyncOutcome }}
 */
function classifyRefusedIntegrationSync({ currentSha, remoteSha, isAncestor, checkedOut }) {
  if (currentSha && currentSha === remoteSha) return { outcome: 'up-to-date' };
  if (isAncestor === false) return { outcome: 'diverged' };
  if (checkedOut) return { outcome: 'checked-out' };
  return { outcome: 'update-failed' };
}

module.exports = { decideIntegrationSync, classifyRefusedIntegrationSync };
