import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createSessionRegistry } from '../server/session-registry.ts';
import type { BackendShutdownDependencies } from '../server/backend-shutdown.ts';
import { createBackendShutdown } from '../server/backend-shutdown.ts';
import { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';

const SILENT_LOGGER = { log: () => {}, warn: () => {}, error: () => {} };

function sessionNamed(id: string, sessionPath: string, onDestroy: () => void): Session {
  const session = new Session({ id, name: id, path: sessionPath, ptySpawn: () => fakePty() });
  session.destroy = () => { onDestroy(); };
  session.discardWorktree = async () => {};
  return session;
}

function registryWithSession(order: string[], makeSession: (() => Session) | null = null) {
  const session = sessionNamed('s1', '/before', () => { order.push('destroy'); });
  const sessions = new Map([['s1', session]]);
  return createSessionRegistry({
    httpServer: http.createServer(),
    sessions,
    config: { projects: [] },
    configStore: { save: () => null },
    makeSession: makeSession ? () => makeSession() : () => session,
    wireSessionEvents: () => {},
    closeSessionDataClients: () => {},
    notificationManager: { acknowledge: () => { order.push('acknowledge'); } },
    millMetricsPort: { onSessionTeardown: (id: string) => { order.push(`teardown:${id}`); } },
    getIngestLane: () => null,
    broadcastControl: () => {},
    applySettingsReload: () => {},
    spawnGate: { run: (callback: () => unknown) => Promise.resolve(callback()) },
    gitWorkspaceSync: { listSessionWorktrees: () => [], removeWorktreeByPath: () => {} },
    reconcileSessionWorktrees: () => {},
    carryWorktreeAcrossRecreate: () => {},
    ensureProjectIds: () => false,
    resolveAgentId: () => 'claude-code',
    logger: SILENT_LOGGER,
  });
}

function shutdownWithLane(millMetricsIdle: () => Promise<void>, overrides: Partial<BackendShutdownDependencies> = {}) {
  return createBackendShutdown({
    cancelAutoResume: () => {},
    healthInterval: setTimeout(() => {}, 0),
    getStopConfigWatch: () => null,
    remoteAuth: null,
    stopUpdateCheck: () => {},
    notificationManager: { destroy: () => {} },
    telegramChannel: { destroy: () => {} },
    sessions: new Map(),
    reviewSessions: new Map(),
    investigationSessions: new Map(),
    distillSessions: new Map(),
    visionsSessions: new Map(),
    memoryDistillSessions: new Map(),
    branchGc: { stop: () => {} },
    prReview: { stopPoller: () => {} },
    posthog: { stopPoller: () => {} },
    packService: { stop: () => {} },
    usage: { stop: () => {} },
    packDistiller: { stop: () => {} },
    getIngestLane: () => null,
    getVisionsLane: () => null,
    memoryIngest: null,
    memoryDistiller: null,
    memoryStore: null,
    millMetricsIdle,
    telegramOutbox: { idle: () => {} },
    heartbeat: { stop: () => {} },
    controlWss: { close: () => {} },
    dataWss: { close: () => {} },
    ...overrides,
  });
}

test('a session removed from the config tells the measurement lane before it is destroyed', () => {
  const order: string[] = [];
  const registry = registryWithSession(order);
  assert.equal(registry.teardownSession('s1', '[config] Removed session'), true);
  assert.deepEqual(order, ['acknowledge', 'teardown:s1', 'destroy']);
});

test('teardown works when no measurement lane is injected', () => {
  const order: string[] = [];
  const laneless = sessionNamed('s1', '/before', () => { order.push('destroy'); });
  const registry = createSessionRegistry({
    httpServer: http.createServer(),
    sessions: new Map([['s1', laneless]]),
    config: { projects: [] },
    configStore: { save: () => null },
    makeSession: () => laneless,
    wireSessionEvents: () => {},
    closeSessionDataClients: () => {},
    notificationManager: { acknowledge: () => {} },
    getIngestLane: () => null,
    broadcastControl: () => {},
    applySettingsReload: () => {},
    spawnGate: { run: (callback: () => unknown) => Promise.resolve(callback()) },
    gitWorkspaceSync: { listSessionWorktrees: () => [], removeWorktreeByPath: () => {} },
    reconcileSessionWorktrees: () => {},
    carryWorktreeAcrossRecreate: () => {},
    ensureProjectIds: () => false,
    resolveAgentId: () => 'claude-code',
    logger: SILENT_LOGGER,
  });
  assert.equal(registry.teardownSession('s1', '[config] Removed session'), true);
  assert.deepEqual(order, ['destroy']);
});

test('shutdown waits on queued measurement writes', async () => {
  const drains: string[] = [];
  const { stoppers } = shutdownWithLane(async () => { drains.push('idle'); })();
  const millMetrics = stoppers.find((entry) => entry.name === 'mill-metrics');
  assert.ok(millMetrics, 'shutdown must drain the mill-metrics lane');
  await millMetrics.promise;
  assert.deepEqual(drains, ['idle']);
});

test('shutdown drains the measurement lane even when no store is open right now', async () => {
  const drains: string[] = [];
  const { stoppers } = shutdownWithLane(async () => { drains.push('idle'); }, {
    millMetricsPort: null,
  })();
  const millMetrics = stoppers.find((entry) => entry.name === 'mill-metrics');
  assert.ok(millMetrics, 'the lane owns the drain, so a store-less window still registers one');
  await millMetrics.promise;
  assert.deepEqual(drains, ['idle']);
});

test('shutdown closes every live accumulator before the sessions are destroyed', async () => {
  const order: string[] = [];
  const { stoppers } = shutdownWithLane(async () => { order.push('drain'); }, {
    sessions: new Map([['s1', { destroy: () => { order.push('destroy:s1'); } }]]),
    millMetricsPort: { onSessionTeardown: (id: string) => { order.push(`teardown:${id}`); } },
  })();
  await Promise.all(stoppers.map((entry) => entry.promise));
  assert.deepEqual(order, ['teardown:s1', 'destroy:s1', 'drain']);
});

test('a session replaced by a config edit closes its accumulator before the old session is destroyed', () => {
  const order: string[] = [];
  const registry = registryWithSession(order, () => sessionNamed('s1', '/after', () => {}));
  registry.applyConfigReload({ projects: [{ id: 's1', name: 's1', path: '/after' }] });
  assert.deepEqual(order, ['acknowledge', 'teardown:s1', 'destroy']);
});
