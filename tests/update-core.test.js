'use strict';

// Unit tests for the pure update-check decisions (server/core/update-core.js). The load-bearing
// guarantees: a commit comparison is exact (any difference from the branch tip is an update), a missing
// commit degrades to the semver compare rather than guessing, and every parse fails closed to null so an
// unreadable install identity can never fabricate an update nudge.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NPM_GLOBAL_COMMAND,
  CLONE_COMMAND,
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
} = require('../server/core/update-core');

const SHA_A = '0123456789abcdef0123456789abcdef01234567';
const SHA_B = 'fedcba9876543210fedcba9876543210fedcba98';

// ---------------------------------------------------------------------------
// parseResolvedSha
// ---------------------------------------------------------------------------

test('parseResolvedSha reads the commit fragment of an npm git spec', () => {
  assert.equal(parseResolvedSha(`git+https://github.com/johncwaters/glissa.git#${SHA_A}`), SHA_A);
  assert.equal(parseResolvedSha(`github:johncwaters/glissa#${SHA_A.toUpperCase()}`), SHA_A);
});

test('parseResolvedSha returns null without a usable commit fragment', () => {
  assert.equal(parseResolvedSha('git+https://github.com/johncwaters/glissa.git'), null);
  assert.equal(parseResolvedSha('git+https://github.com/johncwaters/glissa.git#main'), null);
  assert.equal(parseResolvedSha(`https://registry.npmjs.org/glissa/-/glissa-0.1.0.tgz#${SHA_A.slice(0, 8)}`), null);
  assert.equal(parseResolvedSha('#'), null);
  assert.equal(parseResolvedSha(null), null);
  assert.equal(parseResolvedSha(42), null);
});

// ---------------------------------------------------------------------------
// parseLsRemoteSha
// ---------------------------------------------------------------------------

test('parseLsRemoteSha takes the sha field of the first usable line', () => {
  assert.equal(parseLsRemoteSha(`${SHA_A}\trefs/heads/main\n`), SHA_A);
  assert.equal(parseLsRemoteSha(`\n  ${SHA_B}   refs/heads/main`), SHA_B);
  assert.equal(parseLsRemoteSha('fatal: could not read from remote repository'), null);
  assert.equal(parseLsRemoteSha(''), null);
  assert.equal(parseLsRemoteSha(undefined), null);
});

// ---------------------------------------------------------------------------
// decideInstallFlavor
// ---------------------------------------------------------------------------

test('decideInstallFlavor prefers the lockfile commit, then gitHead, then a clone', () => {
  assert.deepEqual(
    decideInstallFlavor({ lockfileSha: SHA_A, gitHeadSha: SHA_B, hasGitDir: true }),
    { flavor: 'npm-global', installedSha: SHA_A },
  );
  assert.deepEqual(
    decideInstallFlavor({ lockfileSha: null, gitHeadSha: SHA_B, hasGitDir: true }),
    { flavor: 'npm-global', installedSha: SHA_B },
  );
  assert.deepEqual(
    decideInstallFlavor({ hasGitDir: true }),
    { flavor: 'clone', installedSha: null },
  );
  assert.deepEqual(decideInstallFlavor({}), { flavor: 'unknown', installedSha: null });
  assert.deepEqual(decideInstallFlavor(), { flavor: 'unknown', installedSha: null });
});

test('decideInstallFlavor ignores a truncated or non-hex commit', () => {
  assert.deepEqual(
    decideInstallFlavor({ lockfileSha: SHA_A.slice(0, 7), gitHeadSha: 'HEAD', hasGitDir: false }),
    { flavor: 'unknown', installedSha: null },
  );
});

// ---------------------------------------------------------------------------
// buildUpdateCommand / buildCompareUrl / shortSha
// ---------------------------------------------------------------------------

test('buildUpdateCommand matches the install flavor, unknown falling back to the clone command', () => {
  assert.equal(buildUpdateCommand('npm-global'), NPM_GLOBAL_COMMAND);
  assert.equal(buildUpdateCommand('npm-global'), 'npm install -g github:johncwaters/glissa --allow-git=root');
  assert.equal(buildUpdateCommand('clone'), CLONE_COMMAND);
  assert.equal(buildUpdateCommand('clone'), 'git pull --ff-only && npm ci && npm run build');
  assert.equal(buildUpdateCommand('unknown'), CLONE_COMMAND);
  assert.equal(buildUpdateCommand(undefined), CLONE_COMMAND);
});

test('buildCompareUrl points at the GitHub compare view, null without a commit', () => {
  assert.equal(buildCompareUrl(SHA_A), `https://github.com/johncwaters/glissa/compare/${SHA_A}...main`);
  assert.equal(buildCompareUrl(null), null);
  assert.equal(buildCompareUrl('main'), null);
});

test('shortSha shortens a known commit and returns empty otherwise', () => {
  assert.equal(shortSha(SHA_A), '0123456');
  assert.equal(shortSha(SHA_A.toUpperCase()), '0123456');
  assert.equal(shortSha('nope'), '');
  assert.equal(shortSha(null), '');
});

// ---------------------------------------------------------------------------
// compareSemver / parseLatestVersion (moved verbatim from update-check.js)
// ---------------------------------------------------------------------------

