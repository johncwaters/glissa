'use strict';

// Self-update check: compare the commit this install was built from against the tip of the main branch,
// and surface the command that updates THIS flavor of install. Glissa ships as a branch tip (an npm git
// install or a clone), so the old semver-only check saw an update only on release commits and missed
// nearly everything; the version pair survives as the label, not the signal.
// Advisory only - every failure path resolves null or degrades to the semver compare, never rejects, so
// a boot is never blocked, delayed past the timeout, or crashed by this check. Notify only: nothing here
// runs an update (on Windows the running server holds node_modules/node-pty open).
// All decisions live in server/core/update-core.js; this file is the IO around them, with every IO seam
// injectable so the whole check runs offline in tests.

const fs = require('node:fs');
const path = require('node:path');

const { execFileAsync } = require('./child-process-safe');
const { glissaHomeDir } = require('./config-store');
const { writeJsonAtomicSync } = require('./json-file');
const {
  decideInstallFlavor,
  decideUpdateStatus,
  isCheckFresh,
  parseLatestVersion,
  parseLsRemoteSha,
  parseResolvedSha,
  normalizeSha,
} = require('./core/update-core');

const GITHUB_PACKAGE_JSON_URL = 'https://raw.githubusercontent.com/johncwaters/glissa/main/package.json';
const GIT_REMOTE_URL = 'https://github.com/johncwaters/glissa.git';
const GITHUB_SHA_API_URL = 'https://api.github.com/repos/johncwaters/glissa/commits/main';
// Budget for the WHOLE check (up to three network legs), not per request.
const DEFAULT_TIMEOUT_MS = 8000;
const GIT_HEAD_TIMEOUT_MS = 3000;
const LS_REMOTE_TIMEOUT_MS = 5000;
const STATE_FILE_NAME = 'update-check.json';
const STATE_TTL_MS = 6 * 60 * 60 * 1000;

function defaultStatePath() {
  return path.join(glissaHomeDir(), STATE_FILE_NAME);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// npm records the resolved commit of a global git install in the hidden lockfile one level ABOVE the
// package (node_modules/.package-lock.json), which survives an install that stripped .git.
function readLockfileSha(packageRoot) {
  const doc = readJsonFile(path.join(packageRoot, '..', '.package-lock.json'));
  const entry = doc?.packages?.['node_modules/glissa'];
  if (!entry) return null;
  return parseResolvedSha(entry.resolved);
}

// npm stamps `gitHead` into the packed package.json of a git install; the fallback when no lockfile
// entry is readable (a different install layout, or a lockfile npm never wrote).
function readPackageGitHead(packageRoot) {
  const doc = readJsonFile(path.join(packageRoot, 'package.json'));
  if (!doc) return null;
  return normalizeSha(doc.gitHead);
}

function dirExists(dirPath) {
  try {
    return fs.existsSync(dirPath);
  } catch {
    return false;
  }
}

async function runGitStdout(runCommand, args, options) {
  try {
    const { stdout } = await runCommand('git', args, options);
    return typeof stdout === 'string' ? stdout : '';
  } catch {
    return '';
  }
}

// Which commit is running, and how it was installed. The file reads are one-shot boot IO so they stay
// sync; only the clone branch spends a child process, and only when no file already answered.
async function resolveInstalledIdentity({ packageRoot, runCommand, signal }) {
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

// The tip of main. `git ls-remote` is primary because it is the same protocol an update would use and
// needs no API budget; the GitHub API is the fallback for a host with no git on PATH.
async function resolveRemoteSha({ runCommand, fetchFn, signal }) {
  const stdout = await runGitStdout(runCommand, ['ls-remote', GIT_REMOTE_URL, 'refs/heads/main'], {
    timeout: LS_REMOTE_TIMEOUT_MS,
    signal,
  });
  const fromLsRemote = parseLsRemoteSha(stdout);
  if (fromLsRemote) return fromLsRemote;
  try {
    const res = await fetchFn(GITHUB_SHA_API_URL, {
      signal,
      headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'glissa-update-check' },
    });
    if (!res || !res.ok) return null;
    return normalizeSha(await res.text());
  } catch {
    return null;
  }
}

// The published version string, kept purely as the label beside the commit pair.
async function resolveLatestVersion({ fetchFn, packageJsonUrl, signal }) {
  try {
    const res = await fetchFn(packageJsonUrl, { signal });
    if (!res || !res.ok) return null;
    return parseLatestVersion(await res.json());
  } catch {
    return null;
  }
}

function readCheckState(statePath) {
  const doc = readJsonFile(statePath);
  if (!doc || typeof doc !== 'object') return null;
  return doc;
}

function writeCheckState(statePath, state) {
  try {
    writeJsonAtomicSync(statePath, state, { mkdir: true });
  } catch {
    // Throttle state is an optimization; losing it costs one extra network check.
  }
}

/**
 * Decide whether a newer Glissa exists. Resolves:
 *   { updateAvailable, current, latest, currentSha, latestSha, compareUrl, command, flavor }
 *     when a comparison was possible (either both commits are known, or a remote version was read)
 *   null when nothing at all could be read (no remote commit AND no remote version)
 * Never rejects. The abort timer is deliberately NOT unref'd: it is the only thing that settles the
 * promise when a request hangs, so an unref'd timer lets the loop drain and leaves the caller awaiting
 * forever instead of resolving null. It is cleared in every exit path, so it pins the loop only while a
 * check is genuinely in flight (bounded by timeoutMs). The caller may pass its own abortController so a
 * shutdown cancels both the fetches and the git children (execFile takes the same signal).
 */
async function checkForUpdate({
  currentVersion,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  packageJsonUrl = GITHUB_PACKAGE_JSON_URL,
  abortController = new AbortController(),
  packageRoot = path.join(__dirname, '..'),
  runCommand = execFileAsync,
  statePath = defaultStatePath(),
  ttlMs = STATE_TTL_MS,
  now = Date.now(),
} = {}) {
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const signal = abortController.signal;
  try {
    const installed = await resolveInstalledIdentity({ packageRoot, runCommand, signal });
    const cached = readCheckState(statePath);
    if (cached && isCheckFresh(cached.lastCheckAt, now, ttlMs)) {
      return finish(installed, normalizeSha(cached.latestSha), cached.latestVersion || null, currentVersion);
    }
    signal.throwIfAborted();
    const remoteSha = await resolveRemoteSha({ runCommand, fetchFn, signal });
    // A leg that consumed the budget must not start the next: a fetchFn only rejects an abort it observes.
    signal.throwIfAborted();
    const latestVersion = await resolveLatestVersion({ fetchFn, packageJsonUrl, signal });
    if (remoteSha || latestVersion) {
      writeCheckState(statePath, { lastCheckAt: now, latestSha: remoteSha, latestVersion });
    }
    return finish(installed, remoteSha, latestVersion, currentVersion);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// A verdict needs something to compare: either both commits, or a remote version for the semver
// fallback. With neither there is nothing to report, which is the null contract the caller relies on.
function finish(installed, remoteSha, latestVersion, currentVersion) {
  const canCompareSha = Boolean(installed.installedSha && remoteSha);
  if (!canCompareSha && !latestVersion) return null;
  return decideUpdateStatus({
    installedSha: installed.installedSha,
    remoteSha,
    currentVersion,
    latestVersion,
    flavor: installed.flavor,
  });
}

module.exports = {
  checkForUpdate,
  GITHUB_PACKAGE_JSON_URL,
  GITHUB_SHA_API_URL,
  GIT_REMOTE_URL,
  STATE_FILE_NAME,
  STATE_TTL_MS,
};
