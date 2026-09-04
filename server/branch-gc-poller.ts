import { DEFAULT_BRANCH_GC_PREFIXES, planBranchGc, planWorktreeGc, worktreeIntegrationTips } from './core/branch-gc-core.ts';
import { configuredIntegrationBranch } from './core/integration-branch-core.ts';
import { ancestorProvenProbe, ancestryFromResult, buildTipProbe, proveMergedAcrossTips } from './core/merge-proof-core.ts';
import type { MergeProbeEnvResult, MergeProofReason, MergeTreeOutcome, TipProbe } from './core/merge-proof-core.ts';
import type { IntegrationTip, KeptBranch, LocalWorktreeTip, RemoteBranchTip, WorktreeGcDecision } from './core/branch-gc-core.ts';
import { createTickLoop } from './lane-runner.ts';
import type { TickOutcome } from './lane-runner.ts';

const DEFAULT_STALE_DAYS = 14;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BRANCH_GC_FETCH_TIMEOUT_MS = 60000;

interface GitCallResult {
  ok: boolean;
  out?: string;
  err?: string;
}

type ListBranchesResult = GitCallResult & { branches?: RemoteBranchTip[] };
type ListTipsResult = GitCallResult & { integrationTips?: IntegrationTip[] };
type AncestorResult = GitCallResult & { isAncestor?: boolean };
type MergeTreeResult = GitCallResult & { outcome: MergeTreeOutcome };
type DirtyProbeResult = GitCallResult & { dirty?: boolean; headSha?: string | null };

interface BranchGcGitWorkspace {
  fetchOrigin(args: { projectPath: string; timeoutMs?: number }): Promise<GitCallResult>;
  listRemoteBranches(args: { projectPath: string; prefixes: string[] }): Promise<ListBranchesResult>;
  listIntegrationTips(args: { projectPath: string; integrationBranch: string | null }): Promise<ListTipsResult>;
  isAncestor(args: { projectPath: string; ancestorSha: string; descendantSha: string }): Promise<AncestorResult>;
  resolveMergeProbeEnv(args: { projectPath: string }): Promise<MergeProbeEnvResult>;
  writeMergedTree(args: {
    projectPath: string;
    integrationSha: string;
    branchSha: string;
    probeEnv: Record<string, string>;
  }): Promise<MergeTreeResult>;
  treeOid(args: { projectPath: string; sha: string }): Promise<GitCallResult>;
  deleteRemoteBranch(args: { projectPath: string; name: string; tipSha: string }): Promise<GitCallResult>;
  listWorktrees(args: { projectPath: string; prefixes: string[]; integrationBranch: string | null; configuredIntegrationBranch: string | null }): Promise<LocalWorktreeTip[]>;
  probeWorktreeDirty(args: { projectPath: string; cwd: string; branch: string }): Promise<DirtyProbeResult>;
  removeWorktreeByPath(args: { projectPath: string; cwd: string; branch: string }): Promise<GitCallResult>;
}

interface BranchGcConfig {
  integrationBranch?: string | null;
  projects?: { id?: string; path?: string }[];
}

interface BranchGcTraceEntry {
  projectPath: string;
  name?: string | null;
  decision: string;
  reason?: string;
  cwd?: string;
}

interface BranchGcProjectSummary {
  projectPath: string;
  deletions: string[];
  kept: KeptBranch[];
  worktreeRemovals: { cwd: string; branch: string; reason: string }[];
  worktreesKept: { cwd: string; branch: string; reason: string }[];
  errors: number;
}

interface BranchGcPollerDeps {
  gitWorkspace: BranchGcGitWorkspace;
  getConfig: () => BranchGcConfig;
  liveSessionIds: () => Set<string>;
  liveWorktreePaths: () => Set<string> | Promise<Set<string>>;
  staleDays?: number;
  prefixes?: string[];
  pruneWorktrees?: boolean;
  dryRun?: boolean;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  log?: Pick<Console, 'warn'>;
  decisionTrace?: (entry: Record<string, unknown>) => void;
  onTickComplete?: (summary: Record<string, unknown>) => void;
  now?: () => number;
}

interface BranchGcPoller {
  start(prelude?: (() => Promise<void> | void) | null): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
}

