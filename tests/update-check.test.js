'use strict';

// Unit tests for the startup update-check core (server/update-check.js). The one IO call (fetch) is
// injected, so every case runs offline and deterministically. The load-bearing guarantees under test:
// checkForUpdate NEVER rejects, resolves null on every failure path, and compareSemver fails open.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compareSemver,
  parseLatestVersion,
  buildUpdateCommand,
  checkForUpdate,
} = require('../server/update-check');

// A fetch stub that resolves a Response-like object with the given ok/json.
function fakeFetch({ ok = true, json, throws } = {}) {
  return async () => {
    if (throws) throw throws;
    return {
      ok,
      json: async () => {
        if (typeof json === 'function') return json();
        return json;
      },
    };
  };
}

// ---------------------------------------------------------------------------
// compareSemver
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

// ---------------------------------------------------------------------------
// parseLatestVersion
// ---------------------------------------------------------------------------

test('parseLatestVersion reads .version, null on mismatch', () => {
  assert.equal(parseLatestVersion({ version: '0.17.0' }), '0.17.0');
  assert.equal(parseLatestVersion({ name: 'glissa' }), null);
  assert.equal(parseLatestVersion({ version: 17 }), null);
  assert.equal(parseLatestVersion(null), null);
  assert.equal(parseLatestVersion('0.17.0'), null);
});

// ---------------------------------------------------------------------------
// buildUpdateCommand
// ---------------------------------------------------------------------------

test('buildUpdateCommand returns the git update command', () => {
  assert.equal(buildUpdateCommand(), 'git pull && npm ci && npm run build');
});

// ---------------------------------------------------------------------------
// checkForUpdate
// ---------------------------------------------------------------------------

test('checkForUpdate reports an available update with the command', async () => {
  const result = await checkForUpdate({
    currentVersion: '0.16.0',
    fetchFn: fakeFetch({ json: { version: '0.17.0' } }),
  });
  assert.deepEqual(result, {
    updateAvailable: true,
    current: '0.16.0',
    latest: '0.17.0',
    command: 'git pull && npm ci && npm run build',
  });
});

test('checkForUpdate reports updateAvailable false when current is latest or ahead', async () => {
  const same = await checkForUpdate({
    currentVersion: '0.17.0',
    fetchFn: fakeFetch({ json: { version: '0.17.0' } }),
  });
  assert.equal(same.updateAvailable, false);

  const ahead = await checkForUpdate({
    currentVersion: '0.18.0',
    fetchFn: fakeFetch({ json: { version: '0.17.0' } }),
  });
  assert.equal(ahead.updateAvailable, false);
});

test('checkForUpdate fetches the GitHub package.json URL', async () => {
  let requestedUrl = null;
  const result = await checkForUpdate({
    currentVersion: '0.16.0',
    fetchFn: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({ version: '0.17.0' }),
      };
    },
  });
  assert.equal(requestedUrl, 'https://raw.githubusercontent.com/johncwaters/glissa/main/package.json');
  assert.equal(result.command, 'git pull && npm ci && npm run build');
});

test('checkForUpdate resolves null on a non-200 response', async () => {
  const result = await checkForUpdate({
    currentVersion: '0.16.0',
    fetchFn: fakeFetch({ ok: false, json: { version: '0.17.0' } }),
  });
  assert.equal(result, null);
});

test('checkForUpdate resolves null when fetch throws', async () => {
  const result = await checkForUpdate({
    currentVersion: '0.16.0',
    fetchFn: fakeFetch({ throws: new Error('network down') }),
  });
  assert.equal(result, null);
});

test('checkForUpdate resolves null on malformed JSON', async () => {
  const result = await checkForUpdate({
    currentVersion: '0.16.0',
    fetchFn: fakeFetch({ json: () => { throw new Error('bad json'); } }),
  });
  assert.equal(result, null);
});

test('checkForUpdate resolves null when the doc lacks a version', async () => {
  const result = await checkForUpdate({
    currentVersion: '0.16.0',
    fetchFn: fakeFetch({ json: { name: 'glissa' } }),
  });
  assert.equal(result, null);
});

test('checkForUpdate resolves null (never rejects) when the request times out', async () => {
  // fetch that only settles when the abort signal fires; a short timeout drives the abort path.
  const hangingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const result = await checkForUpdate({
    currentVersion: '0.16.0',
    fetchFn: hangingFetch,
    timeoutMs: 5,
  });
  assert.equal(result, null);
});

test('checkForUpdate aborts an in-flight request when the caller aborts (shutdown)', async () => {
  const abortController = new AbortController();
  const hangingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const pending = checkForUpdate({
    currentVersion: '0.16.0',
    fetchFn: hangingFetch,
    timeoutMs: 60000,
    abortController,
  });
  abortController.abort();
  assert.equal(await pending, null);
});
