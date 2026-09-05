import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLONE_COMMAND,
  shortSha,
  parseResolvedSha,
  parseTagVersion,
  parseLsRemoteTags,
  parseLatestReleaseTag,
  decideInstallFlavor,
  buildUpdateCommand,
  buildReleaseUrl,
  compareSemver,
  decideUpdateStatus,
  isCheckFresh,
} from '../server/core/update-core.ts';

const SHA_A = '0123456789abcdef0123456789abcdef01234567';
const SHA_B = 'fedcba9876543210fedcba9876543210fedcba98';
const SHA_C = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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

test('parseTagVersion accepts only v-prefixed strict numeric semver tags', () => {
  assert.equal(parseTagVersion('refs/tags/v0.20.0'), '0.20.0');
  assert.equal(parseTagVersion('refs/tags/v0.20.0^{}'), '0.20.0');
  assert.equal(parseTagVersion('v1.2.3'), '1.2.3');
  assert.equal(parseTagVersion('0.1.0'), null);
  assert.equal(parseTagVersion('refs/tags/0.1.0'), null);
  assert.equal(parseTagVersion('refs/tags/v0.20.0-rc.1'), null);
  assert.equal(parseTagVersion('refs/tags/v0.20.0+build.1'), null);
  assert.equal(parseTagVersion('refs/tags/v0.20'), null);
  assert.equal(parseTagVersion(null), null);
});

test('parseTagVersion trims refs and rejects malformed or non-string tags', () => {
  assert.equal(parseTagVersion('  refs/tags/v1.2.3  '), '1.2.3');
  assert.equal(parseTagVersion('refs/tags/v1.2.3^{}'), '1.2.3');
  assert.equal(parseTagVersion('v1.2'), null);
  assert.equal(parseTagVersion('v1.2.3.4'), null);
  assert.equal(parseTagVersion('v01.2.3'), '01.2.3');
  assert.equal(parseTagVersion(42), null);
});

test('parseLsRemoteTags returns the latest semver tag and prefers peeled shas', () => {
  const stdout = [
    `${SHA_A}\trefs/tags/v0.9.1`,
    `${SHA_B}\trefs/tags/v0.10.0`,
    `${SHA_C}\trefs/tags/v0.10.0^{}`,
    `${SHA_A}\trefs/tags/0.99.0`,
    `${SHA_B}\trefs/tags/v9.9.9-rc.1`,
  ].join('\n');
  assert.deepEqual(parseLsRemoteTags(stdout), { version: '0.10.0', sha: SHA_C });
});

test('parseLsRemoteTags tolerates garbage, CRLF, peeled-first order and duplicate versions', () => {
  const stdout = [
    'not a valid ls-remote row',
    `${SHA_A}\trefs/heads/main`,
    `${SHA_C}\trefs/tags/v0.10.0^{}`,
    `${SHA_A}\trefs/tags/v0.10.0`,
    `${SHA_B}\trefs/tags/v0.9.1`,
    `${SHA_A}\trefs/tags/v0.10.0`,
  ].join('\r\n');
  assert.deepEqual(parseLsRemoteTags(stdout), { version: '0.10.0', sha: SHA_C });
});

test('parseLsRemoteTags accepts lightweight tags and ignores non-tag-only output', () => {
  assert.deepEqual(parseLsRemoteTags(`${SHA_A}\trefs/tags/v0.8.0`), { version: '0.8.0', sha: SHA_A });
  assert.equal(parseLsRemoteTags(`${SHA_A}\trefs/heads/main\r\n${SHA_B}\trefs/heads/develop`), null);
});

test('parseLsRemoteTags returns null when no valid release tag is present', () => {
  assert.equal(parseLsRemoteTags(`${SHA_A}\trefs/tags/0.1.0\n${SHA_B}\trefs/heads/main`), null);
  assert.equal(parseLsRemoteTags('fatal: could not read from remote repository'), null);
  assert.equal(parseLsRemoteTags(''), null);
  assert.equal(parseLsRemoteTags(undefined), null);
});

