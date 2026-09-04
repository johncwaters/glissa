const SESSION_BRANCH_PREFIX = 'glissa/session/';
const DAY_MS = 24 * 60 * 60 * 1000;
const MERGED_DELETION_REASON = 'merged-into-integration';
const STALE_DELETION_REASON = 'stale-orphan';

export interface IntegrationTip {
  branch: string;
  sha?: string | null;
}

export interface RemoteBranchTip {
  name: string;
  tipCommitTimeMs: number;
  mergedIntoIntegration?: boolean;
  mergedReason?: string;
}

export interface KeptBranch {
  name: string;
  reason: string;
}

export interface DeletedBranch {
  name: string;
  reason: string;
}

export interface BranchGcPlan {
  deletions: DeletedBranch[];
  kept: KeptBranch[];
}

function sessionIdFromBranch(branchName: string): string | null {
  if (!branchName.startsWith(SESSION_BRANCH_PREFIX)) return null;
  return branchName.slice(SESSION_BRANCH_PREFIX.length);
}

function protectedBranchNames(integrationTips: IntegrationTip[]): Set<string> {
  return new Set(['main', 'master', ...integrationTips.map((tip) => tip.branch)]);
}

function planBranchGc({
  remoteBranches = [],
  integrationTips = [],
  liveSessionIds = new Set<string>(),
  nowMs,
  staleDays = 14,
}: {
  remoteBranches?: RemoteBranchTip[];
  integrationTips?: IntegrationTip[];
  liveSessionIds?: Set<string>;
  nowMs: number;
  staleDays?: number;
}): BranchGcPlan {
  const deletions: DeletedBranch[] = [];
  const kept: KeptBranch[] = [];
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
      deletions.push({ name, reason: remoteBranch.mergedReason ?? MERGED_DELETION_REASON });
      continue;
    }
    if (Number.isFinite(remoteBranch.tipCommitTimeMs) && remoteBranch.tipCommitTimeMs < staleBeforeMs) {
      deletions.push({ name, reason: STALE_DELETION_REASON });
      continue;
    }
    kept.push({ name, reason: 'not-merged-and-fresh' });
  }

  return { deletions, kept };
}

export { DAY_MS, MERGED_DELETION_REASON, SESSION_BRANCH_PREFIX, STALE_DELETION_REASON, planBranchGc, sessionIdFromBranch };
