import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MAIN_FETCH_TIMEOUT_MS, checkForUpdate } from '../server/update-check.ts';
import type { CheckForUpdateOptions } from '../server/update-check.ts';

const SHA_LOCAL = '0123456789abcdef0123456789abcdef01234567';
const SHA_RELEASE_TAG = '1111111111111111111111111111111111111111';
const SHA_RELEASE_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';

interface Fixture {
  dir: string;
  packageRoot: string;
  statePath: string;
}

function makeTempRoot(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-update-'));
  const packageRoot = path.join(dir, 'node_modules', 'glissa');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'glissa', version: '0.20.0' }), 'utf8');
  return { dir, packageRoot, statePath: path.join(dir, 'update-check.json') };
}

function writeLockfile(packageRoot: string, resolved: string): void {
  const lockfilePath = path.join(packageRoot, '..', '.package-lock.json');
  fs.writeFileSync(lockfilePath, JSON.stringify({ packages: { 'node_modules/glissa': { resolved } } }), 'utf8');
}

function writeGitHead(packageRoot: string, gitHead: string): void {
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'glissa', version: '0.20.0', gitHead }), 'utf8');
}

function tagsStdout({ version = '0.21.0', tagSha = SHA_RELEASE_TAG, commitSha = SHA_RELEASE_COMMIT } = {}): string {
  return [
    `${tagSha}\trefs/tags/v${version}`,
    `${commitSha}\trefs/tags/v${version}^{}`,
  ].join('\n');
}

type RunCommand = NonNullable<CheckForUpdateOptions['runCommand']>;

function argvOf(rest: unknown[]): string[] {
  const args = rest[0];
  return Array.isArray(args) ? args.map((arg) => String(arg)) : [];
}

function fakeGit({ head, tags, throws }: { head?: string; tags?: string; throws?: Error } = {}): RunCommand {
  return async (_file: string, ...rest: unknown[]) => {
    if (throws) throw throws;
    const args = argvOf(rest);
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

function fakeFetch({ version, ok = true, throws }: { version?: string; ok?: boolean; throws?: Error } = {}): typeof fetch {
  return async () => {
    if (throws) throw throws;
    if (!ok) return new Response(null, { status: 500 });
    return Response.json({ tag_name: version ? `v${version}` : null });
  };
}

const hangingFetch: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
});

function statusOf(result: Awaited<ReturnType<typeof checkForUpdate>>) {
  if (!result) throw new Error('expected an update status, the check answered null');
  return result;
}

function baseOptions(fixture: Fixture, overrides: Partial<CheckForUpdateOptions> = {}): CheckForUpdateOptions {
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
  assert.equal(statusOf(result).updateAvailable, true);
  assert.equal(statusOf(result).currentSha, SHA_LOCAL);
  assert.equal(statusOf(result).latestSha, SHA_RELEASE_COMMIT);
  assert.equal(statusOf(result).flavor, 'npm-global');
  assert.equal(statusOf(result).command, 'npm install -g github:johncwaters/glissa#v0.21.0 --allow-git=root');
  assert.equal(statusOf(result).releaseUrl, 'https://github.com/johncwaters/glissa/releases/tag/v0.21.0');
});

test('falls back to package.json gitHead when no lockfile entry is readable', async () => {
  const fixture = makeTempRoot();
  writeGitHead(fixture.packageRoot, SHA_LOCAL);
  const result = await checkForUpdate(baseOptions(fixture));
  assert.equal(statusOf(result).currentSha, SHA_LOCAL);
  assert.equal(statusOf(result).flavor, 'npm-global');
});

test('a clone resolves its commit with git rev-parse and reports the clone command', async () => {
  const fixture = makeTempRoot();
  fs.mkdirSync(path.join(fixture.packageRoot, '.git'));
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({ head: SHA_LOCAL, tags: tagsStdout() }),
  }));
  assert.equal(statusOf(result).currentSha, SHA_LOCAL);
  assert.equal(statusOf(result).flavor, 'clone');
  assert.equal(statusOf(result).command, 'git pull --ff-only && npm ci && npm run build');
});

