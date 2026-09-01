'use strict';

// Connect-time replay of a cached startup update-check result. A control client connecting AFTER the
// check resolved must receive one 'update-available' frame; the accessor is guarded so the four existing
// control-WS tests (which register handlers WITHOUT getUpdateStatus) never throw on connection. The
// same cached-snapshot replay covers the two background lanes (posthog-status, pr-status).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { createBackend } = require('../server/backend.ts');
const { dashboardClient } = require('./helpers/dashboard-ws');
const { registerControlHandlers } = require('../server/control-handlers.ts');

function connect(deps) {
  const controlWss = new EventEmitter();
  const sent = [];
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: () => {} };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: { projects: [], teams: [] },
    configStore: { save: (fn) => fn({ projects: [], teams: [] }), getSettings: () => ({}) },
    applyConfigReload: () => {},
    broadcastControl: () => {},
    ...deps,
  });
  controlWss.emit('connection', ws);
  return sent;
}

test('no update-available when getUpdateStatus is absent (does not throw)', () => {
  let sent;
  assert.doesNotThrow(() => { sent = connect({}); });
  assert.equal(sent.filter((m) => m.type === 'update-available').length, 0);
});

test('no update-available when getUpdateStatus reports no update', () => {
  const sent = connect({ getUpdateStatus: () => ({ updateAvailable: false }) });
  assert.equal(sent.filter((m) => m.type === 'update-available').length, 0);
});

test('replays exactly one update-available frame when an update is cached', () => {
  const status = {
    updateAvailable: true,
    current: '0.16.0',
    latest: '0.17.0',
    currentSha: '0123456789abcdef0123456789abcdef01234567',
    latestSha: 'fedcba9876543210fedcba9876543210fedcba98',
    releaseUrl: 'https://github.com/johncwaters/glissa/releases/tag/v0.17.0',
    command: 'npm install -g github:johncwaters/glissa#v0.17.0 --allow-git=root',
    flavor: 'npm-global',
  };
  const sent = connect({ getUpdateStatus: () => status });
  const updates = sent.filter((m) => m.type === 'update-available');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { type: 'update-available', ...status });
});

function makeUpdateStatus(latest) {
  return {
    updateAvailable: true,
    current: '0.16.0',
    latest,
    currentSha: '0123456789abcdef0123456789abcdef01234567',
    latestSha: 'fedcba9876543210fedcba9876543210fedcba98',
    releaseUrl: `https://github.com/johncwaters/glissa/releases/tag/v${latest}`,
    command: `npm install -g github:johncwaters/glissa#v${latest} --allow-git=root`,
    flavor: 'npm-global',
  };
}

function makeTempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-backend-update-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 0,
    projects: [],
    teams: [],
    checkForUpdates: true,
    autoResume: false,
    packsAutoRebuild: false,
    packDistiller: { enabled: false },
    usage: { enabled: false },
  }), 'utf8');
  return configPath;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function waitForOpen(ws) {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(label)), 500);
    }),
  ]);
}

function waitForUpdate(messages, ws, predicate = (message) => message.type === 'update-available') {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    ws.on('message', function onMessage(raw) {
      const message = JSON.parse(raw);
      messages.push(message);
      if (!predicate(message)) return;
      ws.off('message', onMessage);
      resolve(message);
    });
  });
}

test('surfaceUpdate broadcasts once for a version and again for a newer version', async () => {
  const originalConfig = process.env.GLISSA_CONFIG;
  const originalSetInterval = global.setInterval;
  const originalConsoleLog = console.log;
  const server = http.createServer();
  const firstCheck = deferred();
  const secondCheck = deferred();
  const thirdCheck = deferred();
  const pendingChecks = [firstCheck, secondCheck, thirdCheck];
  const messages = [];
  let updateRecheck = null;
  let backend = null;
  let ws = null;

  const tempConfigPath = makeTempConfig();
  process.env.GLISSA_CONFIG = tempConfigPath;
  console.log = () => {};
  global.setInterval = (fn, ms, ...args) => {
    if (ms === 24 * 60 * 60 * 1000) {
      updateRecheck = () => fn(...args);
    }
    return { unref: () => {} };
  };

  try {
    backend = createBackend(server, {
      staticDir: null,
      checkForUpdate: () => pendingChecks.shift().promise,
    });
    server.on('request', backend.app);
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const dash = await dashboardClient(server.address().port);
    ws = new WebSocket(dash.url('/control'), dash.options);
    await withTimeout(waitForOpen(ws), 'control socket did not open');

    firstCheck.resolve(makeUpdateStatus('0.17.0'));
    await withTimeout(waitForUpdate(messages, ws), 'first update did not broadcast');

    updateRecheck();
    secondCheck.resolve(makeUpdateStatus('0.17.0'));
    updateRecheck();
    thirdCheck.resolve(makeUpdateStatus('0.18.0'));
    await withTimeout(
      waitForUpdate(messages, ws, (message) => message.type === 'update-available' && message.latest === '0.18.0'),
      'newer update did not broadcast',
    );
    assert.deepEqual(
      messages.filter((message) => message.type === 'update-available').map((message) => message.latest),
      ['0.17.0', '0.18.0'],
    );
  } finally {
    if (ws) ws.close();
    if (backend) backend.shutdown();
    await new Promise((resolve) => { server.close(resolve); });
    global.setInterval = originalSetInterval;
    console.log = originalConsoleLog;
    fs.rmSync(path.dirname(tempConfigPath), { recursive: true, force: true });
    if (originalConfig === undefined) {
      delete process.env.GLISSA_CONFIG;
    }
    if (originalConfig !== undefined) process.env.GLISSA_CONFIG = originalConfig;
  }
});

// --- Connect-time replay of the cached lane snapshots (PostHog, PR auto-review) ---

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
  let sent;
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
