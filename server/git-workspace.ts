import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync, execFileSync } from '../server/child-process-safe.ts';
import { createSerialQueue } from './spawn-gate.js';
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

// Shared {ok,out}/{ok:false,out,err} result shaping for the sync and async `run()` git helpers below.
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

// Pure parse of `git worktree list --porcelain`: returns { cwd, branch } for every worktree block that
// carries a `branch refs/heads/...` line (a detached or bare worktree has none and is skipped). Shared
// by findWorktreeForBranch and both listSessionWorktrees engines below.
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

// The worktree path already holding `branch` checked out, or null.
function findWorktreeForBranch(porcelain: string, branch: string): string | null {
  const hit = parseWorktreeBranches(porcelain).find((w) => w.branch === branch);
  return hit ? hit.cwd : null;
}

// The one statement of "this worktree holds UNMERGED work that must NOT be destroyed on a restart":
// uncommitted changes in the worktree, or commits on its branch not yet on the integration branch (a
// parked/conflicted merge). Gitignored junctions/files never show in `status --porcelain`. Pure, over
// the two already-fetched git outputs, so the async and sync engines cannot drift on the rule.
const isDirtyResult = (dirty: GitResult) => dirty.ok && dirty.out !== '';
function hasWorkFrom(dirty: GitResult, ahead: GitResult | null): boolean {
  if (isDirtyResult(dirty)) return true;
  return !!(ahead?.ok && ahead.out && ahead.out !== '0');
}

// The fork-base target stamped on a branch at create time (see createBody), so a worktree's integration
// branch is resolved from its own git config instead of assuming the caller's live config never changed.
const markerFrom = (result: GitResult) => (result.ok && result.out ? result.out : null);

// Run each isolated lane (a session, a PR review) inside a throwaway git worktree on a dedicated
// branch, so its writes never touch the carbon unit's working tree or current branch during the
// (multi-minute) run. On a terminal outcome the work is fast-forwarded back into the base branch when
// that is safe; if the base moved meanwhile, the branch is kept for a manual merge. A non-git project,
// a repo with no commits falls back to running in place (no isolation, no merge).
//
// The git runner is injected so the branch/worktree/merge sequence is unit-testable without a repo;
// backend.js wires the real `git` via execFileSync.

