import fs from 'node:fs';
import path from 'node:path';

import type { UpdateChannel } from '../shared/contracts/update-journal.ts';
import { execFileAsync } from './child-process-safe.ts';
import { glissaHomeDir } from './config-store.ts';
import { parseLeftRightCount, parseRemoteFromUpstream } from './core/branch-sync-core.ts';
import {
  decideInstallFlavor,
  decideUpdateStatus,
  isCheckFresh,
  normalizeSha,
  parseLatestReleaseTag,
  parseLsRemoteTags,
  parseResolvedSha,
} from './core/update-core.ts';
import type { InstallFlavor } from './core/update-core.ts';
import { writeJsonAtomicSync } from './json-file.ts';
import { packageRoot as resolvedPackageRoot } from './runtime-paths.ts';

const GIT_REMOTE_URL = 'https://github.com/johncwaters/glissa.git';
const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/johncwaters/glissa/releases/latest';
const DEFAULT_TIMEOUT_MS = 8000;
const GIT_HEAD_TIMEOUT_MS = 3000;
const LS_REMOTE_TIMEOUT_MS = 5000;
const MAIN_CHANNEL_BUDGET_MS = DEFAULT_TIMEOUT_MS;
const MAIN_FETCH_TIMEOUT_MS = Math.floor(MAIN_CHANNEL_BUDGET_MS / 2);
const MAIN_REMOTE_TIP_TIMEOUT_MS = Math.floor(MAIN_CHANNEL_BUDGET_MS / 4);
const MAIN_BEHIND_COUNT_TIMEOUT_MS = Math.floor(MAIN_CHANNEL_BUDGET_MS / 4);
const STATE_FILE_NAME = 'update-check.json';
const STATE_TTL_MS = 6 * 60 * 60 * 1000;

type RunCommand = typeof execFileAsync;
type GitCallResult = { ok: boolean; out: string; err?: string };
type FetchOrigin = (args: { projectPath: string; timeoutMs?: number }) => Promise<GitCallResult>;

interface InstalledIdentity {
  flavor: InstallFlavor;
  installedSha: string | null;
  installedBranch: string | null;
  upstream: string | null;
  isTreeClean: boolean | null;
}

interface LatestTarget {
  version: string | null;
  sha: string | null;
  behindCount: number | null;
  reason: string | null;
}

interface CheckState {
  lastCheckAt?: unknown;
  channel?: unknown;
  latestVersion?: string | null;
  latestSha?: string | null;
  behindCount?: unknown;
  reason?: unknown;
}

interface CheckForUpdateOptions {
  currentVersion?: string;
  updateChannel?: UpdateChannel;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  abortController?: AbortController;
  packageRoot?: string;
  runCommand?: RunCommand;
  fetchOrigin?: FetchOrigin;
  statePath?: string;
  ttlMs?: number;
  now?: number;
}

type CoreUpdateStatus = ReturnType<typeof decideUpdateStatus>;
type UpdateCheckStatus = CoreUpdateStatus & {
  installedBranch: string | null;
  upstream: string | null;
  isTreeClean: boolean | null;
  lastCheckAt: number;
};

