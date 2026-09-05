import test from 'node:test';
import assert from 'node:assert/strict';

import { createBackendUpdateCheck } from '../server/backend-update.ts';
import type { UpdateStatus } from '../server/backend-update.ts';
import { decideUpdateStatus } from '../server/core/update-core.ts';
import type { ControlHandlerDeps } from '../server/control-handlers.ts';
import type { ControlMessageRecord } from '../server/control-replay-core.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';
import type { UpdateJournal } from '../shared/contracts/update-journal.ts';

const UPDATE_RECHECK_MS = 24 * 60 * 60 * 1000;

interface UpdateFrame {
  type: string;
  latest?: string | null;
}

function connect(deps: Partial<ControlHandlerDeps>): UpdateFrame[] {
  const server = createControlServer(controlDeps({ projects: [] }, deps));
  return connectControl<UpdateFrame>(server).sent;
}

function makeUpdateStatus(latest: string): UpdateStatus {
  return {
    ...decideUpdateStatus({
    currentVersion: '0.16.0',
    latestVersion: latest,
    installedSha: '0123456789abcdef0123456789abcdef01234567',
    latestSha: 'fedcba9876543210fedcba9876543210fedcba98',
    flavor: 'npm-global',
    }),
    installedBranch: null,
    upstream: null,
    isTreeClean: null,
    lastCheckAt: 1000,
    journalSummary: null,
  };
}

function makeJournal(): UpdateJournal {
  return {
    state: 'idle', fromSha: null, toSha: null, toVersion: null, channel: 'release', steps: [],
    activeStep: null, reason: null, startedAt: null, finishedAt: null,
  };
}

test('no update-status when getUpdateStatus is absent', () => {
  let sent: UpdateFrame[] = [];
  assert.doesNotThrow(() => { sent = connect({}); });
  assert.equal(sent.filter((m) => m.type === 'update-status').length, 0);
});

test('update-status replays an up-to-date result', () => {
  const status = { ...makeUpdateStatus('0.16.0'), updateAvailable: false };
  const sent = connect({ getUpdateStatus: () => status });
  assert.deepEqual(sent.filter((message) => message.type === 'update-status'), [{ type: 'update-status', ...status }]);
});

test('replays exactly one update-status frame when an update is cached', () => {
  const status = makeUpdateStatus('0.17.0');
  const sent = connect({ getUpdateStatus: () => status });
  const updates = sent.filter((m) => m.type === 'update-status');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { type: 'update-status', ...status });
});

test('update-progress replays the latest journal', () => {
  const journal = makeJournal();
  const sent = connect({ getUpdateJournal: () => journal });
  assert.deepEqual(sent.filter((message) => message.type === 'update-progress'), [{ type: 'update-progress', journal }]);
});

test('getStatus projects the latest journal summary', async () => {
  const journal = makeJournal();
  const updateCheck = createBackendUpdateCheck({
    config: { checkForUpdates: true },
    isLocalConfig: false,
    currentVersion: '0.16.0',
    checkForUpdate: async () => makeUpdateStatus('0.17.0'),
    getUpdateJournal: () => journal,
    getControlClientCount: () => 0,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });
  await updateCheck.checkNow();
  journal.state = 'running';
  journal.activeStep = 'fetch';
  journal.startedAt = 2000;
  assert.deepEqual(updateCheck.getStatus()?.journalSummary, {
    state: 'running',
    activeStep: 'fetch',
    reason: null,
    startedAt: 2000,
    finishedAt: null,
  });
});

test('every check broadcasts update-status while banner logging stays deduplicated', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const broadcasts: ControlMessageRecord[] = [];
  const results = [makeUpdateStatus('0.17.0'), makeUpdateStatus('0.17.0'), makeUpdateStatus('0.18.0')];
  let checksRun = 0;
  let logs = 0;
  const updateCheck = createBackendUpdateCheck({
    config: { checkForUpdates: true },
    isLocalConfig: false,
    currentVersion: '0.16.0',
    checkForUpdate: async () => results[checksRun++] ?? null,
    getControlClientCount: () => 1,
    broadcastControl: (message) => { broadcasts.push(message); },
    logger: { log: () => { logs += 1; } },
  });

  updateCheck.start();
  await settle();
  t.mock.timers.tick(UPDATE_RECHECK_MS);
  await settle();
  t.mock.timers.tick(UPDATE_RECHECK_MS);
  await settle();
  updateCheck.stop();

  assert.equal(checksRun, 3, 'the startup check plus one per recheck tick');
  assert.deepEqual(
    broadcasts.filter((message) => message.type === 'update-status').map((message) => message.latest),
    ['0.17.0', '0.17.0', '0.18.0'],
  );
  assert.equal(logs, 2);
});

