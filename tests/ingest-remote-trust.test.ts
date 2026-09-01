import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

import { createBackend } from '../server/backend.ts';
import { createPairingsStore } from '../server/pairings-store.ts';
import { closeSocket, dashboardClient, openRecordingSocket, waitForMessage } from './helpers/dashboard-ws.ts';
import { closeServer, listenOnLoopback, reserveFreePort } from './helpers/http-server.ts';
import { ingestLane } from './helpers/lanes.ts';

type Backend = ReturnType<typeof createBackend>;

interface ControlFrame {
  type: string;
  trust?: string;
  events?: { summary?: string }[];
}

interface PairedDeviceOptions {
  origin: string;
  headers: Record<string, string>;
}

interface RemoteSocket {
  ws: WebSocket;
  received: ControlFrame[];
}

interface BootedBackend {
  tmpDir: string;
  previousConfig: string | undefined;
  localServer: http.Server;
  remoteServer: http.Server;
  backend: Backend;
  localPort: number;
  remotePort: number;
}

const booted: { current: BootedBackend | null } = { current: null };

function live(): BootedBackend {
  if (!booted.current) throw new Error('the backend boot never completed');
  return booted.current;
}

async function pairDevice(): Promise<string> {
  const { tmpDir, remotePort } = live();
  const minted = createPairingsStore({ filePath: path.join(tmpDir, 'pairings.json') })
    .mintPending({ name: 'ingest trust test device' });
  if (!minted) throw new Error('the pairings store refused to mint a token');
  const response = await fetch(`http://127.0.0.1:${remotePort}/pair/${minted.token}`, { redirect: 'manual' });
  assert.equal(response.status, 303, 'a fresh token redeems');
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('a redeemed pairing always sets its cookie');
  return cookie.split(';')[0];
}

function openRemoteSocket(url: string, options: PairedDeviceOptions): Promise<RemoteSocket> {
  const ws = new WebSocket(url, options);
  const received: ControlFrame[] = [];
  ws.on('message', (raw: Buffer) => received.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => resolve({ ws, received }));
  });
}

const isIngestFrame = (frame: ControlFrame): boolean => frame.type.startsWith('ingest-');

test.before(async () => {
  const remotePort = await reserveFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-ingest-trust-'));
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [], teams: [], repoRoots: [],
    ingest: { enabled: true, sources: { terminal: { enabled: true } } },
    remote: { enabled: true, port: remotePort, publicHost: 'glissa.test', allowedOrigins: ['https://glissa.test'] },
  }, null, 2), 'utf8');
  const previousConfig = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;

  const localServer = http.createServer();
  const backend = createBackend(localServer, { staticDir: null });
  localServer.on('request', backend.app);
  const localPort = await listenOnLoopback(localServer);

  const remoteServer = http.createServer();
  backend.remote.attach(remoteServer);
  await listenOnLoopback(remoteServer, remotePort);

  booted.current = {
    tmpDir, previousConfig, localServer, remoteServer, backend, localPort, remotePort,
  };
});

test.after(async () => {
  const context = booted.current;
  if (!context) return;
  context.backend.shutdown();
  for (const server of [context.localServer, context.remoteServer]) {
    server.closeAllConnections();
    await closeServer(server);
  }
  if (context.previousConfig == null) delete process.env.GLISSA_CONFIG;
  if (context.previousConfig != null) process.env.GLISSA_CONFIG = context.previousConfig;
  fs.rmSync(context.tmpDir, { recursive: true, force: true });
});

test('the connect-time ingest snapshot goes to a local dashboard and not to a paired device', async () => {
  const { backend, localPort, remotePort } = live();
  const lane = ingestLane(backend);
  assert.ok(lane, 'the lane is on for this boot');
  lane.publish({ source: 'terminal', kind: 'output', summary: 'a local command ran', scope: { root: '/repo' } });

  const cookie = await pairDevice();
  const remote = await openRemoteSocket(`ws://127.0.0.1:${remotePort}/control`, {
    headers: { Cookie: cookie }, origin: 'https://glissa.test',
  });
  const localDash = await dashboardClient(localPort);
  const local = await openRecordingSocket<ControlFrame>(localDash);

  try {
    const snapshotFrame = await waitForMessage(remote.received, (frame) => frame.type === 'snapshot', 'the remote snapshot');
    assert.equal(snapshotFrame.type, 'snapshot');
    const trustFrame = await waitForMessage(remote.received, (frame) => frame.type === 'client-trust', 'the remote trust frame');
    assert.equal(trustFrame.trust, 'remote');

    const snapshot = await waitForMessage(local.received, (frame) => frame.type === 'ingest-snapshot', 'the local ingest snapshot');
    assert.deepEqual((snapshot.events ?? []).map((event) => event.summary), ['a local command ran']);

    assert.deepEqual(remote.received.filter(isIngestFrame), [], 'no ingest frame may cross the remote listener');
  } finally {
    await closeSocket(remote.ws);
    await closeSocket(local.ws);
  }
});

test('a batched activity delta reaches a local dashboard and not a paired device', async () => {
  const { backend, localPort, remotePort } = live();
  const cookie = await pairDevice();
  const remote = await openRemoteSocket(`ws://127.0.0.1:${remotePort}/control`, {
    headers: { Cookie: cookie }, origin: 'https://glissa.test',
  });
  const localDash = await dashboardClient(localPort);
  const local = await openRecordingSocket<ControlFrame>(localDash);

  try {
    await waitForMessage(remote.received, (frame) => frame.type === 'snapshot', 'the remote snapshot');
    await waitForMessage(local.received, (frame) => frame.type === 'ingest-snapshot', 'the local ingest snapshot');

    const secret = 'output only this machine should see';
    const lane = ingestLane(backend);
    assert.ok(lane, 'the lane is on for this boot');
    lane.publish({ source: 'terminal', kind: 'output', summary: secret, scope: { root: '/repo' } });

    const frame = await waitForMessage(
      local.received,
      (message) => message.type === 'ingest-activity' && (message.events ?? []).some((event) => event.summary === secret),
      'the local ingest delta',
    );
    assert.ok((frame.events ?? []).length >= 1);

    assert.deepEqual(remote.received.filter(isIngestFrame), []);
    assert.equal(JSON.stringify(remote.received).includes(secret), false, 'not one byte of it crossed');
  } finally {
    await closeSocket(remote.ws);
    await closeSocket(local.ws);
  }
});