function defaultStatePath(): string {
  return path.join(glissaHomeDir(), STATE_FILE_NAME);
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readLockfileSha(packageRoot: string): string | null {
  const document = readRecord(readJsonFile(path.join(packageRoot, '..', '.package-lock.json')));
  const packages = readRecord(document?.packages);
  const entry = readRecord(packages?.['node_modules/glissa']);
  if (!entry) return null;
  return parseResolvedSha(entry.resolved);
}

function readPackageGitHead(packageRoot: string): string | null {
  const document = readRecord(readJsonFile(path.join(packageRoot, 'package.json')));
  if (!document) return null;
  return normalizeSha(document.gitHead);
}

function directoryExists(directoryPath: string): boolean {
  try {
    return fs.existsSync(directoryPath);
  } catch {
    return false;
  }
}

function commandErrorText(error: unknown): string {
  const commandError = error as { stderr?: unknown; message?: unknown } | null;
  return String(commandError?.stderr || commandError?.message || error || 'git command failed').trim();
}

async function runGitProbe(
  runCommand: RunCommand,
  args: string[],
  options: Record<string, unknown>,
): Promise<GitCallResult> {
  try {
    const { stdout } = await runCommand('git', args, options);
    return { ok: true, out: typeof stdout === 'string' ? stdout.trim() : '' };
  } catch (error) {
    return { ok: false, out: '', err: commandErrorText(error) };
  }
}

async function probeBranchAndUpstream(
  probe: (args: string[]) => Promise<GitCallResult>,
): Promise<{ branch: string | null; upstream: string | null }> {
  const branchProbe = await probe(['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstreamProbe = await probe(['rev-parse', '--abbrev-ref', '@{upstream}']);
  return {
    branch: branchProbe.ok && branchProbe.out !== 'HEAD' ? branchProbe.out : null,
    upstream: upstreamProbe.ok && upstreamProbe.out ? upstreamProbe.out : null,
  };
}

async function cloneIdentity(
  packageRoot: string,
  runCommand: RunCommand,
  signal: AbortSignal,
): Promise<InstalledIdentity> {
  const options = { cwd: packageRoot, timeout: GIT_HEAD_TIMEOUT_MS, signal };
  const head = await runGitProbe(runCommand, ['rev-parse', 'HEAD'], options);
  const checkout = await probeBranchAndUpstream((args) => runGitProbe(runCommand, args, options));
  const status = await runGitProbe(
    runCommand,
    ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'],
    options,
  );
  return {
    flavor: 'clone',
    installedSha: normalizeSha(head.out),
    installedBranch: checkout.branch,
    upstream: checkout.upstream,
    isTreeClean: status.ok ? status.out === '' : null,
  };
}

async function resolveInstalledIdentity(
  { packageRoot, runCommand, signal }: { packageRoot: string; runCommand: RunCommand; signal: AbortSignal },
): Promise<InstalledIdentity> {
  const decided = decideInstallFlavor({
    lockfileSha: readLockfileSha(packageRoot),
    gitHeadSha: readPackageGitHead(packageRoot),
    hasGitDir: directoryExists(path.join(packageRoot, '.git')),
  });
  if (decided.flavor === 'clone') return cloneIdentity(packageRoot, runCommand, signal);
  return { ...decided, installedBranch: null, upstream: null, isTreeClean: null };
}

async function resolveLatestRelease(
  { runCommand, fetchFn, signal }: { runCommand: RunCommand; fetchFn: typeof fetch; signal: AbortSignal },
): Promise<LatestTarget> {
  const remoteTags = await runGitProbe(runCommand, ['ls-remote', '--tags', GIT_REMOTE_URL], {
    timeout: LS_REMOTE_TIMEOUT_MS,
    signal,
  });
  const fromRemote = parseLsRemoteTags(remoteTags.out);
  if (fromRemote) return { ...fromRemote, behindCount: null, reason: null };
  try {
    const response = await fetchFn(GITHUB_LATEST_RELEASE_URL, {
      signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'glissa-update-check' },
    });
    if (!response || !response.ok) return { version: null, sha: null, behindCount: null, reason: 'release-check-failed' };
    const release = parseLatestReleaseTag(await response.json());
    if (!release) return { version: null, sha: null, behindCount: null, reason: 'release-check-failed' };
    return { ...release, behindCount: null, reason: null };
  } catch {
    return { version: null, sha: null, behindCount: null, reason: 'release-check-failed' };
  }
}

function upstreamBranch(upstream: string): string | null {
  const slashIndex = upstream.indexOf('/');
  if (slashIndex < 0 || slashIndex === upstream.length - 1) return null;
  return upstream.slice(slashIndex + 1);
}

async function fetchMainRemote(
  packageRoot: string,
  remote: string,
  runCommand: RunCommand,
  fetchOrigin: FetchOrigin | undefined,
  signal: AbortSignal,
): Promise<GitCallResult> {
  if (remote === 'origin' && fetchOrigin) return fetchOrigin({ projectPath: packageRoot, timeoutMs: MAIN_FETCH_TIMEOUT_MS });
  return runGitProbe(runCommand, ['fetch', '--prune', remote], {
    cwd: packageRoot,
    timeout: MAIN_FETCH_TIMEOUT_MS,
    signal,
  });
}

async function resolveLatestMain(
  installed: InstalledIdentity,
  packageRoot: string,
  runCommand: RunCommand,
  fetchOrigin: FetchOrigin | undefined,
  signal: AbortSignal,
): Promise<LatestTarget> {
  if (installed.flavor !== 'clone') {
    return { version: null, sha: null, behindCount: null, reason: 'main-channel-requires-clone' };
  }
  if (!installed.installedBranch) return { version: null, sha: null, behindCount: null, reason: 'no-branch' };
  if (!installed.upstream) return { version: null, sha: null, behindCount: null, reason: 'no-upstream' };
  const remote = parseRemoteFromUpstream(installed.upstream);
  const branch = upstreamBranch(installed.upstream);
  if (!branch) return { version: null, sha: null, behindCount: null, reason: 'no-upstream' };
  const fetched = await fetchMainRemote(packageRoot, remote, runCommand, fetchOrigin, signal);
  if (!fetched.ok) return { version: null, sha: null, behindCount: null, reason: 'fetch-failed' };
  if (signal.aborted) return { version: null, sha: null, behindCount: null, reason: 'remote-tip-unavailable' };
  const remoteTip = await runGitProbe(runCommand, ['ls-remote', remote, `refs/heads/${branch}`], {
    cwd: packageRoot,
    timeout: MAIN_REMOTE_TIP_TIMEOUT_MS,
    signal,
  });
  const targetSha = normalizeSha(remoteTip.out.split(/\s+/)[0]);
  if (!targetSha) return { version: null, sha: null, behindCount: null, reason: 'remote-tip-unavailable' };
  if (signal.aborted) return { version: null, sha: targetSha, behindCount: null, reason: 'branch-count-unavailable' };
  const countsProbe = await runGitProbe(runCommand, ['rev-list', '--left-right', '--count', `HEAD...${targetSha}`], {
    cwd: packageRoot,
    timeout: MAIN_BEHIND_COUNT_TIMEOUT_MS,
    signal,
  });
  const counts = countsProbe.ok ? parseLeftRightCount(countsProbe.out) : null;
  if (!counts) return { version: null, sha: targetSha, behindCount: null, reason: 'branch-count-unavailable' };
  const reason = counts.behind > 0 && counts.ahead > 0 ? 'branch-diverged' : null;
  return { version: null, sha: targetSha, behindCount: counts.ahead, reason };
}

function readCheckState(statePath: string): CheckState | null {
  return readRecord(readJsonFile(statePath));
}

function writeCheckState(statePath: string, state: Record<string, unknown>): void {
  try {
    writeJsonAtomicSync(statePath, state, { mkdir: true });
  } catch {
  }
}

function finish(
  installed: InstalledIdentity,
  latestTarget: LatestTarget,
  currentVersion: string | undefined,
  channel: UpdateChannel,
  lastCheckAt: number,
): UpdateCheckStatus {
  return {
    ...decideUpdateStatus({
      installedSha: installed.installedSha,
      latestSha: latestTarget.sha,
      currentVersion,
      latestVersion: latestTarget.version,
      flavor: installed.flavor,
      channel,
      behindCount: latestTarget.behindCount,
      reason: latestTarget.reason,
    }),
    installedBranch: installed.installedBranch,
    upstream: installed.upstream,
    isTreeClean: installed.isTreeClean,
    lastCheckAt,
  };
}

function targetFromCache(cached: CheckState): LatestTarget {
  const behindCount = Number.isInteger(cached.behindCount) && Number(cached.behindCount) >= 0
    ? Number(cached.behindCount)
    : null;
  return {
    version: typeof cached.latestVersion === 'string' ? cached.latestVersion : null,
    sha: typeof cached.latestSha === 'string' ? cached.latestSha : null,
    behindCount,
    reason: typeof cached.reason === 'string' ? cached.reason : null,
  };
}

async function checkForUpdate({
  currentVersion,
  updateChannel = 'release',
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  abortController = new AbortController(),
  packageRoot = resolvedPackageRoot,
  runCommand = execFileAsync,
  fetchOrigin,
  statePath = defaultStatePath(),
  ttlMs = STATE_TTL_MS,
  now = Date.now(),
}: CheckForUpdateOptions = {}): Promise<UpdateCheckStatus> {
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const signal = abortController.signal;
  let installed: InstalledIdentity = {
    flavor: 'unknown',
    installedSha: null,
    installedBranch: null,
    upstream: null,
    isTreeClean: null,
  };
  try {
    installed = await resolveInstalledIdentity({ packageRoot, runCommand, signal });
    const cached = readCheckState(statePath);
    const cacheOutrunByInstall = normalizeSha(cached?.latestSha) !== null
      && normalizeSha(cached?.latestSha) === installed.installedSha;
    if (cached?.channel === updateChannel && !cacheOutrunByInstall && isCheckFresh(cached.lastCheckAt, now, ttlMs)) {
      return finish(installed, targetFromCache(cached), currentVersion, updateChannel, now);
    }
    signal.throwIfAborted();
    const latestTarget = updateChannel === 'main'
      ? await resolveLatestMain(installed, packageRoot, runCommand, fetchOrigin, signal)
      : await resolveLatestRelease({ runCommand, fetchFn, signal });
    const hasCacheableTarget = latestTarget.reason === null
      && (latestTarget.version !== null || latestTarget.sha !== null);
    if (hasCacheableTarget) {
      writeCheckState(statePath, {
        lastCheckAt: now,
        channel: updateChannel,
        latestVersion: latestTarget.version,
        latestSha: normalizeSha(latestTarget.sha),
        behindCount: latestTarget.behindCount,
        reason: latestTarget.reason,
      });
    }
    return finish(installed, latestTarget, currentVersion, updateChannel, now);
  } catch {
    return finish(
      installed,
      { version: null, sha: null, behindCount: null, reason: 'update-check-failed' },
      currentVersion,
      updateChannel,
      now,
    );
  } finally {
    clearTimeout(timer);
  }
}

export {
  GITHUB_LATEST_RELEASE_URL,
  GIT_REMOTE_URL,
  MAIN_FETCH_TIMEOUT_MS,
  STATE_FILE_NAME,
  STATE_TTL_MS,
  checkForUpdate,
  probeBranchAndUpstream,
};
export type { CheckForUpdateOptions, FetchOrigin, GitCallResult, UpdateCheckStatus };
