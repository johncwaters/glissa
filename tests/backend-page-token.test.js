'use strict';

// The third layer of the localhost defense, through the REAL upgrade path: a control or data socket
// from a local client must carry the page token, and the token endpoint hands it out same-origin only.
// The layer exists because the port-exact Origin rule (layer two) leans on one header; together they
// mean a web page on another local port can neither forge the handshake nor learn the secret.
//
// SAFETY: temp GLISSA_CONFIG with zero projects, like every other backend boot test (the boot worktree
// reconcile would otherwise touch real repos).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { createBackend } = require('../server/backend');
const { fetchPageToken } = require('./helpers/dashboard-ws');

let tmpDir = null;
let prevEnv = null;
let server = null;
let backend = null;
let port = null;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-page-token-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ projects: [], teams: [], repoRoots: [], checkForUpdates: false }, null, 2), 'utf8');
  prevEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  server = http.createServer();
  backend = createBackend(server, { staticDir: path.join(__dirname, '..', 'public') });
  server.on('request', backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(async () => {
  backend.shutdown();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (prevEnv == null) delete process.env.GLISSA_CONFIG;
  if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function upgradeOutcome(pathAndSearch, options) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathAndSearch}`, options);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => resolve('refused'));
  });
}

test('the token endpoint answers a same-origin fetch and forbids caching', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/control-token`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(typeof body.token, 'string');
  assert.equal(body.token.length, 64, 'a 32-byte random hex token');
});

test('static JavaScript uses the current IANA media type', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/app.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
});

// A same-origin GET carries no Origin header at all, so the presence of a disallowed one is the tell.
// The browser would withhold the body anyway; refusing outright does not depend on it doing so.
test('a cross-origin fetch of the token is refused outright', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/control-token`, {
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(res.status, 403);
});

test('the token is stable for the life of the process', async () => {
  assert.equal(await fetchPageToken(port), await fetchPageToken(port));
});

test('a control socket without the token is refused, and with it connects', async () => {
  const token = await fetchPageToken(port);
  const origin = { origin: `http://127.0.0.1:${port}` };
  assert.equal(await upgradeOutcome('/control', origin), 'refused');
  assert.equal(await upgradeOutcome('/control?token=wrong', origin), 'refused');
  assert.equal(await upgradeOutcome(`/control?token=${token}`, origin), 'open');
  assert.equal(await upgradeOutcome(`/control?since=4&token=${token}`, origin), 'open', 'a replay cursor rides along');
});

test('a data socket is gated by the same token', async () => {
  const token = await fetchPageToken(port);
  const origin = { origin: `http://127.0.0.1:${port}` };
  assert.equal(await upgradeOutcome('/terminals/no-such-session', origin), 'refused');
  // With the token the upgrade itself succeeds; the unknown session is what closes it afterwards,
  // which is the pre-existing behavior this must not have changed.
  assert.equal(await upgradeOutcome(`/terminals/no-such-session?token=${token}`, origin), 'open');
});

// The gap the 2026-08 pass closed: any localhost origin used to be admitted whatever its port, so a
// page on another local port could open a channel that spawns permissionless sessions.
test('a token-carrying socket from another local port is still refused on Origin', async () => {
  const token = await fetchPageToken(port);
  assert.equal(
    await upgradeOutcome(`/control?token=${token}`, { origin: 'http://localhost:5173' }),
    'refused'
  );
  assert.equal(
    await upgradeOutcome(`/control?token=${token}`, { origin: undefined }),
    'refused',
    'and a non-browser client with no Origin has no business on a dashboard channel'
  );
});

// Host is a forbidden header for fetch, so the rebinding shape is only reachable over a raw request.
function statusWithHost(hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/control-token', method: 'GET', headers: { Host: hostHeader },
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

function statusWithoutHost() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.end('GET /control-token HTTP/1.0\r\nConnection: close\r\n\r\n');
    });
    let response = '';
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('end', () => {
      const match = response.match(/^HTTP\/1\.[01] (\d{3})/);
      resolve(match ? Number(match[1]) : null);
    });
    socket.on('error', reject);
  });
}

test('a rebinding Host is refused while every loopback spelling is allowed', async () => {
  assert.equal(await statusWithHost('evil.example'), 403);
  assert.equal(await statusWithHost(`evil.example:${port}`), 403);
  assert.equal(await statusWithHost(`localhost:${port}`), 200);
  assert.equal(await statusWithHost(`127.0.0.1:${port}`), 200);
});

test('an absent Host passes through the real middleware', async () => {
  assert.equal(await statusWithoutHost(), 200);
});