test('compareSemver orders by major/minor/patch', () => {
  assert.equal(compareSemver('0.17.0', '0.16.0'), 1);
  assert.equal(compareSemver('0.16.0', '0.17.0'), -1);
  assert.equal(compareSemver('1.0.0', '0.99.99'), 1);
  assert.equal(compareSemver('0.16.1', '0.16.0'), 1);
  assert.equal(compareSemver('0.16.0', '0.16.0'), 0);
});

test('compareSemver tolerates leading v and trailing prerelease/build', () => {
  assert.equal(compareSemver('v0.17.0', '0.16.0'), 1);
  assert.equal(compareSemver('0.17.0-rc.1', '0.17.0'), 0);
  assert.equal(compareSemver('0.17.0+build.5', '0.17.0'), 0);
});

test('compareSemver fails open (returns 0) on unparseable input', () => {
  assert.equal(compareSemver('not-a-version', '0.16.0'), 0);
  assert.equal(compareSemver('0.16', '0.16.0'), 0);
  assert.equal(compareSemver(undefined, '0.16.0'), 0);
  assert.equal(compareSemver('0.16.0', null), 0);
});

test('parseLatestVersion reads .version, null on mismatch', () => {
  assert.equal(parseLatestVersion({ version: '0.17.0' }), '0.17.0');
  assert.equal(parseLatestVersion({ name: 'glissa' }), null);
  assert.equal(parseLatestVersion({ version: 17 }), null);
  assert.equal(parseLatestVersion(null), null);
  assert.equal(parseLatestVersion('0.17.0'), null);
});

// ---------------------------------------------------------------------------
// decideUpdateStatus
// ---------------------------------------------------------------------------

test('decideUpdateStatus reports an update when the commits differ, version bump or not', () => {
  const status = decideUpdateStatus({
    installedSha: SHA_A,
    remoteSha: SHA_B,
    currentVersion: '0.21.0',
    latestVersion: '0.21.0',
    flavor: 'npm-global',
  });
  assert.deepEqual(status, {
    updateAvailable: true,
    current: '0.21.0',
    latest: '0.21.0',
    currentSha: SHA_A,
    latestSha: SHA_B,
    compareUrl: `https://github.com/johncwaters/glissa/compare/${SHA_A}...main`,
    command: NPM_GLOBAL_COMMAND,
    flavor: 'npm-global',
  });
});

test('decideUpdateStatus reports no update at the branch tip even when the version looks older', () => {
  const status = decideUpdateStatus({
    installedSha: SHA_A,
    remoteSha: SHA_A,
    currentVersion: '0.20.0',
    latestVersion: '0.21.0',
    flavor: 'clone',
  });
  assert.equal(status.updateAvailable, false);
  assert.equal(status.command, CLONE_COMMAND);
});

test('decideUpdateStatus falls back to the semver compare when either commit is unknown', () => {
  const behind = decideUpdateStatus({ remoteSha: SHA_B, currentVersion: '0.20.0', latestVersion: '0.21.0' });
  assert.equal(behind.updateAvailable, true);
  assert.equal(behind.currentSha, null);
  assert.equal(behind.compareUrl, null);

  const current = decideUpdateStatus({ installedSha: SHA_A, currentVersion: '0.21.0', latestVersion: '0.21.0' });
  assert.equal(current.updateAvailable, false);

  const ahead = decideUpdateStatus({ currentVersion: '0.22.0', latestVersion: '0.21.0' });
  assert.equal(ahead.updateAvailable, false);
});

test('decideUpdateStatus fails open on unparseable versions with no commits', () => {
  const status = decideUpdateStatus({ currentVersion: 'dev', latestVersion: 'nightly' });
  assert.equal(status.updateAvailable, false);
  assert.equal(status.current, 'dev');
  assert.equal(status.latest, 'nightly');
});

test('decideUpdateStatus normalizes an unknown flavor and absent fields to null', () => {
  const status = decideUpdateStatus({ remoteSha: SHA_B, latestVersion: '0.21.0', flavor: 'sideloaded' });
  assert.equal(status.flavor, 'unknown');
  assert.equal(status.current, null);
  assert.equal(status.currentSha, null);
  assert.equal(status.command, CLONE_COMMAND);
});

// ---------------------------------------------------------------------------
// isCheckFresh
// ---------------------------------------------------------------------------

test('isCheckFresh is true strictly inside the ttl', () => {
  assert.equal(isCheckFresh(1000, 1000, 100), true);
  assert.equal(isCheckFresh(1000, 1099, 100), true);
  assert.equal(isCheckFresh(1000, 1100, 100), false);
  assert.equal(isCheckFresh(1000, 5000, 100), false);
});

test('isCheckFresh treats a missing, malformed or future timestamp as stale', () => {
  assert.equal(isCheckFresh(undefined, 1000, 100), false);
  assert.equal(isCheckFresh('1000', 1000, 100), false);
  assert.equal(isCheckFresh(Number.NaN, 1000, 100), false);
  assert.equal(isCheckFresh(2000, 1000, 100), false);
  assert.equal(isCheckFresh(1000, 1000, undefined), false);
});