test('up-to-date and failed checks are both recorded and broadcast', async () => {
  const broadcasts: ControlMessageRecord[] = [];
  const results: Array<UpdateStatus | null> = [makeUpdateStatus('0.16.0'), null];
  const updateCheck = createBackendUpdateCheck({
    config: { checkForUpdates: true },
    isLocalConfig: false,
    currentVersion: '0.16.0',
    checkForUpdate: async () => results.shift() ?? null,
    getControlClientCount: () => 0,
    broadcastControl: (message) => { broadcasts.push(message); },
    logger: { log: () => {} },
  });
  assert.equal((await updateCheck.checkNow()).updateAvailable, false);
  assert.equal((await updateCheck.checkNow()).reason, 'update-check-failed');
  assert.deepEqual(
    broadcasts.filter((message) => message.type === 'update-status').map((message) => message.reason),
    [null, 'update-check-failed'],
  );
});

function settle(): Promise<void> {
  return new Promise((resolve) => { queueMicrotask(() => queueMicrotask(() => resolve())); });
}

test('a recheck is skipped while no control client is connected', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let checksRun = 0;
  const updateCheck = createBackendUpdateCheck({
    config: { checkForUpdates: true },
    isLocalConfig: false,
    currentVersion: '0.16.0',
    checkForUpdate: async () => { checksRun += 1; return null; },
    getControlClientCount: () => 0,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });

  updateCheck.start();
  await settle();
  t.mock.timers.tick(UPDATE_RECHECK_MS);
  await settle();
  updateCheck.stop();

  assert.equal(checksRun, 1, 'only the startup check ran: nobody is listening for the result');
});

test('checkNow forces ttl zero and returns the in-flight promise', async () => {
  let release = (_status: UpdateStatus): void => { throw new Error('the check did not expose its resolver'); };
  const seenTtls: Array<number | undefined> = [];
  const updateCheck = createBackendUpdateCheck({
    config: { checkForUpdates: true, updateChannel: 'release' },
    isLocalConfig: false,
    currentVersion: '0.16.0',
    checkForUpdate: (options) => {
      seenTtls.push(options.ttlMs);
      return new Promise((resolve) => { release = resolve; });
    },
    getControlClientCount: () => 0,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });
  const first = updateCheck.checkNow();
  const second = updateCheck.checkNow();
  assert.equal(first, second);
  assert.deepEqual(seenTtls, [0]);
  release(makeUpdateStatus('0.17.0'));
  await first;
});

test('changing updateChannel clears status and triggers a forced check', async () => {
  const config: { checkForUpdates: boolean; updateChannel: 'release' | 'main' } = {
    checkForUpdates: true,
    updateChannel: 'release',
  };
  const channels: string[] = [];
  const updateCheck = createBackendUpdateCheck({
    config,
    isLocalConfig: false,
    currentVersion: '0.16.0',
    checkForUpdate: async (options) => {
      channels.push(options.updateChannel);
      return { ...makeUpdateStatus('0.17.0'), channel: options.updateChannel };
    },
    getControlClientCount: () => 0,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });
  await updateCheck.checkNow();
  config.updateChannel = 'main';
  updateCheck.applySettings();
  assert.equal(updateCheck.getStatus(), null);
  await settle();
  assert.deepEqual(channels, ['release', 'main']);
});

test('update-check delegates to the forced check lane', async () => {
  let checksRun = 0;
  const server = createControlServer(controlDeps({ projects: [] }, {
    checkNow: async () => {
      checksRun += 1;
      return makeUpdateStatus('0.17.0');
    },
  }));
  const connection = connectControl<Record<string, unknown>>(server);
  await connection.send({ type: 'update-check' });
  assert.equal(checksRun, 1);
});

test('update-apply sends a named refusal to the requesting socket', async () => {
  const server = createControlServer(controlDeps({ projects: [] }, {
    applyUpdate: async () => ({ ok: false, reason: 'dirty-worktree', message: 'Commit or stash local changes.' }),
  }));
  const connection = connectControl<Record<string, unknown>>(server);
  await connection.send({ type: 'update-apply' });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'error',
    message: '[dirty-worktree] Commit or stash local changes.',
  });
});