test('an unresolvable installed commit still compares versions', async () => {
  const fixture = makeTempRoot();
  const result = await checkForUpdate(baseOptions(fixture));
  assert.equal(statusOf(result).updateAvailable, true);
  assert.equal(statusOf(result).currentSha, null);
  assert.equal(statusOf(result).latestSha, SHA_RELEASE_COMMIT);
  assert.equal(statusOf(result).flavor, 'unknown');
  assert.equal(statusOf(result).releaseUrl, 'https://github.com/johncwaters/glissa/releases/tag/v0.21.0');
});

test('a broken git binary never throws, it uses releases/latest as fallback', async () => {
  const fixture = makeTempRoot();
  fs.mkdirSync(path.join(fixture.packageRoot, '.git'));
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({ throws: new Error('git not found') }),
    fetchFn: fakeFetch({ version: '0.21.0' }),
  }));
  assert.equal(statusOf(result).updateAvailable, true);
  assert.equal(statusOf(result).currentSha, null);
  assert.equal(statusOf(result).latestSha, null);
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
  assert.equal(statusOf(result).latest, '0.21.0');
  assert.equal(statusOf(result).latestSha, SHA_RELEASE_COMMIT);
});

test('releases/latest is the fallback when git ls-remote tags fails', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  const requested: { url: string; accept: string | null }[] = [];
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: async (input, init) => {
      requested.push({ url: String(input), accept: new Headers(init?.headers).get('accept') });
      return Response.json({ tag_name: 'v0.21.0' });
    },
  }));
  assert.equal(statusOf(result).latest, '0.21.0');
  assert.equal(statusOf(result).latestSha, null);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, 'https://api.github.com/repos/johncwaters/glissa/releases/latest');
  assert.equal(requested[0].accept, 'application/vnd.github+json');
});

test('releases/latest is the fallback when git ls-remote has no valid release tag', async () => {
  const fixture = makeTempRoot();
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({ tags: `${SHA_RELEASE_TAG}\trefs/heads/main\nnot ls remote output` }),
    fetchFn: fakeFetch({ version: '0.21.0' }),
  }));
  assert.equal(statusOf(result).latest, '0.21.0');
  assert.equal(statusOf(result).latestSha, null);
});

test('records a failed status when the releases/latest fallback body is not JSON', async () => {
  const fixture = makeTempRoot();
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: async () => new Response('not json'),
  }));
  assert.equal(statusOf(result).reason, 'release-check-failed');
});

test('same version is no update even when shas differ', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  const result = await checkForUpdate(baseOptions(fixture, {
    currentVersion: '0.21.0',
  }));
  assert.equal(statusOf(result).updateAvailable, false);
  assert.equal(statusOf(result).currentSha, SHA_LOCAL);
  assert.equal(statusOf(result).latestSha, SHA_RELEASE_COMMIT);
});

test('records a failed status when no latest release version could be read', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: fakeFetch({ throws: new Error('network down') }),
  }));
  assert.equal(statusOf(result).reason, 'release-check-failed');
});

test('records a failed status on a non-200 latest release response', async () => {
  const fixture = makeTempRoot();
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: fakeFetch({ version: '0.21.0', ok: false }),
  }));
  assert.equal(statusOf(result).reason, 'release-check-failed');
});

test('does not write throttle state when no release version resolves', async () => {
  const fixture = makeTempRoot();
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: fakeFetch({ ok: false }),
  }));
  assert.equal(statusOf(result).reason, 'release-check-failed');
  assert.equal(fs.existsSync(fixture.statePath), false);
});

test('records a failed status when the request times out', async () => {
  const fixture = makeTempRoot();
  const result = await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: hangingFetch,
    timeoutMs: 5,
  }));
  assert.equal(statusOf(result).reason, 'release-check-failed');
});

test('aborts an in-flight request when the caller aborts', async () => {
  const fixture = makeTempRoot();
  const abortController = new AbortController();
  const pending = checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: hangingFetch,
    timeoutMs: 60000,
    abortController,
  }));
  abortController.abort();
  assert.equal(statusOf(await pending).reason, 'update-check-failed');
});

test('an unwritable state path never breaks the check', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  const result = await checkForUpdate(baseOptions(fixture, {
    statePath: path.join(fixture.packageRoot, 'package.json', 'nested', 'state.json'),
  }));
  assert.equal(statusOf(result).updateAvailable, true);
});

