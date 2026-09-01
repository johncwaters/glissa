import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, execFile } from "../server/child-process-safe.js";
import { isSameDirectoryPath } from "../shared/paths.ts";
import { STATES, MERGEABLE_LIVE_STATES, RESTARTABLE_STATES } from "../shared/states.ts";
import type { SessionState } from "../shared/states.ts";
import { createWorktreeWatcher, readWorktreeGitdirPointer } from "../detection/worktree-watch.ts";
import { createIntegrationRefWatcher } from "../detection/integration-ref-watch.ts";
import { createRerereWatcher } from "../detection/rerere-watch.ts";
import { buildMergePrompt } from "./core/merge-prompt.ts";
import { decideSignatureDemotion, decideBaseSyncDemotion, decideDiffSelfHeal } from "./core/merge-gate.ts";
import { decideAutoRebase, decideRerereCooldownClear, AUTO_REBASE_STATES, SPAWN_GAP_TRIGGER } from "./core/rebase-gate.ts";
import { projectMergeState } from "./core/worktree-state.ts";
import type { MergeStatus } from "./core/worktree-state.ts";
import type { DecisionEntry } from "./core/decision-log.ts";
import {
  GIT_FETCH_TIMEOUT_MS,
  parseLeftRightCount,
  decideBranchSyncState,
  parseRemoteFromUpstream,
  decideResyncAction,
  buildResyncCommand,
  firstGitErrorLine,
} from "../server/core/branch-sync-core.ts";

const WORKTREE_CHECK_DEBOUNCE_MS = 400;

interface Workspace {
  cwd: string;
  isGit: boolean;
  branch?: string | null;
  base?: string | null;
  baseSha?: string | null;
  reason?: string;
  conflictPath?: string;
  warning?: string | null;
}

interface SessionSnapshot {
  state: SessionState;
  isDestroyed: boolean;
  isTeardownPending: boolean;
  hasLivePty: boolean;
}

interface MergeResult {
  merged: boolean;
  parked?: boolean;
  refused?: boolean;
  reason?: string;
  conflicts?: string[];
  baseSha?: string;
  restoreConflict?: boolean;
  warning?: string;
  // Reported by the engine for the caller's logs; the lifecycle itself reads neither.
  branch?: string | null;
  base?: string | null;
  kept?: boolean;
}

interface BranchSyncResult {
  branch: string | null;
  upstream: string | null;
  state: string;
  ahead: number;
  behind: number;
  fetched: boolean | null;
  action: string;
  error: string | null;
}

interface RebaseResult {
  ok?: boolean;
  upToDate?: boolean;
  rebased?: boolean;
  baseSha?: string;
  headSha?: string;
  rerereReplayed?: boolean;
  reason?: string;
  conflicts?: string[];
}

// Every engine verb takes one option bag; its keys differ per verb and the engine reads them itself,
// so the seam names the bag rather than restating each shape.
type WorkspaceArgs = Record<string, unknown>;

interface IntegrationSyncResult {
  outcome: string;
  from: string | null;
  to: string | null;
  error?: string;
}

interface GitWorkspace {
  create: (args: WorkspaceArgs) => Workspace | Promise<Workspace>;
  populate: (args: WorkspaceArgs) => unknown;
  hasUnmergedWork: (args: WorkspaceArgs) => boolean | Promise<boolean>;
  discard: (args: WorkspaceArgs) => unknown;
  mergeBack: (args: WorkspaceArgs) => MergeResult | Promise<MergeResult>;
  mergeKeep: (args: WorkspaceArgs) => MergeResult | Promise<MergeResult>;
  rebaseOnly: (args: WorkspaceArgs) => Promise<RebaseResult>;
  syncIntegrationBranch?: (args: WorkspaceArgs) => Promise<IntegrationSyncResult>;
  detectDefaultBranch?: (options: { projectPath: string }) => Promise<string | null>;
}

interface SessionPort {
  state: () => SessionSnapshot;
  projectPath?: () => string;
  emit: (event: string, detail: Record<string, unknown>) => void;
  recordDecision: (entry: DecisionEntry) => void;
  pasteText: (text: string) => Record<string, unknown>;
}