test('parseLatestReleaseTag reads tag_name and leaves sha null', () => {
  assert.deepEqual(parseLatestReleaseTag({ tag_name: 'v0.21.0' }), { version: '0.21.0', sha: null });
  assert.equal(parseLatestReleaseTag({ tag_name: '0.21.0' }), null);
  assert.equal(parseLatestReleaseTag({ tag_name: 'v0.21.0-rc.1' }), null);
  assert.equal(parseLatestReleaseTag({ name: 'v0.21.0' }), null);
  assert.equal(parseLatestReleaseTag(null), null);
  assert.equal(parseLatestReleaseTag([]), null);
});

test('decideInstallFlavor prefers the lockfile commit, then gitHead, then a clone', () => {
  assert.deepEqual(
    decideInstallFlavor({ lockfileSha: SHA_A, gitHeadSha: SHA_B, hasGitDir: true }),
    { flavor: 'npm-global', installedSha: SHA_A },
  );
  assert.deepEqual(
    decideInstallFlavor({ lockfileSha: null, gitHeadSha: SHA_B, hasGitDir: true }),
    { flavor: 'npm-global', installedSha: SHA_B },
  );
  assert.deepEqual(decideInstallFlavor({ hasGitDir: true }), { flavor: 'clone', installedSha: null });
  assert.deepEqual(decideInstallFlavor({}), { flavor: 'unknown', installedSha: null });
  assert.deepEqual(decideInstallFlavor(), { flavor: 'unknown', installedSha: null });
});

test('decideInstallFlavor ignores a truncated or non-hex commit', () => {
  assert.deepEqual(
    decideInstallFlavor({ lockfileSha: SHA_A.slice(0, 7), gitHeadSha: 'HEAD', hasGitDir: false }),
    { flavor: 'unknown', installedSha: null },
  );
});

test('buildUpdateCommand pins npm-global to the latest tag and keeps clone commands unchanged', () => {
  assert.equal(buildUpdateCommand('npm-global', '0.21.0'), 'npm install -g github:johncwaters/glissa#v0.21.0 --allow-git=root');
  assert.equal(buildUpdateCommand('npm-global', null), 'npm install -g github:johncwaters/glissa --allow-git=root');
  assert.equal(buildUpdateCommand('npm-global', ''), 'npm install -g github:johncwaters/glissa --allow-git=root');
  assert.equal(buildUpdateCommand('clone', '0.21.0'), CLONE_COMMAND);
  assert.equal(buildUpdateCommand('unknown', '0.21.0'), CLONE_COMMAND);
});

test('buildReleaseUrl points at the release tag page', () => {
  assert.equal(buildReleaseUrl('0.21.0'), 'https://github.com/johncwaters/glissa/releases/tag/v0.21.0');
  assert.equal(buildReleaseUrl(null), null);
});

test('shortSha shortens a known commit and returns empty otherwise', () => {
  assert.equal(shortSha(SHA_A), '0123456');
  assert.equal(shortSha(SHA_A.toUpperCase()), '0123456');
  assert.equal(shortSha('nope'), '');
  assert.equal(shortSha(null), '');
});

test('compareSemver orders by major/minor/patch', () => {
  assert.equal(compareSemver('0.17.0', '0.16.0'), 1);
  assert.equal(compareSemver('0.16.0', '0.17.0'), -1);
  assert.equal(compareSemver('1.0.0', '0.99.99'), 1);
  assert.equal(compareSemver('0.16.1', '0.16.0'), 1);
  assert.equal(compareSemver('0.16.0', '0.16.0'), 0);
  assert.equal(compareSemver('0.10.0', '0.9.1'), 1);
  assert.equal(compareSemver('0.9.1', '0.10.0'), -1);
});

test('compareSemver tolerates leading v and trailing prerelease/build', () => {
  assert.equal(compareSemver('v0.17.0', '0.16.0'), 1);
  assert.equal(compareSemver('0.17.0-rc.1', '0.17.0'), 0);
  assert.equal(compareSemver('0.17.0+build.5', '0.17.0'), 0);
});

