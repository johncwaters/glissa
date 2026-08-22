'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkForUpdate } = require('../server/update-check');

const SHA_LOCAL = '0123456789abcdef0123456789abcdef01234567';
const SHA_RELEASE_TAG = '1111111111111111111111111111111111111111';
const SHA_RELEASE_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';

function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-update-'));
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

function tagsStdout({ version = '0.21.0', tagSha = SHA_RELEASE_TAG, commitSha = SHA_RELEASE_COMMIT } = {}) {
  return [
    `${tagSha}\trefs/tags/v${version}`,
    `${commitSha}\trefs/tags/v${version}^{}`,
  ].join('\n');
}

function fakeGit({ head, tags, throws } = {}) {
  return async (_file, args) => {
    if (throws) throw throws;
    if (args[0] === 'rev-parse') {
      if (!head) throw new Error('not a git repository');
      return { stdout: `${head}\n`, stderr: '' };
    }
    if (args[0] === 'ls-remote' && args[1] === '--tags') {
      if (!tags) throw new Error('could not read from remote repository');
      return { stdout: tags, stderr: '' };
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function fakeFetch({ version, ok = true, throws } = {}) {
  return async () => {
    if (throws) throw throws;
    return { ok, json: async () => ({ tag_name: version ? `v${version}` : null }) };
  };
}

function baseOptions(fixture, overrides = {}) {
  return {
    currentVersion: '0.20.0',
    packageRoot: fixture.packageRoot,
    statePath: fixture.statePath,
    runCommand: fakeGit({ tags: tagsStdout() }),
    fetchFn: fakeFetch({ version: '0.21.0' }),
    now: 1000,
    ...overrides,
  };
}

test('reads the installed commit from the hidden npm lockfile and reports the pinned npm-global command', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  const result = await checkForUpdate(baseOptions(fixture));
  assert.equal(result.updateAvailable, true);
  assert.equal(result.currentSha, SHA_LOCAL);
  assert.equal(result.latestSha, SHA_RELEASE_COMMIT);
  assert.equal(result.flavor, 'npm-global');
  assert.equal(result.command, 'npm install -g github:johncwaters/glissa#v0.21.0 --allow-git=root');
  assert.equal(result.releaseUrl, 'https://github.com/johncwaters/glissa/releases/tag/v0.21.0');
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
    runCommand: fakeGit({ head: SHA_LOCAL, tags: tagsStdout() }),
  }));
  assert.equal(result.currentSha, SHA_LOCAL);
  assert.equal(result.flavor, 'clone');
  assert.equal(result.command, 'git pull --ff-only && npm ci && npm run build');
});

test('an unresolvable installed commit still compares versions', async () => {
  const fixture = makeTempRoot();
  const result = await checkForUpdate(baseOptions(fixture));
  assert.equal(result.updateAvailable, true);
  assert.equal(result.currentSha, null);
  assert.equal(result.latestSha, SHA_RELEASE_COMMIT);
  assert.equal(result.flavor, 'unknown');
  assert.equal(result.releaseUrl, 'https://github.com/johncwaters/glissa/releases/tag/v0.21.0');
});

test('a broken git binary never throws, it uses releases/latest as fallback', async () => {
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

test('git ls-remote tags is primary and releases/latest is not fetched when it succeeds', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  let fetchCalls = 0;
  const result = await checkForUpdate(baseOptions(fixture, {
    fetchFn: async () => {
      fetchCalls += 1;
      throw new Error('should not fetch');
    },
  }));
  assert.equal(fetchCalls, 0);
  assert.equal(result.latest, '0.21.0');
  assert.equal(result.latestSha, SHA_RELEASE_COMMIT);
});

test('releases/latest is the fallback when git ls-remote tags fails', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  const requested = [];
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: async (url, options) => {
      requested.push({ url, headers: options.headers });
      return { ok: true, json: async () => ({ tag_name: 'v0.21.0' }) };
    },
  }));
  assert.equal(result.latest, '0.21.0');
  assert.equal(result.latestSha, null);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, 'https://api.github.com/repos/johncwaters/glissa/releases/latest');
  assert.equal(requested[0].headers.Accept, 'application/vnd.github+json');
});

test('releases/latest is the fallback when git ls-remote has no valid release tag', async () => {
  const fixture = makeTempRoot();
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({ tags: `${SHA_RELEASE_TAG}\trefs/heads/main\nnot ls remote output` }),
    fetchFn: fakeFetch({ version: '0.21.0' }),
  }));
  assert.equal(result.latest, '0.21.0');
  assert.equal(result.latestSha, null);
});

test('resolves null when the releases/latest fallback body is not JSON', async () => {
  const fixture = makeTempRoot();
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: async () => ({ ok: true, json: async () => { throw new Error('not json'); } }),
  }));
  assert.equal(result, null);
});

