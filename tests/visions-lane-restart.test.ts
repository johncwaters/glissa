/*
 * The Visions switch takes effect on the save that flipped it: `server/visions-setup.ts` wires the
 * editors at that moment, so a lane arriving only at the next boot would leave them mirroring into
 * nothing. Booted backend, real control WS, no PTY ever spawned.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type WebSocket from 'ws';

import { createBackend } from '../server/backend.ts';
import { dashboardClient, openRecordingSocket, waitForMessage } from './helpers/dashboard-ws.ts';
import type { DashboardClient } from './helpers/dashboard-ws.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { ingestLane, visionsLane } from './helpers/lanes.ts';
import type { Backend } from './helpers/lanes.ts';

const WAIT_MS = 5000;

interface ControlFrame {
  type: string;
}

interface LaneScope {
  backend: Backend;
  cfgPath: string;
  dash: DashboardClient;
}

function until(predicate: () => boolean, message: string): Promise<void> {
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

function withBackend(configExtras: Record<string, unknown>, fn: (scope: LaneScope) => Promise<void>) {
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
    await listenOnLoopback(server);
    try {
      await fn({ backend, cfgPath, dash: await dashboardClient(boundPort(server)) });
    } finally {
      backend.shutdown();
      server.closeAllConnections();
      await closeServer(server);
      if (previousConfigEnv == null) delete process.env.GLISSA_CONFIG;
      if (previousConfigEnv != null) process.env.GLISSA_CONFIG = previousConfigEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

function saveSettings(ws: WebSocket, settings: Record<string, unknown>): void {
  ws.send(JSON.stringify({ type: 'update-settings', requestId: 'save-1', settings }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// A dotted read into parsed config JSON, so an assertion states the path it means rather than
// narrowing one level at a time.
function readConfigValue(filePath: string, dottedPath: string): unknown {
  let cursor: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  for (const key of dottedPath.split('.')) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

test('turning Visions on builds its lane without a restart', withBackend({}, async ({ backend, dash }) => {
  assert.equal(visionsLane(backend), null);
  assert.equal(ingestLane(backend), null);

  const { received, ws } = await openRecordingSocket<ControlFrame>(dash);
  saveSettings(ws, { visions: { enabled: true, dispatch: { enabled: false } }, ingest: { enabled: true, sources: { fs: { enabled: true } } } });
  await waitForMessage(received, (frame) => frame.type === 'settings-updated', 'settings-updated');
  await until(() => visionsLane(backend) !== null, 'the visions lane was never built');
  await until(() => ingestLane(backend) !== null, 'the ingest lane was never built');
  assert.equal(ingestLane(backend)?.fsEnabled, true);
  ws.close();
}));

test('turning Visions off takes its lane back down', withBackend({
  visions: { enabled: true, dispatch: { enabled: false } },
}, async ({ backend, dash }) => {
  assert.notEqual(visionsLane(backend), null);

  const { received, ws } = await openRecordingSocket<ControlFrame>(dash);
  saveSettings(ws, { visions: { enabled: false } });
  await waitForMessage(received, (frame) => frame.type === 'settings-updated', 'settings-updated');
  await until(() => visionsLane(backend) === null, 'the visions lane was never stopped');
  ws.close();
}));

test('a boot with Visions on brings up the lanes it implies, on that same boot', withBackend({
  visions: { enabled: true },
}, async ({ backend, cfgPath }) => {
  await until(() => ingestLane(backend) !== null, 'the implied ingest lane never came up');
  const lane = ingestLane(backend);
  assert.equal(lane?.fsEnabled, true);
  assert.equal(lane?.editorEnabled, true);

  // Written to disk as well, or the dashboard would show sources off while they ran.
  assert.equal(readConfigValue(cfgPath, 'ingest.enabled'), true);
  assert.equal(readConfigValue(cfgPath, 'visions.dispatch.enabled'), true);
}));

test('a save that leaves both configs alone rebuilds nothing', withBackend({
  visions: { enabled: true, dispatch: { enabled: false } },
}, async ({ backend, dash }) => {
  const laneBefore = visionsLane(backend);
  const { received, ws } = await openRecordingSocket<ControlFrame>(dash);
  saveSettings(ws, { cursorBlink: true });
  await waitForMessage(received, (frame) => frame.type === 'settings-updated', 'settings-updated');
  assert.equal(visionsLane(backend), laneBefore);
  ws.close();
}));
