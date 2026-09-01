import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync, execFileSync } from '../server/child-process-safe.ts';
import { createSerialQueue } from './spawn-gate.ts';
import { sessionIdFromBranch } from './core/branch-gc-core.ts';
import {
  GIT_FETCH_TIMEOUT_MS,
  parseLeftRightCount,
  decideBranchSyncState,
  decideResyncAction,
  buildResyncCommand,
  firstGitErrorLine,
} from './core/branch-sync-core.ts';
import { decideIntegrationSync, classifyRefusedIntegrationSync } from './core/integration-sync-core.ts';
import type { IntegrationSyncOutcome } from './core/integration-sync-core.ts';

const fsp = fs.promises;

type GitResult = { ok: boolean; out: string; err?: string };
type IntegrationSyncResult = {
  outcome: IntegrationSyncOutcome;
  from: string | null;
  to: string | null;
  error?: string;
};
type GitExtraOptions = { timeout?: number; env?: Record<string, string> };
type GitRunner = (args: string[], cwd: string, extra?: GitExtraOptions) => Promise<string> | string;
type WorktreeBranch = { cwd: string; branch: string };
type WorkspaceHandle = {
  cwd: string;
  isGit: boolean;
  branch?: string | null;
  base?: string | null;
  baseSha?: string | null;
  reason?: string;
  conflictPath?: string;
  error?: string;
};
type WorktreeArgs = {
  projectPath: string;
  workspace?: WorkspaceHandle | null;
  targetBranch?: string | null;
  integrationBranch?: string | null;
  cwd?: string | null;
  branch?: string | null;
  wtDir?: string;
  shareList?: string[] | null;
  teamId?: string;
  label?: string;
  baseBranch?: string | null;
  forkFromHead?: boolean;
  worktreeBase?: string | null;
  name?: string;
  ancestorSha?: string;
  descendantSha?: string;
  knownProjects?: unknown;
};

type MergeOutcome = {
  merged: boolean;
  committed: boolean;
  branch: string | null;
  base?: string | null;
  reason: string | null;
  parked?: boolean;
  kept?: boolean;
  baseSha?: string | null;
  conflicts?: string[];
  restoreConflict?: boolean;
  rerereReplayed?: boolean;
  pushed?: boolean;
  warning?: string;
};
type RebaseOutcome = {
  ok: boolean;
  upToDate?: boolean;
  rebased?: boolean;
  headSha?: string | null;
  baseSha?: string | null;
  rerereReplayed?: boolean;
  reason?: string;
  conflicts?: string[];
};
type SessionWorktree = {
  cwd: string;
  branch: string;
  id: string;
  hasWork: boolean;
  integrationBranch: string | null;
};
type RemoteSessionBranch = { name: string; tipSha: string; tipCommitTimeMs: number };
type IntegrationTip = { branch: string; sha: string | null };
type BaseClassification = { state: string; upstream: string };
type BaseSyncResult = BaseClassification & { fetched: boolean | null; error?: string };

function errorExitCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function okResult(out: unknown): GitResult {
  return { ok: true, out: String(out || '').trim() };
}
function errResult(err: unknown): GitResult {
  const failure = (err ?? {}) as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return { ok: false, out: String(failure.stdout || '').trim(), err: String(failure.stderr || failure.message || '') };
}

function normalizedDirectoryPath(value: unknown): string {
  const posix = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const isWindowsPath = /^[A-Za-z]:\//.test(posix) || posix.startsWith('//');
  return isWindowsPath ? posix.toLowerCase() : posix;
}

function absoluteGitDir(value: string | null | undefined, cwd: string): string | null {
  if (!value) return null;
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || String(value).startsWith('\\\\')) {
    return normalizedDirectoryPath(value);
  }
  return normalizedDirectoryPath(path.resolve(cwd, value));
}

function projectPaths(knownProjects: unknown): string[] {
  const paths: string[] = [];
  for (const project of Array.isArray(knownProjects) ? knownProjects : []) {
    const candidate = typeof project === 'string' ? project : (project as { path?: unknown } | null)?.path;
    if (typeof candidate !== 'string' || !candidate.trim() || paths.includes(candidate)) continue;
    paths.push(candidate);
  }
  return paths;
}

function parseWorktreeBranches(porcelain: string): WorktreeBranch[] {
  const result: WorktreeBranch[] = [];
  let curWt: string | null = null;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { curWt = line.slice('worktree '.length).trim(); continue; }
    if (line === '') { curWt = null; continue; }
    if (!line.startsWith('branch ')) continue;
    const branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    const cwd = curWt;
    curWt = null;
    if (cwd) result.push({ cwd, branch });
  }
  return result;
}

function findWorktreeForBranch(porcelain: string, branch: string): string | null {
  const hit = parseWorktreeBranches(porcelain).find((w) => w.branch === branch);
  return hit ? hit.cwd : null;
}

const isDirtyResult = (dirty: GitResult) => dirty.ok && dirty.out !== '';
function hasWorkFrom(dirty: GitResult, ahead: GitResult | null): boolean {
  if (isDirtyResult(dirty)) return true;
  return !!(ahead?.ok && ahead.out && ahead.out !== '0');
}

