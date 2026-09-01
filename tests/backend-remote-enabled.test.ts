// The remote listener as actually wired: same Express app, different trust. Covers the things only a
// live two-listener boot can show - the pair route existing, an unpaired 401, the hook ingress being
// refused remotely, and an upgrade for a path Glissa does not own being closed rather than stranded.
//
// SAFETY: temp config with ZERO projects via GLISSA_CONFIG, like every other backend boot test (the
// boot worktree reconcile would otherwise touch real repos).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket from 'ws';

import { createBackend } from '../server/backend.ts';
import { createPairingsStore } from '../server/pairings-store.ts';
import { boundPort, closeServer, listenOnLoopback, reserveFreePort } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';

interface RemoteOnContext {
  tmpDir: string;
  prevEnv: string | undefined;
  localServer: Server;
  remoteServer: Server;
  backend: Backend;
  localPort: number;
  remotePort: number;
}

const booted: { context: RemoteOnContext | null } = { context: null };

function ctx(): RemoteOnContext {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

function upgradeRequestLines(port: number, requestPath: string, extraHeaders: string[]): string {
  return [
    `GET ${requestPath} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    ...extraHeaders,
    '', '',
  ].join('\r\n');
}

function rawUpgrade(port: number, requestPath: string, extraHeaders: string[] = []): Promise<{ closed: boolean; body: string }> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(upgradeRequestLines(port, requestPath, extraHeaders));
    });
    const chunks: Buffer[] = [];
    const finish = () => resolve({ closed: socket.destroyed, body: Buffer.concat(chunks).toString() });
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('close', finish);
    socket.on('error', finish);
    setTimeout(() => { socket.destroy(); finish(); }, 2000).unref();
  });
}

/**
 * Asks the SERVER what it did with a socket, rather than inferring it from the client side. A second
 * 'upgrade' listener runs right after the backend's (listeners fire in registration order), so
 * socket.destroyed tells us whether the backend closed the socket or left it for another listener.
 * Reading the answer this way is also what keeps the test from stranding the very socket it is
 * asserting about: an upgraded socket is detached from the server, so closeAllConnections() would
 * never reap it and the leaked handle would hang the whole test process.
 */
function backendDestroyedUpgrade(server: Server, port: number, requestPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no upgrade event for ${requestPath}`)), 5000);
    const probe: { client: net.Socket | null } = { client: null };
    server.once('upgrade', (_req: IncomingMessage, socket: Duplex) => {
      clearTimeout(timer);
      const destroyedByBackend = socket.destroyed;
      socket.destroy();
      if (probe.client) probe.client.destroy();
      resolve(destroyedByBackend);
    });
    const client = net.connect(port, '127.0.0.1', () => {
      client.write(upgradeRequestLines(port, requestPath, []));
    });
    probe.client = client;
    client.on('error', () => { /* the server end closing is the expected outcome */ });
  });
}

/**
 * Mints a pairing token the way `glissa pair` does (a second store instance over the same temp
 * pairings.json - redeem re-reads the file under its lock) and redeems it over HTTP, returning the
 * device cookie the browser would then send.
 */
async function pairDevice(): Promise<string> {
  const { tmpDir, remotePort } = ctx();
  const minted = createPairingsStore({ filePath: path.join(tmpDir, 'pairings.json') })
    .mintPending({ name: 'reconnect test device' });
  assert.ok(minted, 'the store minted a pending pairing');
  const res = await fetch(`http://127.0.0.1:${remotePort}/pair/${minted.token}`, { redirect: 'manual' });
  assert.equal(res.status, 303, 'a fresh token redeems');
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'the redeem response mints a device cookie');
  return setCookie.split(';')[0];
}

test.before(async () => {
  const remotePort = await reserveFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-remote-on-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    projects: [], teams: [], repoRoots: [],
    remote: { enabled: true, port: remotePort, publicHost: 'glissa.test', allowedOrigins: ['https://glissa.test'] },
  }, null, 2), 'utf8');
  const prevEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  const localServer = http.createServer();
  const backend = createBackend(localServer, { staticDir: path.join(import.meta.dirname, '..', 'public') });
  localServer.on('request', backend.app);
  const localPort = await listenOnLoopback(localServer);

  const remoteServer = http.createServer();
  backend.remote.attach(remoteServer);
  await listenOnLoopback(remoteServer, remotePort);

  booted.context = { tmpDir, prevEnv, localServer, remoteServer, backend, localPort, remotePort };
});

test.after(async () => {
  if (!booted.context) return;
  const { backend, localServer, remoteServer, prevEnv, tmpDir } = booted.context;
  backend.shutdown();
  for (const server of [localServer, remoteServer]) {
    server.closeAllConnections();
    await closeServer(server);
  }
  if (prevEnv == null) delete process.env.GLISSA_CONFIG;
  if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the backend reports the configured remote listener', () => {
  const { backend, remotePort, remoteServer } = ctx();
  assert.equal(backend.remote.enabled, true);
  assert.equal(backend.remote.port, remotePort);
  assert.equal(boundPort(remoteServer), remotePort, 'the second listener really took the configured port');
  assert.equal(backend.remote.publicHost, 'glissa.test');
});

