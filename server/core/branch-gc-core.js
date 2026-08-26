'use strict';

const SESSION_BRANCH_PREFIX = 'glissa/session/';
const DAY_MS = 24 * 60 * 60 * 1000;

function sessionIdFromBranch(branchName) {
  if (!branchName.startsWith(SESSION_BRANCH_PREFIX)) return null;
  return branchName.slice(SESSION_BRANCH_PREFIX.length);
}

/** @param {Array<{ branch: string }>} integrationTips */
function protectedBranchNames(integrationTips) {
  return new Set(['main', 'master', ...integrationTips.map((tip) => tip.branch)]);
}

/**
 * @param {{ remoteBranches?: Array<{ name: string, tipCommitTimeMs: number, mergedIntoIntegration?: boolean }>,
 *   integrationTips?: Array<{ branch: string }>, liveSessionIds?: Set<string>, nowMs: number,
 *   staleDays?: number }} options
 */
function planBranchGc({
  remoteBranches = [],
  integrationTips = [],
  liveSessionIds = new Set(),
  nowMs,
  staleDays = 14,
}) {
  const deletions = [];
  const kept = [];
  const protectedNames = protectedBranchNames(integrationTips);
  const staleBeforeMs = nowMs - staleDays * DAY_MS;

  for (const remoteBranch of remoteBranches) {
    const { name } = remoteBranch;
    const sessionId = sessionIdFromBranch(name);
    if (sessionId === null) {
      kept.push({ name, reason: 'foreign-prefix' });
      continue;
    }
    if (protectedNames.has(name)) {
      kept.push({ name, reason: 'not-merged-and-fresh' });
      continue;
    }
    if (liveSessionIds.has(sessionId)) {
      kept.push({ name, reason: 'live-session' });
      continue;
    }
    if (remoteBranch.mergedIntoIntegration === true) {
      deletions.push(name);
      continue;
    }
    if (Number.isFinite(remoteBranch.tipCommitTimeMs) && remoteBranch.tipCommitTimeMs < staleBeforeMs) {
      deletions.push(name);
      continue;
    }
    kept.push({ name, reason: 'not-merged-and-fresh' });
  }

  return { deletions, kept };
}

module.exports = { DAY_MS, SESSION_BRANCH_PREFIX, planBranchGc, sessionIdFromBranch };
