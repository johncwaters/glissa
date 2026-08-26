'use strict';

/*
 * The Visions switch takes effect on the save that flipped it: `server/visions-setup.js` wires the
 * editors at that moment, so a lane arriving only at the next boot would leave them mirroring into
 * nothing. Booted backend, real control WS, no PTY ever spawned.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { createBackend } = require('../server/backend');
const { dashboardClient } = require('./helpers/dashboard-ws');

const WAIT_MS = 5000;

function until(predicate, message) {
  const deadline = Date.now() + WAIT_MS;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(message));
      return setTimeout(poll, 20).unref();
    };
    poll();
  });
}

function withBackend(configExtras, fn) {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-lane-restart-'));
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      projects: [{ id: 'p1', name: 'project', path: projectDir }],
      teams: [],
      repoRoots: [],
      ...configExtras,
    }, null, 2), 'utf8');
    const previousConfigEnv = process.env.GLISSA_CONFIG;
    process.env.GLISSA_CONFIG = cfgPath;

    const server = http.createServer();
    const backend = createBackend(server, { staticDir: null });
    server.on('request', backend.app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const sockets = [];
    try {
      await fn({
        backend,
        cfgPath,
        dash: await dashboardClient(server.address().port),
        track: (ws) => { sockets.push(ws); return ws; },
      });
    } finally {
      for (const ws of sockets) ws.close();
      backend.shutdown();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (previousConfigEnv == null) delete process.env.GLISSA_CONFIG;
      if (previousConfigEnv != null) process.env.GLISSA_CONFIG = previousConfigEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

function openControl(dash, track) {
  const ws = track(new WebSocket(dash.url('/control'), dash.options));
  const received = [];
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => resolve({ received, ws }));
  });
}

function saveSettings(ws, settings) {
  ws.send(JSON.stringify({ type: 'update-settings', requestId: 'save-1', settings }));
}

test('turning Visions on builds its lane without a restart', withBackend({}, async ({ backend, dash, track }) => {
  assert.equal(backend.getVisionsLane(), null);
  assert.equal(backend.getIngestLane(), null);

  const { received, ws } = await openControl(dash, track);
  saveSettings(ws, { visions: { enabled: true, dispatch: { enabled: false } }, ingest: { enabled: true, sources: { fs: { enabled: true } } } });
  await until(() => received.some((message) => message.type === 'settings-updated'), 'no settings-updated frame');
  await until(() => backend.getVisionsLane() !== null, 'the visions lane was never built');
  await until(() => backend.getIngestLane() !== null, 'the ingest lane was never built');
  assert.equal(backend.getIngestLane().fsEnabled, true);
}));

test('turning Visions off takes its lane back down', withBackend({
  visions: { enabled: true, dispatch: { enabled: false } },
}, async ({ backend, dash, track }) => {
  assert.notEqual(backend.getVisionsLane(), null);

  const { received, ws } = await openControl(dash, track);
  saveSettings(ws, { visions: { enabled: false } });
  await until(() => received.some((message) => message.type === 'settings-updated'), 'no settings-updated frame');
  await until(() => backend.getVisionsLane() === null, 'the visions lane was never stopped');
}));

test('a boot with Visions on brings up the lanes it implies, on that same boot', withBackend({
  visions: { enabled: true },
}, async ({ backend, cfgPath }) => {
  await until(() => backend.getIngestLane() !== null, 'the implied ingest lane never came up');
  const lane = backend.getIngestLane();
  assert.equal(lane.fsEnabled, true);
  assert.equal(lane.editorEnabled, true);

  // Written to disk as well, or the dashboard would show sources off while they ran.
  const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(onDisk.ingest.enabled, true);
  assert.equal(onDisk.visions.dispatch.enabled, true);
}));

test('a save that leaves both configs alone rebuilds nothing', withBackend({
  visions: { enabled: true, dispatch: { enabled: false } },
}, async ({ backend, dash, track }) => {
  const laneBefore = backend.getVisionsLane();
  const { received, ws } = await openControl(dash, track);
  saveSettings(ws, { cursorBlink: true });
  await until(() => received.some((message) => message.type === 'settings-updated'), 'no settings-updated frame');
  assert.equal(backend.getVisionsLane(), laneBefore);
}));