test('restart-server refuses while update staging is active', () => {
  let restartsRequested = 0;
  let restartNotices = 0;
  const server = createControlServer(controlDeps({ projects: [] }, {
    isStaging: () => true,
    noteRestartRequested: () => { restartNotices += 1; },
    requestRestart: () => { restartsRequested += 1; },
  }));
  const connection = connectControl<Record<string, unknown>>(server);
  connection.send({ type: 'restart-server' });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'error',
    message: '[update-staging] Wait for the update staging run to finish before restarting.',
  });
  assert.equal(restartNotices, 0);
  assert.equal(restartsRequested, 0);
});

test('restart-server records the request before scheduling restart', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const order: string[] = [];
  const server = createControlServer(controlDeps({ projects: [] }, {
    isStaging: () => false,
    noteRestartRequested: () => { order.push('notice'); },
    requestRestart: () => { order.push('restart'); },
    broadcastControl: (message) => { order.push(String(message.type)); },
  }));
  const connection = connectControl<Record<string, unknown>>(server);
  connection.send({ type: 'restart-server' });
  assert.deepEqual(order, ['notice', 'restarting']);
  t.mock.timers.tick(200);
  assert.deepEqual(order, ['notice', 'restarting', 'restart']);
});

test('a channel change queued during a check never starts another one after stop', async () => {
  const config: { checkForUpdates: boolean; updateChannel: 'release' | 'main' } = {
    checkForUpdates: true,
    updateChannel: 'release',
  };
  const channels: string[] = [];
  const broadcasts: ControlMessageRecord[] = [];
  let release = (_status: UpdateStatus): void => { throw new Error('the check did not expose its resolver'); };
  const updateCheck = createBackendUpdateCheck({
    config,
    isLocalConfig: false,
    currentVersion: '0.16.0',
    checkForUpdate: (options) => {
      channels.push(options.updateChannel);
      return new Promise((resolve) => { release = resolve; });
    },
    getControlClientCount: () => 0,
    broadcastControl: (message) => { broadcasts.push(message); },
    logger: { log: () => {} },
  });
  const first = updateCheck.checkNow();
  config.updateChannel = 'main';
  updateCheck.applySettings();
  updateCheck.stop();
  release(makeUpdateStatus('0.17.0'));
  await first;
  await settle();
  assert.deepEqual(channels, ['release'], 'the queued refresh never ran after stop');
  assert.deepEqual(broadcasts, [], 'a result arriving after stop is never recorded');
  updateCheck.applySettings();
  await settle();
  assert.deepEqual(channels, ['release'], 'a settings change after stop starts nothing');
});

const PR_STATUS = {
  type: 'pr-status',
  ts: 1000,
  projects: [{
    projectId: 'p1',
    name: 'My Repo',
    repoSlug: 'me/repo',
    lastTickAt: 1000,
    prs: [{
      key: 'me/repo#7',
      number: 7,
      title: 'Fix the thing',
      url: 'https://github.com/me/repo/pull/7',
      headSha: 'sha1',
      phase: 'awaiting-checks',
      inFlight: false,
      wasConflicting: false,
      pingedError: false,
    }],
  }],
};

test('no pr-status when getPrStatus is absent (does not throw)', () => {
  let sent: UpdateFrame[] = [];
  assert.doesNotThrow(() => { sent = connect({}); });
  assert.equal(sent.filter((m) => m.type === 'pr-status').length, 0);
});

test('no pr-status when no tick has completed yet', () => {
  const sent = connect({ getPrStatus: () => null });
  assert.equal(sent.filter((m) => m.type === 'pr-status').length, 0);
});

test('replays exactly one pr-status frame from the cached tick summary', () => {
  const sent = connect({ getPrStatus: () => PR_STATUS });
  const frames = sent.filter((m) => m.type === 'pr-status');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], PR_STATUS);
});

test('the posthog and pr lane snapshots replay independently', () => {
  const posthogStatus = { type: 'posthog-status', ts: 1000, projects: [] };
  const sent = connect({ getPosthogStatus: () => posthogStatus, getPrStatus: () => PR_STATUS });
  assert.deepEqual(sent.filter((m) => m.type === 'posthog-status'), [posthogStatus]);
  assert.deepEqual(sent.filter((m) => m.type === 'pr-status'), [PR_STATUS]);
});