function createGitWorkspace(opts: {
  git?: GitRunner;
  mkdtemp?: (prefix: string) => string;
  rerere?: boolean;
  log?: Pick<Console, 'warn'>;
} = {}) {
  // The default runner is the promisified execFile: it rejects on a non-zero exit with err.stdout/
  // err.stderr attached, which run()'s catch reads exactly as the sync execFileSync error did. A test
  // may inject a sync fake (returns a string or throws); `await` resolves the string and a sync throw
  // rejects the awaited expression into the same catch, so sync fakes stay valid unchanged.
  // `extra.env` overlays the inherited environment for the one call that needs it (GIT_EDITOR on a
  // rebase --continue), and `extra.timeout` tightens the generic budget for a call that must not hold
  // the engine queue that long (the network fetch on the spawn path). An injected fake simply ignores
  // the third argument.
  const git: GitRunner = opts.git || (async (args, cwd, extra) => {
    const { stdout } = await execFileAsync('git', args, {
      cwd, encoding: 'utf8', timeout: extra?.timeout || 20000,
      ...(extra?.env ? { env: { ...process.env, ...extra.env } } : {}),
    });
    return stdout;
  });
  const mkdtemp = opts.mkdtemp || ((prefix: string) => fs.mkdtempSync(prefix));
  const log = opts.log || console;
  // Share recorded conflict resolutions across every linked worktree of a repo (git's rr-cache lives in
  // the COMMON gitdir, so the sharing is free once rerere.enabled is set). False switches off both the
  // config write and every replay attempt, leaving the merge paths exactly as they were.
  const rerereEnabled = opts.rerere !== false;

  // Engine-level serialization queue. ALL sessions share ONE gitWorkspace instance, and the old
  // synchronous engine was a de-facto global lock (two merges in one process never interleaved). Making
  // the engine async dissolves that implicit lock, so two different sessions merging into the SAME
  // integration branch could interleave their rev-list/stash/rebase/merge sequences across await gaps.
  // serialize() chains the ref/worktree-MUTATING method bodies so they run strictly one at a time.
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

  // Seed refs tried in order to auto-create a missing integration branch: the remote-tracking branch of
  // the same name first (it just is not checked out locally yet), then the repo's likely default
  // branches, then HEAD as a final catch-all (createBody already verified HEAD resolves earlier, so a
  // seed is effectively always found in a repo with commits). Passing the REF NAME (not the sha) to
  // `git branch` means creating from a remote-tracking ref also sets upstream tracking automatically;
  // `--` keeps a config-sourced branch name from ever parsing as a flag. Returns the new branch tip
  // sha (the seed's own sha, so no re-verify is needed), or null when creation fails.
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

  // Create an isolated worktree on `glissa/<teamId>/<label>`. `teamId` names the LANE ("session",
  // "pr-review"); the segment name is on-disk branch shape that boot reconciliation matches, so it
  // stays. Returns { cwd, isGit, branch, base, baseSha }; falls back to { cwd: projectPath, isGit: false }.
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
    if (!head.ok) return { cwd: projectPath, isGit: false }; // no commits yet - nothing to branch from
    // Set here rather than per merge so a worktree that ends up ADOPTED (branch-in-use, below) is
    // covered too, and only when the key is UNSET: an operator who wrote `rerere.enabled = false`
    // means it, and gets no replay. autoUpdate is never written, only forced per invocation
    // (withAutoUpdate), so the operator's own merges keep git's default staging behavior.
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
    await run(['branch', '-D', branch], projectPath); // drop a stale branch left by a crashed prior run

    // A SESSION worktree lives under a stable, project-associated root (worktreeBase, e.g. a
    // `.glissa-worktrees` sibling of the repo) rather than system-temp, so its path is recognizable and
    // persistent. It stays
    // OUTSIDE the repo working tree (no nested biome/eslint config; the main checkout's git status stays
    // clean). A caller that passes no worktreeBase keeps the temp-dir default.
    let wtParent = os.tmpdir();
    let prefix = `glissa-wt-${sanitize(teamId)}-`;
    if (worktreeBase) {
      try { fs.mkdirSync(worktreeBase, { recursive: true }); } catch { /* best-effort */ }
      wtParent = worktreeBase;
      prefix = `${sanitize(path.basename(projectPath)) || 'repo'}-`;
    }
    const wtDir = mkdtemp(path.join(wtParent, prefix));
    const add = await run(['worktree', 'add', '-b', branch, wtDir, baseSha], projectPath);
    if (!add.ok) {
      try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      return { cwd: projectPath, isGit: false, error: add.err };
    }
    // Stamp the fork-base target on the branch itself, so later reads (listSessionWorktrees, boot
    // reconcile) resolve the correct integration branch even if the live config changes afterward.
    // Non-fatal: git drops branch.<name>.* config on branch delete, so no cleanup path is needed either.
    await run(['config', `branch.${branch}.glissa-integration`, base], projectPath);
    // Bring the gitignored local working context (node_modules, .env, .claude, .omc, ...) into the
    // worktree so the spawned agent sees a COMPLETE, recognizable project, not a bare checkout. Dirs are
    // junctioned (shared with the real repo, never copied or merged, gitignored so `git add -A` skips
    // them); files are copied. Entries already committed or absent are skipped.
    await populateShare({ projectPath, wtDir, shareList });
    return { cwd: wtDir, isGit: true, branch, base, baseSha };
  }

  // Bring the gitignored share entries into a worktree. Only entries git IGNORES are brought in, so a
  // shared file/junction can NEVER be staged by mergeBack's `git add -A` and accidentally committed to
  // the integration branch (e.g. leaking a .env). Checked sequentially so the check-ignore probes never
  // interleave with another serialized mutation. Idempotent (entries already present are skipped), so
  // it is also safe on an ADOPTED survivor worktree whose junctions were stripped by a failed removal
  // (removeWorktreeLinks runs before the `worktree remove` that then fails on a locked dir).
  async function populateShare({ projectPath, wtDir, shareList }: WorktreeArgs): Promise<void> {
    if (!wtDir || !shareList || !shareList.length) return;
    const ignored: string[] = [];
    for (const rel of shareList) {
      if (rel && !String(rel).includes('..') && (await run(['check-ignore', '-q', '--', rel], projectPath)).ok) {
        ignored.push(rel);
      }
    }
    if (!ignored.length) return;
    try { await populateWorktree(projectPath, wtDir, ignored); } catch { /* best-effort */ }
    await refuseTrackableLinks(wtDir, ignored);
  }

  // Re-probe in the WORKTREE: a share is a symlink there (a blob to git, unlike a Windows junction), so a trailing-slash ignore pattern stops matching it and `git add -A` could commit it; an unignored link is dropped, same cost as a first-probe refusal.
  async function refuseTrackableLinks(wtDir: string, entries: string[]): Promise<void> {
    for (const rel of entries) {
      if ((await run(['check-ignore', '-q', '--', rel], wtDir)).ok) continue;
      const target = path.join(wtDir, rel);
      const stat = await fsp.lstat(target).catch(() => null);
      if (!stat || !stat.isSymbolicLink()) continue;
      console.warn(`[git-workspace] not sharing ${rel}: git does not ignore it as a link, so a commit in the worktree would carry it (use a slash-free .gitignore entry)`);
      try { await fsp.rm(target, { force: true }); } catch { /* best-effort */ }
    }
  }

  // Junction-safe teardown of a worktree (+ its branch): the node_modules junction is removed BEFORE
  // `worktree remove` so git can never follow it into the operator's real node_modules.
  async function tearDownWorktree(projectPath: string, wt: string, branch: string | null | undefined): Promise<void> {
    removeWorktreeLinks(wt);
    await run(['worktree', 'remove', '--force', wt], projectPath);
    await run(['worktree', 'prune'], projectPath);
    if (branch) await run(['branch', '-D', branch], projectPath);
  }

  // THE fast-forward mechanism: advance `target` to `sourceRef`'s tip. An ff-only merge when `target` is
  // the checked-out HEAD in projectPath (which advances the working tree with it), else a LOCAL fetch
  // (`.` is this repo: no network, and no checkout of the target required). That fetch is enforcement,
  // not just plumbing: with no leading `+` git refuses a non-fast-forward, and it refuses any branch
  // checked out in ANY worktree, so a caller cannot move a ref out from under a live index. `sourceRef`
  // is a FULL ref, since the sources are not all under refs/heads (the integration sync feeds it a
  // remote-tracking ref). Returns { ok, err } so the caller can report why git refused.
  async function fastForwardTarget(projectPath: string, sourceRef: string, target: string, targetIsHead: boolean): Promise<{ ok: boolean; err: string }> {
    if (!targetIsHead) {
      const fetched = await run(['fetch', '.', `${sourceRef}:refs/heads/${target}`], projectPath);
      return { ok: fetched.ok, err: fetched.ok ? '' : (fetched.err ?? '') };
    }
    // The merge takes the SHORT name: `merge --ff-only` resolves either spelling to the same commit, and
    // the short form is the command every existing caller and its pins already issue.
    const merged = await run(['merge', '--ff-only', String(sourceRef).replace(/^refs\/heads\//, '')], projectPath);
    return { ok: merged.ok, err: merged.ok ? '' : (merged.err ?? '') };
  }

  // The files git left unmerged in `wt` right now.
  async function unmergedPaths(wt: string): Promise<string[]> {
    return (await run(['diff', '--name-only', '--diff-filter=U'], wt)).out
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  // Every path that gives up on a conflicted rebase captures the unmerged files BEFORE aborting (the
  // abort restores a clean tree and loses them), so the parked-merge handoff prompt can name exactly
  // what overlaps.
  async function abortRebaseWithConflicts(wt: string): Promise<string[]> {
    const conflicts = await unmergedPaths(wt);
    await run(['rebase', '--abort'], wt);
    return conflicts;
  }

  // True while a rebase is STOPPED on a commit (REBASE_HEAD names it), which is what separates a rebase
  // that hit a conflict from one that never started (an index lock, a hook, an unreadable ref).
  async function rebaseStopped(wt: string): Promise<boolean> {
    return (await run(['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'], wt)).ok;
  }

  // Forced per invocation and NEVER written to the repo config, so the operator's own merges keep git's
  // default (autoUpdate unset) while every rebase Glissa drives has rerere STAGE what it resolved. That
  // staging is the entire completeness proof in replayRecordedResolutions, so it may not be dropped.
  const withAutoUpdate = (args: string[]) => (rerereEnabled ? ['-c', 'rerere.autoUpdate=true', ...args] : args);

  // One rebase step forward. `--skip` rather than `--continue` when the replayed resolution left the
  // patch empty (the change is already upstream), which `--continue` refuses and would strand mid-rebase.
  // GIT_EDITOR=true so no editor can ever hang an unattended loop. `ok` on the step means the whole
  // rebase finished; a non-zero exit with unmerged files means it stopped on the NEXT conflict.
  async function advanceRebaseStep(wt: string): Promise<{ done: boolean; conflicted?: boolean }> {
    const staged = await run(['diff', '--cached', '--quiet'], wt);
    const step = staged.ok ? '--skip' : '--continue';
    const r = await run(withAutoUpdate(['rebase', step]), wt, { env: { GIT_EDITOR: 'true' } });
    if (r.ok) return { done: true };
    return { done: false, conflicted: (await unmergedPaths(wt)).length > 0 };
  }
  // Replay a conflicted rebase out of the shared rr-cache, one conflicted step at a time. Because the
  // rebase and every --continue run with rerere.autoUpdate forced on, rerere stages exactly what it
  // resolved, so "no unmerged paths remain" is a sound proof that this step is fully resolved.
  //
  // `git rerere remaining` is NOT such a proof and must never be used as one: rerere does not track
  // BINARY content conflicts at all (any file with a NUL in its first 8k), so it prints nothing while a
  // binary path is still unmerged. Staging and continuing there commits git's target-side copy over the
  // session's work, and when the staged tree then equals HEAD the step is silently --skipped, dropping
  // the whole commit. Which paths rerere replayed is deliberately NOT reported: git drops a path from
  // MERGE_RR as it resolves it, so by the time the rebase returns, `rerere status` and `rerere remaining`
  // are both empty and no honest per-path list can be recovered (verified against git 2.44).
  //
  // Leaves the conflicted state untouched for the caller's capture-then-abort whenever it cannot finish.
  // Returns { ok, steps }.
  const RERERE_STEP_CAP = 50;
  async function replayRecordedResolutions(wt: string): Promise<{ ok: boolean; steps: number }> {
    let steps = 0;
    for (; steps < RERERE_STEP_CAP; steps += 1) {
      if ((await unmergedPaths(wt)).length) return { ok: false, steps };
      const staged = await run(['add', '-u'], wt);
      if (!staged.ok) return { ok: false, steps }; // the caller aborts; a half-staged step never continues
      const advanced = await advanceRebaseStep(wt);
      if (advanced.done) return { ok: true, steps: steps + 1 };
      if (!advanced.conflicted) return { ok: false, steps };
    }
    return { ok: false, steps };
  }

  // The shared merge core (COMMITTED-ONLY): merge the commits already on `branch` into `target` via
  // rebase-then-FF, leaving UNCOMMITTED working-tree changes out of the merge. Uncommitted edits are never
  // swept in (the operator's "commit it first" boundary, and what the review sidebar draws its committed/
  // uncommitted line on) and never destroyed: they are stashed around the rebase (which needs a clean
  // tree) and ALWAYS restored afterward. Callers that want to tear the worktree down (mergeBack) must do
  // so only on a clean tree, so this function never has to drop a stash. Does NOT tear anything down - the
  // caller decides. Serialized by the engine-level `serialize` queue (its callers mergeBack/mergeKeep are
  // wrapped), so two merges into the same target never interleave: the first advances the target before
  // the second reads it. A rebase conflict ABORTS and reports parked; nothing is ever auto-resolved.
  // `committed` means "there were commits to merge", not that this function made one.
  // Returns { committed, merged, reason, parked?, restoreConflict?, rerereReplayed? }.
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
    // Commits on the branch but not yet on the target = exactly what merging would bring in. None means
    // there is nothing committed to merge (uncommitted-only work is left for the operator to commit).
    const ahead = await run(['rev-list', '--count', `${target}..${branch}`], projectPath);
    if (!ahead.ok || ahead.out === '' || ahead.out === '0') {
      return { committed: false, merged: false, reason: 'nothing-to-commit' };
    }

    // Stash uncommitted work (incl. untracked) so the rebase runs on a clean tree. Track whether the stash
    // actually took: only pop when it did, so a failed push can never make a later pop grab an unrelated,
    // pre-existing stash (which would corrupt the worktree).
    const dirty = (await run(['status', '--porcelain'], wt)).out !== '';
    const stashed = dirty && (await run(['stash', 'push', '--include-untracked', '-m', 'glissa-merge'], wt)).ok;

    // Rebase onto the integration branch. A conflict git has ALREADY seen resolved once (shared rr-cache)
    // is replayed and the rebase carries on as an ordinary success; anything else aborts and reports
    // parked (caller keeps the branch), exactly as before rerere existed.
    let rerereReplayed = false;
    if (!(await run(withAutoUpdate(['rebase', target]), wt)).ok) {
      const replay = rerereEnabled && (await rebaseStopped(wt))
        ? await replayRecordedResolutions(wt)
        : { ok: false };
      if (!replay.ok) {
        const conflicts = await abortRebaseWithConflicts(wt);
        if (stashed) await run(['stash', 'pop'], wt); // hand the operator their uncommitted work back, un-rebased
        return { committed: true, merged: false, reason: 'rebase-conflict', parked: true, conflicts };
      }
      rerereReplayed = true;
    }

    // Fast-forward the integration branch to the rebased session branch.
    const head = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath)).out;
    const merged = await fastForwardTarget(projectPath, `refs/heads/${branch}`, target, head === target);
    if (!merged.ok) {
      if (stashed) await run(['stash', 'pop'], wt);
      return { committed: true, merged: false, reason: 'not-fast-forward', parked: true, rerereReplayed };
    }

    // Merged. Restore the uncommitted work onto the rebased worktree. A `stash pop` that conflicts leaves
    // markers for the operator and is reported (restoreConflict), never auto-resolved.
    const restoreConflict = stashed ? !(await run(['stash', 'pop'], wt)).ok : false;
    return { committed: true, merged: true, reason: null, restoreConflict, rerereReplayed };
  }

  // Shared guard preamble for the merge-back paths (mergeBack/mergeKeep): validate the workspace and
  // resolve the integration target. Returns { wt, branch, target } on success, or { error } carrying the
  // caller's standard failure result. The integration branch must already exist - Glissa never creates it
  // (AC-16) - so a missing target reports parked.
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

  // Session worktree merge-back into the integration branch that ENDS the session:
  // committed-only rebase-then-FF via rebaseFfBranch, then tear the worktree down junction-safely. A
  // rebase conflict / lost FF PARKS the branch (worktree + branch preserved) for a manual merge. Returns
  // { merged, committed, branch, base, reason, parked? }; `branch` is null once merged (deleted) or
  // discarded, else the parked branch.
  async function mergeBackBody({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<MergeOutcome> {
    const g = await resolveMergeBack({ projectPath, workspace, targetBranch });
    if (g.error) return g.error;
    const { wt = '', branch = '', target = '' } = g;

    const baseSync = await synchronizeBaseWithOrigin(projectPath, target);
    if (baseSync.state === 'diverged') {
      return { merged: false, committed: false, branch, base: target, reason: 'base-diverged', parked: true };
    }
    const warning = mergeSyncWarning(baseSync, target);

    // Finishing tears the worktree down, which would DESTROY any uncommitted work. Never do that
    // silently: if the worktree is dirty, refuse and PARK (worktree + branch preserved) so the operator
    // commits or discards the uncommitted work first, then finishes. (committed-only never sweeps
    // uncommitted work into the merge, so there is nothing to gain by merging here while dirty either.)
    if ((await run(['status', '--porcelain'], wt)).out !== '') {
      return includeWarning({ merged: false, committed: false, branch, base: target, reason: 'uncommitted-changes', parked: true }, warning);
    }

    const r = await rebaseFfBranch({ projectPath, wt, branch, target });
    if (!r.committed) {
      // Clean worktree with nothing committed = a throwaway chat/research session: discard it (junction-safe).
      await tearDownWorktree(projectPath, wt, branch);
      return includeWarning({ merged: false, committed: false, branch: null, base: target, reason: 'nothing-to-commit' }, warning);
    }
    if (!r.merged) {
      // Rebase conflict / lost FF: PARK (keep worktree + branch for manual resolution).
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

  // Like mergeBack, but KEEPS the worktree alive on success: after the rebase-then-FF, the worktree
  // STAYS checked out on its branch (now sitting on top of the freshly advanced target). This is the
  // "merge/commit as you go" path: the operator's LIVE session keeps running in the same worktree and
  // can produce + merge more changes later. A rebase conflict / lost FF still PARKS (worktree + branch
  // preserved); nothing-to-commit is a harmless no-op that keeps the worktree. Returns { merged,
  // committed, branch, base, baseSha?, kept, reason, parked? }; `branch` is retained (non-null) whenever
  // the worktree is kept, and baseSha is the new integration tip the worktree was rebased onto.
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
      // Nothing committed to merge yet - keep the worktree; the live session commits more then merges.
      return includeWarning({ merged: false, committed: false, branch, base: target, reason: 'nothing-to-commit', kept: true }, warning);
    }
    if (!r.merged) {
      return includeWarning({ merged: false, committed: true, branch, base: target, reason: r.reason, parked: true, conflicts: r.conflicts || [] }, warning);
    }
    // Merged AND kept: record the new integration tip the worktree now sits on top of. restoreConflict
    // flags that the stashed uncommitted work reapplied with conflict markers for the operator to resolve.
    const baseSha = (await run(['rev-parse', target], projectPath)).out || workspace?.baseSha || null;
    const pushed = await pushBaseToOrigin(projectPath, target);
    return includeWarning({
      merged: true, committed: true, branch, base: target, baseSha, kept: true, reason: null,
      pushed, restoreConflict: r.restoreConflict || false, rerereReplayed: r.rerereReplayed === true,
    }, warning);
  }

  // Eager conflict avoidance: replay this worktree's own commits on top of a moved integration branch
  // WITHOUT merging anything back, so the drift a long-lived session accumulates is paid off in small
  // pieces instead of as one large conflict at merge time. Automatic and unattended, so it refuses far
  // more than the merge paths do: a dirty tree is REFUSED rather than stashed (stashing underneath a live
  // agent is exactly the risk this feature exists to avoid), and a conflict rerere cannot replay aborts
  // and leaves the worktree byte-identical to how it was found - the operator's eventual Merge then hits
  // the same conflict and the existing parked handoff takes over. Returns { ok, upToDate?, rebased?,
  // headSha?, baseSha?, rerereReplayed?, reason?, conflicts? }.
  async function rebaseOnlyBody({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<RebaseOutcome> {
    const g = await resolveMergeBack({ projectPath, workspace, targetBranch });
    if (g.error) return { ok: false, reason: g.error.reason ?? undefined };
    const { wt = '', target = '' } = g;

    const status = await run(['status', '--porcelain'], wt);
    if (!status.ok) return { ok: false, reason: 'unreadable' };
    if (status.out !== '') return { ok: false, reason: 'dirty' };

    // Nothing on the target this worktree does not already have: a rebase would be a no-op, so skip the
    // ref churn (and the hot-reload poke a rewritten worktree costs a live session) entirely.
    const behind = await run(['rev-list', '--count', `HEAD..${target}`], wt);
    if (!behind.ok) return { ok: false, reason: 'unreadable' };
    if (behind.out === '' || behind.out === '0') return { ok: true, upToDate: true };

    let rerereReplayed = false;
    if (!(await run(withAutoUpdate(['rebase', target]), wt)).ok) {
      // A rebase that never STARTED (an index lock, a hook, an unreadable ref) is transient: there is
      // nothing to abort and nothing an operator could resolve, so it is reported apart from a real
      // conflict and deliberately does not arm the caller's conflict cooldown.
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

  // Throw away a worktree and its branch (cancelled runs): nothing is committed or merged.
  async function discardBody({ projectPath, workspace }: WorktreeArgs): Promise<void> {
    if (!workspace || !workspace.isGit) return;
    if (workspace.cwd) {
      removeWorktreeLinks(workspace.cwd);
      await run(['worktree', 'remove', '--force', workspace.cwd], projectPath);
    }
    if (workspace.branch) await run(['branch', '-D', workspace.branch], projectPath);
    await run(['worktree', 'prune'], projectPath);
  }

  // THE shared dirty-or-ahead probe (marker-resolved integration branch, porcelain, ahead-count only when clean), returning raw {ok,out} so each caller applies its own failure policy.
  async function probeWorktreeWork({ projectPath, cwd, branch, integrationBranch }: {
    projectPath: string;
    cwd: string;
    branch: string;
    integrationBranch?: string | null;
  }): Promise<{ dirty: GitResult; ahead: GitResult | null; integrationBranch: string | null }> {
    // The marker is the authority for THIS worktree's integration branch; the passed integrationBranch
    // is only the fallback for a worktree created before the marker existed.
    const marker = await run(['config', '--get', `branch.${branch}.glissa-integration`], projectPath);
    const resolvedIntegrationBranch = markerFrom(marker) || integrationBranch;
    // The ahead-count is only asked for when the working tree is clean: a dirty tree already holds work.
    const dirty = await run(['status', '--porcelain'], cwd);
    const ahead = !isDirtyResult(dirty) && resolvedIntegrationBranch
      ? await run(['rev-list', '--count', `${resolvedIntegrationBranch}..${branch}`], projectPath)
      : null;
    return { dirty, ahead, integrationBranch: resolvedIntegrationBranch ?? null };
  }

  // Exit-time never-destroy-work test: the boot reconcile's dirty-or-ahead rule failing SAFE (a probe that cannot run reads as work), because uncommitted-only once let discard's `git branch -D` take a committed-but-clean session's last ref and reflog.
  async function hasUnmergedWork({ projectPath, workspace, integrationBranch }: WorktreeArgs): Promise<boolean> {
    if (!workspace || !workspace.isGit || !workspace.cwd || !workspace.branch) return true;
    const { dirty, ahead } = await probeWorktreeWork({
      projectPath, cwd: workspace.cwd, branch: workspace.branch,
      integrationBranch: integrationBranch || workspace.base,
    });
    if (!dirty.ok) return true;
    if (isDirtyResult(dirty)) return true;
    if (!ahead || !ahead.ok) return true; // no integration branch to compare against, or rev-list failed
    return hasWorkFrom(dirty, ahead);
  }

  // List the SESSION worktrees (branch `glissa/session/<id>`) of a repo, each with its extracted session
  // id and whether it holds unmerged work.
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

  // Junction-safe removal of a single worktree by path (+ its branch), then prune. A mutator, so it is
  // serialized too (the async engine never races it against a live merge into the same target).
  async function removeWorktreeByPathBody({ projectPath, cwd, branch }: WorktreeArgs): Promise<void> {
    if (cwd) {
      removeWorktreeLinks(cwd);
      await run(['worktree', 'remove', '--force', cwd], projectPath);
    }
    if (branch) await run(['branch', '-D', branch], projectPath);
    await run(['worktree', 'prune'], projectPath);
  }

  // Generic worktree enumeration for callers that need to know which branches are checked out
  // anywhere in a repo (e.g. the PR-review poller's branch-in-use precheck and its orphan prune).
  // Returns every worktree carrying a branch as { cwd, branch }; goes through this module so the
  // `git worktree` guard stays satisfied. A read-only listing (not serialized): a stale entry only
  // makes a precheck slightly stale, which the caller's failing `gh pr checkout` then handles.
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
    // The ONE network call on the spawn path refreshes the full tracking namespace so a missing target
    // is represented by an absent tracking ref rather than a failed branch-specific fetch.
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

  // Every ref/worktree-MUTATING method is the same shape: run its body on the serialize queue. populate
  // is the one whose inner half stays reachable unwrapped (createBody calls populateShare directly;
  // chaining from inside the queue would deadlock on a tail that includes the in-flight create).
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

// Synchronous sibling for the ONE-SHOT cold boot reconcile (backend.js), which runs once at server start
// before any live session streams, so a blocking git call there steals no PTY time (MEMORY
// single-event-loop-no-sync-git: one-shot cold paths may stay sync). It exposes only boot reconciliation
// plus the store-open project resolver, so the live
// async engine is never reached from boot and the cold path never awaits. Logic mirrors the async engine
// with execFileSync; no serialize queue is needed (single caller, single pass, no concurrency).
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

  // The async engine's listSessionWorktrees, step for step, over the sync runner: same git calls in the
  // same order, and the same shared marker/hasWork rules, so the two cannot report a worktree differently.
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

// Remove every JUNCTION/symlink reparse point at the top level of a worktree WITHOUT touching its
// target. Critical before `git worktree remove --force`: a left-in-place junction (node_modules, .claude,
// .omc, ...) can be followed by git and delete the operator's REAL directory. Real (non-symlink) dirs and
// files are left for worktree-remove to delete. Best-effort and idempotent.
function removeWorktreeLinks(wtDir: string | null | undefined): void {
  if (!wtDir) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(wtDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue; // junctions report as symbolic links via the dirent lstat
    const p = path.join(wtDir, e.name);
    try { fs.rmSync(p, { recursive: false, force: true }); }
    catch { try { fs.rmdirSync(p); } catch { /* best-effort */ } }
  }
}

// Bring gitignored local working context into a worktree. Each share entry: a DIR is junctioned
// (mklink /J - shared with the real repo, never copied or merged, gitignored so `git add -A` skips it);
// a FILE is copied. Entries already present in the worktree (committed) or absent in the project are
// skipped. Best-effort per entry so one failure never aborts the spawn. Windows junctions need no admin.
// Async on purpose: this runs on EVERY isolated lane spawn, and a sync cmd.exe spawn or copy
// here stalls every other session's PTY streaming on the shared event loop.
async function populateWorktree(projectPath: string, wtDir: string, shareList: string[]): Promise<void> {
  for (const rel of shareList) {
    if (!rel || String(rel).includes('..')) continue; // no path traversal
    const src = path.join(projectPath, rel);
    const dst = path.join(wtDir, rel);
    try {
      const srcStat = await fsp.stat(src).catch(() => null);
      if (!srcStat) continue;  // nothing to share
      const dstExists = await fsp.access(dst).then(() => true, () => false);
      if (dstExists) continue; // already in the worktree (committed) - leave it
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
    } catch { /* best-effort: the session runs without that piece */ }
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