function createBranchGcPoller(deps: BranchGcPollerDeps): BranchGcPoller {
  const {
    gitWorkspace,
    getConfig,
    liveSessionIds,
    liveWorktreePaths,
    staleDays = DEFAULT_STALE_DAYS,
    prefixes = DEFAULT_BRANCH_GC_PREFIXES,
    pruneWorktrees = true,
    dryRun = false,
    intervalMs = DEFAULT_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    log = console,
    decisionTrace = () => {},
    onTickComplete = () => {},
    now = () => Date.now(),
  } = deps;

  async function callGit<Args, Result extends GitCallResult>(
    method: (args: Args) => Promise<Result>,
    args: Args,
  ): Promise<Result | GitCallResult> {
    try {
      return await method(args);
    } catch (error) {
      return { ok: false, err: error instanceof Error ? error.message : String(error) };
    }
  }

  function trace(entry: BranchGcTraceEntry): void {
    decisionTrace({ kind: 'branch-gc', ts: now(), ...entry });
  }

  function noteGitError({ projectPath, name = null, operation, gitResult }: {
    projectPath: string;
    name?: string | null;
    operation: string;
    gitResult: GitCallResult;
  }): void {
    const message = gitResult.err || gitResult.out || 'git command failed';
    log.warn(`[branch-gc] ${operation} failed in ${projectPath}: ${message}`);
    trace({ projectPath, name, decision: 'skipped', reason: `${operation}-error` });
  }

  async function probeAncestryAcrossTips(
    projectPath: string,
    name: string,
    tipSha: string,
    integrationTips: IntegrationTip[],
  ): Promise<(boolean | null)[]> {
    const ancestries: (boolean | null)[] = [];
    for (const integrationTip of integrationTips) {
      const ancestorResult = await callGit(gitWorkspace.isAncestor, {
        projectPath,
        ancestorSha: tipSha,
        descendantSha: integrationTip.sha ?? '',
      });
      if (!ancestorResult.ok) {
        noteGitError({ projectPath, name, operation: 'ancestor-check', gitResult: ancestorResult });
      }
      ancestries.push(ancestryFromResult(ancestorResult));
    }
    return ancestries;
  }

  async function resolveIntegrationTreeOids(
    projectPath: string,
    integrationTips: IntegrationTip[],
    integrationTreeByTipSha: Map<string, GitCallResult> = new Map<string, GitCallResult>(),
  ): Promise<Map<string, GitCallResult>> {
    for (const integrationTip of integrationTips) {
      const integrationSha = integrationTip.sha ?? '';
      if (integrationTreeByTipSha.has(integrationSha)) continue;
      integrationTreeByTipSha.set(integrationSha, await callGit(gitWorkspace.treeOid, { projectPath, sha: integrationSha }));
    }
    return integrationTreeByTipSha;
  }

  async function resolveMergeProbeEnv(projectPath: string): Promise<MergeProbeEnvResult> {
    try {
      return await gitWorkspace.resolveMergeProbeEnv({ projectPath });
    } catch (error) {
      return { ok: false, err: error instanceof Error ? error.message : String(error) };
    }
  }

  async function probeTreeContainment({ projectPath, name, tipSha, integrationSha, integrationTree, isAncestor, mergeProbeEnv }: {
    projectPath: string;
    name: string;
    tipSha: string;
    integrationSha: string;
    integrationTree: GitCallResult;
    isAncestor: boolean | null;
    mergeProbeEnv: MergeProbeEnvResult;
  }): Promise<TipProbe> {
    if (!integrationTree.ok) noteGitError({ projectPath, name, operation: 'tree-check', gitResult: integrationTree });
    if (!mergeProbeEnv.ok) {
      const gitResult: GitCallResult = { ok: false, err: mergeProbeEnv.err };
      noteGitError({ projectPath, name, operation: 'merge-probe-env', gitResult });
      return buildTipProbe({ isAncestor, integrationTree, mergeTree: { ...gitResult, outcome: 'failed' } });
    }
    const mergeTree = await callGit(gitWorkspace.writeMergedTree, {
      projectPath,
      integrationSha,
      branchSha: tipSha,
      probeEnv: mergeProbeEnv.probeEnv,
    });
    const outcome: MergeTreeOutcome = 'outcome' in mergeTree ? mergeTree.outcome : 'failed';
    if (outcome === 'failed') noteGitError({ projectPath, name, operation: 'merge-tree', gitResult: mergeTree });
    return buildTipProbe({ isAncestor, integrationTree, mergeTree: { ...mergeTree, outcome } });
  }

  async function probeBranchAgainstTips(
    projectPath: string,
    name: string,
    tipSha: string,
    integrationTips: IntegrationTip[],
    integrationTreeByTipSha: Map<string, GitCallResult>,
    mergeProbeEnv: MergeProbeEnvResult,
  ): Promise<TipProbe[]> {
    const ancestries = await probeAncestryAcrossTips(projectPath, name, tipSha, integrationTips);
    if (ancestries.some((isAncestor) => isAncestor === true)) return [ancestorProvenProbe()];
    const probes: TipProbe[] = [];
    for (const [index, integrationTip] of integrationTips.entries()) {
      const integrationSha = integrationTip.sha ?? '';
      probes.push(await probeTreeContainment({
        projectPath,
        name,
        tipSha,
        integrationSha,
        integrationTree: integrationTreeByTipSha.get(integrationSha) ?? { ok: false, err: 'tree oid was never resolved' },
        isAncestor: ancestries[index] ?? null,
        mergeProbeEnv,
      }));
    }
    return probes;
  }

  async function resolveOwnIntegrationTips({ projectPath, integrationBranch, tipsByIntegrationBranch }: {
    projectPath: string;
    integrationBranch: string | null;
    tipsByIntegrationBranch: Map<string, ListTipsResult | GitCallResult>;
  }): Promise<ListTipsResult | GitCallResult> {
    const cached = tipsByIntegrationBranch.get(integrationBranch ?? '');
    if (cached) return cached;
    const resolved = await callGit(gitWorkspace.listIntegrationTips, { projectPath, integrationBranch });
    tipsByIntegrationBranch.set(integrationBranch ?? '', resolved);
    return resolved;
  }

  async function checkWorktreeMerged({ projectPath, worktree, summary, projectTips, integrationTreeByTipSha, mergeProbeEnv, tipsByIntegrationBranch }: {
    projectPath: string;
    worktree: LocalWorktreeTip;
    summary: BranchGcProjectSummary;
    projectTips: IntegrationTip[];
    integrationTreeByTipSha: Map<string, GitCallResult>;
    mergeProbeEnv: MergeProbeEnvResult;
    tipsByIntegrationBranch: Map<string, ListTipsResult | GitCallResult>;
  }): Promise<LocalWorktreeTip> {
    if (worktree.prunable === true) return worktree;
    const ownTipsResult = await resolveOwnIntegrationTips({ projectPath, integrationBranch: worktree.integrationBranch, tipsByIntegrationBranch });
    if (!ownTipsResult.ok) {
      noteGitError({ projectPath, name: worktree.branch, operation: 'worktree-integration-tips', gitResult: ownTipsResult });
      summary.errors += 1;
      return { ...worktree, merged: null };
    }
    const ownTips = ('integrationTips' in ownTipsResult ? ownTipsResult.integrationTips : undefined) ?? [];
    const worktreeTips = worktreeIntegrationTips({ projectTips, worktreeOwnTips: ownTips });
    if (worktreeTips.some((integrationTip) => integrationTip.sha === worktree.tipSha)) return { ...worktree, atIntegrationTip: true };
    await resolveIntegrationTreeOids(projectPath, worktreeTips, integrationTreeByTipSha);
    const probes = await probeBranchAgainstTips(projectPath, worktree.branch, worktree.tipSha, worktreeTips, integrationTreeByTipSha, mergeProbeEnv);
    const proof = proveMergedAcrossTips(probes);
    if (proof.verdict === 'undecidable') {
      summary.errors += 1;
      return { ...worktree, merged: null };
    }
    return { ...worktree, merged: proof.verdict === 'merged' };
  }

  async function removePlannedWorktree({ projectPath, summary, decision, plannedTipSha }: {
    projectPath: string;
    summary: BranchGcProjectSummary;
    decision: WorktreeGcDecision;
    plannedTipSha: string | null;
  }): Promise<void> {
    if (dryRun) {
      summary.worktreeRemovals.push({ cwd: decision.cwd, branch: decision.branch, reason: decision.reason });
      trace({ projectPath, name: decision.branch, cwd: decision.cwd, decision: 'would-remove', reason: decision.reason });
      return;
    }
    const recheck = await callGit(gitWorkspace.probeWorktreeDirty, { projectPath, cwd: decision.cwd, branch: decision.branch });
    if (!recheck.ok) {
      noteGitError({ projectPath, name: decision.branch, operation: 'worktree-status-recheck', gitResult: recheck });
      summary.errors += 1;
      return;
    }
    if ('dirty' in recheck && recheck.dirty === true) {
      summary.worktreesKept.push({ cwd: decision.cwd, branch: decision.branch, reason: 'became-dirty' });
      trace({ projectPath, name: decision.branch, cwd: decision.cwd, decision: 'kept', reason: 'became-dirty' });
      return;
    }
    const recheckedTipSha = 'headSha' in recheck ? recheck.headSha ?? null : null;
    if (recheckedTipSha !== plannedTipSha) {
      summary.worktreesKept.push({ cwd: decision.cwd, branch: decision.branch, reason: 'tip-moved' });
      trace({ projectPath, name: decision.branch, cwd: decision.cwd, decision: 'kept', reason: 'tip-moved' });
      return;
    }
    const removed = await callGit(gitWorkspace.removeWorktreeByPath, { projectPath, cwd: decision.cwd, branch: decision.branch });
    if (!removed.ok) {
      noteGitError({ projectPath, name: decision.branch, operation: 'remove-worktree', gitResult: removed });
      summary.errors += 1;
      return;
    }
    summary.worktreeRemovals.push({ cwd: decision.cwd, branch: decision.branch, reason: decision.reason });
    trace({ projectPath, name: decision.branch, cwd: decision.cwd, decision: 'removed', reason: decision.reason });
  }

  async function pruneLocalWorktrees({ projectPath, summary, integrationBranch, integrationTips, projectTips, integrationTreeByTipSha, mergeProbeEnv, tipsByIntegrationBranch, liveWorktreePathSet }: {
    projectPath: string;
    summary: BranchGcProjectSummary;
    integrationBranch: string | null;
    integrationTips: IntegrationTip[];
    projectTips: IntegrationTip[];
    integrationTreeByTipSha: Map<string, GitCallResult>;
    mergeProbeEnv: MergeProbeEnvResult;
    tipsByIntegrationBranch: Map<string, ListTipsResult | GitCallResult>;
    liveWorktreePathSet: Set<string>;
  }): Promise<void> {
    if (!pruneWorktrees) return;
    let listedWorktrees: LocalWorktreeTip[] = [];
    try {
      listedWorktrees = await gitWorkspace.listWorktrees({ projectPath, prefixes, integrationBranch, configuredIntegrationBranch: integrationBranch });
    } catch (error) {
      noteGitError({ projectPath, operation: 'list-worktrees', gitResult: { ok: false, err: error instanceof Error ? error.message : String(error) } });
      summary.errors += 1;
      return;
    }
    const checkedWorktrees: LocalWorktreeTip[] = [];
    for (const worktree of listedWorktrees) {
      checkedWorktrees.push(await checkWorktreeMerged({
        projectPath, worktree, summary, projectTips, integrationTreeByTipSha, mergeProbeEnv, tipsByIntegrationBranch,
      }));
    }
    const plannedTipShaByCwd = new Map(checkedWorktrees.map((worktree) => [worktree.cwd, worktree.tipSha]));
    const plan = planWorktreeGc({ worktrees: checkedWorktrees, liveWorktreePaths: liveWorktreePathSet, integrationTips, prefixes });
    for (const decision of plan.kept) {
      if (decision.reason === 'status-probe-failed') summary.errors += 1;
      summary.worktreesKept.push({ cwd: decision.cwd, branch: decision.branch, reason: decision.reason });
      trace({ projectPath, name: decision.branch, cwd: decision.cwd, decision: 'kept', reason: decision.reason });
    }
    for (const decision of plan.removals) {
      await removePlannedWorktree({ projectPath, summary, decision, plannedTipSha: plannedTipShaByCwd.get(decision.cwd) ?? null });
    }
  }

  async function tickProject(projectPath: string, config: BranchGcConfig, liveWorktreePathSet: Set<string>): Promise<BranchGcProjectSummary> {
    const summary: BranchGcProjectSummary = { projectPath, deletions: [], kept: [], worktreeRemovals: [], worktreesKept: [], errors: 0 };
    const fetched = await callGit(gitWorkspace.fetchOrigin, {
      projectPath,
      timeoutMs: BRANCH_GC_FETCH_TIMEOUT_MS,
    });
    if (!fetched.ok) {
      noteGitError({ projectPath, operation: 'fetch', gitResult: fetched });
      summary.errors += 1;
      return summary;
    }

    const listed = await callGit(gitWorkspace.listRemoteBranches, { projectPath, prefixes });
    if (!listed.ok) {
      noteGitError({ projectPath, operation: 'list', gitResult: listed });
      summary.errors += 1;
    }
    const listedBranches = (listed.ok && 'branches' in listed ? listed.branches : undefined) ?? [];

    const integrationBranch = configuredIntegrationBranch(config);
    const tipsByIntegrationBranch = new Map<string, ListTipsResult | GitCallResult>();
    const tipsResult = await resolveOwnIntegrationTips({ projectPath, integrationBranch, tipsByIntegrationBranch });
    if (!tipsResult.ok) {
      for (const remoteBranch of listedBranches) {
        noteGitError({
          projectPath,
          name: remoteBranch.name,
          operation: 'integration-tips',
          gitResult: tipsResult,
        });
      }
      if (listedBranches.length === 0) {
        noteGitError({ projectPath, operation: 'integration-tips', gitResult: tipsResult });
      }
      summary.errors += Math.max(1, listedBranches.length);
      return summary;
    }
    const integrationTips = ('integrationTips' in tipsResult ? tipsResult.integrationTips : undefined) ?? [];

    const checkedBranches: (RemoteBranchTip & { mergedIntoIntegration: boolean; mergedReason: MergeProofReason })[] = [];
    const resolvedIntegrationTips = integrationTips.filter((integrationTip) => integrationTip.sha);
    const integrationTreeByTipSha = await resolveIntegrationTreeOids(projectPath, resolvedIntegrationTips);
    const mergeProbeEnv = await resolveMergeProbeEnv(projectPath);

    await pruneLocalWorktrees({
      projectPath,
      summary,
      integrationBranch,
      integrationTips,
      projectTips: resolvedIntegrationTips,
      integrationTreeByTipSha,
      mergeProbeEnv,
      tipsByIntegrationBranch,
      liveWorktreePathSet,
    });
    for (const remoteBranch of listedBranches) {
      const probes = await probeBranchAgainstTips(projectPath, remoteBranch.name, remoteBranch.tipSha, resolvedIntegrationTips, integrationTreeByTipSha, mergeProbeEnv);
      const proof = proveMergedAcrossTips(probes);
      if (proof.verdict === 'undecidable') {
        summary.errors += 1;
        continue;
      }
      checkedBranches.push({
        ...remoteBranch,
        mergedIntoIntegration: proof.verdict === 'merged',
        mergedReason: proof.reason,
      });
    }

    const configuredProjectIds = (config.projects || []).map((project) => project.id ?? '');
    const plan = planBranchGc({
      remoteBranches: checkedBranches,
      integrationTips,
      liveSessionIds: new Set([...configuredProjectIds, ...liveSessionIds()]),
      prefixes,
      nowMs: now(),
      staleDays,
    });

    for (const keptBranch of plan.kept) {
      summary.kept.push(keptBranch);
      trace({ projectPath, name: keptBranch.name, decision: 'kept', reason: keptBranch.reason });
    }

    for (const { name, reason, tipSha } of plan.deletions) {
      if (dryRun) {
        summary.deletions.push(name);
        trace({ projectPath, name, decision: 'would-delete', reason });
        continue;
      }
      const deleted = await callGit(gitWorkspace.deleteRemoteBranch, { projectPath, name, tipSha });
      if (!deleted.ok) {
        noteGitError({ projectPath, name, operation: 'delete', gitResult: deleted });
        summary.errors += 1;
        continue;
      }
      summary.deletions.push(name);
      trace({ projectPath, name, decision: 'deleted', reason });
    }

    return summary;
  }

  async function runTick(): Promise<TickOutcome | undefined> {
    const config = getConfig();
    const projectPaths = [...new Set((config.projects || [])
      .map((project) => project.path)
      .filter((projectPath): projectPath is string => Boolean(projectPath)))];
    const projects: BranchGcProjectSummary[] = [];
    let failures = 0;
    const liveWorktreePathSet = await liveWorktreePaths();
    for (const projectPath of projectPaths) {
      const summary = await tickProject(projectPath, config, liveWorktreePathSet);
      projects.push(summary);
      failures += summary.errors;
    }
    onTickComplete({ type: 'branch-gc-status', ts: now(), dryRun, projects });
    if (failures > 0) return { failed: true };
    return undefined;
  }

  const loop = createTickLoop({
    tag: 'branch-gc',
    intervalMs,
    tick: runTick,
    setIntervalFn,
    clearIntervalFn,
    log,
    now,
  });

  return { start: loop.start, stop: loop.stop, tick: loop.tick };
}

export { BRANCH_GC_FETCH_TIMEOUT_MS, DEFAULT_INTERVAL_MS, DEFAULT_STALE_DAYS, createBranchGcPoller };
export type { BranchGcGitWorkspace, BranchGcPoller, BranchGcPollerDeps, BranchGcProjectSummary };