test('the local listener is untouched by remote mode', async () => {
  const res = await fetch(`http://127.0.0.1:${ctx().localPort}/definitely-not-a-route`);
  assert.equal(res.status, 404, 'no auth gate on the local listener');
});

test('the remote listener refuses an unpaired device', async () => {
  const res = await fetch(`http://127.0.0.1:${ctx().remotePort}/`);
  assert.equal(res.status, 401);
});

test('the hook ingress is refused on the remote listener before the route runs', async () => {
  const { localPort, remotePort } = ctx();
  const res = await fetch(`http://127.0.0.1:${remotePort}/hook/no-such-session/Stop`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401, 'a 404 would mean the hook route was reached');

  const local = await fetch(`http://127.0.0.1:${localPort}/hook/no-such-session/Stop`, { method: 'POST', body: '{}' });
  assert.equal(local.status, 404, 'and the local ingress still behaves exactly as before');
});

test('an unknown pairing token is refused without echoing the token back', async () => {
  const res = await fetch(`http://127.0.0.1:${ctx().remotePort}/pair/some-made-up-token`);
  assert.equal(res.status, 403, 'the pair route IS mounted (an unmounted route would 404)');
  assert.equal(res.headers.get('set-cookie'), null);
  const body = await res.text();
  assert.equal(body.includes('some-made-up-token'), false, 'a rejected token never appears in the page');
});

test('a control upgrade without a cookie is refused with a 401 status line', async () => {
  const { closed, body } = await rawUpgrade(ctx().remotePort, '/control');
  assert.equal(closed, true);
  assert.match(body, /^HTTP\/1\.1 401/, 'remote mode explains the refusal instead of a naked reset');
});

test('an upgrade for a path Glissa does not own is CLOSED on the remote listener', async () => {
  const { remoteServer, remotePort } = ctx();
  const destroyed = await backendDestroyedUpgrade(remoteServer, remotePort, '/some-other-app');
  assert.equal(destroyed, true, 'nothing else listens there; leaving it open strands a pre-auth socket');
});

test('the same unknown upgrade path is left alone on the local listener (Vite HMR owns some)', async () => {
  const { localServer, localPort } = ctx();
  const destroyed = await backendDestroyedUpgrade(localServer, localPort, '/some-other-app');
  assert.equal(destroyed, false, 'another upgrade listener must still get its chance');
});

// The dashboard reconnects with '/control?since=<seq>', so a query string must reach the control route
// and be judged by the pairing gate, not fall through to the unknown-path bucket (which is what exact
// URL matching used to do, killing every in-page reconnect).
test('a control upgrade with a query string is refused as a control connection, not as an unknown path', async () => {
  const { closed, body } = await rawUpgrade(ctx().remotePort, '/control?since=7');
  assert.equal(closed, true);
  assert.match(body, /^HTTP\/1\.1 401/, 'the 401 status line proves the control route judged it');
});

test('a paired device may reconnect with a replay cursor on the remote listener', async () => {
  const cookie = await pairDevice();
  const ws = new WebSocket(`ws://127.0.0.1:${ctx().remotePort}/control?since=7`, {
    headers: { Cookie: cookie },
    origin: 'https://glissa.test',
  });
  const first = await new Promise<{ type: string }>((resolve, reject) => {
    ws.once('message', (raw: Buffer) => resolve(JSON.parse(raw.toString())));
    ws.once('error', reject);
  });
  assert.equal(first.type, 'snapshot', 'the cursor-carrying reconnect reached the control route');
  await new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close(); });
});

// The 2026-08 review pass reproduced this: express.static percent-decodes and resolves dot segments,
// so an un-normalized "/pair/" prefix check exempted "/pair/%2e%2e/index.html" from the pairing gate
// while express served the dashboard bundle under it. Impact was limited to static assets, but every
// later app.use handler would have inherited the hole.
test('a traversal dressed as a pair path does not escape the pairing gate', async () => {
  const { localPort, remotePort } = ctx();
  const local = await fetch(`http://127.0.0.1:${localPort}/index.html`);
  assert.equal(local.status, 200, 'the dashboard asset is mounted on the shared app');

  const plain = await fetch(`http://127.0.0.1:${remotePort}/index.html`);
  assert.equal(plain.status, 401, 'the baseline: an unpaired device gets nothing');

  for (const target of ['/pair/%2e%2e/index.html', '/pair/../index.html', '/pair/%2e%2e%2findex.html']) {
    const res = await fetch(`http://127.0.0.1:${remotePort}${target}`);
    assert.equal(res.status, 401, `${target} must be judged as the resource it resolves to`);
  }
});
