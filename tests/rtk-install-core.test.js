'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  RTK_ASSETS,
  RTK_VERSION,
  INSTALL_FAILURE_COOLDOWN_MS,
  assetForPlatform,
  decideRtkInstall,
  verifyDigest,
  installTargetPath,
  isRtkBinaryName,
} = require('../server/core/rtk-install-core');

const BASE = { rtkEnabled: true, resolvedPath: null, platform: 'linux', arch: 'x64', nowMs: 1_000_000 };

test('every pinned asset carries a 64 hex char sha256 and a pinned version url', () => {
  for (const [key, entry] of Object.entries(RTK_ASSETS)) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${key} digest`);
    const asset = assetForPlatform(...key.split('-'));
    assert.equal(asset.version, RTK_VERSION);
    assert.ok(asset.url.includes(`v${RTK_VERSION}`), `${key} url is version-pinned`);
    assert.ok(asset.url.endsWith(entry.file), `${key} url ends with its asset file`);
    assert.ok(!asset.url.includes('latest'), `${key} url never resolves latest`);
  }
});

test('decision table', () => {
  const cases = [
    [{ ...BASE, rtkEnabled: false }, 'skip', 'rtk-disabled'],
    [{ ...BASE, resolvedPath: '/usr/bin/rtk' }, 'skip', 'already-resolved'],
    [{ ...BASE, inFlight: true }, 'skip', 'install-in-flight'],
    [{ ...BASE, platform: 'sunos' }, 'skip', 'unsupported-platform:sunos-x64'],
    [{ ...BASE, arch: 'ppc64' }, 'skip', 'unsupported-platform:linux-ppc64'],
    [{ ...BASE, lastFailureAt: BASE.nowMs - 1000 }, 'skip', 'failure-cooldown'],
    [{ ...BASE, lastFailureAt: BASE.nowMs - INSTALL_FAILURE_COOLDOWN_MS }, 'install', 'missing-binary'],
    [BASE, 'install', 'missing-binary'],
  ];
  for (const [input, action, reason] of cases) {
    const decision = decideRtkInstall(input);
    assert.equal(decision.action, action, JSON.stringify(input));
    assert.equal(decision.reason, reason, JSON.stringify(input));
  }
});

test('an unsupported platform is a skip, never a throw', () => {
  assert.doesNotThrow(() => decideRtkInstall({ ...BASE, platform: 'aix', arch: 'ppc' }));
  assert.equal(decideRtkInstall({ ...BASE, platform: 'aix', arch: 'ppc' }).asset, undefined);
});

test('an install decision carries the pinned asset for that platform', () => {
  const decision = decideRtkInstall({ ...BASE, platform: 'win32', arch: 'x64' });
  assert.equal(decision.action, 'install');
  assert.equal(decision.asset.sha256, RTK_ASSETS['win32-x64'].sha256);
});

test('verifyDigest compares exactly and refuses non-strings or length mismatches', () => {
  const digest = 'a'.repeat(64);
  assert.equal(verifyDigest(digest, digest), true);
  assert.equal(verifyDigest(digest, `b${digest.slice(1)}`), false);
  assert.equal(verifyDigest(digest, digest.slice(0, 63)), false);
  assert.equal(verifyDigest(digest, null), false);
  assert.equal(verifyDigest(undefined, digest), false);
});

test('installTargetPath lands under ~/.glissa/bin and takes .exe only on Windows', () => {
  assert.equal(installTargetPath('/home/x', 'linux'), path.join('/home/x', '.glissa', 'bin', 'rtk'));
  assert.equal(installTargetPath('/home/x', 'darwin'), path.join('/home/x', '.glissa', 'bin', 'rtk'));
  assert.equal(installTargetPath('C:\\Users\\x', 'win32'), path.join('C:\\Users\\x', '.glissa', 'bin', 'rtk.exe'));
});

test('isRtkBinaryName matches the platform binary and nothing beside it', () => {
  assert.equal(isRtkBinaryName('rtk', 'linux'), true);
  assert.equal(isRtkBinaryName('RTK', 'linux'), true);
  assert.equal(isRtkBinaryName('rtk.exe', 'linux'), false);
  assert.equal(isRtkBinaryName('rtk.exe', 'win32'), true);
  assert.equal(isRtkBinaryName('README.md', 'linux'), false);
});
