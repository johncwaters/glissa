'use strict';

// The remote listener as actually wired: same Express app, different trust. Covers the things only a
// live two-listener boot can show - the pair route existing, an unpaired 401, the hook ingress being
// refused remotely, and an upgrade for a path Glissa does not own being closed rather than stranded.
//
// SAFETY: temp config with ZERO projects via GLISSA_CONFIG, like every other backend boot test (the
// boot worktree reconcile would otherwise touch real repos).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { createBackend } = require('../server/backend');

let tmpDir = null;
let prevEnv = null;
let localServer = null;
let remoteServer = null;
let backend = null;
let localPort = null;
let remotePort = null;

// A configured remote port has to be known BEFORE boot (trust is decided by comparing it against
// req.socket.localPort), so grab a free one from the OS and release it.
function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function upgradeRequestLines(port, requestPath, extraHeaders) {
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

function rawUpgrade(port, requestPath, extraHeaders = []) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(upgradeRequestLines(port, requestPath, extraHeaders));
    });
    const chunks = [];
    const finish = () => resolve({ closed: socket.destroyed, body: Buffer.concat(chunks).toString() });
    socket.on('data', (c) => chunks.push(c));
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
function backendDestroyedUpgrade(server, port, requestPath) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no upgrade event for ${requestPath}`)), 5000);
    let client = null;
    server.once('upgrade', (_req, socket) => {
      clearTimeout(timer);
      const destroyedByBackend = socket.destroyed;
      socket.destroy();
      if (client) client.destroy();
      resolve(destroyedByBackend);
    });
    client = net.connect(port, '127.0.0.1', () => {
      client.write(upgradeRequestLines(port, requestPath, []));
    });
    client.on('error', () => { /* the server end closing is the expected outcome */ });
  });
}

test.before(async () => {
  remotePort = await reserveFreePort();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-remote-on-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    projects: [], teams: [], repoRoots: [],
    remote: { enabled: true, port: remotePort, publicHost: 'glissa.test', allowedOrigins: ['https://glissa.test'] },
  }, null, 2), 'utf8');
  prevEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  localServer = http.createServer();
  backend = createBackend(localServer, { staticDir: null });
  localServer.on('request', backend.app);
  await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
  localPort = localServer.address().port;

  remoteServer = http.createServer();
  backend.remote.attach(remoteServer);
  await new Promise((resolve) => remoteServer.listen(remotePort, '127.0.0.1', resolve));
});

test.after(async () => {
  if (backend) backend.shutdown();
  for (const server of [localServer, remoteServer]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (prevEnv == null) delete process.env.GLISSA_CONFIG;
  if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the backend reports the configured remote listener', () => {
  assert.equal(backend.remote.enabled, true);
  assert.equal(backend.remote.port, remotePort);
  assert.equal(backend.remote.publicHost, 'glissa.test');
});

test('the local listener is untouched by remote mode', async () => {
  const res = await fetch(`http://127.0.0.1:${localPort}/definitely-not-a-route`);
  assert.equal(res.status, 404, 'no auth gate on the local listener');
});

test('the remote listener refuses an unpaired device', async () => {
  const res = await fetch(`http://127.0.0.1:${remotePort}/`);
  assert.equal(res.status, 401);
});

test('the hook ingress is refused on the remote listener before the route runs', async () => {
  const res = await fetch(`http://127.0.0.1:${remotePort}/hook/no-such-session/Stop`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401, 'a 404 would mean the hook route was reached');

  const local = await fetch(`http://127.0.0.1:${localPort}/hook/no-such-session/Stop`, { method: 'POST', body: '{}' });
  assert.equal(local.status, 404, 'and the local ingress still behaves exactly as before');
});

test('an unknown pairing token is refused without echoing the token back', async () => {
  const res = await fetch(`http://127.0.0.1:${remotePort}/pair/some-made-up-token`);
  assert.equal(res.status, 403, 'the pair route IS mounted (an unmounted route would 404)');
  assert.equal(res.headers.get('set-cookie'), null);
  const body = await res.text();
  assert.equal(body.includes('some-made-up-token'), false, 'a rejected token never appears in the page');
});

test('a control upgrade without a cookie is refused with a 401 status line', async () => {
  const { closed, body } = await rawUpgrade(remotePort, '/control');
  assert.equal(closed, true);
  assert.match(body, /^HTTP\/1\.1 401/, 'remote mode explains the refusal instead of a naked reset');
});

test('an upgrade for a path Glissa does not own is CLOSED on the remote listener', async () => {
  const destroyed = await backendDestroyedUpgrade(remoteServer, remotePort, '/some-other-app');
  assert.equal(destroyed, true, 'nothing else listens there; leaving it open strands a pre-auth socket');
});

test('the same unknown upgrade path is left alone on the local listener (Vite HMR owns some)', async () => {
  const destroyed = await backendDestroyedUpgrade(localServer, localPort, '/some-other-app');
  assert.equal(destroyed, false, 'another upgrade listener must still get its chance');
});

// '/control?x=1' does not match the exact '/control' route, so it lands in the unknown bucket. That
// matching behavior is preserved; the point here is that the remote listener closes it either way.
test('a control upgrade with a query string is also closed remotely rather than stranded', async () => {
  const destroyed = await backendDestroyedUpgrade(remoteServer, remotePort, '/control?x=1');
  assert.equal(destroyed, true);
});
