"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, execFile } = require("../server/child-process-safe");
const { isSameDirectoryPath } = require("../shared/paths");
const { STATES, MERGEABLE_LIVE_STATES, RESTARTABLE_STATES } = require("../shared/states");
const { createWorktreeWatcher, readWorktreeGitdirPointer } = require("../detection/worktree-watch");
const { createIntegrationRefWatcher } = require("../detection/integration-ref-watch");
const { createRerereWatcher } = require("../detection/rerere-watch");
const { buildMergePrompt } = require("./core/merge-prompt");
const { decideSignatureDemotion, decideDiffSelfHeal } = require("./core/merge-gate");
const { decideAutoRebase, decideRerereCooldownClear, AUTO_REBASE_STATES } = require("./core/rebase-gate");
const { projectMergeState } = require("./core/worktree-state");
const {
  parseLeftRightCount,
  decideBranchSyncState,
  parseRemoteFromUpstream,
  decideResyncAction,
  firstGitErrorLine,
} = require("../server/core/branch-sync-core");

const WORKTREE_CHECK_DEBOUNCE_MS = 400;

/**
 * @typedef {{ cwd: string, isGit: boolean, branch?: string | null, base?: string | null, baseSha?: string | null }} Workspace
 * @typedef {{ state: import('../shared/states').SessionState, isDestroyed: boolean, isTeardownPending: boolean, hasLivePty: boolean }} SessionSnapshot
 * @typedef {{ create: (...args: unknown[]) => unknown, populate: (...args: unknown[]) => unknown, hasUnmergedWork: (...args: unknown[]) => unknown, discard: (...args: unknown[]) => unknown, mergeBack: (...args: unknown[]) => unknown, mergeKeep: (...args: unknown[]) => unknown, rebaseOnly: (...args: unknown[]) => Promise<{ ok?: boolean, rebased?: boolean, baseSha?: string, headSha?: string, rerereReplayed?: boolean, reason?: string, conflicts?: string[] }> }} GitWorkspace
 * @typedef {{ state: () => SessionSnapshot, projectPath?: () => string, emit: (event: string, detail: Record<string, unknown>) => void, recordDecision: (entry: Record<string, unknown>) => void, pasteText: (text: string) => Record<string, unknown> }} SessionPort
 * @typedef {{ id: string, projectPath: string, integrationBranch?: string | null, gitWorkspace?: GitWorkspace | null, autoRebase?: boolean, liveWorktreeReview?: boolean, worktreeRoot?: string | null, worktreeShare?: string[] | null, port: SessionPort }} WorktreeLifecycleOptions
 */

function gitOut(args, opts) {
  return new Promise((resolve) => {
    execFile("git", args, opts, (_error, stdout) => resolve(stdout != null ? String(stdout) : ""));
  });
}

function gitStrict(args, opts) {
  return new Promise((resolve, reject) => {
    execFile("git", args, opts, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout != null ? String(stdout) : "");
    });
  });
}

const RESYNC_COMMANDS = {
  "ff-merge": ({ upstream, opts }) => ({ args: ["merge", "--ff-only", upstream], opts, successAction: "fast-forwarded" }),
  "ff-fetch": ({ branch, remote, opts }) => ({ args: ["fetch", "--quiet", remote, `${branch}:${branch}`], opts: { ...opts, timeout: 8000 }, successAction: "fast-forwarded" }),
  push: ({ branch, remote, opts }) => ({ args: ["push", remote, branch], opts: { ...opts, timeout: 15000 }, successAction: "pushed" }),
};

function stopWatcher(watcher) {
  if (!watcher) return null;
  try { watcher.stop(); } catch {}
  return null;
}

function detectLinkedWorktree(directory) {
  return readWorktreeGitdirPointer(directory) !== null;
}