test('same version is no update even when shas differ', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  const result = await checkForUpdate(baseOptions(fixture, {
    currentVersion: '0.21.0',
  }));
  assert.equal(result.updateAvailable, false);
  assert.equal(result.currentSha, SHA_LOCAL);
  assert.equal(result.latestSha, SHA_RELEASE_COMMIT);
});

test('resolves null when no latest release version could be read', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: fakeFetch({ throws: new Error('network down') }),
  }));
  assert.equal(result, null);
});

test('resolves null on a non-200 latest release response', async () => {
  const fixture = makeTempRoot();
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: fakeFetch({ version: '0.21.0', ok: false }),
  }));
  assert.equal(result, null);
});

test('does not write throttle state when no release version resolves', async () => {
  const fixture = makeTempRoot();
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: fakeFetch({ ok: false }),
  }));
  assert.equal(result, null);
  assert.equal(fs.existsSync(fixture.statePath), false);
});

test('resolves null when the request times out', async () => {
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

test('aborts an in-flight request when the caller aborts', async () => {
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

test('a real check persists the latest version and nullable sha', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  await checkForUpdate(baseOptions(fixture));
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  assert.deepEqual(state, { lastCheckAt: 1000, latestVersion: '0.21.0', latestSha: SHA_RELEASE_COMMIT });
});

test('a releases/latest fallback persists a nullable sha', async () => {
  const fixture = makeTempRoot();
  await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: fakeFetch({ version: '0.21.0' }),
  }));
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  assert.deepEqual(state, { lastCheckAt: 1000, latestVersion: '0.21.0', latestSha: null });
});

test('a fresh state is reused and no network call is made', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  fs.writeFileSync(fixture.statePath, JSON.stringify({ lastCheckAt: 1000, latestVersion: '0.21.0', latestSha: SHA_RELEASE_COMMIT }), 'utf8');
  let networkCalls = 0;
  const result = await checkForUpdate(baseOptions(fixture, {
    now: 1000 + 60 * 60 * 1000,
    runCommand: async (_file, args) => {
      if (args[0] === 'ls-remote') networkCalls += 1;
      throw new Error('not a git repository');
    },
    fetchFn: async () => {
      networkCalls += 1;
      throw new Error('should not be called');
    },
  }));
  assert.equal(networkCalls, 0);
  assert.equal(result.latestSha, SHA_RELEASE_COMMIT);
  assert.equal(result.latest, '0.21.0');
  assert.equal(result.updateAvailable, true);
});

test('a fresh old-shape state is tolerated when it has a latest version', async () => {
  const fixture = makeTempRoot();
  fs.writeFileSync(fixture.statePath, JSON.stringify({
    lastCheckAt: 1000,
    remoteSha: SHA_RELEASE_COMMIT,
    latestVersion: '0.21.0',
    latestSha: SHA_RELEASE_COMMIT,
    latestPackageVersion: '0.21.0',
  }), 'utf8');
  const result = await checkForUpdate(baseOptions(fixture, {
    now: 1000 + 60 * 60 * 1000,
    runCommand: async () => { throw new Error('should not be called'); },
    fetchFn: async () => { throw new Error('should not be called'); },
  }));
  assert.equal(result.latest, '0.21.0');
  assert.equal(result.latestSha, SHA_RELEASE_COMMIT);
  assert.equal(result.updateAvailable, true);
});

test('a stale state is ignored and refreshed', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  fs.writeFileSync(fixture.statePath, JSON.stringify({ lastCheckAt: 1000, latestVersion: '0.19.0', latestSha: SHA_LOCAL }), 'utf8');
  const staleNow = 1000 + 7 * 60 * 60 * 1000;
  const result = await checkForUpdate(baseOptions(fixture, { now: staleNow }));
  assert.equal(result.latestSha, SHA_RELEASE_COMMIT);
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  assert.equal(state.lastCheckAt, staleNow);
  assert.equal(state.latestVersion, '0.21.0');
  assert.equal(state.latestSha, SHA_RELEASE_COMMIT);
});

test('a corrupt state file is ignored rather than fatal', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  fs.writeFileSync(fixture.statePath, 'not json', 'utf8');
  let lsRemoteCalls = 0;
  const runCommand = async (file, args, options) => {
    if (args[0] === 'ls-remote') lsRemoteCalls += 1;
    return fakeGit({ tags: tagsStdout() })(file, args, options);
  };
  const result = await checkForUpdate(baseOptions(fixture, { runCommand }));
  assert.equal(lsRemoteCalls, 1);
  assert.equal(result.latestSha, SHA_RELEASE_COMMIT);
});

test('a corrupt state file is replaced after a successful check', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  fs.writeFileSync(fixture.statePath, 'not json', 'utf8');
  const result = await checkForUpdate(baseOptions(fixture));
  assert.equal(result.latestSha, SHA_RELEASE_COMMIT);
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  assert.equal(state.latestVersion, '0.21.0');
});
