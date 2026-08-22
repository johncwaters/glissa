'use strict';

// Pure decisions behind the self-update check. Glissa is distributed as a GitHub BRANCH TIP (an npm git
// install or a clone), so package.json's version only moves on release commits and is a label, not the
// freshness signal: the signal is the commit the install was built from versus the main branch head.
// Everything here is IO-free and clock-free (the caller passes `now`), so the shell in
// server/update-check.js stays a thin wrapper around these rules.

const REPO_SLUG = 'johncwaters/glissa';
const SHA_RE = /^[0-9a-f]{40}$/;
const NPM_GLOBAL_COMMAND = `npm install -g github:${REPO_SLUG} --allow-git=root`;
const CLONE_COMMAND = 'git pull --ff-only && npm ci && npm run build';
const SHORT_SHA_LENGTH = 7;
const INSTALL_FLAVORS = new Set(['npm-global', 'clone', 'unknown']);

// A commit id, lowercased, or null for anything that is not a full 40-hex sha. Every sha entering the
// comparison goes through here, so a short sha, a ref name, or a truncated read can never compare equal
// or unequal by accident.
function normalizeSha(value) {
  if (typeof value !== 'string') return null;
  const sha = value.trim().toLowerCase();
  if (!SHA_RE.test(sha)) return null;
  return sha;
}

// First 7 chars of a known sha, for display. Empty string when there is no sha to shorten.
function shortSha(value) {
  const sha = normalizeSha(value);
  if (!sha) return '';
  return sha.slice(0, SHORT_SHA_LENGTH);
}

// The commit out of an npm `resolved` spec, e.g.
// 'git+https://github.com/johncwaters/glissa.git#<40hex>'. Null when there is no fragment or the
// fragment is not a sha (a tag or branch spec resolves that way).
function parseResolvedSha(resolved) {
  if (typeof resolved !== 'string') return null;
  const fragmentAt = resolved.lastIndexOf('#');
  if (fragmentAt === -1) return null;
  return normalizeSha(resolved.slice(fragmentAt + 1));
}

// First field of the first `git ls-remote` line, which is the sha the ref points at.
function parseLsRemoteSha(stdout) {
  if (typeof stdout !== 'string') return null;
  for (const line of stdout.split('\n')) {
    const field = line.trim().split(/\s+/)[0];
    const sha = normalizeSha(field);
    if (sha) return sha;
  }
  return null;
}

// How this copy of Glissa was installed, and the commit it was built from where that is knowable from a
// file alone. Precedence is by reliability: the hidden global lockfile records the exact commit npm
// resolved, package.json `gitHead` is npm's own stamp on the packed tarball, and a `.git` directory means
// a clone whose HEAD the shell reads with a git call.
function decideInstallFlavor({ lockfileSha, gitHeadSha, hasGitDir } = {}) {
  const fromLockfile = normalizeSha(lockfileSha);
  if (fromLockfile) return { flavor: 'npm-global', installedSha: fromLockfile };
  const fromGitHead = normalizeSha(gitHeadSha);
  if (fromGitHead) return { flavor: 'npm-global', installedSha: fromGitHead };
  if (hasGitDir) return { flavor: 'clone', installedSha: null };
  return { flavor: 'unknown', installedSha: null };
}

// The command that actually updates THIS install. An unknown flavor gets the clone command: it is the
// safe guess for a checkout, and it fails loudly rather than reinstalling over the wrong thing.
function buildUpdateCommand(flavor) {
  if (flavor === 'npm-global') return NPM_GLOBAL_COMMAND;
  return CLONE_COMMAND;
}

// GitHub compare view from the installed commit to the branch tip, so the operator can read what an
// update would bring before running it. Null when the installed commit is unknown.
function buildCompareUrl(installedSha) {
  const sha = normalizeSha(installedSha);
  if (!sha) return null;
  return `https://github.com/${REPO_SLUG}/compare/${sha}...main`;
}

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

function textOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function normalizeFlavor(flavor) {
  if (INSTALL_FLAVORS.has(flavor)) return flavor;
  return 'unknown';
}

// The whole verdict, in one place. Both commits known is the real signal (any difference from the branch
// tip is an update, including a commit that carries no version bump); with either commit unknown it
// degrades to the old semver compare, which fails open. Version strings stay in the result either way as
// the human-readable label.
function decideUpdateStatus({ installedSha, remoteSha, currentVersion, latestVersion, flavor } = {}) {
  const currentSha = normalizeSha(installedSha);
  const latestSha = normalizeSha(remoteSha);
  const current = textOrNull(currentVersion);
  const latest = textOrNull(latestVersion);
  const bothShasKnown = Boolean(currentSha && latestSha);
  return {
    updateAvailable: bothShasKnown ? currentSha !== latestSha : compareSemver(latest, current) > 0,
    current,
    latest,
    currentSha,
    latestSha,
    compareUrl: buildCompareUrl(currentSha),
    command: buildUpdateCommand(flavor),
    flavor: normalizeFlavor(flavor),
  };
}

// Whether a persisted check result may be reused instead of hitting the network. A missing, malformed,
// or future-dated timestamp is never fresh, so the failure mode is one extra check rather than a stale
// verdict that outlives its subject.
function isCheckFresh(lastCheckAt, nowMs, ttlMs) {
  if (!Number.isFinite(lastCheckAt)) return false;
  if (!Number.isFinite(nowMs)) return false;
  if (!Number.isFinite(ttlMs)) return false;
  const age = nowMs - lastCheckAt;
  if (age < 0) return false;
  return age < ttlMs;
}

module.exports = {
  NPM_GLOBAL_COMMAND,
  CLONE_COMMAND,
  normalizeSha,
  shortSha,
  parseResolvedSha,
  parseLsRemoteSha,
  decideInstallFlavor,
  buildUpdateCommand,
  buildCompareUrl,
  compareSemver,
  parseLatestVersion,
  decideUpdateStatus,
  isCheckFresh,
};
