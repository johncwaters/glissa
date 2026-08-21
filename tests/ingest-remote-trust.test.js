'use strict';

/*
 * Ingest frames never cross the remote listener (docs/plan-ingestion.md, "Privacy and trust posture":
 * the ingest lane is refused to remote-trust sockets exactly like the navigator lane). Captured
 * terminal output is the most sensitive thing this daemon holds in memory, and a paired phone is a
 * device that is not the machine the output came from.
 *
 * This needs a REAL two-listener boot: trust is decided from the socket's local port, so a fake ws
 * would be testing the assertion rather than the wiring. A paired device is minted the same way the
 * remote suite does it, which is also what proves the remote socket is genuinely live and receiving,
 * so "no ingest frame" means refused rather than merely disconnected.
 *
 * SAFETY: temp config with ZERO projects via GLISSA_CONFIG, like every other backend boot test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { createBackend } = require('../server/backend');
const { createPairingsStore } = require('../server/pairings-store');

let tmpDir = null;
let prevEnv = null;
let localServer = null;
let remoteServer = null;
let backend = null;
let localPort = null;
let remotePort = null;

const MESSAGE_WAIT_MS = 5000;

// The remote port has to be known BEFORE boot (trust compares it against req.socket.localPort), so
// take a free one from the OS and hand it straight back.
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

async function pairDevice() {
  const minted = createPairingsStore({ filePath: path.join(tmpDir, 'pairings.json') })
    .mintPending({ name: 'ingest trust test device' });
  const res = await fetch(`http://127.0.0.1:${remotePort}/pair/${minted.token}`, { redirect: 'manual' });
  assert.equal(res.status, 303, 'a fresh token redeems');
  return res.headers.get('set-cookie').split(';')[0];
}

// Recording starts before 'open' resolves: the connect frames land the instant the socket does.
function openRecordingSocket(url, options = {}) {
  const ws = new WebSocket(url, options);
  const received = [];
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => resolve({ ws, received }));
  });
}

function waitFor(received, match) {
  const deadline = Date.now() + MESSAGE_WAIT_MS;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const found = received.find(match);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('timed out waiting for a matching control message'));
        return;
      }
      setTimeout(poll, 20).unref();
    };
    poll();
  });
}

const isIngestFrame = (msg) => typeof msg.type === 'string' && msg.type.startsWith('ingest-');

test.before(async () => {
  remotePort = await reserveFreePort();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-ingest-trust-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    projects: [], teams: [], repoRoots: [],
    ingest: { enabled: true, sources: { terminal: { enabled: true } } },
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

test('the connect-time ingest snapshot goes to a local dashboard and not to a paired device', async () => {
  const lane = backend.getIngestLane();
  assert.ok(lane, 'the lane is on for this boot');
  lane.publish({ source: 'terminal', kind: 'output', summary: 'a local command ran', scope: { root: '/repo' } });

  const cookie = await pairDevice();
  const remote = await openRecordingSocket(`ws://127.0.0.1:${remotePort}/control`, {
    headers: { Cookie: cookie }, origin: 'https://glissa.test',
  });
  const local = await openRecordingSocket(`ws://127.0.0.1:${localPort}/control`);

  try {
    // The paired device IS receiving: it gets the ordinary connect snapshot and is told its own trust.
    assert.equal((await waitFor(remote.received, (msg) => msg.type === 'snapshot')).type, 'snapshot');
    assert.equal((await waitFor(remote.received, (msg) => msg.type === 'client-trust')).trust, 'remote');
    // The local dashboard gets the ingest snapshot on the same connect.
    const snapshot = await waitFor(local.received, (msg) => msg.type === 'ingest-snapshot');
    assert.deepEqual(snapshot.events.map((event) => event.summary), ['a local command ran']);

    assert.deepEqual(remote.received.filter(isIngestFrame), [], 'no ingest frame may cross the remote listener');
  } finally {
    remote.ws.close();
    local.ws.close();
  }
});

test('a batched activity delta reaches a local dashboard and not a paired device', async () => {
  const cookie = await pairDevice();
  const remote = await openRecordingSocket(`ws://127.0.0.1:${remotePort}/control`, {
    headers: { Cookie: cookie }, origin: 'https://glissa.test',
  });
  const local = await openRecordingSocket(`ws://127.0.0.1:${localPort}/control`);

  try {
    await waitFor(remote.received, (msg) => msg.type === 'snapshot');
    await waitFor(local.received, (msg) => msg.type === 'ingest-snapshot');

    const secret = 'output only this machine should see';
    backend.getIngestLane().publish({
      source: 'terminal', kind: 'output', summary: secret, scope: { root: '/repo' },
    });

    // Waiting on the LOCAL delta is what makes the remote negative meaningful: the batch interval has
    // demonstrably fired by the time it resolves, so the remote socket had its chance and got nothing.
    // What else rode that frame is the batching test's business, not this one's.
    const frame = await waitFor(
      local.received,
      (msg) => msg.type === 'ingest-activity' && msg.events.some((event) => event.summary === secret),
    );
    assert.ok(frame.events.length >= 1);

    assert.deepEqual(remote.received.filter(isIngestFrame), []);
    assert.equal(JSON.stringify(remote.received).includes(secret), false, 'not one byte of it crossed');
  } finally {
    remote.ws.close();
    local.ws.close();
  }
});
