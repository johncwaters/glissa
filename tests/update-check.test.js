'use strict';

// Unit tests for the update-check IO shell (server/update-check.js). Every IO seam is injected (fetch,
// the git runner, the package root, the throttle state path), so each case runs offline against a temp
// directory. The load-bearing guarantees under test: checkForUpdate NEVER rejects, resolves null only
// when nothing at all could be read, reads the installed commit from the install itself, prefers
// `git ls-remote` with the GitHub API as fallback, and honors the persisted 6h throttle.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkForUpdate } = require('../server/update-check');

const SHA_LOCAL = '0123456789abcdef0123456789abcdef01234567';
const SHA_REMOTE = 'fedcba9876543210fedcba9876543210fedcba98';

function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-update-'));
  // packageRoot sits one level down so the shell's `..` lookup for the hidden lockfile stays inside.
  const packageRoot = path.join(dir, 'node_modules', 'glissa');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'glissa', version: '0.20.0' }), 'utf8');
  return { dir, packageRoot, statePath: path.join(dir, 'update-check.json') };
}

function writeLockfile(packageRoot, resolved) {
  const lockfilePath = path.join(packageRoot, '..', '.package-lock.json');
  fs.writeFileSync(lockfilePath, JSON.stringify({ packages: { 'node_modules/glissa': { resolved } } }), 'utf8');
}

function writeGitHead(packageRoot, gitHead) {
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'glissa', version: '0.20.0', gitHead }), 'utf8');
}

// A git runner that answers the two commands the shell issues, and rejects anything else.
function fakeGit({ head, lsRemote, throws } = {}) {
  return async (_file, args) => {
    if (throws) throw throws;
    if (args[0] === 'rev-parse') {
      if (!head) throw new Error('not a git repository');
      return { stdout: `${head}\n`, stderr: '' };
    }
    if (args[0] === 'ls-remote') {
      if (!lsRemote) throw new Error('could not read from remote repository');
      return { stdout: `${lsRemote}\trefs/heads/main\n`, stderr: '' };
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

// A fetch that answers the package.json URL with a version and the commits API with a bare sha.
function fakeFetch({ version, apiSha, packageJsonOk = true, apiOk = true, throws } = {}) {
  return async (url) => {
    if (throws) throw throws;
    if (url.includes('api.github.com')) {
      return { ok: apiOk && Boolean(apiSha), text: async () => apiSha || '' };
    }
    return { ok: packageJsonOk, json: async () => ({ version }) };
  };
}

function baseOptions(fixture, overrides = {}) {
  return {
    currentVersion: '0.20.0',
    packageRoot: fixture.packageRoot,
    statePath: fixture.statePath,
    runCommand: fakeGit({ lsRemote: SHA_REMOTE }),
    fetchFn: fakeFetch({ version: '0.20.0' }),
    now: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Installed identity
// ---------------------------------------------------------------------------

test('reads the installed commit from the hidden npm lockfile and reports the npm-global command', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  const result = await checkForUpdate(baseOptions(fixture));
  assert.equal(result.updateAvailable, true);
  assert.equal(result.currentSha, SHA_LOCAL);
  assert.equal(result.latestSha, SHA_REMOTE);
  assert.equal(result.flavor, 'npm-global');
  assert.equal(result.command, 'npm install -g github:johncwaters/glissa --allow-git=root');
  assert.equal(result.compareUrl, `https://github.com/johncwaters/glissa/compare/${SHA_LOCAL}...main`);
});

test('falls back to package.json gitHead when no lockfile entry is readable', async () => {
  const fixture = makeTempRoot();
  writeGitHead(fixture.packageRoot, SHA_LOCAL);
  const result = await checkForUpdate(baseOptions(fixture));
  assert.equal(result.currentSha, SHA_LOCAL);
  assert.equal(result.flavor, 'npm-global');
});

test('a clone resolves its commit with git rev-parse and reports the clone command', async () => {
  const fixture = makeTempRoot();
  fs.mkdirSync(path.join(fixture.packageRoot, '.git'));
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({ head: SHA_LOCAL, lsRemote: SHA_REMOTE }),
  }));
  assert.equal(result.currentSha, SHA_LOCAL);
  assert.equal(result.flavor, 'clone');
  assert.equal(result.command, 'git pull --ff-only && npm ci && npm run build');
});

test('an unresolvable installed commit degrades to the semver compare', async () => {
  const fixture = makeTempRoot();
  const result = await checkForUpdate(baseOptions(fixture, {
    fetchFn: fakeFetch({ version: '0.21.0' }),
  }));
  assert.equal(result.updateAvailable, true);
  assert.equal(result.currentSha, null);
  assert.equal(result.latestSha, SHA_REMOTE);
  assert.equal(result.flavor, 'unknown');
  assert.equal(result.compareUrl, null);
});

test('a broken git binary never throws, it degrades to the semver compare', async () => {
  const fixture = makeTempRoot();
  fs.mkdirSync(path.join(fixture.packageRoot, '.git'));
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({ throws: new Error('git not found') }),
    fetchFn: fakeFetch({ version: '0.21.0' }),
  }));
  assert.equal(result.updateAvailable, true);
  assert.equal(result.currentSha, null);
  assert.equal(result.latestSha, null);
});

