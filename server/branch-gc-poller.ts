import { planBranchGc } from './core/branch-gc-core.ts';
import { configuredIntegrationBranch } from './core/integration-branch-core.ts';
import type { IntegrationTip, KeptBranch } from './core/branch-gc-core.ts';
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

interface RemoteSessionBranch {
  name: string;
  tipSha: string;
  tipCommitTimeMs: number;
}

type ListBranchesResult = GitCallResult & { branches?: RemoteSessionBranch[] };
type ListTipsResult = GitCallResult & { integrationTips?: IntegrationTip[] };
type AncestorResult = GitCallResult & { isAncestor?: boolean };

interface BranchGcGitWorkspace {
  fetchOrigin(args: { projectPath: string; timeoutMs?: number }): Promise<GitCallResult>;
  listRemoteSessionBranches(args: { projectPath: string }): Promise<ListBranchesResult>;
  listIntegrationTips(args: { projectPath: string; integrationBranch: string | null }): Promise<ListTipsResult>;
  isAncestor(args: { projectPath: string; ancestorSha: string; descendantSha: string }): Promise<AncestorResult>;
  deleteRemoteBranch(args: { projectPath: string; name: string }): Promise<GitCallResult>;
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
}

interface BranchGcProjectSummary {
  projectPath: string;
  deletions: string[];
  kept: KeptBranch[];
  errors: number;
}

interface BranchGcPollerDeps {
  gitWorkspace: BranchGcGitWorkspace;
  getConfig: () => BranchGcConfig;
  liveSessionIds: () => Set<string>;
  staleDays?: number;
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
    staleDays = DEFAULT_STALE_DAYS,
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

  async function branchMergedIntoAnyTip(
    projectPath: string,
    remoteBranch: RemoteSessionBranch,
    integrationTips: IntegrationTip[],
  ): Promise<{ ok: boolean; mergedIntoIntegration: boolean }> {
    for (const integrationTip of integrationTips) {
      const ancestorResult = await callGit(gitWorkspace.isAncestor, {
        projectPath,
        ancestorSha: remoteBranch.tipSha,
        descendantSha: integrationTip.sha ?? '',
      });
      if (!ancestorResult.ok) {
        noteGitError({
          projectPath,
          name: remoteBranch.name,
          operation: 'ancestor-check',
          gitResult: ancestorResult,
        });
        return { ok: false, mergedIntoIntegration: false };
      }
      if ('isAncestor' in ancestorResult && ancestorResult.isAncestor) return { ok: true, mergedIntoIntegration: true };
    }
    return { ok: true, mergedIntoIntegration: false };
  }

  async function tickProject(projectPath: string, config: BranchGcConfig): Promise<BranchGcProjectSummary> {
    const summary: BranchGcProjectSummary = { projectPath, deletions: [], kept: [], errors: 0 };
    const fetched = await callGit(gitWorkspace.fetchOrigin, {
      projectPath,
      timeoutMs: BRANCH_GC_FETCH_TIMEOUT_MS,
    });
    if (!fetched.ok) {
      noteGitError({ projectPath, operation: 'fetch', gitResult: fetched });
      summary.errors += 1;
      return summary;
    }

    const listed = await callGit(gitWorkspace.listRemoteSessionBranches, { projectPath });
    if (!listed.ok) {
      noteGitError({ projectPath, operation: 'list', gitResult: listed });
      summary.errors += 1;
      return summary;
    }
    const listedBranches = ('branches' in listed ? listed.branches : undefined) ?? [];

    const tipsResult = await callGit(gitWorkspace.listIntegrationTips, {
      projectPath,
      integrationBranch: configuredIntegrationBranch(config),
    });
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

    const checkedBranches: (RemoteSessionBranch & { mergedIntoIntegration: boolean })[] = [];
    const resolvedIntegrationTips = integrationTips.filter((integrationTip) => integrationTip.sha);
    for (const remoteBranch of listedBranches) {
      const mergeResult = await branchMergedIntoAnyTip(projectPath, remoteBranch, resolvedIntegrationTips);
      if (!mergeResult.ok) {
        summary.errors += 1;
        continue;
      }
      checkedBranches.push({ ...remoteBranch, mergedIntoIntegration: mergeResult.mergedIntoIntegration });
    }

    const configuredProjectIds = (config.projects || []).map((project) => project.id ?? '');
    const plan = planBranchGc({
      remoteBranches: checkedBranches,
      integrationTips,
      liveSessionIds: new Set([...configuredProjectIds, ...liveSessionIds()]),
      nowMs: now(),
      staleDays,
    });

    for (const keptBranch of plan.kept) {
      summary.kept.push(keptBranch);
      trace({ projectPath, name: keptBranch.name, decision: 'kept', reason: keptBranch.reason });
    }

    for (const name of plan.deletions) {
      const deleted = await callGit(gitWorkspace.deleteRemoteBranch, { projectPath, name });
      if (!deleted.ok) {
        noteGitError({ projectPath, name, operation: 'delete', gitResult: deleted });
        summary.errors += 1;
        continue;
      }
      summary.deletions.push(name);
      trace({ projectPath, name, decision: 'deleted', reason: 'provably-dead' });
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
    for (const projectPath of projectPaths) {
      const summary = await tickProject(projectPath, config);
      projects.push(summary);
      failures += summary.errors;
    }
    onTickComplete({ type: 'branch-gc-status', ts: now(), projects });
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