interface WorktreeLifecycleOptions {
  id: string;
  projectPath: string;
  integrationBranch?: string | null;
  gitWorkspace?: GitWorkspace | null;
  autoRebase?: boolean;
  syncOnStart?: boolean;
  liveWorktreeReview?: boolean;
  worktreeRoot?: string | null;
  worktreeShare?: string[] | null;
  port: SessionPort;
}

interface WorktreeLifecycleState {
  worktreeDir: string | null;
  commonGitDir: string | null;
  baseSha: string | null;
  workspace: Workspace | null;
  mergeStatus: MergeStatus;
  mergeReason: string | null;
  mergeConflicts: string[];
  worktreeNotice: string | null;
  effectiveBase: string | null;
  isWorktree: boolean;
  autoRebasing: boolean;
  rebaseConflictKey: string | null;
  resyncPromise: Promise<BranchSyncResult> | null;
  worktreeWatcher: ReturnType<typeof createWorktreeWatcher> | null;
  integrationWatcher: ReturnType<typeof createIntegrationRefWatcher> | null;
  rerereWatcher: ReturnType<typeof createRerereWatcher> | null;
  checkTimer: NodeJS.Timeout | null;
  lastSignature: string | null;
}

interface AdoptWorktreeOptions {
  worktreeDir: string;
  branch: string | null;
  base?: string | null;
  baseSha?: string | null;
  hasUnmergedWork?: boolean;
  watch?: boolean;
  emit?: boolean;
}

interface WorktreeSignature {
  sig: string;
  dirty: boolean;
  ahead: string;
  behind: string;
  rebaseInProgress: boolean;
  headSha: string;
  targetSha: string | null;
}

type GitOptions = Record<string, unknown>;

// A discriminated pair so `if (failure) return failure` narrows `result` to the merge that ran.
type MergeEngineOutcome =
  | { result: MergeResult; failure?: undefined }
  | { result?: undefined; failure: MergeResult };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gitOut(args: string[], opts: GitOptions): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, opts, (_error: unknown, stdout: unknown) => resolve(stdout != null ? String(stdout) : ""));
  });
}

function gitStrict(args: string[], opts: GitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, opts, (error: unknown, stdout: unknown) => {
      if (error) return reject(error);
      resolve(stdout != null ? String(stdout) : "");
    });
  });
}

function stopWatcher(watcher: { stop: () => void } | null): null {
  if (!watcher) return null;
  try { watcher.stop(); } catch {}
  return null;
}

function detectLinkedWorktree(directory: string): boolean {
  return readWorktreeGitdirPointer(directory) !== null;
}

function branchFromRemoteRef(upstream: string): string {
  const separatorIndex = upstream.indexOf("/");
  if (separatorIndex === -1) return upstream;
  return upstream.slice(separatorIndex + 1);
}

function isOwnRemoteCopy(upstream: string, branch: string): boolean {
  return branchFromRemoteRef(upstream) === branch;
}