test('a real check persists the latest version and nullable sha', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  await checkForUpdate(baseOptions(fixture));
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  assert.deepEqual(state, {
    lastCheckAt: 1000,
    channel: 'release',
    latestVersion: '0.21.0',
    latestSha: SHA_RELEASE_COMMIT,
    behindCount: null,
    reason: null,
  });
});

test('a releases/latest fallback persists a nullable sha', async () => {
  const fixture = makeTempRoot();
  await checkForUpdate(baseOptions(fixture, {
    runCommand: fakeGit({}),
    fetchFn: fakeFetch({ version: '0.21.0' }),
  }));
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  assert.deepEqual(state, {
    lastCheckAt: 1000,
    channel: 'release',
    latestVersion: '0.21.0',
    latestSha: null,
    behindCount: null,
    reason: null,
  });
});

test('a fresh state is reused and no network call is made', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  fs.writeFileSync(fixture.statePath, JSON.stringify({
    lastCheckAt: 1000,
    channel: 'release',
    latestVersion: '0.21.0',
    latestSha: SHA_RELEASE_COMMIT,
  }), 'utf8');
  let networkCalls = 0;
  const result = await checkForUpdate(baseOptions(fixture, {
    now: 1000 + 60 * 60 * 1000,
    runCommand: async (_file: string, ...rest: unknown[]) => {
      if (argvOf(rest)[0] === 'ls-remote') networkCalls += 1;
      throw new Error('not a git repository');
    },
    fetchFn: async () => {
      networkCalls += 1;
      throw new Error('should not be called');
    },
  }));
  assert.equal(networkCalls, 0);
  assert.equal(statusOf(result).latestSha, SHA_RELEASE_COMMIT);
  assert.equal(statusOf(result).latest, '0.21.0');
  assert.equal(statusOf(result).updateAvailable, true);
});

test('a fresh cache with no channel is ignored', async () => {
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
    runCommand: fakeGit({ tags: tagsStdout({ version: '0.22.0' }) }),
    fetchFn: async () => { throw new Error('should not be called'); },
  }));
  assert.equal(statusOf(result).latest, '0.22.0');
  assert.equal(statusOf(result).latestSha, SHA_RELEASE_COMMIT);
  assert.equal(statusOf(result).updateAvailable, true);
});

test('a stale state is ignored and refreshed', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  fs.writeFileSync(fixture.statePath, JSON.stringify({ lastCheckAt: 1000, latestVersion: '0.19.0', latestSha: SHA_LOCAL }), 'utf8');
  const staleNow = 1000 + 7 * 60 * 60 * 1000;
  const result = await checkForUpdate(baseOptions(fixture, { now: staleNow }));
  assert.equal(statusOf(result).latestSha, SHA_RELEASE_COMMIT);
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
  const runCommand: RunCommand = async (file: string, ...rest: unknown[]) => {
    if (argvOf(rest)[0] === 'ls-remote') lsRemoteCalls += 1;
    return fakeGit({ tags: tagsStdout() })(file, ...rest);
  };
  const result = await checkForUpdate(baseOptions(fixture, { runCommand }));
  assert.equal(lsRemoteCalls, 1);
  assert.equal(statusOf(result).latestSha, SHA_RELEASE_COMMIT);
});

test('a corrupt state file is replaced after a successful check', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  fs.writeFileSync(fixture.statePath, 'not json', 'utf8');
  const result = await checkForUpdate(baseOptions(fixture));
  assert.equal(statusOf(result).latestSha, SHA_RELEASE_COMMIT);
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
  assert.equal(state.latestVersion, '0.21.0');
});