// ---------------------------------------------------------------------------
// Remote commit
// ---------------------------------------------------------------------------

test('the GitHub commits API is the fallback when git ls-remote fails', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  const requested = [];
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: async (url, options) => {
      requested.push({ url, headers: options.headers });
      if (url.includes('api.github.com')) return { ok: true, text: async () => `${SHA_REMOTE}\n` };
      return { ok: true, json: async () => ({ version: '0.20.0' }) };
    },
  }));
  assert.equal(result.latestSha, SHA_REMOTE);
  assert.equal(requested[0].url, 'https://api.github.com/repos/johncwaters/glissa/commits/main');
  assert.equal(requested[0].headers.Accept, 'application/vnd.github.sha');
  assert.equal(requested[1].url, 'https://raw.githubusercontent.com/johncwaters/glissa/main/package.json');
});

test('the commit pair beats the version label: same commit is no update even with a newer version', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_REMOTE}`);
  const result = await checkForUpdate(baseOptions(fixture, {
    fetchFn: fakeFetch({ version: '0.99.0' }),
  }));
  assert.equal(result.updateAvailable, false);
  assert.equal(result.latest, '0.99.0');
});

test('a commit ahead of the last release still reports an update with no version bump', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  const result = await checkForUpdate(baseOptions(fixture));
  assert.equal(result.updateAvailable, true);
  assert.equal(result.current, '0.20.0');
  assert.equal(result.latest, '0.20.0');
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

test('resolves null when neither a remote commit nor a remote version could be read', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: fakeFetch({ throws: new Error('network down') }),
  }));
  assert.equal(result, null);
});

test('resolves null on a non-200 package.json with no remote commit', async () => {
  const fixture = makeTempRoot();
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: fakeFetch({ version: '0.21.0', packageJsonOk: false }),
  }));
  assert.equal(result, null);
});

test('resolves null (never rejects) when the request times out', async () => {
  const fixture = makeTempRoot();
  const hangingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: hangingFetch,
    timeoutMs: 5,
  }));
  assert.equal(result, null);
});

test('aborts an in-flight request when the caller aborts (shutdown)', async () => {
  const fixture = makeTempRoot();
  const abortController = new AbortController();
  const hangingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const pending = checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: hangingFetch,
    timeoutMs: 60000,
    abortController,
  }));
  abortController.abort();
  assert.equal(await pending, null);
});

test('an unwritable state path never breaks the check', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  const result = await checkForUpdate(baseOptions(fixture, {
    statePath: path.join(fixture.packageRoot, 'package.json', 'nested', 'state.json'),
  }));
  assert.equal(result.updateAvailable, true);
});

// ---------------------------------------------------------------------------
// Persisted throttle
// ---------------------------------------------------------------------------

test('a real check persists the remote commit and version', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  await checkForUpdate(baseOptions(fixture, { fetchFn: fakeFetch({ version: '0.21.0' }) }));
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  assert.deepEqual(state, { lastCheckAt: 1000, latestSha: SHA_REMOTE, latestVersion: '0.21.0' });
});

test('a fresh state is reused and no network call is made', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  fs.writeFileSync(fixture.statePath, JSON.stringify({ lastCheckAt: 1000, latestSha: SHA_REMOTE, latestVersion: '0.21.0' }), 'utf8');
  let networkCalls = 0;
  const result = await checkForUpdate(baseOptions(fixture, {
    now: 1000 + 60 * 60 * 1000,
    runCommand: async (_file, args) => {
      if (args[0] === 'ls-remote') networkCalls += 1;
      throw new Error('not a git repository');
    },
    fetchFn: async () => { networkCalls += 1; throw new Error('should not be called'); },
  }));
  assert.equal(networkCalls, 0);
  assert.equal(result.latestSha, SHA_REMOTE);
  assert.equal(result.latest, '0.21.0');
  assert.equal(result.updateAvailable, true);
});

test('a stale state is ignored and refreshed', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  fs.writeFileSync(fixture.statePath, JSON.stringify({ lastCheckAt: 1000, latestSha: SHA_LOCAL, latestVersion: '0.19.0' }), 'utf8');
  const staleNow = 1000 + 7 * 60 * 60 * 1000;
  const result = await checkForUpdate(baseOptions(fixture, { now: staleNow }));
  assert.equal(result.latestSha, SHA_REMOTE);
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  assert.equal(state.lastCheckAt, staleNow);
  assert.equal(state.latestSha, SHA_REMOTE);
});

test('a corrupt state file is ignored rather than fatal', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  fs.writeFileSync(fixture.statePath, 'not json', 'utf8');
  const result = await checkForUpdate(baseOptions(fixture));
  assert.equal(result.latestSha, SHA_REMOTE);
});
