'use strict';

// THE BYTE-IDENTICAL GUARANTEE. A config without a remote block must behave exactly as it did before
// remote mode existed: one listener, no auth middleware, no /pair route, no pairing files on disk,
// and an upgrade path whose refusals look the same on the wire as the old bare socket.destroy().
//
// SAFETY: createBackend runs a boot worktree reconcile against the configured projects, so this
// points at a throwaway temp config with ZERO projects via GLISSA_CONFIG (memory: booting the backend
// against the real config once destroyed an active worktree). Keep projects [] in this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { createBackend } = require('../server/backend.ts');
const { dashboardClient } = require('./helpers/dashboard-ws');

let tmpDir = null;
let prevEnv = null;
let server = null;
let backend = null;
let base = null;
let boundPort = null;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-remote-off-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ projects: [], teams: [], repoRoots: [] }, null, 2), 'utf8');
  prevEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  server = http.createServer();
  backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  boundPort = server.address().port;
  base = `http://127.0.0.1:${boundPort}`;
});

test.after(async () => {
  if (backend) backend.shutdown();
  if (server) server.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (prevEnv == null) delete process.env.GLISSA_CONFIG;
  if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the backend reports remote disabled and a loopback bind host', () => {
  assert.equal(backend.remote.enabled, false);
  assert.equal(backend.remote.port, null);
  assert.equal(backend.bindHost, '127.0.0.1');
  assert.equal(typeof backend.remote.attach, 'function');
});

test('no pairing files are created next to the config when remote is off', () => {
  const stray = fs.readdirSync(tmpDir).filter((f) => f.startsWith('pairings'));
  assert.deepEqual(stray, [], 'the pairings store is never constructed while remote is disabled');
});

test('no /pair route is mounted', async () => {
  const res = await fetch(`${base}/pair/anything`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('set-cookie'), null, 'nothing ever mints a cookie');
});

test('no auth middleware intercepts ordinary requests', async () => {
  const res = await fetch(`${base}/definitely-not-a-route`);
  assert.equal(res.status, 404, 'a 401 here would mean the remote gate ran');
});

test('the hook route still answers exactly as before (404 unknown-session, not 401)', async () => {
  const res = await fetch(`${base}/hook/no-such-session/Stop`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual({ ok: body.ok, reason: body.reason }, { ok: false, reason: 'unknown-session' });
});

test('a control upgrade with no cookie connects and receives a snapshot', async () => {
  const client = await dashboardClient(boundPort);
  const ws = new WebSocket(client.url('/control'), client.options);
  const snapshot = await new Promise((resolve, reject) => {
    ws.on('message', (data) => {
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
  const { token } = await dashboardClient(boundPort);
  const ws = new WebSocket(`ws://127.0.0.1:${boundPort}/control?token=${token}`, { origin: `http://localhost:${boundPort}` });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.close();
});

test('a foreign Origin is refused by a bare socket destroy, with no HTTP status line written', async () => {
  const received = await new Promise((resolve, reject) => {
    const socket = net.connect(boundPort, '127.0.0.1', () => {
      socket.write([
        'GET /control HTTP/1.1',
        `Host: 127.0.0.1:${boundPort}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Origin: https://evil.example',
        '', '',
      ].join('\r\n'));
    });
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', () => resolve(Buffer.concat(chunks).toString()));
    setTimeout(() => { socket.destroy(); reject(new Error('socket stayed open')); }, 3000).unref();
  });
  assert.equal(received, '', 'the remote-disabled refusal writes nothing, exactly as before');
});

// A leftover publicHost in a switched-off remote block used to synthesize an allowed origin, which
// widened the LOCAL listener's WebSocket allow-list for a feature that was not running.
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
  await new Promise((resolve) => otherServer.listen(0, '127.0.0.1', resolve));
  const otherPort = otherServer.address().port;

  try {
    assert.equal(otherBackend.remote.enabled, false);
    const ws = new WebSocket(`ws://127.0.0.1:${otherPort}/control`, { origin: 'https://glissa.test' });
    const outcome = await new Promise((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('refused'));
    });
    assert.equal(outcome, 'refused', 'the configured host grants nothing while remote is disabled');
    ws.close();
  } finally {
    otherBackend.shutdown();
    otherServer.closeAllConnections();
    await new Promise((resolve) => otherServer.close(resolve));
    process.env.GLISSA_CONFIG = outerConfig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a data-terminal upgrade for an unknown session is still refused after the origin check', async () => {
  const client = await dashboardClient(boundPort);
  const ws = new WebSocket(client.url('/terminals/no-such-session'), client.options);
  const outcome = await new Promise((resolve) => {
    ws.on('open', () => resolve('open'));
    ws.on('error', () => resolve('error'));
    ws.on('close', () => resolve('close'));
  });
  // The upgrade itself is allowed (no remote gate); the session lookup is what closes it.
  assert.notEqual(outcome, 'error');
  ws.close();
});
