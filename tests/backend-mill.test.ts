
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type WebSocket from 'ws';

import { createBackend } from '../server/backend.ts';
import { closeSocket, dashboardClient, openRecordingSocket, waitForMessage } from './helpers/dashboard-ws.ts';
import type { DashboardClient } from './helpers/dashboard-ws.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

const SESSION_ID = 'd0000000-0000-4000-8000-000000000001';
const VERSION = 'f'.repeat(64);

interface MillPack {
  name: string;
  measurement: Record<string, unknown> | null;
  specValid: boolean;
  built: { version: string; budgetPct: number } | null;
  specErrors: string[];
  consumers: { projects: string[] };
  hasConsumers: boolean;
}

interface MillTotals {
  packCount: number;
  builtCount: number;
  invalidSpecs: number;
  unconsumed: number;
}

type ControlFrame =
  | {
    type: 'mill-report';
    requestId: string | null;
    ts: number;
    error: string | null;
    totals: MillTotals;
    packs: MillPack[];
    projects: { id: string; name: string; packs: string[] }[];
    maxPacksPerProject: number;
    configWarnings: string[];
  }
  | { type: 'state-change'; to: string }
  | { type: 'snapshot' };

type MillReport = Extract<ControlFrame, { type: 'mill-report' }>;

const isMillReport = (m: ControlFrame): m is MillReport => m.type === 'mill-report';

function writePackFixture(root: string) {
  const specsDir = path.join(root, 'packs', 'specs');
  const sourcesDir = path.join(root, 'packs', 'sources', 'good');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.mkdirSync(sourcesDir, { recursive: true });
  fs.writeFileSync(path.join(sourcesDir, 'notes.md'), '# notes\n', 'utf8');
  fs.writeFileSync(path.join(specsDir, 'good.pack.json'), JSON.stringify({
    name: 'good',
    description: 'A pack that builds',
    sources: [{ path: 'sources/good' }],
    budgetTokens: 8000,
  }), 'utf8');
  fs.writeFileSync(path.join(specsDir, 'broken.pack.json'), '{ not json', 'utf8');

  const builtRoot = path.join(root, 'built');
  const currentDir = path.join(builtRoot, 'good', 'current');
  fs.mkdirSync(currentDir, { recursive: true });
  fs.writeFileSync(path.join(currentDir, 'manifest.json'), JSON.stringify({
    name: 'good',
    description: 'A pack that builds',
    version: VERSION,
    builtAt: '2026-08-20T10:00:00.000Z',
    tokenEstimate: 4000,
    budgetTokens: 8000,
    indexTokenEstimate: 200,
    rules: [],
    sources: [{ pattern: 'sources/good', files: [{ relPath: 'sources/good/notes.md' }] }],
    skills: [],
    outputs: [{ relPath: 'CLAUDE.md', tokenEstimate: 200 }],
  }), 'utf8');

  return { specsDir, builtRoot, baseDir: path.join(root, 'packs') };
}

const BUILD_LOG: string[] = [];

function fakePackService() {
  return {
    listSpecs: async () => [{ name: 'good', specPath: '/specs/good.pack.json' }],
    loadSpec: async () => ({ name: 'good', sources: [], skills: [] }),
    watchRootsForSpec: async () => [],
    build: async ({ name }: { name: string }) => {
      BUILD_LOG.push(name);
      return { ok: true, name, version: 'v-good-1', unchanged: false, errors: [] };
    },
    createWatcher: () => ({ watch: () => false, stop: () => {} }),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  };
}

const OPEN_SOCKETS: WebSocket[] = [];

interface MillHarness {
  dash: DashboardClient;
  cfgPath: string;
}

function withBackend(
  fn: (harness: MillHarness) => Promise<void>,
  { millEnabled = false, packServiceOptions, measurement }: {
    millEnabled?: boolean;
    packServiceOptions?: ReturnType<typeof fakePackService>;
    measurement?: () => Record<string, unknown>;
  } = {},
) {
  return async () => {
    BUILD_LOG.length = 0;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-mill-'));
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);
    const fixture = writePackFixture(tmpDir);

    const project: Record<string, unknown> = { id: SESSION_ID, name: 'mill probe', path: projectDir };
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      projects: [project],
      teams: [],
      repoRoots: [],
      checkForUpdates: false,
      usage: { enabled: false },
      millEnabled,
    }, null, 2), 'utf8');
    const prevEnv = process.env.GLISSA_CONFIG;
    process.env.GLISSA_CONFIG = cfgPath;

    const server = http.createServer();
    const backend = createBackend(server, {
      staticDir: null,
      millWiringOptions: {
        specsDir: fixture.specsDir,
        builtRoot: fixture.builtRoot,
        baseDir: fixture.baseDir,
        ...(measurement ? { measurement } : {}),
      },
      ...(packServiceOptions ? { packServiceOptions } : {}),
    });
    server.on('request', backend.app);
    await listenOnLoopback(server);

    try {
      const dash = await dashboardClient(boundPort(server));
      await fn({ dash, cfgPath });
    } finally {
      for (const socket of OPEN_SOCKETS.splice(0)) socket.terminate();
      backend.shutdown();
      server.closeAllConnections();
      await closeServer(server);
      if (prevEnv == null) delete process.env.GLISSA_CONFIG;
      if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

async function openControl(dash: DashboardClient) {
  const socket = await openRecordingSocket<ControlFrame>(dash, '/control');
  OPEN_SOCKETS.push(socket.ws);
  return socket;
}

function packNamed(report: MillReport, name: string): MillPack {
  const found = report.packs.find((pack) => pack.name === name);
  assert.ok(found, `the report describes the "${name}" pack`);
  return found;
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(() => resolve(), ms); });
}