test('main channel resolves the upstream tip and reports commits behind after fetching', async () => {
  const fixture = makeTempRoot();
  fs.mkdirSync(path.join(fixture.packageRoot, '.git'));
  const commands: string[][] = [];
  let fetches = 0;
  const runCommand: RunCommand = async (_file, ...rest) => {
    const args = argvOf(rest);
    commands.push(args);
    if (args.join(' ') === 'rev-parse HEAD') return { stdout: `${SHA_LOCAL}\n`, stderr: '' };
    if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n', stderr: '' };
    if (args.join(' ') === 'rev-parse --abbrev-ref @{upstream}') return { stdout: 'origin/main\n', stderr: '' };
    if (args[0] === 'status') return { stdout: '', stderr: '' };
    if (args.join(' ') === 'ls-remote origin refs/heads/main') {
      return { stdout: `${SHA_RELEASE_COMMIT}\trefs/heads/main\n`, stderr: '' };
    }
    if (args[0] === 'rev-list') return { stdout: '0\t4\n', stderr: '' };
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const status = statusOf(await checkForUpdate(baseOptions(fixture, {
    updateChannel: 'main',
    runCommand,
    fetchOrigin: async () => {
      fetches += 1;
      return { ok: true, out: '' };
    },
  })));
  assert.equal(fetches, 1);
  assert.equal(status.channel, 'main');
  assert.equal(status.installedBranch, 'main');
  assert.equal(status.upstream, 'origin/main');
  assert.equal(status.isTreeClean, true);
  assert.equal(status.latestSha, SHA_RELEASE_COMMIT);
  assert.equal(status.behindCount, 4);
  assert.equal(status.updateAvailable, true);
  assert.ok(commands.some((args) => args.join(' ') === `rev-list --left-right --count HEAD...${SHA_RELEASE_COMMIT}`));
});

test('main channel reports no-upstream without querying a remote tip', async () => {
  const fixture = makeTempRoot();
  fs.mkdirSync(path.join(fixture.packageRoot, '.git'));
  let remoteQueries = 0;
  const runCommand: RunCommand = async (_file, ...rest) => {
    const args = argvOf(rest);
    if (args.join(' ') === 'rev-parse HEAD') return { stdout: `${SHA_LOCAL}\n`, stderr: '' };
    if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n', stderr: '' };
    if (args.join(' ') === 'rev-parse --abbrev-ref @{upstream}') throw new Error('no upstream');
    if (args[0] === 'status') return { stdout: '', stderr: '' };
    if (args[0] === 'ls-remote') remoteQueries += 1;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const status = statusOf(await checkForUpdate(baseOptions(fixture, {
    updateChannel: 'main',
    runCommand,
  })));
  assert.equal(status.reason, 'no-upstream');
  assert.equal(status.updateAvailable, false);
  assert.equal(remoteQueries, 0);
});

test('a cache entry is ignored when its channel does not match', async () => {
  const fixture = makeTempRoot();
  writeLockfile(fixture.packageRoot, `git+https://github.com/johncwaters/glissa.git#${SHA_LOCAL}`);
  fs.writeFileSync(fixture.statePath, JSON.stringify({
    lastCheckAt: 1000,
    channel: 'main',
    latestVersion: null,
    latestSha: SHA_LOCAL,
    behindCount: 0,
  }), 'utf8');
  let releaseQueries = 0;
  const status = statusOf(await checkForUpdate(baseOptions(fixture, {
    now: 2000,
    runCommand: async (file, ...rest) => {
      if (argvOf(rest)[0] === 'ls-remote') releaseQueries += 1;
      return fakeGit({ tags: tagsStdout() })(file, ...rest);
    },
  })));
  assert.equal(releaseQueries, 1);
  assert.equal(status.channel, 'release');
  assert.equal(status.latest, '0.21.0');
});

test('a fresh cache is discarded once the installed sha is the sha it names', async () => {
  const fixture = makeTempRoot();
  fs.mkdirSync(path.join(fixture.packageRoot, '.git'));
  fs.writeFileSync(fixture.statePath, JSON.stringify({
    lastCheckAt: 1000,
    channel: 'main',
    latestVersion: null,
    latestSha: SHA_LOCAL,
    behindCount: 6,
  }), 'utf8');
  let remoteTipQueries = 0;
  const runCommand: RunCommand = async (_file, ...rest) => {
    const args = argvOf(rest);
    if (args.join(' ') === 'rev-parse HEAD') return { stdout: `${SHA_LOCAL}\n`, stderr: '' };
    if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n', stderr: '' };
    if (args.join(' ') === 'rev-parse --abbrev-ref @{upstream}') return { stdout: 'origin/main\n', stderr: '' };
    if (args[0] === 'status') return { stdout: '', stderr: '' };
    if (args[0] === 'ls-remote') {
      remoteTipQueries += 1;
      return { stdout: `${SHA_LOCAL}\trefs/heads/main\n`, stderr: '' };
    }
    if (args[0] === 'rev-list') return { stdout: '0\t0\n', stderr: '' };
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const status = statusOf(await checkForUpdate(baseOptions(fixture, {
    updateChannel: 'main',
    now: 1000 + 60 * 60 * 1000,
    runCommand,
    fetchOrigin: async () => ({ ok: true, out: '' }),
  })));
  assert.equal(remoteTipQueries, 1, 'the cached count against the old head is never trusted');
  assert.equal(status.behindCount, 0);
  assert.equal(status.updateAvailable, false);
});

test('the main-channel fetch takes a fraction of the budget so the probes after it still run', async () => {
  const fixture = makeTempRoot();
  fs.mkdirSync(path.join(fixture.packageRoot, '.git'));
  const fetchTimeouts: Array<number | undefined> = [];
  const probeTimeouts: Array<{ args: string; timeout: number }> = [];
  const runCommand: RunCommand = async (_file, ...rest) => {
    const args = argvOf(rest);
    const options = rest[1] && typeof rest[1] === 'object' ? rest[1] as Record<string, unknown> : {};
    if (args[0] === 'ls-remote' || args[0] === 'rev-list') {
      probeTimeouts.push({ args: args[0], timeout: Number(options.timeout) });
    }
    if (args.join(' ') === 'rev-parse HEAD') return { stdout: `${SHA_LOCAL}\n`, stderr: '' };
    if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n', stderr: '' };
    if (args.join(' ') === 'rev-parse --abbrev-ref @{upstream}') return { stdout: 'origin/main\n', stderr: '' };
    if (args[0] === 'status') return { stdout: '', stderr: '' };
    if (args[0] === 'ls-remote') return { stdout: `${SHA_RELEASE_COMMIT}\trefs/heads/main\n`, stderr: '' };
    if (args[0] === 'rev-list') return { stdout: '0\t2\n', stderr: '' };
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const status = statusOf(await checkForUpdate(baseOptions(fixture, {
    updateChannel: 'main',
    timeoutMs: 8000,
    runCommand,
    fetchOrigin: async ({ timeoutMs }) => {
      fetchTimeouts.push(timeoutMs);
      return { ok: true, out: '' };
    },
  })));
  assert.deepEqual(fetchTimeouts, [MAIN_FETCH_TIMEOUT_MS]);
  assert.ok(MAIN_FETCH_TIMEOUT_MS < 8000);
  const budgetLeftForProbes = probeTimeouts.reduce((total, probe) => total + probe.timeout, 0);
  assert.equal(MAIN_FETCH_TIMEOUT_MS + budgetLeftForProbes, 8000);
  assert.equal(status.behindCount, 2);
});

test('an abort between main-channel steps stops the remaining probes', async () => {
  const fixture = makeTempRoot();
  fs.mkdirSync(path.join(fixture.packageRoot, '.git'));
  const abortController = new AbortController();
  let remoteTipQueries = 0;
  const runCommand: RunCommand = async (_file, ...rest) => {
    const args = argvOf(rest);
    if (args.join(' ') === 'rev-parse HEAD') return { stdout: `${SHA_LOCAL}\n`, stderr: '' };
    if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n', stderr: '' };
    if (args.join(' ') === 'rev-parse --abbrev-ref @{upstream}') return { stdout: 'origin/main\n', stderr: '' };
    if (args[0] === 'status') return { stdout: '', stderr: '' };
    if (args[0] === 'ls-remote') {
      remoteTipQueries += 1;
      return { stdout: `${SHA_RELEASE_COMMIT}\trefs/heads/main\n`, stderr: '' };
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const status = statusOf(await checkForUpdate(baseOptions(fixture, {
    updateChannel: 'main',
    abortController,
    runCommand,
    fetchOrigin: async () => {
      abortController.abort();
      return { ok: true, out: '' };
    },
  })));
  assert.equal(remoteTipQueries, 0);
  assert.equal(status.reason, 'remote-tip-unavailable');
});