function createSessionWorktreeLifecycle({
  id,
  projectPath,
  integrationBranch = null,
  gitWorkspace = null,
  autoRebase = true,
  syncOnStart = true,
  liveWorktreeReview = true,
  worktreeRoot = null,
  worktreeShare = null,
  port,
}: WorktreeLifecycleOptions) {
  const currentProjectPath = (): string => port.projectPath ? port.projectPath() : projectPath;
  const lifecycleState: WorktreeLifecycleState = {
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

  function effectiveIntegrationBranch() {
    return lifecycleState.workspace?.base || lifecycleState.effectiveBase || integrationBranch || null;
  }

  function snapshot() {
    return {
      worktreeDir: lifecycleState.worktreeDir,
      commonGitDir: lifecycleState.commonGitDir,
      baseSha: lifecycleState.baseSha,
      mergeStatus: lifecycleState.mergeStatus,
      mergeReason: lifecycleState.mergeReason,
      mergeConflicts: [...lifecycleState.mergeConflicts],
      worktreeNotice: lifecycleState.worktreeNotice,
      effectiveBase: effectiveIntegrationBranch(),
      isWorktree: lifecycleState.isWorktree,
      isAutoRebasing: lifecycleState.autoRebasing,
      hasConflictCooldown: Boolean(lifecycleState.rebaseConflictKey),
      hasPendingCheck: lifecycleState.checkTimer !== null,
    };
  }

  function getCarry(): { worktreeDir: string; branch: string | null; base: string | null } | null {
    if (!lifecycleState.worktreeDir || !lifecycleState.workspace) return null;
    return {
      worktreeDir: lifecycleState.worktreeDir,
      branch: lifecycleState.workspace.branch || null,
      base: lifecycleState.workspace.base || null,
    };
  }

  function setMergeStatus(status: MergeStatus, detail: Record<string, unknown> = {}, { emit = true }: { emit?: boolean } = {}): void {
    Object.assign(lifecycleState, projectMergeState(status, detail));
    if (!emit) return;
    port.emit("merge-status", { id, mergeStatus: status, ...detail });
  }

  const isMerging = (): boolean => lifecycleState.mergeStatus === "merging";

  function effectiveCwd(): string {
    return lifecycleState.worktreeDir || currentProjectPath();
  }

  function refreshGitContext(): boolean {
    const next = detectLinkedWorktree(effectiveCwd());
    if (next === lifecycleState.isWorktree) return false;
    lifecycleState.isWorktree = next;
    return true;
  }

  function resolveCommonGitDir(): string | null {
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

  function clearCheckTimer(): void {
    if (!lifecycleState.checkTimer) return;
    clearTimeout(lifecycleState.checkTimer);
    lifecycleState.checkTimer = null;
  }

  function scheduleCheck(): void {
    const session = port.state();
    if (session.isDestroyed || !lifecycleState.worktreeDir || lifecycleState.checkTimer) return;
    lifecycleState.checkTimer = setTimeout(() => {
      lifecycleState.checkTimer = null;
      api.checkWorktreeChange().catch(() => {});
    }, WORKTREE_CHECK_DEBOUNCE_MS);
    lifecycleState.checkTimer.unref?.();
  }

  function stopWatching(): void {
    lifecycleState.worktreeWatcher = stopWatcher(lifecycleState.worktreeWatcher);
    lifecycleState.integrationWatcher = stopWatcher(lifecycleState.integrationWatcher);
    lifecycleState.rerereWatcher = stopWatcher(lifecycleState.rerereWatcher);
    clearCheckTimer();
    lifecycleState.lastSignature = null;
  }

  function onRerereRecorded(): void {
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

  function startWatching(): void {
    stopWatching();
    const session = port.state();
    if (session.isDestroyed || !lifecycleState.worktreeDir) return;
    const onChange = (): void => scheduleCheck();
    lifecycleState.worktreeWatcher = createWorktreeWatcher({ worktreeDir: lifecycleState.worktreeDir, onChange });
    lifecycleState.worktreeWatcher.start();
    const watchedBranch = effectiveIntegrationBranch();
    if (liveWorktreeReview === false || !lifecycleState.commonGitDir || !watchedBranch) return;
    lifecycleState.integrationWatcher = createIntegrationRefWatcher({
      commonGitDir: lifecycleState.commonGitDir,
      branch: watchedBranch,
      onChange,
    });
    lifecycleState.integrationWatcher.start();
    lifecycleState.rerereWatcher = createRerereWatcher({
      commonGitDir: lifecycleState.commonGitDir,
      onChange: onRerereRecorded,
    });
    lifecycleState.rerereWatcher.start();
  }

  function adoptWorktree({
    worktreeDir,
    branch,
    base,
    baseSha = null,
    hasUnmergedWork: hasUnmerged = true,
    watch = true,
    emit = true,
  }: AdoptWorktreeOptions): void {
    if (!worktreeDir) return;
    const resolvedBase = base || integrationBranch || null;
    lifecycleState.workspace = { cwd: worktreeDir, isGit: true, branch, base: resolvedBase, baseSha };
    lifecycleState.effectiveBase = resolvedBase;
    lifecycleState.worktreeDir = worktreeDir;
    lifecycleState.baseSha = baseSha;
    lifecycleState.commonGitDir = resolveCommonGitDir();
    lifecycleState.isWorktree = true;
    setMergeStatus(hasUnmerged ? "pending-review" : "none", {}, { emit });
    if (watch) startWatching();
  }

  function syncableGitWorkspace(): (GitWorkspace & Required<Pick<GitWorkspace, "syncIntegrationBranch">>) | null {
    if (syncOnStart === false) return null;
    if (!gitWorkspace || typeof gitWorkspace.syncIntegrationBranch !== "function") return null;
    return gitWorkspace as GitWorkspace & Required<Pick<GitWorkspace, "syncIntegrationBranch">>;
  }

  async function resolveBaseForStart(): Promise<string | null> {
    const resolvedBase = effectiveIntegrationBranch();
    if (resolvedBase) return resolvedBase;
    if (!gitWorkspace || typeof gitWorkspace.detectDefaultBranch !== "function") return null;
    const detectedBase = await gitWorkspace.detectDefaultBranch({ projectPath: currentProjectPath() });
    lifecycleState.effectiveBase = detectedBase;
    return detectedBase;
  }

  async function syncIntegrationBranchForStart(
    trigger: string,
    branch: string | null,
  ): Promise<IntegrationSyncResult | null> {
    const syncGitWorkspace = syncableGitWorkspace();
    if (!syncGitWorkspace || !branch) return null;
    try {
      const sync = await syncGitWorkspace.syncIntegrationBranch({
        projectPath: currentProjectPath(),
        branch,
      });
      port.recordDecision({
        kind: "integration-sync",
        ts: Date.now(),
        decision: trigger,
        outcome: sync.outcome,
        from: sync.from,
        to: sync.to,
      });
      if (sync.outcome === "fetch-failed" || sync.outcome === "update-failed") {
        const detail = sync.error ? `${sync.outcome}: ${sync.error}` : sync.outcome;
        console.warn(`[session ${id}] integration sync failed during ${trigger}: ${detail}`);
      }
      return sync;
    } catch (error) {
      console.warn(`[session ${id}] integration sync failed during ${trigger}: ${errorMessage(error)}`);
      return null;
    }
  }

  function forkSyncWarning(sync: IntegrationSyncResult | null, branch: string | null): string | null {
    if (!sync || !branch) return null;
    if (sync.outcome === "diverged") return `base ${branch} has diverged from origin/${branch}; forked from local`;
    if (sync.outcome === "fetch-failed") return `could not fetch origin/${branch}; forked from local`;
    if (sync.outcome === "checked-out" || sync.outcome === "update-failed") {
      return `could not fast-forward ${branch} from origin/${branch}; forked from local`;
    }
    return null;
  }

  async function syncFreshWorktree(): Promise<void> {
    // The switch gates BOTH halves. With syncOnStart off there is no sync AND no replay: the operator who
    // turned the feature off would otherwise still get an unattended rewrite of their worktree in the
    // spawn gap, which is the half of it they can actually feel.
    if (!syncableGitWorkspace()) return;
    const branch = await resolveBaseForStart();
    await syncIntegrationBranchForStart(SPAWN_GAP_TRIGGER, branch);
    if (port.state().isDestroyed) return;
    if (!lifecycleState.workspace) return;
    const signature = await api.computeWorktreeSignature();
    if (!signature) return;
    await runAutoRebase(SPAWN_GAP_TRIGGER, signature);
  }

  async function provision({ fresh = false }: { fresh?: boolean } = {}): Promise<boolean> {
    if (!gitWorkspace) return true;
    if (lifecycleState.worktreeDir && fs.existsSync(lifecycleState.worktreeDir)) {
      if (fresh) await syncFreshWorktree();
      return true;
    }
    const baseBranch = await resolveBaseForStart();
    const initialSync = await syncIntegrationBranchForStart("initial-create", baseBranch);
    if (port.state().isDestroyed) return false;
    let workspace: Workspace;
    try {
      workspace = await gitWorkspace.create({
        projectPath: currentProjectPath(),
        teamId: "session",
        label: id,
        baseBranch,
        worktreeBase: worktreeRoot,
        shareList: worktreeShare,
      });
    } catch (error) {
      console.warn(`[session ${id}] worktree create failed: ${errorMessage(error)} - running in place`);
      return true;
    }
    if (workspace?.reason === "no-base-branch") {
      lifecycleState.worktreeNotice = integrationBranch
        ? `Integration branch "${integrationBranch}" not found. Create it, then start this session.`
        : "No default branch found. Configure integrationBranch or create main or master, then start this session.";
      port.emit("worktree-blocked", { id, branch: integrationBranch, notice: lifecycleState.worktreeNotice });
      return false;
    }
    if (workspace?.reason === "branch-in-use") {
      let adopted = false;
      if (workspace.branch && workspace.conflictPath && fs.existsSync(workspace.conflictPath)
          && !isSameDirectoryPath(workspace.conflictPath, currentProjectPath())) {
        try {
          adoptWorktree({ worktreeDir: workspace.conflictPath, branch: workspace.branch, base: workspace.base || integrationBranch });
          adopted = true;
        } catch (error) {
          console.warn(`[session ${id}] survivor adopt failed: ${errorMessage(error)} - running in place`);
        }
      }
      if (adopted && lifecycleState.worktreeDir) {
        lifecycleState.worktreeNotice = null;
        await Promise.resolve(gitWorkspace.populate({
          projectPath: currentProjectPath(),
          wtDir: lifecycleState.worktreeDir,
          shareList: worktreeShare,
        })).catch(() => {});
        port.emit("worktree-ready", {
          id,
          worktreeDir: lifecycleState.worktreeDir,
          branch: workspace.branch,
          base: effectiveIntegrationBranch(),
        });
        return true;
      }
      lifecycleState.worktreeNotice = `session branch already checked out at ${workspace.conflictPath}; running in place`;
      port.emit("worktree-blocked", { id, branch: effectiveIntegrationBranch(), notice: lifecycleState.worktreeNotice });
    }
    if (!workspace || !workspace.isGit) {
      lifecycleState.worktreeDir = null;
      lifecycleState.isWorktree = false;
      return true;
    }
    lifecycleState.workspace = workspace;
    lifecycleState.effectiveBase = workspace.base || null;
    lifecycleState.worktreeDir = workspace.cwd;
    lifecycleState.commonGitDir = resolveCommonGitDir();
    lifecycleState.baseSha = workspace.baseSha || null;
    lifecycleState.worktreeNotice = null;
    setMergeStatus("none", {}, { emit: false });
    lifecycleState.isWorktree = true;
    const syncWarning = forkSyncWarning(initialSync, workspace.base || baseBranch);
    if (syncWarning) port.emit("worktree-warning", { id, branch: workspace.base || null, notice: syncWarning });
    port.emit("worktree-ready", { id, worktreeDir: workspace.cwd, branch: workspace.branch, base: workspace.base || null });
    return true;
  }

  async function hasUnmergedWork(): Promise<boolean> {
    if (!lifecycleState.worktreeDir) return false;
    if (!gitWorkspace || !lifecycleState.workspace) return true;
    try {
      return await gitWorkspace.hasUnmergedWork({
        projectPath: currentProjectPath(),
        workspace: lifecycleState.workspace,
        integrationBranch: effectiveIntegrationBranch(),
      });
    } catch {
      return true;
    }
  }

  function clearWorktreeState(status: MergeStatus): void {
    lifecycleState.workspace = null;
    lifecycleState.worktreeDir = null;
    lifecycleState.commonGitDir = null;
    lifecycleState.isWorktree = false;
    setMergeStatus(status);
  }

  async function discardWorktree(): Promise<void> {
    stopWatching();
    if (gitWorkspace && lifecycleState.workspace) {
      try { await gitWorkspace.discard({ projectPath: currentProjectPath(), workspace: lifecycleState.workspace }); } catch {}
    }
    clearWorktreeState("none");
  }

  async function discardIfClean(): Promise<boolean> {
    if (!lifecycleState.worktreeDir) return false;
    if (await hasUnmergedWork()) return false;
    await discardWorktree();
    return true;
  }

  async function settleOnExit(): Promise<void> {
    const session = port.state();
    if (session.isDestroyed || !gitWorkspace || !lifecycleState.workspace) return;
    if (!RESTARTABLE_STATES.includes(session.state)) return;
    if (await discardIfClean()) return;
    setMergeStatus("pending-review");
  }

  function pasteMergePrompt(): Record<string, unknown> {
    const session = port.state();
    if (session.isDestroyed) return { ok: false, reason: "destroyed" };
    if (lifecycleState.mergeStatus !== "parked") return { ok: false, reason: "not-parked" };
    if (!session.hasLivePty) return { ok: false, reason: "no-pty" };
    return port.pasteText(buildMergePrompt({
      branch: lifecycleState.workspace?.branch || undefined,
      target: effectiveIntegrationBranch() || undefined,
      reason: lifecycleState.mergeReason || undefined,
      conflicts: lifecycleState.mergeConflicts,
      worktreeDir: lifecycleState.worktreeDir || undefined,
    }));
  }

  async function resolveEffectiveBase(opts: GitOptions): Promise<string | null> {
    if (lifecycleState.workspace?.base) {
      lifecycleState.effectiveBase = lifecycleState.workspace.base;
      return lifecycleState.effectiveBase;
    }
    const upstream = (await gitOut(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "HEAD@{upstream}"], opts)).trim();
    const hasUpstream = Boolean(upstream) && !upstream.includes("@{");
    const branch = hasUpstream ? (await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], opts)).trim() : "";
    if (hasUpstream && !isOwnRemoteCopy(upstream, branch)) {
      lifecycleState.effectiveBase = branchFromRemoteRef(upstream);
      return upstream;
    }
    lifecycleState.effectiveBase = effectiveIntegrationBranch();
    return lifecycleState.effectiveBase;
  }

  async function resolveVerifiedBaseRef(
    run: (args: string[]) => Promise<string>,
    opts: GitOptions,
    { swallowResolveError = false }: { swallowResolveError?: boolean } = {},
  ): Promise<{ ref: string; verified: true } | { ref: string | null; verified: false }> {
    let verifiedRef: string | null = null;
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
    const run = (args: string[]): Promise<string> => gitOut(args, opts);
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

  function noUpstream(branch: string | null) {
    return {
      branch: branch || null,
      upstream: null,
      state: decideBranchSyncState({ hasUpstream: false }),
      ahead: 0,
      behind: 0,
      fetched: null,
    };
  }

  async function branchUpstream(branch: string, opts: GitOptions): Promise<string | null> {
    const upstream = (await gitOut(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`], opts)).trim();
    return upstream && !upstream.includes("@{") ? upstream : null;
  }

  async function fetchBranch(remote: string, branch: string, opts: GitOptions): Promise<boolean> {
    try {
      await gitStrict(["fetch", "--quiet", remote, branch], {
        ...opts,
        timeout: GIT_FETCH_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return true;
    } catch {
      return false;
    }
  }

  async function branchCounts(upstream: string, branch: string, opts: GitOptions) {
    const counts = parseLeftRightCount(await gitOut(["rev-list", "--left-right", "--count", `${upstream}...${branch}`], opts));
    return {
      ahead: counts ? counts.ahead : 0,
      behind: counts ? counts.behind : 0,
      state: decideBranchSyncState({ hasUpstream: true, ahead: counts?.ahead, behind: counts?.behind }),
    };
  }

  function applyBaseSyncDemotion<T extends { state: string }>(sync: T): T {
    const nextStatus = decideBaseSyncDemotion(
      lifecycleState.mergeStatus,
      lifecycleState.mergeReason,
      sync.state,
    );
    if (nextStatus !== null) setMergeStatus(nextStatus);
    return sync;
  }

  async function getBranchSync() {
    const branch = effectiveIntegrationBranch();
    if (!branch || !currentProjectPath()) return noUpstream(branch);
    const opts = { cwd: currentProjectPath(), encoding: "utf8", timeout: 10000 };
    const upstream = await branchUpstream(branch, opts);
    if (!upstream) return noUpstream(branch);
    const fetched = await fetchBranch(parseRemoteFromUpstream(upstream), branch, opts);
    return applyBaseSyncDemotion({ branch, upstream, fetched, ...(await branchCounts(upstream, branch, opts)) });
  }

  async function resyncBranchBody(): Promise<BranchSyncResult> {
    const branch = effectiveIntegrationBranch();
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
    let error: string | null = null;
    const command = buildResyncCommand(decision, { upstream, branch, remote, opts });
    if (command) {
      try {
        await gitStrict(command.args, command.opts);
        action = command.successAction;
      } catch (commandError) {
        error = firstGitErrorLine(commandError);
      }
    }
    return applyBaseSyncDemotion({ branch, upstream, fetched, ...(await branchCounts(upstream, branch, opts)), action, error });
  }

  function resyncBranch(): Promise<BranchSyncResult> {
    if (lifecycleState.resyncPromise) return lifecycleState.resyncPromise;
    lifecycleState.resyncPromise = resyncBranchBody().finally(() => { lifecycleState.resyncPromise = null; });
    return lifecycleState.resyncPromise;
  }

  async function computeWorktreeSignature(): Promise<WorktreeSignature | null> {
    const worktreeDir = lifecycleState.worktreeDir;
    if (!worktreeDir) return null;
    const opts = { cwd: worktreeDir, encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024 };
    const run = (args: string[]): Promise<string> => gitStrict(["--no-optional-locks", ...args], opts);
    let status: string;
    let head: string;
    let ahead = "0";
    let behind = "0";
    let rebaseInProgress = false;
    let targetSha: string | null = null;
    try {
      status = await run(["status", "--porcelain"]);
      head = (await run(["rev-parse", "HEAD"])).trim();
      const { ref: baseRef } = await resolveVerifiedBaseRef(run, opts, { swallowResolveError: true });
      if (baseRef) ahead = (await run(["rev-list", "--count", `${baseRef}..HEAD`])).trim();
      try {
        const mergeTarget = effectiveIntegrationBranch() || lifecycleState.baseSha;
        const resolvedTarget = mergeTarget ? (await run(["rev-parse", "--verify", "--quiet", mergeTarget])).trim() : "";
        if (resolvedTarget) {
          targetSha = resolvedTarget;
          behind = (await run(["rev-list", "--count", `HEAD..${mergeTarget}`])).trim();
        }
      } catch {}
      const rebaseMerge = (await run(["rev-parse", "--git-path", "rebase-merge"])).trim();
      const rebaseApply = (await run(["rev-parse", "--git-path", "rebase-apply"])).trim();
      const resolveGitPath = (gitPath: string): string => path.isAbsolute(gitPath) ? gitPath : path.resolve(worktreeDir, gitPath);
      rebaseInProgress = fs.existsSync(resolveGitPath(rebaseMerge)) || fs.existsSync(resolveGitPath(rebaseApply));
    } catch {
      return null;
    }
    const sig = crypto.createHash("sha1").update(`${status} ${head} ${ahead}`).digest("hex");
    return { sig, dirty: status.trim() !== "", ahead, behind, rebaseInProgress, headSha: head, targetSha };
  }

  async function runAutoRebase(trigger: string, signature: WorktreeSignature): Promise<void> {
    if (lifecycleState.autoRebasing) return;
    const session = port.state();
    if (session.isDestroyed) return;
    const currentKey = `${signature.headSha || ""}::${signature.targetSha || ""}`;
    const verdict = decideAutoRebase({
      enabled: autoRebase !== false && Boolean(gitWorkspace && lifecycleState.workspace),
      trigger,
      state: session.state,
      hasLivePty: session.hasLivePty,
      mergeStatus: lifecycleState.mergeStatus,
      dirty: signature.dirty,
      behind: signature.behind,
      rebaseInProgress: signature.rebaseInProgress,
      teardownPending: session.isTeardownPending,
      currentKey,
      lastConflictKey: lifecycleState.rebaseConflictKey,
    });
    if (verdict.action !== "rebase") {
      if (trigger === SPAWN_GAP_TRIGGER) {
        port.recordDecision({ kind: "rebase", ts: Date.now(), decision: "skipped", trigger, reason: verdict.reason });
      }
      return;
    }
    if (!gitWorkspace || !lifecycleState.workspace) return;
    const workspace = lifecycleState.workspace;
    lifecycleState.autoRebasing = true;
    try {
      const rebase = await gitWorkspace.rebaseOnly({
        projectPath: currentProjectPath(),
        workspace,
        targetBranch: effectiveIntegrationBranch(),
      });
      const currentSession = port.state();
      if (trigger !== SPAWN_GAP_TRIGGER && !AUTO_REBASE_STATES.includes(currentSession.state)) {
        port.recordDecision({ kind: "rebase", ts: Date.now(), decision: "state-moved", state: currentSession.state });
      }
      if (rebase?.ok && rebase.rebased) {
        lifecycleState.rebaseConflictKey = null;
        if (rebase.baseSha) {
          lifecycleState.baseSha = rebase.baseSha;
          workspace.baseSha = rebase.baseSha;
        }
        port.recordDecision({
          kind: "rebase",
          ts: Date.now(),
          decision: "auto-rebased",
          trigger,
          from: signature.headSha || null,
          to: rebase.headSha || null,
          rerereReplayed: rebase.rerereReplayed === true,
        });
        return;
      }
      if (rebase?.reason === "rebase-conflict") {
        lifecycleState.rebaseConflictKey = currentKey;
        port.recordDecision({ kind: "rebase", ts: Date.now(), decision: "conflict", trigger, conflicts: rebase.conflicts || [] });
      }
    } catch (error) {
      console.warn(`[session ${id}] auto-rebase failed: ${errorMessage(error)}`);
    } finally {
      lifecycleState.autoRebasing = false;
      scheduleCheck();
    }
  }

  async function checkWorktreeChange(signatureOverride?: WorktreeSignature | null): Promise<void> {
    let session = port.state();
    if (session.isDestroyed || !lifecycleState.worktreeDir || isMerging()) return;
    if (lifecycleState.autoRebasing) return;
    const signature = signatureOverride || await api.computeWorktreeSignature();
    session = port.state();
    if (session.isDestroyed || isMerging() || !signature) return;
    const nextStatus = decideSignatureDemotion(lifecycleState.mergeStatus, signature);
    const demoted = nextStatus !== null;
    if (demoted) setMergeStatus(nextStatus);
    await runAutoRebase("change", signature);
    session = port.state();
    if (session.isDestroyed || isMerging()) return;
    if (signature.sig === lifecycleState.lastSignature && !demoted) return;
    lifecycleState.lastSignature = signature.sig;
    port.emit("worktree-changed", { id, sig: signature.sig });
  }

  async function runMergeEngine(
    workspaceApi: GitWorkspace,
    workspace: Workspace,
    method: "mergeBack" | "mergeKeep",
  ): Promise<MergeEngineOutcome> {
    setMergeStatus("merging");
    try {
      const result = await workspaceApi[method]({
        projectPath: currentProjectPath(),
        workspace,
        targetBranch: effectiveIntegrationBranch(),
      });
      if (result.warning) port.emit("worktree-warning", { id, branch: effectiveIntegrationBranch(), notice: result.warning });
      return { result };
    } catch (error) {
      setMergeStatus("pending-review", { reason: errorMessage(error) });
      return { failure: { merged: false, reason: errorMessage(error) } };
    }
  }

  function applyParkedOrPending(mergeResult: MergeResult): MergeResult {
    if (mergeResult.parked) {
      setMergeStatus("parked", { reason: mergeResult.reason || null, conflicts: mergeResult.conflicts || [] });
      return mergeResult;
    }
    setMergeStatus("pending-review", { reason: mergeResult.reason || null });
    return mergeResult;
  }

  async function mergeWorktree(): Promise<MergeResult> {
    if (!gitWorkspace || !lifecycleState.workspace) return { merged: false, refused: true, reason: "no-worktree" };
    const workspace = lifecycleState.workspace;
    if (isMerging()) return { merged: false, refused: true, reason: "merge-in-progress" };
    const { result, failure } = await runMergeEngine(gitWorkspace, workspace, "mergeBack");
    if (failure) return failure;
    if (!result.merged) return applyParkedOrPending(result);
    stopWatching();
    clearWorktreeState("merged");
    return result;
  }

  async function mergeAndContinue({ force = false }: { force?: boolean } = {}): Promise<MergeResult> {
    const session = port.state();
    if (session.isDestroyed) return { merged: false, refused: true, reason: "destroyed" };
    if (!gitWorkspace || !lifecycleState.workspace) return { merged: false, refused: true, reason: "no-worktree" };
    const workspace = lifecycleState.workspace;
    const runningOverride = force && session.state === STATES.RUNNING;
    if (!MERGEABLE_LIVE_STATES.includes(session.state) && !runningOverride) {
      return { merged: false, refused: true, reason: "not-continuable" };
    }
    if (isMerging()) return { merged: false, refused: true, reason: "merge-in-progress" };
    const { result, failure } = await runMergeEngine(gitWorkspace, workspace, "mergeKeep");
    if (failure) return failure;
    if (result.merged) {
      if (result.baseSha) {
        lifecycleState.baseSha = result.baseSha;
        workspace.baseSha = result.baseSha;
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

export { createSessionWorktreeLifecycle, WORKTREE_CHECK_DEBOUNCE_MS };
export type {
  AdoptWorktreeOptions,
  BranchSyncResult,
  IntegrationSyncResult,
  RebaseResult,
  WorkspaceArgs,
  GitWorkspace,
  MergeResult,
  SessionPort,
  SessionSnapshot,
  Workspace,
  WorktreeLifecycleOptions,
  WorktreeLifecycleState,
  WorktreeSignature,
};