const markerFrom = (result: GitResult) => (result.ok && result.out ? result.out : null);

function createGitWorkspace(opts: {
  git?: GitRunner;
  mkdtemp?: (prefix: string) => string;
  rerere?: boolean;
  log?: Pick<Console, 'warn'>;
} = {}) {

  const git: GitRunner = opts.git || (async (args, cwd, extra) => {
    const { stdout } = await execFileAsync('git', args, {
      cwd, encoding: 'utf8', timeout: extra?.timeout || 20000,
      ...(extra?.env ? { env: { ...process.env, ...extra.env } } : {}),
    });
    return stdout;
  });
  const mkdtemp = opts.mkdtemp || ((prefix: string) => fs.mkdtempSync(prefix));
  const log = opts.log || console;

  const rerereEnabled = opts.rerere !== false;

  const engineQueue = createSerialQueue();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => engineQueue.run(fn);
  const serialized = <T>(body: (args: WorktreeArgs) => Promise<T>) => (args: WorktreeArgs): Promise<T> => serialize(() => body(args));

  async function run(args: string[], cwd: string, extra?: GitExtraOptions): Promise<GitResult> {
    try { return okResult(await git(args, cwd, extra)); }
    catch (err) { return errResult(err); }
  }
  const commonGitDirByProject = new Map<string, string | null>();

  async function commonGitDir(cwd: string): Promise<string | null> {
    const common = await run(['rev-parse', '--git-common-dir'], cwd);
    if (!common.ok || !common.out) return null;
    return absoluteGitDir(common.out, cwd);
  }

  async function resolveProjectPath({ cwd, knownProjects }: { cwd: string; knownProjects?: unknown }): Promise<string | null> {
    const sourceCommonGitDir = await commonGitDir(cwd);
    if (!sourceCommonGitDir) return null;
    for (const projectPath of projectPaths(knownProjects)) {
      let configuredCommonGitDir = commonGitDirByProject.get(projectPath);
      if (configuredCommonGitDir === undefined) {
        configuredCommonGitDir = await commonGitDir(projectPath);
        commonGitDirByProject.set(projectPath, configuredCommonGitDir);
      }
      if (configuredCommonGitDir !== sourceCommonGitDir) continue;
      return projectPath;
    }
    return null;
  }
  function sanitize(s: unknown): string { return String(s || '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, ''); }

  async function detectDefaultBranch({ projectPath }: { projectPath: string }): Promise<string | null> {
    const remoteHead = await run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], projectPath);
    if (remoteHead.ok && remoteHead.out.startsWith('origin/')) return remoteHead.out.slice('origin/'.length) || null;
    for (const branch of ['main', 'master']) {
      const localBranch = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], projectPath);
      if (localBranch.ok) return branch;
    }
    return null;
  }

  async function classifyBaseAgainstOrigin(projectPath: string, branch: string): Promise<BaseClassification> {
    const upstream = `origin/${branch}`;
    const remoteBranch = await run(['rev-parse', '--verify', '--quiet', `refs/remotes/${upstream}`], projectPath);
    if (!remoteBranch.ok) return { state: 'no-upstream', upstream };
    const counts = parseLeftRightCount((await run([
      'rev-list', '--left-right', '--count', `${upstream}...${branch}`,
    ], projectPath)).out);
    return {
      state: decideBranchSyncState({ hasUpstream: true, ahead: counts?.ahead, behind: counts?.behind }),
      upstream,
    };
  }

  async function hasOriginRemote(projectPath: string): Promise<boolean> {
    return (await run(['remote', 'get-url', 'origin'], projectPath)).ok;
  }

  async function fastForwardBaseFromOrigin(projectPath: string, branch: string, upstream: string): Promise<boolean> {
    const checkedOut = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath)).out;
    const decision = decideResyncAction('behind', checkedOut === branch);
    const command = buildResyncCommand(decision, { upstream, branch, remote: 'origin', opts: {} });
    if (!command) return false;
    return (await run(command.args, projectPath, { timeout: command.opts.timeout })).ok;
  }

  async function synchronizeBaseWithOrigin(
    projectPath: string,
    branch: string,
    fetched: GitResult | null = null,
  ): Promise<BaseSyncResult> {
    if (!(await hasOriginRemote(projectPath))) return { state: 'no-upstream', upstream: `origin/${branch}`, fetched: null };
    const fetchResult = fetched || await fetchOriginBody({ projectPath, branch });
    if (!fetchResult.ok) {
      const fullError = fetchResult.err || fetchResult.out;
      log.warn(`[git-workspace] fetch origin/${branch} failed: ${fullError}`);
      return {
        state: 'unknown', upstream: `origin/${branch}`, fetched: false, error: firstGitErrorLine(fullError),
      };
    }
    const classified = await classifyBaseAgainstOrigin(projectPath, branch);
    if (classified.state === 'no-upstream') return { ...classified, fetched: null };
    if (classified.state !== 'behind') return { ...classified, fetched: true };
    const fastForwarded = await fastForwardBaseFromOrigin(projectPath, branch, classified.upstream);
    if (!fastForwarded) return { ...classified, fetched: true, error: 'fast-forward failed' };
    return { ...classified, state: 'in-sync', fetched: true };
  }

  async function pushBaseToOrigin(projectPath: string, branch: string): Promise<boolean> {
    if (!(await hasOriginRemote(projectPath))) return false;
    const classified = await classifyBaseAgainstOrigin(projectPath, branch);
    const decision = decideResyncAction(classified.state, false);
    const command = buildResyncCommand(decision, {
      upstream: classified.upstream, branch, remote: 'origin', opts: {},
    });
    if (!command) return false;
    return (await run(command.args, projectPath, {
      timeout: command.opts.timeout,
      env: { GIT_TERMINAL_PROMPT: '0' },
    })).ok;
  }

  function mergeSyncWarning(baseSync: BaseSyncResult, branch: string): string | null {
    if (baseSync.fetched === false) return `could not fetch origin/${branch}; merged with local base: ${baseSync.error}`;
    if (baseSync.error) return `could not fast-forward ${branch} from origin/${branch}; merged with local base`;
    return null;
  }

  function includeWarning(mergeResult: MergeOutcome, warning: string | null): MergeOutcome {
    if (!warning) return mergeResult;
    return { ...mergeResult, warning };
  }

  async function ensureLocalBranch(projectPath: string, baseBranch: string): Promise<string | null> {
    const seedCandidates = [
      `refs/remotes/origin/${baseBranch}`,
      'refs/heads/main',
      'refs/heads/master',
      'refs/remotes/origin/main',
      'refs/remotes/origin/master',
      'HEAD',
    ];
    for (const candidate of seedCandidates) {
      const verify = await run(['rev-parse', '--verify', '--quiet', candidate], projectPath);
      if (!verify.ok) continue;
      const created = await run(['branch', '--', baseBranch, candidate], projectPath);
      if (!created.ok) return null;
      return verify.out;
    }
    return null;
  }

  async function createBody({
    projectPath,
    teamId,
    label,
    baseBranch = null,
    forkFromHead = false,
    worktreeBase,
    shareList,
  }: WorktreeArgs): Promise<WorkspaceHandle> {
    const inside = await run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return { cwd: projectPath, isGit: false };
    const head = await run(['rev-parse', 'HEAD'], projectPath);
    if (!head.ok) return { cwd: projectPath, isGit: false };

    if (rerereEnabled) {
      const configured = await run(['config', '--get', 'rerere.enabled'], projectPath);
      if (!configured.ok || configured.out === '') await run(['config', 'rerere.enabled', 'true'], projectPath);
    }
    const branch = `glissa/${sanitize(teamId)}/${sanitize(label)}`;
    await run(['worktree', 'prune'], projectPath);
    const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
    if (listed.ok) {
      const conflictPath = findWorktreeForBranch(listed.out, branch);
      if (conflictPath) {
        const marker = await run(['config', '--get', `branch.${branch}.glissa-integration`], projectPath);
        return {
          cwd: projectPath,
          isGit: false,
          reason: 'branch-in-use',
          conflictPath,
          branch,
          base: markerFrom(marker) || baseBranch || null,
        };
      }
    }
    const currentBranch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath)).out || 'HEAD';
    let base: string | null = currentBranch;
    if (!forkFromHead) base = baseBranch || await detectDefaultBranch({ projectPath });
    if (!base) return { cwd: projectPath, isGit: false, reason: 'no-base-branch' };
    const ref = forkFromHead
      ? head
      : await run(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], projectPath);
    const baseSha = ref.ok ? ref.out : await ensureLocalBranch(projectPath, base);
    if (!baseSha) return { cwd: projectPath, isGit: false, reason: 'no-base-branch' };
    await run(['branch', '-D', branch], projectPath);

    let wtParent = os.tmpdir();
    let prefix = `glissa-wt-${sanitize(teamId)}-`;
    if (worktreeBase) {
      try { fs.mkdirSync(worktreeBase, { recursive: true }); } catch {}
      wtParent = worktreeBase;
      prefix = `${sanitize(path.basename(projectPath)) || 'repo'}-`;
    }
    const wtDir = mkdtemp(path.join(wtParent, prefix));
    const add = await run(['worktree', 'add', '-b', branch, wtDir, baseSha], projectPath);
    if (!add.ok) {
      try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch {}
      return { cwd: projectPath, isGit: false, error: add.err };
    }

    await run(['config', `branch.${branch}.glissa-integration`, base], projectPath);

    await populateShare({ projectPath, wtDir, shareList });
    return { cwd: wtDir, isGit: true, branch, base, baseSha };
  }

  async function populateShare({ projectPath, wtDir, shareList }: WorktreeArgs): Promise<void> {
    if (!wtDir || !shareList || !shareList.length) return;
    const ignored: string[] = [];
    for (const rel of shareList) {
      if (rel && !String(rel).includes('..') && (await run(['check-ignore', '-q', '--', rel], projectPath)).ok) {
        ignored.push(rel);
      }
    }
    if (!ignored.length) return;
    try { await populateWorktree(projectPath, wtDir, ignored); } catch {}
    await refuseTrackableLinks(wtDir, ignored);
  }

  async function refuseTrackableLinks(wtDir: string, entries: string[]): Promise<void> {
    for (const rel of entries) {
      if ((await run(['check-ignore', '-q', '--', rel], wtDir)).ok) continue;
      const target = path.join(wtDir, rel);
      const stat = await fsp.lstat(target).catch(() => null);
      if (!stat || !stat.isSymbolicLink()) continue;
      console.warn(`[git-workspace] not sharing ${rel}: git does not ignore it as a link, so a commit in the worktree would carry it (use a slash-free .gitignore entry)`);
      try { await fsp.rm(target, { force: true }); } catch {}
    }
  }

  async function tearDownWorktree(projectPath: string, wt: string, branch: string | null | undefined): Promise<void> {
    removeWorktreeLinks(wt);
    await run(['worktree', 'remove', '--force', wt], projectPath);
    await run(['worktree', 'prune'], projectPath);
    if (branch) await run(['branch', '-D', branch], projectPath);
  }

  async function fastForwardTarget(projectPath: string, sourceRef: string, target: string, targetIsHead: boolean): Promise<{ ok: boolean; err: string }> {
    if (!targetIsHead) {
      const fetched = await run(['fetch', '.', `${sourceRef}:refs/heads/${target}`], projectPath);
      return { ok: fetched.ok, err: fetched.ok ? '' : (fetched.err ?? '') };
    }

    const merged = await run(['merge', '--ff-only', String(sourceRef).replace(/^refs\/heads\//, '')], projectPath);
    return { ok: merged.ok, err: merged.ok ? '' : (merged.err ?? '') };
  }

  async function unmergedPaths(wt: string): Promise<string[]> {
    return (await run(['diff', '--name-only', '--diff-filter=U'], wt)).out
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  async function abortRebaseWithConflicts(wt: string): Promise<string[]> {
    const conflicts = await unmergedPaths(wt);
    await run(['rebase', '--abort'], wt);
    return conflicts;
  }

  async function rebaseStopped(wt: string): Promise<boolean> {
    return (await run(['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'], wt)).ok;
  }

  const withAutoUpdate = (args: string[]) => (rerereEnabled ? ['-c', 'rerere.autoUpdate=true', ...args] : args);

  async function advanceRebaseStep(wt: string): Promise<{ done: boolean; conflicted?: boolean }> {
    const staged = await run(['diff', '--cached', '--quiet'], wt);
    const step = staged.ok ? '--skip' : '--continue';
    const r = await run(withAutoUpdate(['rebase', step]), wt, { env: { GIT_EDITOR: 'true' } });
    if (r.ok) return { done: true };
    return { done: false, conflicted: (await unmergedPaths(wt)).length > 0 };
  }

  const RERERE_STEP_CAP = 50;
  async function replayRecordedResolutions(wt: string): Promise<{ ok: boolean; steps: number }> {
    let steps = 0;
    for (; steps < RERERE_STEP_CAP; steps += 1) {
      if ((await unmergedPaths(wt)).length) return { ok: false, steps };
      const staged = await run(['add', '-u'], wt);
      if (!staged.ok) return { ok: false, steps };
      const advanced = await advanceRebaseStep(wt);
      if (advanced.done) return { ok: true, steps: steps + 1 };
      if (!advanced.conflicted) return { ok: false, steps };
    }
    return { ok: false, steps };
  }

  async function rebaseFfBranch({ projectPath, wt, branch, target }: {
    projectPath: string;
    wt: string;
    branch: string;
    target: string;
  }): Promise<{
    committed: boolean;
    merged: boolean;
    reason: string | null;
    parked?: boolean;
    conflicts?: string[];
    restoreConflict?: boolean;
    rerereReplayed?: boolean;
  }> {

    const ahead = await run(['rev-list', '--count', `${target}..${branch}`], projectPath);
    if (!ahead.ok || ahead.out === '' || ahead.out === '0') {
      return { committed: false, merged: false, reason: 'nothing-to-commit' };
    }

    const dirty = (await run(['status', '--porcelain'], wt)).out !== '';
    const stashed = dirty && (await run(['stash', 'push', '--include-untracked', '-m', 'glissa-merge'], wt)).ok;

    let rerereReplayed = false;
    if (!(await run(withAutoUpdate(['rebase', target]), wt)).ok) {
      const replay = rerereEnabled && (await rebaseStopped(wt))
        ? await replayRecordedResolutions(wt)
        : { ok: false };
      if (!replay.ok) {
        const conflicts = await abortRebaseWithConflicts(wt);
        if (stashed) await run(['stash', 'pop'], wt);
        return { committed: true, merged: false, reason: 'rebase-conflict', parked: true, conflicts };
      }
      rerereReplayed = true;
    }

    const head = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath)).out;
    const merged = await fastForwardTarget(projectPath, `refs/heads/${branch}`, target, head === target);
    if (!merged.ok) {
      if (stashed) await run(['stash', 'pop'], wt);
      return { committed: true, merged: false, reason: 'not-fast-forward', parked: true, rerereReplayed };
    }

    const restoreConflict = stashed ? !(await run(['stash', 'pop'], wt)).ok : false;
    return { committed: true, merged: true, reason: null, restoreConflict, rerereReplayed };
  }

  async function resolveMergeBack({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<{
    wt?: string;
    branch?: string;
    target?: string;
    error?: MergeOutcome;
  }> {
    if (!workspace || !workspace.isGit) return { error: { merged: false, committed: false, branch: null, reason: 'not-git' } };
    const branch = workspace.branch;
    if (!branch) return { error: { merged: false, committed: false, branch: null, reason: 'no-branch' } };
    const target = workspace.base || targetBranch;
    if (!target || target === 'HEAD') return { error: { merged: false, committed: false, branch, reason: 'no-target', parked: true } };
    if (!(await run(['rev-parse', '--verify', '--quiet', `refs/heads/${target}`], projectPath)).ok) {
      return { error: { merged: false, committed: false, branch, base: target, reason: 'no-target-branch', parked: true } };
    }
    return { wt: workspace.cwd, branch, target };
  }

  async function mergeBackBody({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<MergeOutcome> {
    const g = await resolveMergeBack({ projectPath, workspace, targetBranch });
    if (g.error) return g.error;
    const { wt = '', branch = '', target = '' } = g;

    const baseSync = await synchronizeBaseWithOrigin(projectPath, target);
    if (baseSync.state === 'diverged') {
      return { merged: false, committed: false, branch, base: target, reason: 'base-diverged', parked: true };
    }
    const warning = mergeSyncWarning(baseSync, target);

    if ((await run(['status', '--porcelain'], wt)).out !== '') {
      return includeWarning({ merged: false, committed: false, branch, base: target, reason: 'uncommitted-changes', parked: true }, warning);
    }

    const r = await rebaseFfBranch({ projectPath, wt, branch, target });
    if (!r.committed) {

      await tearDownWorktree(projectPath, wt, branch);
      return includeWarning({ merged: false, committed: false, branch: null, base: target, reason: 'nothing-to-commit' }, warning);
    }
    if (!r.merged) {

      return includeWarning({ merged: false, committed: true, branch, base: target, reason: r.reason, parked: true, conflicts: r.conflicts || [] }, warning);
    }
    await tearDownWorktree(projectPath, wt, branch);
    const pushed = await pushBaseToOrigin(projectPath, target);
    return includeWarning({
      merged: true,
      committed: true,
      branch: null,
      base: target,
      reason: null,
      pushed,
      rerereReplayed: r.rerereReplayed === true,
    }, warning);
  }

  async function mergeKeepBody({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<MergeOutcome> {
    const g = await resolveMergeBack({ projectPath, workspace, targetBranch });
    if (g.error) return g.error;
    const { wt = '', branch = '', target = '' } = g;

    const baseSync = await synchronizeBaseWithOrigin(projectPath, target);
    if (baseSync.state === 'diverged') {
      return { merged: false, committed: false, branch, base: target, reason: 'base-diverged', parked: true };
    }
    const warning = mergeSyncWarning(baseSync, target);

    const r = await rebaseFfBranch({ projectPath, wt, branch, target });
    if (!r.committed) {

      return includeWarning({ merged: false, committed: false, branch, base: target, reason: 'nothing-to-commit', kept: true }, warning);
    }
    if (!r.merged) {
      return includeWarning({ merged: false, committed: true, branch, base: target, reason: r.reason, parked: true, conflicts: r.conflicts || [] }, warning);
    }

    const baseSha = (await run(['rev-parse', target], projectPath)).out || workspace?.baseSha || null;
    const pushed = await pushBaseToOrigin(projectPath, target);
    return includeWarning({
      merged: true, committed: true, branch, base: target, baseSha, kept: true, reason: null,
      pushed, restoreConflict: r.restoreConflict || false, rerereReplayed: r.rerereReplayed === true,
    }, warning);
  }

  async function rebaseOnlyBody({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<RebaseOutcome> {
    const g = await resolveMergeBack({ projectPath, workspace, targetBranch });
    if (g.error) return { ok: false, reason: g.error.reason ?? undefined };
    const { wt = '', target = '' } = g;

    const status = await run(['status', '--porcelain'], wt);
    if (!status.ok) return { ok: false, reason: 'unreadable' };
    if (status.out !== '') return { ok: false, reason: 'dirty' };

    const behind = await run(['rev-list', '--count', `HEAD..${target}`], wt);
    if (!behind.ok) return { ok: false, reason: 'unreadable' };
    if (behind.out === '' || behind.out === '0') return { ok: true, upToDate: true };

    let rerereReplayed = false;
    if (!(await run(withAutoUpdate(['rebase', target]), wt)).ok) {

      if (!(await rebaseStopped(wt))) return { ok: false, reason: 'rebase-failed' };
      const replay = rerereEnabled ? await replayRecordedResolutions(wt) : { ok: false };
      if (!replay.ok) return { ok: false, reason: 'rebase-conflict', conflicts: await abortRebaseWithConflicts(wt) };
      rerereReplayed = true;
    }
    return {
      ok: true,
      rebased: true,
      headSha: (await run(['rev-parse', 'HEAD'], wt)).out || null,
      baseSha: (await run(['rev-parse', target], wt)).out || null,
      rerereReplayed,
    };
  }

  async function discardBody({ projectPath, workspace }: WorktreeArgs): Promise<void> {
    if (!workspace || !workspace.isGit) return;
    if (workspace.cwd) {
      removeWorktreeLinks(workspace.cwd);
      await run(['worktree', 'remove', '--force', workspace.cwd], projectPath);
    }
    if (workspace.branch) await run(['branch', '-D', workspace.branch], projectPath);
    await run(['worktree', 'prune'], projectPath);
  }

  async function probeWorktreeWork({ projectPath, cwd, branch, integrationBranch }: {
    projectPath: string;
    cwd: string;
    branch: string;
    integrationBranch?: string | null;
  }): Promise<{ dirty: GitResult; ahead: GitResult | null; integrationBranch: string | null }> {

    const marker = await run(['config', '--get', `branch.${branch}.glissa-integration`], projectPath);
    const resolvedIntegrationBranch = markerFrom(marker) || integrationBranch;

    const dirty = await run(['status', '--porcelain'], cwd);
    const ahead = !isDirtyResult(dirty) && resolvedIntegrationBranch
      ? await run(['rev-list', '--count', `${resolvedIntegrationBranch}..${branch}`], projectPath)
      : null;
    return { dirty, ahead, integrationBranch: resolvedIntegrationBranch ?? null };
  }

  async function hasUnmergedWork({ projectPath, workspace, integrationBranch }: WorktreeArgs): Promise<boolean> {
    if (!workspace || !workspace.isGit || !workspace.cwd || !workspace.branch) return true;
    const { dirty, ahead } = await probeWorktreeWork({
      projectPath, cwd: workspace.cwd, branch: workspace.branch,
      integrationBranch: integrationBranch || workspace.base,
    });
    if (!dirty.ok) return true;
    if (isDirtyResult(dirty)) return true;
    if (!ahead || !ahead.ok) return true;
    return hasWorkFrom(dirty, ahead);
  }

  async function listSessionWorktrees({ projectPath, integrationBranch }: WorktreeArgs): Promise<SessionWorktree[]> {
    const out: SessionWorktree[] = [];
    const inside = await run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return out;
    const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
    if (!listed.ok) return out;
    for (const { cwd: wt, branch: name } of parseWorktreeBranches(listed.out)) {
      const id = sessionIdFromBranch(name);
      if (id === null) continue;
      const probe = await probeWorktreeWork({ projectPath, cwd: wt, branch: name, integrationBranch });
      out.push({
        cwd: wt, branch: name, id,
        hasWork: hasWorkFrom(probe.dirty, probe.ahead),
        integrationBranch: probe.integrationBranch,
      });
    }
    return out;
  }

  async function removeWorktreeByPathBody({ projectPath, cwd, branch }: WorktreeArgs): Promise<void> {
    if (cwd) {
      removeWorktreeLinks(cwd);
      await run(['worktree', 'remove', '--force', cwd], projectPath);
    }
    if (branch) await run(['branch', '-D', branch], projectPath);
    await run(['worktree', 'prune'], projectPath);
  }

  async function listWorktreeBranches({ projectPath }: WorktreeArgs): Promise<WorktreeBranch[]> {
    const inside = await run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return [];
    const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
    if (!listed.ok) return [];
    return parseWorktreeBranches(listed.out);
  }

  async function fetchOriginBody({ projectPath, branch = null }: WorktreeArgs): Promise<GitResult> {
    const fetchOptions: GitExtraOptions = {
      timeout: GIT_FETCH_TIMEOUT_MS,
      env: { GIT_TERMINAL_PROMPT: '0' },
    };
    if (branch) {
      return run([
        'fetch', '--quiet', '--prune', 'origin', 'refs/heads/*:refs/remotes/origin/*',
      ], projectPath, fetchOptions);
    }
    return run(['fetch', '--prune', 'origin'], projectPath, fetchOptions);
  }

  async function classifyRefusedSync({ projectPath, branch, localRef, localSha, remoteSha, err }: {
    projectPath: string;
    branch: string;
    localRef: string;
    localSha: string | null;
    remoteSha: string | null;
    err: string;
  }): Promise<IntegrationSyncResult> {
    const current = await run(['rev-parse', '--verify', '--quiet', localRef], projectPath);
    const currentSha = current.ok && current.out ? current.out : localSha;
    let ancestry: boolean | null = null;
    if (currentSha && remoteSha && currentSha !== remoteSha) {
      const probe = await isAncestor({ projectPath, ancestorSha: currentSha, descendantSha: remoteSha });
      ancestry = probe.ok ? probe.isAncestor : null;
    }
    const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
    const checkedOut = !listed.ok || Boolean(findWorktreeForBranch(listed.out, branch));
    const { outcome } = classifyRefusedIntegrationSync({ currentSha, remoteSha, isAncestor: ancestry, checkedOut });
    if (outcome !== 'update-failed') return { outcome, from: currentSha, to: remoteSha };
    return { outcome, from: currentSha, to: remoteSha, error: firstGitErrorLine(err) };
  }

  async function syncIntegrationBranchBody({ projectPath, branch }: WorktreeArgs): Promise<IntegrationSyncResult> {
    if (!(await hasOriginRemote(projectPath))) return { outcome: 'no-remote', from: null, to: null };
    const localRef = `refs/heads/${branch}`;
    const remoteRef = `refs/remotes/origin/${branch}`;

    const fetched = await run(
      ['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
      projectPath,
      { timeout: GIT_FETCH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } },
    );
    if (!fetched.ok) return { outcome: 'fetch-failed', from: null, to: null };

    const local = await run(['rev-parse', '--verify', '--quiet', localRef], projectPath);
    const remote = await run(['rev-parse', '--verify', '--quiet', remoteRef], projectPath);
    const localSha = local.ok ? local.out : null;
    const remoteSha = remote.ok ? remote.out : null;
    let ancestryVerdict: boolean | null = null;
    let ancestryError = '';
    let checkedOut = false;
    if (localSha && remoteSha && localSha !== remoteSha) {
      const ancestry = await isAncestor({ projectPath, ancestorSha: localSha, descendantSha: remoteSha });
      ancestryVerdict = ancestry.ok ? ancestry.isAncestor : null;
      if (!ancestry.ok) ancestryError = ancestry.err ?? '';
      if (ancestryVerdict === true) {
        const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
        checkedOut = !listed.ok || Boolean(findWorktreeForBranch(listed.out, branch ?? ''));
      }
    }

    const decision = decideIntegrationSync({ localSha, remoteSha, isAncestor: ancestryVerdict, checkedOut });
    if (decision.outcome === 'update-failed') {
      return { outcome: decision.outcome, from: localSha, to: remoteSha, error: firstGitErrorLine(ancestryError) };
    }
    if (decision.action !== 'update') return { outcome: decision.outcome, from: localSha, to: remoteSha };
    const updated = await fastForwardTarget(projectPath, remoteRef, branch ?? '', false);
    if (updated.ok) return { outcome: 'updated', from: localSha, to: remoteSha };
    return classifyRefusedSync({ projectPath, branch: branch ?? '', localRef, localSha, remoteSha, err: updated.err });
  }

  async function listRemoteSessionBranches({ projectPath }: WorktreeArgs): Promise<GitResult | { ok: true; branches: RemoteSessionBranch[] }> {
    const listed = await run([
      'for-each-ref',
      'refs/remotes/origin/glissa/session/',
      '--format=%(refname:short) %(objectname) %(committerdate:unix)',
    ], projectPath);
    if (!listed.ok) return listed;
    const branches: RemoteSessionBranch[] = [];
    for (const line of listed.out.split(/\r?\n/)) {
      if (!line) continue;
      const [remoteName, tipSha, commitTimeSeconds] = line.trim().split(/\s+/);
      const name = remoteName.startsWith('origin/') ? remoteName.slice('origin/'.length) : remoteName;
      branches.push({
        name,
        tipSha,
        tipCommitTimeMs: Number.parseInt(commitTimeSeconds, 10) * 1000,
      });
    }
    return { ok: true, branches };
  }

  async function listIntegrationTips({ projectPath, integrationBranch }: WorktreeArgs): Promise<GitResult | { ok: true; integrationTips: IntegrationTip[] }> {
    const detectedBranch = integrationBranch || await detectDefaultBranch({ projectPath });
    const branchNames = [...new Set([detectedBranch, 'main', 'master'].filter((name): name is string => Boolean(name)))];
    const refNames = branchNames.flatMap((branchName) => [
      `refs/remotes/origin/${branchName}`,
      `refs/heads/${branchName}`,
    ]);
    const listed = await run([
      'for-each-ref',
      ...refNames,
      '--format=%(refname) %(objectname)',
    ], projectPath);
    if (!listed.ok) return listed;
    const shaByRef = new Map<string, string>();
    for (const line of listed.out.split(/\r?\n/)) {
      if (!line) continue;
      const [refName, sha] = line.trim().split(/\s+/);
      if (refNames.includes(refName)) shaByRef.set(refName, sha);
    }
    const integrationTips: IntegrationTip[] = [];
    for (const branch of branchNames) {
      const sha = shaByRef.get(`refs/remotes/origin/${branch}`) || shaByRef.get(`refs/heads/${branch}`);
      integrationTips.push({ branch, sha: sha || null });
    }
    return { ok: true, integrationTips };
  }

  async function isAncestor({ projectPath, ancestorSha, descendantSha }: WorktreeArgs): Promise<(GitResult | { ok: true }) & { isAncestor: boolean }> {
    try {
      await git(['merge-base', '--is-ancestor', ancestorSha ?? '', descendantSha ?? ''], projectPath);
      return { ok: true, isAncestor: true };
    } catch (err) {
      if (errorExitCode(err) === 1) return { ok: true, isAncestor: false };
      return { ...errResult(err), isAncestor: false };
    }
  }

  async function deleteRemoteBranchBody({ projectPath, name }: WorktreeArgs): Promise<GitResult> {
    return run(['push', 'origin', '--delete', name ?? ''], projectPath);
  }

  return {
    create: serialized(createBody),
    discard: serialized(discardBody),
    mergeBack: serialized(mergeBackBody),
    mergeKeep: serialized(mergeKeepBody),
    rebaseOnly: serialized(rebaseOnlyBody),
    populate: serialized(populateShare),
    removeWorktreeByPath: serialized(removeWorktreeByPathBody),
    fetchOrigin: serialized(fetchOriginBody),
    syncIntegrationBranch: serialized(syncIntegrationBranchBody),
    deleteRemoteBranch: serialized(deleteRemoteBranchBody),
    listSessionWorktrees, listWorktreeBranches, hasUnmergedWork, detectDefaultBranch,
    listRemoteSessionBranches, listIntegrationTips, isAncestor, resolveProjectPath,
  };
}

function createGitWorkspaceSync(opts: { git?: (args: string[], cwd: string) => string } = {}) {
  const git = opts.git || ((args: string[], cwd: string) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
  }));
  function run(args: string[], cwd: string): GitResult {
    try { return okResult(git(args, cwd)); }
    catch (err) { return errResult(err); }
  }
  const commonGitDirByProject = new Map<string, string | null>();

  function commonGitDir(cwd: string): string | null {
    const common = run(['rev-parse', '--git-common-dir'], cwd);
    if (!common.ok || !common.out) return null;
    return absoluteGitDir(common.out, cwd);
  }

  function resolveProjectPath({ cwd, knownProjects }: { cwd: string; knownProjects?: unknown }): string | null {
    const sourceCommonGitDir = commonGitDir(cwd);
    if (!sourceCommonGitDir) return null;
    for (const projectPath of projectPaths(knownProjects)) {
      let configuredCommonGitDir = commonGitDirByProject.get(projectPath);
      if (configuredCommonGitDir === undefined) {
        configuredCommonGitDir = commonGitDir(projectPath);
        commonGitDirByProject.set(projectPath, configuredCommonGitDir);
      }
      if (configuredCommonGitDir !== sourceCommonGitDir) continue;
      return projectPath;
    }
    return null;
  }

  function listSessionWorktrees({ projectPath, integrationBranch }: WorktreeArgs): SessionWorktree[] {
    const out: SessionWorktree[] = [];
    const inside = run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return out;
    const listed = run(['worktree', 'list', '--porcelain'], projectPath);
    if (!listed.ok) return out;
    for (const { cwd: wt, branch: name } of parseWorktreeBranches(listed.out)) {
      const id = sessionIdFromBranch(name);
      if (id === null) continue;
      const marker = run(['config', '--get', `branch.${name}.glissa-integration`], projectPath);
      const resolvedIntegrationBranch = markerFrom(marker) || integrationBranch;
      const dirty = run(['status', '--porcelain'], wt);
      const ahead = !isDirtyResult(dirty) && resolvedIntegrationBranch
        ? run(['rev-list', '--count', `${resolvedIntegrationBranch}..${name}`], projectPath)
        : null;
      out.push({
        cwd: wt, branch: name, id,
        hasWork: hasWorkFrom(dirty, ahead),
        integrationBranch: resolvedIntegrationBranch ?? null,
      });
    }
    return out;
  }

  function removeWorktreeByPath({ projectPath, cwd, branch }: WorktreeArgs): void {
    if (cwd) {
      removeWorktreeLinks(cwd);
      run(['worktree', 'remove', '--force', cwd], projectPath);
    }
    if (branch) run(['branch', '-D', branch], projectPath);
    run(['worktree', 'prune'], projectPath);
  }

  return { listSessionWorktrees, removeWorktreeByPath, resolveProjectPath };
}

function removeWorktreeLinks(wtDir: string | null | undefined): void {
  if (!wtDir) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(wtDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue;
    const p = path.join(wtDir, e.name);
    try { fs.rmSync(p, { recursive: false, force: true }); }
    catch { try { fs.rmdirSync(p); } catch {} }
  }
}

async function populateWorktree(projectPath: string, wtDir: string, shareList: string[]): Promise<void> {
  for (const rel of shareList) {
    if (!rel || String(rel).includes('..')) continue;
    const src = path.join(projectPath, rel);
    const dst = path.join(wtDir, rel);
    try {
      const srcStat = await fsp.stat(src).catch(() => null);
      if (!srcStat) continue;
      const dstExists = await fsp.access(dst).then(() => true, () => false);
      if (dstExists) continue;
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      if (srcStat.isDirectory()) {
        if (process.platform === 'win32') {
          await execFileAsync('cmd', ['/c', 'mklink', '/J', dst, src]);
          continue;
        }
        await fsp.symlink(src, dst, 'dir');
        continue;
      }
      await fsp.copyFile(src, dst);
    } catch {}
  }
}

export { createGitWorkspace, createGitWorkspaceSync };
export type {
  GitResult,
  IntegrationSyncResult,
  MergeOutcome,
  RebaseOutcome,
  SessionWorktree,
  WorkspaceHandle,
  WorktreeArgs,
};
