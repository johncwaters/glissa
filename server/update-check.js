'use strict';

// Startup update check: query the npm registry for the latest published glissa version and, if it is
// newer than the running package, surface the update command. Advisory only - every failure path resolves
// null (never rejects), so a boot is never blocked, delayed past the timeout, or crashed by this check.
// Pure/injectable: the one IO call (fetch) is injected, so the whole module is unit-testable offline.

const REGISTRY_URL = 'https://registry.npmjs.org/glissa/latest';
const DEFAULT_TIMEOUT_MS = 3000;

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

// Pull `.version` from the npm registry `latest` dist-tag document. Null on any shape mismatch.
function parseLatestVersion(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (typeof doc.version !== 'string') return null;
  return doc.version;
}

// The copy-pasteable update command. pnpm global installs use `pnpm add -g`; everything else (npm, the
// documented default install path) uses `npm install -g`.
function buildUpdateCommand({ packageManager } = {}) {
  if (packageManager === 'pnpm') return 'pnpm add -g glissa@latest';
  return 'npm install -g glissa@latest';
}

// Query the registry and decide whether an update exists. Resolves:
//   { updateAvailable, current, latest, command }  when the fetch + parse succeed
//   null                                           on ANY failure (throw, non-200, bad JSON, timeout)
// Never rejects. The abort timer is unref'd (never pins the loop) and always cleared. The caller may pass
// its own abortController so a shutdown can cancel an in-flight request; otherwise a fresh one is used.
async function checkForUpdate({
  currentVersion,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  registryUrl = REGISTRY_URL,
  packageManager,
  abortController = new AbortController(),
} = {}) {
  let timer = setTimeout(() => abortController.abort(), timeoutMs);
  if (timer && timer.unref) timer.unref();
  try {
    const res = await fetchFn(registryUrl, { signal: abortController.signal });
    if (!res || !res.ok) return null;
    const doc = await res.json();
    const latest = parseLatestVersion(doc);
    if (!latest) return null;
    return {
      updateAvailable: compareSemver(latest, currentVersion) > 0,
      current: currentVersion,
      latest,
      command: buildUpdateCommand({ packageManager }),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  REGISTRY_URL,
  DEFAULT_TIMEOUT_MS,
  compareSemver,
  parseLatestVersion,
  buildUpdateCommand,
  checkForUpdate,
};
