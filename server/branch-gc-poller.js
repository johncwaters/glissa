'use strict';

const { planBranchGc } = require('./core/branch-gc-core');
const { createTickLoop } = require('./lane-runner');

const DEFAULT_STALE_DAYS = 14;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

function createBranchGcPoller(deps) {
  const {
    gitWorkspace,
    getConfig,
    staleDays = DEFAULT_STALE_DAYS,
    intervalMs = DEFAULT_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    log = console,
    decisionTrace = () => {},
    onTickComplete = () => {},
    now = () => Date.now(),
  } = deps;

  async function callGit(method, args) {
    try {
      return await method(args);
    } catch (error) {
      return { ok: false, err: error.message };
    }
  }

  function trace(entry) {
    decisionTrace({ kind: 'branch-gc', ts: now(), ...entry });
  }

  function noteGitError({ projectPath, name = null, operation, gitResult }) {
    const message = gitResult.err || gitResult.out || 'git command failed';
    log.warn(`[branch-gc] ${operation} failed in ${projectPath}: ${message}`);
    trace({ projectPath, name, decision: 'skipped', reason: `${operation}-error` });
  }

  async function branchMergedIntoAnyTip(projectPath, remoteBranch, integrationTips) {
    for (const integrationTip of integrationTips) {
      const ancestorResult = await callGit(gitWorkspace.isAncestor, {
        projectPath,
        ancestorSha: remoteBranch.tipSha,
        descendantSha: integrationTip.sha,
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
      if (ancestorResult.isAncestor) return { ok: true, mergedIntoIntegration: true };
    }
    return { ok: true, mergedIntoIntegration: false };
  }

  async function tickProject(projectPath, config) {
    /** @type {{ projectPath: string, deletions: string[], kept: unknown[], errors: number }} */
    const summary = { projectPath, deletions: [], kept: [], errors: 0 };
    const fetched = await callGit(gitWorkspace.fetchOrigin, { projectPath });
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

    const tipsResult = await callGit(gitWorkspace.listIntegrationTips, {
      projectPath,
      integrationBranch: config.integrationBranch || 'develop',
    });
    if (!tipsResult.ok) {
      for (const remoteBranch of listed.branches) {
        noteGitError({
          projectPath,
          name: remoteBranch.name,
          operation: 'integration-tips',
          gitResult: tipsResult,
        });
      }
      if (listed.branches.length === 0) {
        noteGitError({ projectPath, operation: 'integration-tips', gitResult: tipsResult });
      }
      summary.errors += Math.max(1, listed.branches.length);
      return summary;
    }

    /** @type {Array<{ name: string, tipSha: string, tipCommitTimeMs: number, mergedIntoIntegration: boolean }>} */
    const checkedBranches = [];
    const resolvedIntegrationTips = tipsResult.integrationTips.filter((integrationTip) => integrationTip.sha);
    for (const remoteBranch of listed.branches) {
      const mergeResult = await branchMergedIntoAnyTip(projectPath, remoteBranch, resolvedIntegrationTips);
      if (!mergeResult.ok) {
        summary.errors += 1;
        continue;
      }
      checkedBranches.push({ ...remoteBranch, mergedIntoIntegration: mergeResult.mergedIntoIntegration });
    }

    const liveSessionIds = new Set((config.projects || []).map((project) => project.id));
    const plan = planBranchGc({
      remoteBranches: checkedBranches,
      integrationTips: tipsResult.integrationTips,
      liveSessionIds,
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

  async function runTick() {
    const config = getConfig();
    const projectPaths = [...new Set((config.projects || []).map((project) => project.path).filter(Boolean))];
    const projects = [];
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

module.exports = { DEFAULT_INTERVAL_MS, DEFAULT_STALE_DAYS, createBranchGcPoller };