test('compareSemver fails open on unparseable input', () => {
  assert.equal(compareSemver('not-a-version', '0.16.0'), 0);
  assert.equal(compareSemver('0.16', '0.16.0'), 0);
  assert.equal(compareSemver(undefined, '0.16.0'), 0);
  assert.equal(compareSemver('0.16.0', null), 0);
});

test('decideUpdateStatus reports updates by version only', () => {
  const newerWithSameSha = decideUpdateStatus({
    installedSha: SHA_A,
    latestSha: SHA_A,
    currentVersion: '0.20.0',
    latestVersion: '0.21.0',
    flavor: 'npm-global',
  });
  assert.deepEqual(newerWithSameSha, {
    updateAvailable: true,
    current: '0.20.0',
    latest: '0.21.0',
    currentSha: SHA_A,
    latestSha: SHA_A,
    releaseUrl: 'https://github.com/johncwaters/glissa/releases/tag/v0.21.0',
    command: 'npm install -g github:johncwaters/glissa#v0.21.0 --allow-git=root',
    flavor: 'npm-global',
    channel: 'release',
    behindCount: null,
    reason: null,
  });

  const sameVersionWithDifferentSha = decideUpdateStatus({
    installedSha: SHA_A,
    latestSha: SHA_B,
    currentVersion: '0.21.0',
    latestVersion: '0.21.0',
    flavor: 'clone',
  });
  assert.equal(sameVersionWithDifferentSha.updateAvailable, false);
  assert.equal(sameVersionWithDifferentSha.command, CLONE_COMMAND);
});

test('decideUpdateStatus reports a main-channel update from the behind count', () => {
  const behind = decideUpdateStatus({
    installedSha: SHA_A,
    latestSha: SHA_B,
    currentVersion: '0.21.0',
    latestVersion: null,
    flavor: 'clone',
    channel: 'main',
    behindCount: 3,
  });
  assert.equal(behind.updateAvailable, true);
  assert.equal(behind.channel, 'main');
  assert.equal(behind.behindCount, 3);

  const current = decideUpdateStatus({ channel: 'main', behindCount: 0, flavor: 'clone' });
  assert.equal(current.updateAvailable, false);
});

test('decideUpdateStatus ignores a stale main-channel count once the installed sha is the target', () => {
  const justUpdated = decideUpdateStatus({
    installedSha: SHA_A,
    latestSha: SHA_A,
    currentVersion: '0.21.0',
    flavor: 'clone',
    channel: 'main',
    behindCount: 7,
  });
  assert.equal(justUpdated.updateAvailable, false);
  assert.equal(justUpdated.behindCount, 7);
});

test('decideUpdateStatus reports no update when current is equal, newer or latest is missing', () => {
  const equal = decideUpdateStatus({ currentVersion: '0.21.0', latestVersion: '0.21.0', flavor: 'npm-global' });
  assert.equal(equal.updateAvailable, false);
  assert.equal(equal.releaseUrl, 'https://github.com/johncwaters/glissa/releases/tag/v0.21.0');

  const currentAhead = decideUpdateStatus({ currentVersion: '0.22.0', latestVersion: '0.21.0', flavor: 'clone' });
  assert.equal(currentAhead.updateAvailable, false);
  assert.equal(currentAhead.releaseUrl, 'https://github.com/johncwaters/glissa/releases/tag/v0.21.0');

  const missingLatest = decideUpdateStatus({ currentVersion: '0.22.0', latestVersion: null, flavor: 'unknown' });
  assert.equal(missingLatest.updateAvailable, false);
  assert.equal(missingLatest.latest, null);
  assert.equal(missingLatest.releaseUrl, null);
});

test('decideUpdateStatus fails open on unparseable versions and normalizes flavor', () => {
  const status = decideUpdateStatus({ currentVersion: 'dev', latestVersion: 'nightly', flavor: 'sideloaded' });
  assert.equal(status.updateAvailable, false);
  assert.equal(status.current, 'dev');
  assert.equal(status.latest, 'nightly');
  assert.equal(status.flavor, 'unknown');
  assert.equal(status.command, CLONE_COMMAND);
});

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
