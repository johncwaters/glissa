'use strict';

// Startup update check: query the GitHub main branch package.json and, if it is newer than the running
// package, surface the update command. Advisory only - every failure path resolves null (never rejects),
// so a boot is never blocked, delayed past the timeout, or crashed by this check.
// Pure/injectable: the one IO call (fetch) is injected, so the whole module is unit-testable offline.

const GITHUB_PACKAGE_JSON_URL = 'https://raw.githubusercontent.com/johncwaters/glissa/main/package.json';
const DEFAULT_TIMEOUT_MS = 3000;
// Run from the clone directory.
const GIT_UPDATE_COMMAND = 'git pull && npm ci && npm run build';

// Parse an x.y.z version into a [major, minor, patch] number triple. Tolerates a leading `v` and a
// trailing prerelease/build (`-rc.1`, `+build`), which are dropped so a stable release compares by its
// release numbers. Returns null when any of the three core parts is not a plain integer.
function parseVersionTriple(version) {
  if (typeof version !== 'string') return null;
  const core = version.trim().replace(/^v/, '').split(/[-+]/)[0];
  const parts = core.split('.');
  if (parts.length !== 3) return null;
  const triple = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    triple.push(Number.parseInt(part, 10));
  }
  return triple;
}

// Compare two semver-ish strings. Returns 1 if a > b, -1 if a < b, 0 if equal OR either side is
// unparseable (fail-open: an unknown/odd version never reports as "newer", so it never triggers a
// false update nudge).
function compareSemver(a, b) {
  const ta = parseVersionTriple(a);
  const tb = parseVersionTriple(b);
  if (!ta || !tb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (ta[i] > tb[i]) return 1;
    if (ta[i] < tb[i]) return -1;
  }
  return 0;
}

// Pull `.version` from the remote package.json document. Null on any shape mismatch.
function parseLatestVersion(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (typeof doc.version !== 'string') return null;
  return doc.version;
}

function buildUpdateCommand() {
  return GIT_UPDATE_COMMAND;
}

// Query the remote package.json and decide whether an update exists. Resolves:
//   { updateAvailable, current, latest, command }  when the fetch + parse succeed
//   null                                           on ANY failure (throw, non-200, bad JSON, timeout)
// Never rejects. The abort timer is deliberately NOT unref'd: it is the only thing that settles the
// promise when the request hangs, so an unref'd timer lets the loop drain and leaves the caller awaiting
// forever instead of resolving null. It is cleared in every exit path, so it pins the loop only while a
// check is genuinely in flight (bounded by timeoutMs), which a real fetch's socket does anyway. The
// caller may pass its own abortController so a shutdown can cancel an in-flight request.
async function checkForUpdate({
  currentVersion,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  packageJsonUrl = GITHUB_PACKAGE_JSON_URL,
  abortController = new AbortController(),
} = {}) {
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const res = await fetchFn(packageJsonUrl, { signal: abortController.signal });
    if (!res || !res.ok) return null;
    const doc = await res.json();
    const latest = parseLatestVersion(doc);
    if (!latest) return null;
    return {
      updateAvailable: compareSemver(latest, currentVersion) > 0,
      current: currentVersion,
      latest,
      command: buildUpdateCommand(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  compareSemver,
  parseLatestVersion,
  buildUpdateCommand,
  checkForUpdate,
};
