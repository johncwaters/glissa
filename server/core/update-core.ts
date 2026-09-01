// Pure decisions behind the self-update check. The freshness signal is the latest GitHub release tag.
// Everything here is IO-free and clock-free (the caller passes `now`), so the shell in
// server/update-check.js stays a thin wrapper around these rules.

const REPO_SLUG = 'johncwaters/glissa';
const SHA_RE = /^[0-9a-f]{40}$/;
const NPM_GLOBAL_COMMAND = `npm install -g github:${REPO_SLUG} --allow-git=root`;
const CLONE_COMMAND = 'git pull --ff-only && npm ci && npm run build';
const SHORT_SHA_LENGTH = 7;
const INSTALL_FLAVORS = new Set<string>(['npm-global', 'clone', 'unknown']);
const TAG_VERSION_RE = /^v(\d+\.\d+\.\d+)$/;

export type InstallFlavor = 'npm-global' | 'clone' | 'unknown';

export interface ReleaseTag {
  version: string;
  sha: string | null;
}

// A commit id, lowercased, or null for anything that is not a full 40-hex sha. Every sha entering the
// comparison goes through here, so a short sha, a ref name, or a truncated read can never compare equal
// or unequal by accident.
function normalizeSha(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sha = value.trim().toLowerCase();
  if (!SHA_RE.test(sha)) return null;
  return sha;
}

// First 7 chars of a known sha, for display. Empty string when there is no sha to shorten.
function shortSha(value: unknown): string {
  const sha = normalizeSha(value);
  if (!sha) return '';
  return sha.slice(0, SHORT_SHA_LENGTH);
}

// The commit out of an npm `resolved` spec, e.g.
// 'git+https://github.com/johncwaters/glissa.git#<40hex>'. Null when there is no fragment or the
// fragment is not a sha (a tag or branch spec resolves that way).
function parseResolvedSha(resolved: unknown): string | null {
  if (typeof resolved !== 'string') return null;
  const fragmentAt = resolved.lastIndexOf('#');
  if (fragmentAt === -1) return null;
  return normalizeSha(resolved.slice(fragmentAt + 1));
}

function parseTagVersion(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const normalized = ref.trim().replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '');
  const matched = TAG_VERSION_RE.exec(normalized);
  if (!matched) return null;
  return matched[1];
}

function parseLsRemoteTags(stdout: unknown): { version: string; sha: string } | null {
  if (typeof stdout !== 'string') return null;
  const tagsByVersion = new Map<string, { version: string; sha: string }>();
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    const sha = normalizeSha(fields[0]);
    if (!sha) continue;
    const ref = fields[1];
    const version = parseTagVersion(ref);
    if (!version) continue;
    const existing = tagsByVersion.get(version);
    if (existing && !ref.endsWith('^{}')) continue;
    tagsByVersion.set(version, { version, sha });
  }
  let latest: { version: string; sha: string } | null = null;
  for (const entry of tagsByVersion.values()) {
    if (!latest) {
      latest = entry;
      continue;
    }
    if (compareSemver(entry.version, latest.version) > 0) latest = entry;
  }
  return latest;
}

// How this copy of Glissa was installed, and the commit it was built from where that is knowable from a
// file alone. Precedence is by reliability: the hidden global lockfile records the exact commit npm
// resolved, package.json `gitHead` is npm's own stamp on the packed tarball, and a `.git` directory means
// a clone whose HEAD the shell reads with a git call.
function decideInstallFlavor({ lockfileSha, gitHeadSha, hasGitDir }: {
  lockfileSha?: unknown;
  gitHeadSha?: unknown;
  hasGitDir?: boolean;
} = {}): { flavor: InstallFlavor; installedSha: string | null } {
  const fromLockfile = normalizeSha(lockfileSha);
  if (fromLockfile) return { flavor: 'npm-global', installedSha: fromLockfile };
  const fromGitHead = normalizeSha(gitHeadSha);
  if (fromGitHead) return { flavor: 'npm-global', installedSha: fromGitHead };
  if (hasGitDir) return { flavor: 'clone', installedSha: null };
  return { flavor: 'unknown', installedSha: null };
}