function isOwnRemoteCopy(upstream, branch) {
  return upstream.replace(/^[^/]+\//, "") === branch;
}

/** @param {WorktreeLifecycleOptions} options */
function createSessionWorktreeLifecycle({
  id,
  projectPath,
  integrationBranch = null,
  gitWorkspace = null,
  autoRebase = true,
  liveWorktreeReview = true,
  worktreeRoot = null,
  worktreeShare = null,
  port,
}) {
  const currentProjectPath = () => port.projectPath ? port.projectPath() : projectPath;
  const lifecycleState = {
    worktreeDir: null,
    commonGitDir: null,
    baseSha: null,
    workspace: null,
    mergeStatus: "none",
    mergeReason: null,
    mergeConflicts: [],
    worktreeNotice: null,
    effectiveBase: null,
    isWorktree: detectLinkedWorktree(currentProjectPath()),
    autoRebasing: false,
    rebaseConflictKey: null,
    resyncPromise: null,
    worktreeWatcher: null,
    integrationWatcher: null,
    rerereWatcher: null,
    checkTimer: null,
    lastSignature: null,
  };

  function snapshot() {
    return {
      worktreeDir: lifecycleState.worktreeDir,
      commonGitDir: lifecycleState.commonGitDir,
      baseSha: lifecycleState.baseSha,
      mergeStatus: lifecycleState.mergeStatus,
      mergeReason: lifecycleState.mergeReason,
      mergeConflicts: [...lifecycleState.mergeConflicts],
      worktreeNotice: lifecycleState.worktreeNotice,
      effectiveBase: lifecycleState.effectiveBase || integrationBranch || null,
      isWorktree: lifecycleState.isWorktree,
      isAutoRebasing: lifecycleState.autoRebasing,
      hasConflictCooldown: Boolean(lifecycleState.rebaseConflictKey),
      hasPendingCheck: lifecycleState.checkTimer !== null,
    };
  }

  function getCarry() {
    if (!lifecycleState.worktreeDir || !lifecycleState.workspace) return null;
    return {
      worktreeDir: lifecycleState.worktreeDir,
      branch: lifecycleState.workspace.branch || null,
      base: lifecycleState.workspace.base || null,
    };
  }

  function setMergeStatus(status, detail = {}, { emit = true } = {}) {
    Object.assign(lifecycleState, projectMergeState(status, detail));
    if (!emit) return;
    port.emit("merge-status", { id, mergeStatus: status, ...detail });
  }

  function effectiveCwd() {
    return lifecycleState.worktreeDir || currentProjectPath();
  }

  function refreshGitContext() {
    const next = detectLinkedWorktree(effectiveCwd());
    if (next === lifecycleState.isWorktree) return false;
    lifecycleState.isWorktree = next;
    return true;
  }

  function resolveCommonGitDir() {
    if (!lifecycleState.worktreeDir) return null;
    try {
      const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: lifecycleState.worktreeDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      });
      return path.resolve(lifecycleState.worktreeDir, commonDir.trim());
    } catch {
      return null;
    }
  }

  function clearCheckTimer() {
    if (!lifecycleState.checkTimer) return;
    clearTimeout(lifecycleState.checkTimer);
    lifecycleState.checkTimer = null;
  }

  function scheduleCheck() {
    const session = port.state();
    if (session.isDestroyed || !lifecycleState.worktreeDir || lifecycleState.checkTimer) return;
    lifecycleState.checkTimer = setTimeout(() => {
      lifecycleState.checkTimer = null;
      api.checkWorktreeChange().catch(() => {});
    }, WORKTREE_CHECK_DEBOUNCE_MS);
    lifecycleState.checkTimer.unref?.();
  }

  function stopWatching() {
    lifecycleState.worktreeWatcher = stopWatcher(lifecycleState.worktreeWatcher);
    lifecycleState.integrationWatcher = stopWatcher(lifecycleState.integrationWatcher);
    lifecycleState.rerereWatcher = stopWatcher(lifecycleState.rerereWatcher);
    clearCheckTimer();
    lifecycleState.lastSignature = null;
  }

  function onRerereRecorded() {
    const session = port.state();
    const verdict = decideRerereCooldownClear({
      enabled: autoRebase !== false && Boolean(gitWorkspace && lifecycleState.workspace),
      hasCooldown: Boolean(lifecycleState.rebaseConflictKey),
      teardownPending: session.isTeardownPending,
    });
    if (!verdict.clear) return;
    port.recordDecision({ kind: "rebase", ts: Date.now(), decision: "cooldown-cleared", reason: verdict.reason });
    lifecycleState.rebaseConflictKey = null;
    scheduleCheck();
  }

  function startWatching() {
    stopWatching();
    const session = port.state();
    if (session.isDestroyed || !lifecycleState.worktreeDir) return;
    const onChange = () => scheduleCheck();
    lifecycleState.worktreeWatcher = createWorktreeWatcher({ worktreeDir: lifecycleState.worktreeDir, onChange });
    lifecycleState.worktreeWatcher.start();
    if (liveWorktreeReview === false || !lifecycleState.commonGitDir || !integrationBranch) return;
    lifecycleState.integrationWatcher = createIntegrationRefWatcher({
      commonGitDir: lifecycleState.commonGitDir,
      branch: integrationBranch,
      onChange,
    });
    lifecycleState.integrationWatcher.start();
    lifecycleState.rerereWatcher = createRerereWatcher({
      commonGitDir: lifecycleState.commonGitDir,
      onChange: onRerereRecorded,
    });
    lifecycleState.rerereWatcher.start();
  }

  /**
   * @param {{ worktreeDir: string, branch: string, base?: string | null, baseSha?: string | null,
   *   hasUnmergedWork?: boolean, watch?: boolean, emit?: boolean }} options
   */
  function adoptWorktree({
    worktreeDir,
    branch,
    base,
    baseSha = null,
    hasUnmergedWork = true,
    watch = true,
    emit = true,
  }) {
    if (!worktreeDir) return;
    lifecycleState.workspace = { cwd: worktreeDir, isGit: true, branch, base: base || integrationBranch, baseSha };
    lifecycleState.worktreeDir = worktreeDir;
    lifecycleState.baseSha = baseSha;
    lifecycleState.commonGitDir = resolveCommonGitDir();
    lifecycleState.isWorktree = true;
    setMergeStatus(hasUnmergedWork ? "pending-review" : "none", {}, { emit });
    if (watch) startWatching();
  }

  async function provision() {
    if (!gitWorkspace || !integrationBranch) return true;
    if (lifecycleState.worktreeDir && fs.existsSync(lifecycleState.worktreeDir)) return true;
    let workspace;
    try {
      workspace = await gitWorkspace.create({
        projectPath: currentProjectPath(),
        teamId: "session",
        label: id,
        baseBranch: integrationBranch,
        worktreeBase: worktreeRoot,
        shareList: worktreeShare,
      });
    } catch (error) {
      console.warn(`[session ${id}] worktree create failed: ${error.message} - running in place`);
      return true;
    }
    if (workspace?.reason === "no-base-branch") {
      lifecycleState.worktreeNotice = `Integration branch "${integrationBranch}" not found. Create it, then start this session.`;
      port.emit("worktree-blocked", { id, branch: integrationBranch, notice: lifecycleState.worktreeNotice });
      return false;
    }
    if (workspace?.reason === "branch-in-use") {
      let adopted = false;
      if (workspace.branch && workspace.conflictPath && fs.existsSync(workspace.conflictPath)
          && !isSameDirectoryPath(workspace.conflictPath, currentProjectPath())) {
        try {
          adoptWorktree({ worktreeDir: workspace.conflictPath, branch: workspace.branch, base: integrationBranch });
          adopted = true;
        } catch (error) {
          console.warn(`[session ${id}] survivor adopt failed: ${error.message} - running in place`);
        }
      }
      if (adopted && lifecycleState.worktreeDir) {
        lifecycleState.worktreeNotice = null;
        await Promise.resolve(gitWorkspace.populate({
          projectPath: currentProjectPath(),
          wtDir: lifecycleState.worktreeDir,
          shareList: worktreeShare,
        })).catch(() => {});
        port.emit("worktree-ready", { id, worktreeDir: lifecycleState.worktreeDir, branch: workspace.branch });
        return true;
      }
      lifecycleState.worktreeNotice = `session branch already checked out at ${workspace.conflictPath}; running in place`;
      port.emit("worktree-blocked", { id, branch: integrationBranch, notice: lifecycleState.worktreeNotice });
    }
    if (!workspace || !workspace.isGit) {
      lifecycleState.worktreeDir = null;
      lifecycleState.isWorktree = false;
      return true;
    }
    lifecycleState.workspace = workspace;
    lifecycleState.worktreeDir = workspace.cwd;
    lifecycleState.commonGitDir = resolveCommonGitDir();
    lifecycleState.baseSha = workspace.baseSha || null;
    lifecycleState.worktreeNotice = null;
    setMergeStatus("none", {}, { emit: false });
    lifecycleState.isWorktree = true;
    port.emit("worktree-ready", { id, worktreeDir: workspace.cwd, branch: workspace.branch });
    return true;
  }

  async function hasUnmergedWork() {
    if (!lifecycleState.worktreeDir) return false;
    if (!gitWorkspace || !lifecycleState.workspace) return true;
    try {
      return await gitWorkspace.hasUnmergedWork({ projectPath: currentProjectPath(), workspace: lifecycleState.workspace, integrationBranch });
    } catch {
      return true;
    }
  }

  function clearWorktreeState(status) {
    lifecycleState.workspace = null;
    lifecycleState.worktreeDir = null;
    lifecycleState.commonGitDir = null;
    lifecycleState.isWorktree = false;
    setMergeStatus(status);
  }

  async function discardWorktree() {
    stopWatching();
    if (gitWorkspace && lifecycleState.workspace) {
      try { await gitWorkspace.discard({ projectPath: currentProjectPath(), workspace: lifecycleState.workspace }); } catch {}
    }
    clearWorktreeState("none");
  }

  async function discardIfClean() {
    if (!lifecycleState.worktreeDir) return false;
    if (await hasUnmergedWork()) return false;
    await discardWorktree();
    return true;
  }

  async function settleOnExit() {
    const session = port.state();
    if (session.isDestroyed || !gitWorkspace || !lifecycleState.workspace) return;
    if (!RESTARTABLE_STATES.includes(session.state)) return;
    if (await discardIfClean()) return;
    setMergeStatus("pending-review");
  }

  function pasteMergePrompt() {
    const session = port.state();
    if (session.isDestroyed) return { ok: false, reason: "destroyed" };
    if (lifecycleState.mergeStatus !== "parked") return { ok: false, reason: "not-parked" };
    if (!session.hasLivePty) return { ok: false, reason: "no-pty" };
    return port.pasteText(buildMergePrompt({
      branch: lifecycleState.workspace?.branch || null,
      target: integrationBranch,
      reason: lifecycleState.mergeReason,
      conflicts: lifecycleState.mergeConflicts,
      worktreeDir: lifecycleState.worktreeDir,
    }));
  }

  async function resolveEffectiveBase(opts) {
    const upstream = (await gitOut(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "HEAD@{upstream}"], opts)).trim();
    const hasUpstream = Boolean(upstream) && !upstream.includes("@{");
    const branch = hasUpstream ? (await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], opts)).trim() : "";
    if (hasUpstream && !isOwnRemoteCopy(upstream, branch)) {
      lifecycleState.effectiveBase = upstream;
      return upstream;
    }
    lifecycleState.effectiveBase = integrationBranch || null;
    return lifecycleState.effectiveBase;
  }

  async function resolveVerifiedBaseRef(run, opts, { swallowResolveError = false } = {}) {
    let verifiedRef = null;
    try {
      const candidate = await resolveEffectiveBase(opts);
      if (candidate && (await run(["rev-parse", "--verify", "--quiet", candidate])).trim()) verifiedRef = candidate;
    } catch (error) {
      if (!swallowResolveError) throw error;
    }
    if (verifiedRef) return { ref: verifiedRef, verified: true };
    return { ref: lifecycleState.baseSha || null, verified: false };
  }

  async function getDiff() {
    const empty = { stat: "", diff: "" };
    if (!lifecycleState.worktreeDir) return { committed: empty, uncommitted: empty, hasCommits: false };
    const opts = { cwd: lifecycleState.worktreeDir, encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 * 1024 };
    const run = (args) => gitOut(args, opts);
    await run(["add", "-N", "--", "."]);
    let base = "";
    let aheadCount = "0";
    const { ref: baseRef, verified } = await resolveVerifiedBaseRef(run, opts);
    if (verified) {
      base = (await run(["merge-base", baseRef, "HEAD"])).trim();
      aheadCount = (await run(["rev-list", "--count", `${baseRef}..HEAD`])).trim();
    }
    if (!verified && baseRef) {
      base = baseRef;
      aheadCount = (await run(["rev-list", "--count", `${base}..HEAD`])).trim();
    }
    const committed = base
      ? { stat: (await run(["diff", "--stat", `${base}..HEAD`])).trim(), diff: await run(["diff", `${base}..HEAD`]) }
      : empty;
    const uncommitted = { stat: (await run(["diff", "--stat", "HEAD"])).trim(), diff: await run(["diff", "HEAD"]) };
    const healed = decideDiffSelfHeal(lifecycleState.mergeStatus, committed.diff, uncommitted.diff);
    if (healed) setMergeStatus(healed);
    return { committed, uncommitted, hasCommits: aheadCount !== "" && aheadCount !== "0" };
  }

  function noUpstream(branch) {
    return {
      branch: branch || null,
      upstream: null,
      state: decideBranchSyncState({ hasUpstream: false }),
      ahead: 0,
      behind: 0,
      fetched: null,
    };
  }

  async function branchUpstream(branch, opts) {
    const upstream = (await gitOut(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`], opts)).trim();
    return upstream && !upstream.includes("@{") ? upstream : null;
  }

  async function fetchBranch(remote, branch, opts) {
    try {
      await gitStrict(["fetch", "--quiet", remote, branch], { ...opts, timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  async function branchCounts(upstream, branch, opts) {
    const counts = parseLeftRightCount(await gitOut(["rev-list", "--left-right", "--count", `${upstream}...${branch}`], opts));
    return {
      ahead: counts ? counts.ahead : 0,
      behind: counts ? counts.behind : 0,
      state: decideBranchSyncState({ hasUpstream: true, ahead: counts?.ahead, behind: counts?.behind }),
    };
  }

  async function getBranchSync() {
    const branch = integrationBranch;
    if (!branch || !currentProjectPath()) return noUpstream(branch);
    const opts = { cwd: currentProjectPath(), encoding: "utf8", timeout: 10000 };
    const upstream = await branchUpstream(branch, opts);
    if (!upstream) return noUpstream(branch);
    const fetched = await fetchBranch(parseRemoteFromUpstream(upstream), branch, opts);
    return { branch, upstream, fetched, ...(await branchCounts(upstream, branch, opts)) };
  }

  async function resyncBranchBody() {
    const branch = integrationBranch;
    if (!branch || !currentProjectPath()) return { ...noUpstream(branch), action: "none", error: null };
    const opts = { cwd: currentProjectPath(), encoding: "utf8", timeout: 10000 };
    const upstream = await branchUpstream(branch, opts);
    if (!upstream) return { ...noUpstream(branch), action: "none", error: null };
    const remote = parseRemoteFromUpstream(upstream);
    const fetched = await fetchBranch(remote, branch, opts);
    const before = await branchCounts(upstream, branch, opts);
    const checkedOut = (await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], opts)).trim();
    const decision = decideResyncAction(before.state, checkedOut === branch);
    let action = "none";
    let error = null;
    const command = RESYNC_COMMANDS[decision]?.({ upstream, branch, remote, opts });
    if (command) {
      try {
        await gitStrict(command.args, command.opts);
        action = command.successAction;
      } catch (commandError) {
        error = firstGitErrorLine(commandError);
      }
    }
    return { branch, upstream, fetched, ...(await branchCounts(upstream, branch, opts)), action, error };
  }

  function resyncBranch() {
    if (lifecycleState.resyncPromise) return lifecycleState.resyncPromise;
    lifecycleState.resyncPromise = resyncBranchBody().finally(() => { lifecycleState.resyncPromise = null; });
    return lifecycleState.resyncPromise;
  }

  async function computeWorktreeSignature() {
    if (!lifecycleState.worktreeDir) return null;
    const opts = { cwd: lifecycleState.worktreeDir, encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024 };
    const run = (args) => gitStrict(["--no-optional-locks", ...args], opts);
    let status;
    let head;
    let ahead = "0";
    let behind = "0";
    let rebaseInProgress = false;
    let targetSha = null;
    try {
      status = await run(["status", "--porcelain"]);
      head = (await run(["rev-parse", "HEAD"])).trim();
      const { ref: baseRef } = await resolveVerifiedBaseRef(run, opts, { swallowResolveError: true });
      if (baseRef) ahead = (await run(["rev-list", "--count", `${baseRef}..HEAD`])).trim();
      try {
        const mergeTarget = integrationBranch || lifecycleState.workspace?.base || lifecycleState.baseSha;
        const resolvedTarget = mergeTarget ? (await run(["rev-parse", "--verify", "--quiet", mergeTarget])).trim() : "";
        if (resolvedTarget) {
          targetSha = resolvedTarget;
          behind = (await run(["rev-list", "--count", `HEAD..${mergeTarget}`])).trim();
        }
      } catch {}
      const rebaseMerge = (await run(["rev-parse", "--git-path", "rebase-merge"])).trim();
      const rebaseApply = (await run(["rev-parse", "--git-path", "rebase-apply"])).trim();
      const resolveGitPath = (gitPath) => path.isAbsolute(gitPath) ? gitPath : path.resolve(lifecycleState.worktreeDir, gitPath);
      rebaseInProgress = fs.existsSync(resolveGitPath(rebaseMerge)) || fs.existsSync(resolveGitPath(rebaseApply));
    } catch {
      return null;
    }
    const sig = crypto.createHash("sha1").update(`${status} ${head} ${ahead}`).digest("hex");
    return { sig, dirty: status.trim() !== "", ahead, behind, rebaseInProgress, headSha: head, targetSha };
  }

  async function maybeAutoRebase(signature) {
    if (lifecycleState.autoRebasing) return;
    const session = port.state();
    const currentKey = `${signature.headSha || ""}::${signature.targetSha || ""}`;
    const verdict = decideAutoRebase({
      enabled: autoRebase !== false && Boolean(gitWorkspace && lifecycleState.workspace),
      state: session.state,
      mergeStatus: lifecycleState.mergeStatus,
      dirty: signature.dirty,
      behind: signature.behind,
      rebaseInProgress: signature.rebaseInProgress,
      teardownPending: session.isTeardownPending,
      currentKey,
      lastConflictKey: lifecycleState.rebaseConflictKey,
    });
    if (verdict.action !== "rebase") return;
    lifecycleState.autoRebasing = true;
    try {
      const rebase = await gitWorkspace.rebaseOnly({
        projectPath: currentProjectPath(),
        workspace: lifecycleState.workspace,
        targetBranch: integrationBranch,
      });
      const currentSession = port.state();
      if (!AUTO_REBASE_STATES.includes(currentSession.state)) {
        port.recordDecision({ kind: "rebase", ts: Date.now(), decision: "state-moved", state: currentSession.state });
      }
      if (rebase?.ok && rebase.rebased) {
        lifecycleState.rebaseConflictKey = null;
        if (rebase.baseSha) {
          lifecycleState.baseSha = rebase.baseSha;
          lifecycleState.workspace.baseSha = rebase.baseSha;
        }
        port.recordDecision({
          kind: "rebase",
          ts: Date.now(),
          decision: "auto-rebased",
          from: signature.headSha || null,
          to: rebase.headSha || null,
          rerereReplayed: rebase.rerereReplayed === true,
        });
        return;
      }
      if (rebase?.reason === "rebase-conflict") {
        lifecycleState.rebaseConflictKey = currentKey;
        port.recordDecision({ kind: "rebase", ts: Date.now(), decision: "conflict", conflicts: rebase.conflicts || [] });
      }
    } catch (error) {
      console.warn(`[session ${id}] auto-rebase failed: ${error.message}`);
    } finally {
      lifecycleState.autoRebasing = false;
      scheduleCheck();
    }
  }

  async function checkWorktreeChange(signatureOverride) {
    let session = port.state();
    if (session.isDestroyed || !lifecycleState.worktreeDir || lifecycleState.mergeStatus === "merging") return;
    if (lifecycleState.autoRebasing) return;
    const signature = signatureOverride || await api.computeWorktreeSignature();
    session = port.state();
    if (session.isDestroyed || lifecycleState.mergeStatus === "merging" || !signature) return;
    const nextStatus = decideSignatureDemotion(lifecycleState.mergeStatus, signature);
    const demoted = nextStatus !== null;
    if (demoted) setMergeStatus(nextStatus);
    await maybeAutoRebase(signature);
    session = port.state();
    if (session.isDestroyed || lifecycleState.mergeStatus === "merging") return;
    if (signature.sig === lifecycleState.lastSignature && !demoted) return;
    lifecycleState.lastSignature = signature.sig;
    port.emit("worktree-changed", { id, sig: signature.sig });
  }

  async function runMergeEngine(method) {
    setMergeStatus("merging");
    try {
      return { result: await gitWorkspace[method]({
        projectPath: currentProjectPath(),
        workspace: lifecycleState.workspace,
        targetBranch: integrationBranch,
      }) };
    } catch (error) {
      setMergeStatus("pending-review", { reason: error.message });
      return { failure: { merged: false, reason: error.message } };
    }
  }

  function applyParkedOrPending(mergeResult) {
    if (mergeResult.parked) {
      setMergeStatus("parked", { reason: mergeResult.reason || null, conflicts: mergeResult.conflicts || [] });
      return mergeResult;
    }
    setMergeStatus("pending-review", { reason: mergeResult.reason || null });
    return mergeResult;
  }

  async function mergeWorktree() {
    if (!gitWorkspace || !lifecycleState.workspace) return { merged: false, refused: true, reason: "no-worktree" };
    if (lifecycleState.mergeStatus === "merging") return { merged: false, refused: true, reason: "merge-in-progress" };
    const { result, failure } = await runMergeEngine("mergeBack");
    if (failure) return failure;
    if (!result.merged) return applyParkedOrPending(result);
    stopWatching();
    clearWorktreeState("merged");
    return result;
  }

  async function mergeAndContinue({ force = false } = {}) {
    const session = port.state();
    if (session.isDestroyed) return { merged: false, refused: true, reason: "destroyed" };
    if (!gitWorkspace || !lifecycleState.workspace) return { merged: false, refused: true, reason: "no-worktree" };
    const runningOverride = force && session.state === STATES.RUNNING;
    if (!MERGEABLE_LIVE_STATES.includes(session.state) && !runningOverride) {
      return { merged: false, refused: true, reason: "not-continuable" };
    }
    if (lifecycleState.mergeStatus === "merging") return { merged: false, refused: true, reason: "merge-in-progress" };
    const { result, failure } = await runMergeEngine("mergeKeep");
    if (failure) return failure;
    if (result.merged) {
      if (result.baseSha) {
        lifecycleState.baseSha = result.baseSha;
        lifecycleState.workspace.baseSha = result.baseSha;
      }
      if (!result.restoreConflict) {
        setMergeStatus("none");
        return result;
      }
      setMergeStatus("pending-review", { reason: "restore-conflict" });
      return result;
    }
    if (!result.parked && result.reason === "nothing-to-commit") {
      setMergeStatus("none");
      return result;
    }
    return applyParkedOrPending(result);
  }

  const api = {
    snapshot,
    getCarry,
    effectiveCwd,
    refreshGitContext,
    provision,
    settleOnExit,
    discardIfClean,
    setMergeStatus,
    pasteMergePrompt,
    hasUnmergedWork,
    getDiff,
    resolveEffectiveBase,
    getBranchSync,
    resyncBranch,
    computeWorktreeSignature,
    checkWorktreeChange,
    scheduleCheck,
    startWatching,
    stopWatching,
    mergeWorktree,
    mergeAndContinue,
    adoptWorktree,
    discardWorktree,
  };
  return api;
}

module.exports = { createSessionWorktreeLifecycle, WORKTREE_CHECK_DEBOUNCE_MS };
