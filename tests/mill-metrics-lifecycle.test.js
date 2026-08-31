'use strict';

// The two ends a live measured session can leave through that are NOT a state transition: the operator
// removing the session from the config (no DONE, no FAILED, just a destroy) and the process shutting
// down with writes still queued. Both stranded the lane before: the first left an accumulator counting
// a delivery forever, the second dropped the records that were still in flight.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionRegistry } = require('../server/session-registry');
const { createBackendShutdown } = require('../server/backend-shutdown');

const SILENT_LOGGER = { log: () => {}, warn: () => {}, error: () => {} };

function registryWithSession(order, makeSession = null) {
  const session = {
    id: 's1',
    name: 's1',
    path: '/before',
    state: 'DORMANT',
    packNames: [],
    agentId: 'claude-code',
    bypassHookTrust: false,
    dangerouslySkipPermissions: true,
    destroy: () => order.push('destroy'),
    discardWorktree: () => {},
  };
  const sessions = new Map([['s1', session]]);
  return createSessionRegistry({
    httpServer: { listening: false, once: () => {}, off: () => {} },
    sessions,
    config: { projects: [] },
    configStore: { save: () => null },
    makeSession: makeSession || (() => session),
    wireSessionEvents: () => {},
    closeSessionDataClients: () => {},
    notificationManager: { acknowledge: () => order.push('acknowledge') },
    millMetricsPort: { onSessionTeardown: (id) => order.push(`teardown:${id}`) },
    getIngestLane: () => null,
    broadcastControl: () => {},
    applySettingsReload: () => {},
    spawnGate: { run: (callback) => Promise.resolve(callback()) },
    gitWorkspaceSync: { listSessionWorktrees: () => [], removeWorktreeByPath: () => {} },
    reconcileSessionWorktrees: () => {},
    carryWorktreeAcrossRecreate: () => {},
    ensureProjectIds: () => false,
    resolveAgentId: () => 'claude-code',
    logger: SILENT_LOGGER,
  });
}

function shutdownWithLane(millMetricsIdle, overrides = {}) {
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
  const order = [];
  const registry = registryWithSession(order);
  assert.equal(registry.teardownSession('s1', '[config] Removed session'), true);
  assert.deepEqual(order, ['acknowledge', 'teardown:s1', 'destroy']);
});

test('teardown works when no measurement lane is injected', () => {
  const order = [];
  const registry = createSessionRegistry({
    httpServer: { listening: false, once: () => {}, off: () => {} },
    sessions: new Map([['s1', { id: 's1', name: 's1', destroy: () => order.push('destroy') }]]),
    config: { projects: [] },
    configStore: { save: () => null },
    makeSession: () => null,
    wireSessionEvents: () => {},
    closeSessionDataClients: () => {},
    notificationManager: { acknowledge: () => {} },
    getIngestLane: () => null,
    broadcastControl: () => {},
    applySettingsReload: () => {},
    spawnGate: { run: (callback) => Promise.resolve(callback()) },
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
  const drains = [];
  const { stoppers } = shutdownWithLane(async () => { drains.push('idle'); })();
  const millMetrics = stoppers.find((entry) => entry.name === 'mill-metrics');
  assert.ok(millMetrics, 'shutdown must drain the mill-metrics lane');
  await millMetrics.promise;
  assert.deepEqual(drains, ['idle']);
});

test('shutdown drains the measurement lane even when no store is open right now', async () => {
  const drains = [];
  const { stoppers } = shutdownWithLane(async () => { drains.push('idle'); }, {
    millMetricsPort: null,
  })();
  const millMetrics = stoppers.find((entry) => entry.name === 'mill-metrics');
  assert.ok(millMetrics, 'the lane owns the drain, so a store-less window still registers one');
  await millMetrics.promise;
  assert.deepEqual(drains, ['idle']);
});

test('shutdown closes every live accumulator before the sessions are destroyed', async () => {
  const order = [];
  const { stoppers } = shutdownWithLane(async () => { order.push('drain'); }, {
    sessions: new Map([['s1', { destroy: () => order.push('destroy:s1') }]]),
    millMetricsPort: { onSessionTeardown: (id) => order.push(`teardown:${id}`) },
  })();
  await Promise.all(stoppers.map((entry) => entry.promise));
  assert.deepEqual(order, ['teardown:s1', 'destroy:s1', 'drain']);
});

test('a session replaced by a config edit closes its accumulator before the old session is destroyed', () => {
  const order = [];
  const registry = registryWithSession(order, () => ({
    id: 's1',
    name: 's1',
    path: '/after',
    state: 'DORMANT',
    stateSince: 0,
    destroy: () => {},
    discardWorktree: () => {},
  }));
  registry.applyConfigReload({ projects: [{ id: 's1', name: 's1', path: '/after' }] });
  assert.deepEqual(order, ['acknowledge', 'teardown:s1', 'destroy']);
});
