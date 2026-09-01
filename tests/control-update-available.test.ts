import test from 'node:test';
import assert from 'node:assert/strict';

import { createBackendUpdateCheck } from '../server/backend-update.ts';
import type { UpdateStatus } from '../server/backend-update.ts';
import { decideUpdateStatus } from '../server/core/update-core.ts';
import type { ControlHandlerDeps } from '../server/control-handlers.ts';
import type { ControlMessageRecord } from '../server/control-replay-core.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

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
  return decideUpdateStatus({
    currentVersion: '0.16.0',
    latestVersion: latest,
    installedSha: '0123456789abcdef0123456789abcdef01234567',
    latestSha: 'fedcba9876543210fedcba9876543210fedcba98',
    flavor: 'npm-global',
  });
}

test('no update-available when getUpdateStatus is absent (does not throw)', () => {
  let sent: UpdateFrame[] = [];
  assert.doesNotThrow(() => { sent = connect({}); });
  assert.equal(sent.filter((m) => m.type === 'update-available').length, 0);
});

test('no update-available when getUpdateStatus reports no update', () => {
  const sent = connect({ getUpdateStatus: () => ({ updateAvailable: false }) });
  assert.equal(sent.filter((m) => m.type === 'update-available').length, 0);
});

test('replays exactly one update-available frame when an update is cached', () => {
  const status = makeUpdateStatus('0.17.0');
  const sent = connect({ getUpdateStatus: () => status });
  const updates = sent.filter((m) => m.type === 'update-available');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { type: 'update-available', ...status });
});

test('surfaceUpdate broadcasts once for a version and again for a newer version', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const broadcasts: ControlMessageRecord[] = [];
  const results = [makeUpdateStatus('0.17.0'), makeUpdateStatus('0.17.0'), makeUpdateStatus('0.18.0')];
  let checksRun = 0;
  const updateCheck = createBackendUpdateCheck({
    config: { checkForUpdates: true },
    isLocalConfig: false,
    currentVersion: '0.16.0',
    checkForUpdate: async () => results[checksRun++] ?? null,
    getControlClientCount: () => 1,
    broadcastControl: (message) => { broadcasts.push(message); },
    logger: { log: () => {} },
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
    broadcasts.filter((message) => message.type === 'update-available').map((message) => message.latest),
    ['0.17.0', '0.18.0'],
    'the repeat of a version already surfaced is not rebroadcast',
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
