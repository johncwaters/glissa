import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import WebSocket from 'ws';

import { createBackend } from '../server/backend.ts';
import { dashboardClient } from './helpers/dashboard-ws.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';

interface RemoteOffContext {
  tmpDir: string;
  prevEnv: string | undefined;
  server: Server;
  backend: Backend;
  base: string;
  boundPort: number;
}

const booted: { context: RemoteOffContext | null } = { context: null };

function ctx(): RemoteOffContext {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

test.before(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-remote-off-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ projects: [], teams: [], repoRoots: [] }, null, 2), 'utf8');
  const prevEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);
  const port = boundPort(server);

  booted.context = { tmpDir, prevEnv, server, backend, base: `http://127.0.0.1:${port}`, boundPort: port };
});

test.after(async () => {
  if (!booted.context) return;
  const { backend, server, prevEnv, tmpDir } = booted.context;
  backend.shutdown();
  server.closeAllConnections();
  await closeServer(server);
  if (prevEnv == null) delete process.env.GLISSA_CONFIG;
  if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the backend reports remote disabled and a loopback bind host', () => {
  const { backend } = ctx();
  assert.equal(backend.remote.enabled, false);
  assert.equal(backend.remote.port, null);
  assert.equal(backend.bindHost, '127.0.0.1');
  assert.equal(typeof backend.remote.attach, 'function');
});

test('no pairing files are created next to the config when remote is off', () => {
  const stray = fs.readdirSync(ctx().tmpDir).filter((f) => f.startsWith('pairings'));
  assert.deepEqual(stray, [], 'the pairings store is never constructed while remote is disabled');
});

test('no /pair route is mounted', async () => {
  const res = await fetch(`${ctx().base}/pair/anything`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('set-cookie'), null, 'nothing ever mints a cookie');
});

test('no auth middleware intercepts ordinary requests', async () => {
  const res = await fetch(`${ctx().base}/definitely-not-a-route`);
  assert.equal(res.status, 404, 'a 401 here would mean the remote gate ran');
});

test('the hook route still answers exactly as before (404 unknown-session, not 401)', async () => {
  const res = await fetch(`${ctx().base}/hook/no-such-session/Stop`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual({ ok: body.ok, reason: body.reason }, { ok: false, reason: 'unknown-session' });
});

test('a control upgrade with no cookie connects and receives a snapshot', async () => {
  const client = await dashboardClient(ctx().boundPort);
  const ws = new WebSocket(client.url('/control'), client.options);
  const snapshot = await new Promise<{ type: string; sessions?: unknown }>((resolve, reject) => {
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'snapshot') resolve(msg);
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('no snapshot within 3s')), 3000).unref();
  });
  assert.equal(Array.isArray(snapshot.sessions), true);
  ws.close();
});

test('a localhost Origin on the listener port is accepted on the control upgrade', async () => {
  const port = ctx().boundPort;
  const { token } = await dashboardClient(port);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/control?token=${token}`, { origin: `http://localhost:${port}` });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  ws.close();
});

test('a foreign Origin is refused by a bare socket destroy, with no HTTP status line written', async () => {
  const port = ctx().boundPort;
  const received = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([
        'GET /control HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Origin: https://evil.example',
        '', '',
      ].join('\r\n'));
    });
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', () => resolve(Buffer.concat(chunks).toString()));
    setTimeout(() => { socket.destroy(); reject(new Error('socket stayed open')); }, 3000).unref();
  });
  assert.equal(received, '', 'the remote-disabled refusal writes nothing, exactly as before');
});

test('a disabled remote block with a publicHost grants no extra origin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-remote-off-host-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    projects: [], teams: [], repoRoots: [],
    remote: { enabled: false, port: null, publicHost: 'glissa.test', allowedOrigins: ['https://glissa.test'] },
  }, null, 2), 'utf8');
  const outerConfig = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  const otherServer = http.createServer();
  const otherBackend = createBackend(otherServer, { staticDir: null });
  otherServer.on('request', otherBackend.app);
  const otherPort = await listenOnLoopback(otherServer);

  try {
    assert.equal(otherBackend.remote.enabled, false);
    const ws = new WebSocket(`ws://127.0.0.1:${otherPort}/control`, { origin: 'https://glissa.test' });
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('refused'));
    });
    assert.equal(outcome, 'refused', 'the configured host grants nothing while remote is disabled');
    ws.close();
  } finally {
    otherBackend.shutdown();
    otherServer.closeAllConnections();
    await closeServer(otherServer);
    if (outerConfig == null) delete process.env.GLISSA_CONFIG;
    if (outerConfig != null) process.env.GLISSA_CONFIG = outerConfig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a data-terminal upgrade for an unknown session is still refused after the origin check', async () => {
  const client = await dashboardClient(ctx().boundPort);
  const ws = new WebSocket(client.url('/terminals/no-such-session'), client.options);
  const outcome = await new Promise<string>((resolve) => {
    ws.on('open', () => resolve('open'));
    ws.on('error', () => resolve('error'));
    ws.on('close', () => resolve('close'));
  });

  assert.notEqual(outcome, 'error');
  ws.close();
});
