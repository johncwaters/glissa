import fs from 'node:fs';
import path from 'node:path';

import { execFileAsync } from './child-process-safe.ts';
import { glissaHomeDir } from './config-store.ts';
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
const STATE_FILE_NAME = 'update-check.json';
const STATE_TTL_MS = 6 * 60 * 60 * 1000;

type RunCommand = typeof execFileAsync;

interface InstalledIdentity {
  flavor: InstallFlavor;
  installedSha: string | null;
}

interface LatestRelease {
  version: string | null;
  sha: string | null;
}

interface CheckState {
  lastCheckAt?: unknown;
  latestVersion?: string | null;
  latestSha?: string | null;
}

interface CheckForUpdateOptions {
  currentVersion?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  abortController?: AbortController;
  packageRoot?: string;
  runCommand?: RunCommand;
  statePath?: string;
  ttlMs?: number;
  now?: number;
}

type UpdateStatus = ReturnType<typeof decideUpdateStatus>;

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
  const doc = readRecord(readJsonFile(path.join(packageRoot, '..', '.package-lock.json')));
  const packages = readRecord(doc?.packages);
  const entry = readRecord(packages?.['node_modules/glissa']);
  if (!entry) return null;
  return parseResolvedSha(entry.resolved);
}

function readPackageGitHead(packageRoot: string): string | null {
  const doc = readRecord(readJsonFile(path.join(packageRoot, 'package.json')));
  if (!doc) return null;
  return normalizeSha(doc.gitHead);
}

function dirExists(dirPath: string): boolean {
  try {
    return fs.existsSync(dirPath);
  } catch {
    return false;
  }
}

async function runGitStdout(
  runCommand: RunCommand,
  args: string[],
  options: Record<string, unknown>,
): Promise<string> {
  try {
    const { stdout } = await runCommand('git', args, options);
    return typeof stdout === 'string' ? stdout : '';
  } catch {
    return '';
  }
}

async function resolveInstalledIdentity(
  { packageRoot, runCommand, signal }: { packageRoot: string; runCommand: RunCommand; signal: AbortSignal },
): Promise<InstalledIdentity> {
  const decided = decideInstallFlavor({
    lockfileSha: readLockfileSha(packageRoot),
    gitHeadSha: readPackageGitHead(packageRoot),
    hasGitDir: dirExists(path.join(packageRoot, '.git')),
  });
  if (decided.flavor !== 'clone') return decided;
  const stdout = await runGitStdout(runCommand, ['rev-parse', 'HEAD'], {
    cwd: packageRoot,
    timeout: GIT_HEAD_TIMEOUT_MS,
    signal,
  });
  return { flavor: 'clone', installedSha: normalizeSha(stdout) };
}

async function resolveLatestRelease(
  { runCommand, fetchFn, signal }: { runCommand: RunCommand; fetchFn: typeof fetch; signal: AbortSignal },
): Promise<LatestRelease | null> {
  const stdout = await runGitStdout(runCommand, ['ls-remote', '--tags', GIT_REMOTE_URL], {
    timeout: LS_REMOTE_TIMEOUT_MS,
    signal,
  });
  const fromLsRemote = parseLsRemoteTags(stdout);
  if (fromLsRemote) return fromLsRemote;
  try {
    const res = await fetchFn(GITHUB_LATEST_RELEASE_URL, {
      signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'glissa-update-check' },
    });
    if (!res || !res.ok) return null;
    return parseLatestReleaseTag(await res.json());
  } catch {
    return null;
  }
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
  latestRelease: LatestRelease | null,
  currentVersion: string | undefined,
): UpdateStatus | null {
  const latestVersion = latestRelease?.version || null;
  if (!latestVersion) return null;
  return decideUpdateStatus({
    installedSha: installed.installedSha,
    latestSha: latestRelease?.sha,
    currentVersion,
    latestVersion,
    flavor: installed.flavor,
  });
}

async function checkForUpdate({
  currentVersion,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  abortController = new AbortController(),
  packageRoot = resolvedPackageRoot,
  runCommand = execFileAsync,
  statePath = defaultStatePath(),
  ttlMs = STATE_TTL_MS,
  now = Date.now(),
}: CheckForUpdateOptions = {}): Promise<UpdateStatus | null> {
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const signal = abortController.signal;
  try {
    const installed = await resolveInstalledIdentity({ packageRoot, runCommand, signal });
    const cached = readCheckState(statePath);
    if (cached && isCheckFresh(cached.lastCheckAt, now, ttlMs)) {
      return finish(installed, { version: cached.latestVersion || null, sha: cached.latestSha || null }, currentVersion);
    }
    signal.throwIfAborted();
    const latestRelease = await resolveLatestRelease({ runCommand, fetchFn, signal });
    if (latestRelease?.version) {
      writeCheckState(statePath, {
        lastCheckAt: now,
        latestVersion: latestRelease.version,
        latestSha: normalizeSha(latestRelease.sha),
      });
    }
    return finish(installed, latestRelease, currentVersion);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export {
  GITHUB_LATEST_RELEASE_URL,
  GIT_REMOTE_URL,
  STATE_FILE_NAME,
  STATE_TTL_MS,
  checkForUpdate,
};
export type { CheckForUpdateOptions };
