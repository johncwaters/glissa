const SESSION_BRANCH_PREFIX = 'glissa/session/';
const DEFAULT_BRANCH_GC_PREFIXES = [SESSION_BRANCH_PREFIX, 'worktree-agent-'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MERGED_DELETION_REASON = 'merged-into-integration';
const STALE_DELETION_REASON = 'stale-orphan';

export interface IntegrationTip {
  branch: string;
  sha?: string | null;
}

export interface RemoteBranchTip {
  name: string;
  tipSha: string;
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
  tipSha: string;
}

export interface BranchGcPlan {
  deletions: DeletedBranch[];
  kept: KeptBranch[];
}

export interface LocalWorktreeTip {
  cwd: string;
  branch: string;
  locked: boolean;
  dirty: boolean | null;
  tipSha: string;
  integrationBranch: string | null;
  prunable?: boolean;
  atIntegrationTip?: boolean;
  merged?: boolean | null;
}

export interface WorktreeGcDecision {
  cwd: string;
  branch: string;
  disposition: 'keep' | 'remove';
  reason: 'missing-directory' | 'locked' | 'live-session' | 'protected' | 'foreign-prefix' | 'status-probe-failed' | 'uncommitted-changes' | 'no-commits' | 'merge-proof-failed' | 'unmerged' | 'merged';
}

export interface WorktreeGcPlan {
  removals: WorktreeGcDecision[];
  kept: WorktreeGcDecision[];
}

function sessionIdFromBranch(branchName: string): string | null {
  if (!branchName.startsWith(SESSION_BRANCH_PREFIX)) return null;
  return branchName.slice(SESSION_BRANCH_PREFIX.length);
}

function usablePrefixes(prefixes: string[]): string[] {
  return prefixes.filter((prefix) => prefix.length > 0);
}

function matchedPrefix(name: string, prefixes: string[]): string | null {
  for (const prefix of usablePrefixes(prefixes)) {
    if (name.startsWith(prefix)) return prefix;
  }
  return null;
}

function protectedBranchNames(integrationTips: IntegrationTip[]): Set<string> {
  return new Set(['main', 'master', ...integrationTips.map((tip) => tip.branch)]);
}

function planBranchGc({
  remoteBranches = [],
  integrationTips = [],
  liveSessionIds = new Set<string>(),
  prefixes = DEFAULT_BRANCH_GC_PREFIXES,
  nowMs,
  staleDays = 14,
}: {
  remoteBranches?: RemoteBranchTip[];
  integrationTips?: IntegrationTip[];
  liveSessionIds?: Set<string>;
  prefixes?: string[];
  nowMs: number;
  staleDays?: number;
}): BranchGcPlan {
  const deletions: DeletedBranch[] = [];
  const kept: KeptBranch[] = [];
  const protectedNames = protectedBranchNames(integrationTips);
  const staleBeforeMs = nowMs - staleDays * DAY_MS;

  for (const remoteBranch of remoteBranches) {
    const { name, tipSha } = remoteBranch;
    if (matchedPrefix(name, prefixes) === null) {
      kept.push({ name, reason: 'foreign-prefix' });
      continue;
    }
    if (protectedNames.has(name)) {
      kept.push({ name, reason: 'not-merged-and-fresh' });
      continue;
    }
    const sessionId = sessionIdFromBranch(name);
    if (sessionId !== null && liveSessionIds.has(sessionId)) {
      kept.push({ name, reason: 'live-session' });
      continue;
    }
    if (remoteBranch.mergedIntoIntegration === true) {
      deletions.push({ name, reason: remoteBranch.mergedReason ?? MERGED_DELETION_REASON, tipSha });
      continue;
    }
    if (Number.isFinite(remoteBranch.tipCommitTimeMs) && remoteBranch.tipCommitTimeMs < staleBeforeMs) {
      deletions.push({ name, reason: STALE_DELETION_REASON, tipSha });
      continue;
    }
    kept.push({ name, reason: 'not-merged-and-fresh' });
  }

  return { deletions, kept };
}

function worktreeIntegrationTips({ projectTips, worktreeOwnTips }: {
  projectTips: IntegrationTip[];
  worktreeOwnTips: IntegrationTip[];
}): IntegrationTip[] {
  const tipBySha = new Map<string, IntegrationTip>();
  for (const tip of [...projectTips, ...worktreeOwnTips]) {
    if (!tip.sha) continue;
    if (tipBySha.has(tip.sha)) continue;
    tipBySha.set(tip.sha, tip);
  }
  return [...tipBySha.values()];
}

function protectedWorktreeBranchNames(integrationTips: IntegrationTip[], worktrees: LocalWorktreeTip[]): Set<string> {
  const ownIntegrationBranches = worktrees
    .map((worktree) => worktree.integrationBranch)
    .filter((branch): branch is string => Boolean(branch))
    .map((branch) => ({ branch }));
  return protectedBranchNames([...integrationTips, ...ownIntegrationBranches]);
}

function planWorktreeGc({
  worktrees,
  liveWorktreePaths,
  integrationTips,
  prefixes,
}: {
  worktrees: LocalWorktreeTip[];
  liveWorktreePaths: Set<string>;
  integrationTips: IntegrationTip[];
  prefixes: string[];
}): WorktreeGcPlan {
  const removals: WorktreeGcDecision[] = [];
  const kept: WorktreeGcDecision[] = [];
  const protectedNames = protectedWorktreeBranchNames(integrationTips, worktrees);
  for (const worktree of worktrees) {
    const decision = (disposition: WorktreeGcDecision['disposition'], reason: WorktreeGcDecision['reason']) => ({
      cwd: worktree.cwd, branch: worktree.branch, disposition, reason,
    });
    if (worktree.prunable === true) { kept.push(decision('keep', 'missing-directory')); continue; }
    if (worktree.locked) { kept.push(decision('keep', 'locked')); continue; }
    if (liveWorktreePaths.has(worktree.cwd)) { kept.push(decision('keep', 'live-session')); continue; }
    if (protectedNames.has(worktree.branch)) { kept.push(decision('keep', 'protected')); continue; }
    if (matchedPrefix(worktree.branch, prefixes) === null) { kept.push(decision('keep', 'foreign-prefix')); continue; }
    if (worktree.dirty === null) { kept.push(decision('keep', 'status-probe-failed')); continue; }
    if (worktree.dirty) { kept.push(decision('keep', 'uncommitted-changes')); continue; }
    if (worktree.atIntegrationTip === true) { kept.push(decision('keep', 'no-commits')); continue; }
    if (worktree.merged === null) { kept.push(decision('keep', 'merge-proof-failed')); continue; }
    if (worktree.merged !== true) { kept.push(decision('keep', 'unmerged')); continue; }
    removals.push(decision('remove', 'merged'));
  }
  return { removals, kept };
}

export { DAY_MS, DEFAULT_BRANCH_GC_PREFIXES, MERGED_DELETION_REASON, SESSION_BRANCH_PREFIX, STALE_DELETION_REASON, matchedPrefix, planBranchGc, planWorktreeGc, protectedBranchNames, sessionIdFromBranch, usablePrefixes, worktreeIntegrationTips };