test('request-mill-report replies to the requesting socket only, with both specs described', withBackend(async ({ dash }) => {
  const asker = await openControl(dash);
  const bystander = await openControl(dash);
  bystander.received.length = 0;

  asker.ws.send(JSON.stringify({ type: 'request-mill-report', requestId: 'm1' }));
  const report = await waitForMessage(asker.received, isMillReport, 'mill-report');

  assert.equal(report.requestId, 'm1');
  assert.equal(report.error, null);
  assert.equal(typeof report.ts, 'number');
  assert.equal(report.totals.packCount, 2);
  assert.equal(report.totals.builtCount, 1);
  assert.equal(report.totals.invalidSpecs, 1);

  const good = packNamed(report, 'good');
  assert.equal(good.specValid, true);
  assert.equal(good.built?.version, VERSION);
  assert.equal(good.built?.budgetPct, 50);
  assert.deepEqual(good.consumers.projects, ['mill probe']);

  const broken = packNamed(report, 'broken');
  assert.equal(broken.specValid, false);
  assert.equal(broken.built, null);
  assert.ok(broken.specErrors[0].startsWith('could not read spec:'));

  await settle(200);
  assert.equal(bystander.received.filter(isMillReport).length, 0, 'a pull is not a broadcast');

  await closeSocket(asker.ws);
  await closeSocket(bystander.ws);
}, { millEnabled: true, packServiceOptions: fakePackService() }));

test('the backend report carries the measurement lane scorecard', withBackend(async ({ dash }) => {
  const asker = await openControl(dash);
  asker.ws.send(JSON.stringify({ type: 'request-mill-report', requestId: 'measured' }));
  const report = await waitForMessage(asker.received, isMillReport, 'mill-report');
  assert.deepEqual(packNamed(report, 'good').measurement, {
    deliveries: 3,
    measurableDeliveries: 2,
    openRate: 0.5,
  });
  await closeSocket(asker.ws);
}, {
  measurement: () => ({
    good: { deliveries: 3, measurableDeliveries: 2, openRate: 0.5 },
  }),
}));

test('the last report is replayed to a client that connects after it was built', withBackend(async ({ dash }) => {
  const first = await openControl(dash);
  first.ws.send(JSON.stringify({ type: 'request-mill-report', requestId: 'm1' }));
  await waitForMessage(first.received, isMillReport, 'the first mill-report');

  const later = await openControl(dash);
  const replayed = await waitForMessage(later.received, isMillReport, 'the connect replay');
  assert.equal(replayed.requestId, null, 'a replay answers no request');
  assert.equal(replayed.totals.packCount, 2);

  await closeSocket(first.ws);
  await closeSocket(later.ws);
}));

test('a control client with no prior request gets no mill report until it asks', withBackend(async ({ dash }) => {
  const client = await openControl(dash);
  await settle(200);
  assert.equal(client.received.filter(isMillReport).length, 0);
  await closeSocket(client.ws);
}));

test('the report lists every configured project as a consumer of every spec on disk', withBackend(async ({ dash }) => {
  const asker = await openControl(dash);
  asker.ws.send(JSON.stringify({ type: 'request-mill-report', requestId: 'm1' }));
  const report = await waitForMessage(asker.received, isMillReport, 'mill-report');

  assert.deepEqual(report.projects, [{ id: SESSION_ID, name: 'mill probe', packs: ['broken', 'good'] }]);
  assert.equal(packNamed(report, 'broken').hasConsumers, true);
  assert.equal(packNamed(report, 'good').hasConsumers, true);
  assert.equal(report.totals.unconsumed, 0);

  await closeSocket(asker.ws);
}, { millEnabled: true, packServiceOptions: fakePackService() }));

test('with the mill on, every spec builds at boot without any per-project assignment', withBackend(async () => {
  await settle(200);
  assert.ok(BUILD_LOG.includes('good'), `expected a boot build of "good", got ${JSON.stringify(BUILD_LOG)}`);
}, { millEnabled: true, packServiceOptions: fakePackService() }));

test('with the mill off, nothing builds at boot', withBackend(async () => {
  await settle(200);
  assert.deepEqual(BUILD_LOG, []);
}, { millEnabled: false, packServiceOptions: fakePackService() }));