// The command that actually updates THIS install. An unknown flavor gets the clone command: it is the
// safe guess for a checkout, and it fails loudly rather than reinstalling over the wrong thing.
function buildUpdateCommand(flavor: unknown, latestVersion: unknown): string {
  if (flavor === 'npm-global' && textOrNull(latestVersion)) {
    return `npm install -g github:${REPO_SLUG}#v${latestVersion} --allow-git=root`;
  }
  if (flavor === 'npm-global') return NPM_GLOBAL_COMMAND;
  return CLONE_COMMAND;
}

function buildReleaseUrl(version: unknown): string | null {
  const releaseVersion = textOrNull(version);
  if (!releaseVersion) return null;
  return `https://github.com/${REPO_SLUG}/releases/tag/v${releaseVersion}`;
}

function parseVersionTriple(version: unknown): number[] | null {
  if (typeof version !== 'string') return null;
  const core = version.trim().replace(/^v/, '').split(/[-+]/)[0];
  const parts = core.split('.');
  if (parts.length !== 3) return null;
  const triple: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    triple.push(Number.parseInt(part, 10));
  }
  return triple;
}

// Compare two semver-ish strings. Returns 1 if a > b, -1 if a < b, 0 if equal OR either side is
// unparseable (fail-open: an unknown/odd version never reports as "newer", so it never triggers a
// false update nudge).
function compareSemver(a: unknown, b: unknown): number {
  const ta = parseVersionTriple(a);
  const tb = parseVersionTriple(b);
  if (!ta || !tb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (ta[i] > tb[i]) return 1;
    if (ta[i] < tb[i]) return -1;
  }
  return 0;
}

function parseLatestReleaseTag(doc: unknown): ReleaseTag | null {
  if (!doc || typeof doc !== 'object') return null;
  const version = parseTagVersion((doc as { tag_name?: unknown }).tag_name);
  if (!version) return null;
  return { version, sha: null };
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function normalizeFlavor(flavor: unknown): InstallFlavor {
  if (typeof flavor === 'string' && INSTALL_FLAVORS.has(flavor)) return flavor as InstallFlavor;
  return 'unknown';
}

function decideUpdateStatus({ installedSha, latestSha: remoteSha, currentVersion, latestVersion, flavor }: {
  installedSha?: unknown;
  latestSha?: unknown;
  currentVersion?: unknown;
  latestVersion?: unknown;
  flavor?: unknown;
} = {}) {
  const currentSha = normalizeSha(installedSha);
  const latestSha = normalizeSha(remoteSha);
  const current = textOrNull(currentVersion);
  const latest = textOrNull(latestVersion);
  return {
    updateAvailable: compareSemver(latest, current) > 0,
    current,
    latest,
    currentSha,
    latestSha,
    releaseUrl: buildReleaseUrl(latest),
    command: buildUpdateCommand(flavor, latest),
    flavor: normalizeFlavor(flavor),
  };
}

// Whether a persisted check result may be reused instead of hitting the network. A missing, malformed,
// or future-dated timestamp is never fresh, so the failure mode is one extra check rather than a stale
// verdict that outlives its subject.
function isCheckFresh(lastCheckAt: unknown, nowMs: unknown, ttlMs: unknown): boolean {
  if (!Number.isFinite(lastCheckAt)) return false;
  if (!Number.isFinite(nowMs)) return false;
  if (!Number.isFinite(ttlMs)) return false;
  const age = Number(nowMs) - Number(lastCheckAt);
  if (age < 0) return false;
  return age < Number(ttlMs);
}

export { NPM_GLOBAL_COMMAND, CLONE_COMMAND, normalizeSha, shortSha, parseResolvedSha, parseTagVersion, parseLsRemoteTags, decideInstallFlavor, buildUpdateCommand, buildReleaseUrl, compareSemver, parseLatestReleaseTag, decideUpdateStatus, isCheckFresh };
