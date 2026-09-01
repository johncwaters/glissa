'use strict';

// The dashboard's in-page reconnect, through the REAL upgrade path.
//
// public/control-ws.ts reconnects with '/control?since=<lastSeq>' once it has processed a single
// message, so every reconnect after the first carries a query string. The upgrade router used to match
// the control path by exact equality against req.url (query string included), which put every one of
// those reconnects in the unknown-path bucket: destroyed remotely, stranded locally. Only a full page
// reload ever reconnected. The existing replay tests (control-dispatch.test.js) emit 'connection' on a
// fake emitter and never touch handleUpgrade, which is why the bug survived them - so this suite goes
// through a real http server and a real ws client.
//
// SAFETY: temp GLISSA_CONFIG with a single project pointing at the temp dir (never a real repo): boot
// reconcile removes glissa/session/* worktrees, so a real project path here could delete live work.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { createBackend } = require('../server/backend.ts');
const { dashboardClient } = require('./helpers/dashboard-ws');

const SESSION_ID = 'reconnect-test-session';
// Over the 16384-char input cap the data-WS handler enforces, so the server answers with a
// `session-error` broadcast: a replayable message type, stamped with a seq, and reachable without ever
// starting a PTY (the size check returns before the write).
const OVERSIZED_INPUT = 'x'.repeat(20000);
const MESSAGE_WAIT_MS = 5000;

function withBackend(fn) {
  return async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-reconnect-'));
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      projects: [{ id: SESSION_ID, name: 'reconnect probe', path: tmpDir }],
      teams: [], repoRoots: [],
    }, null, 2), 'utf8');
    const prevEnv = process.env.GLISSA_CONFIG;
    process.env.GLISSA_CONFIG = cfgPath;

    const server = http.createServer();
    const backend = createBackend(server, { staticDir: null });
    server.on('request', backend.app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    // The dashboard channels require a browser Origin and the page token; the client helper is the
    // one place that handshake lives.
    const client = await dashboardClient(server.address().port);

    try {
      await fn(t, client);
    } finally {
      backend.shutdown();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (prevEnv == null) delete process.env.GLISSA_CONFIG;
      if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

/**
 * Opens a socket that records every message from construction onward, in arrival order.
 *
 * The recording has to start before 'open' resolves: the server sends the snapshot the instant the
 * connection lands, so the 101 response and the first frames usually arrive in ONE socket read and ws
 * emits 'open' and 'message' synchronously within it. A listener attached after awaiting 'open' misses
 * the snapshot entirely.
 */
function openRecordingSocket(client, pathAndSearch) {
  const ws = new WebSocket(client.url(pathAndSearch), client.options);
  const received = [];
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => resolve({ ws, received }));
  });
}

function openSocket(client, pathAndSearch) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(client.url(pathAndSearch), client.options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function closeSocket(ws) {
  return new Promise((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
}

async function waitForMessage(received, predicate) {
  const deadline = Date.now() + MESSAGE_WAIT_MS;
  while (Date.now() < deadline) {
    const hit = received.find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no matching message among ${JSON.stringify(received.map((m) => m.type))}`);
}

const isSessionError = (m) => m.type === 'session-error';

test('a control reconnect carrying a replay cursor connects and gets snapshot then replay', withBackend(async (_t, client) => {
  const first = await openRecordingSocket(client, '/control');
  const snapshot = await waitForMessage(first.received, (m) => m.type === 'snapshot');
  assert.deepEqual(snapshot.sessions.map((s) => s.id), [SESSION_ID]);

  // A query string on the data route must route AND not leak into the session id: the broadcast below
  // is only reachable through a socket that resolved to this exact session.
  const dataConnection = await openSocket(client, `/terminals/${SESSION_ID}?probe=1`);
  const dataCloseCode = new Promise((resolve) => dataConnection.once('close', resolve));

  dataConnection.send(JSON.stringify({ type: 'input', data: OVERSIZED_INPUT }));
  const beforeCursor = await waitForMessage(first.received, isSessionError);
  assert.equal(beforeCursor.id, SESSION_ID, 'the query string never became part of the session id');
  assert.equal(typeof beforeCursor.seq, 'number');

  dataConnection.send(JSON.stringify({ type: 'input', data: OVERSIZED_INPUT }));
  const afterCursor = await waitForMessage(first.received, (m) => isSessionError(m) && m.seq > beforeCursor.seq);

  await closeSocket(first.ws);

  // The reconnect the old exact-match router dropped on the floor.
  const reconnected = await openRecordingSocket(client, `/control?since=${beforeCursor.seq}`);
  const replayedError = await waitForMessage(reconnected.received, isSessionError);
  assert.equal(reconnected.received[0].type, 'snapshot', 'the snapshot is still the first frame of a reconnect');
  assert.equal(replayedError.seq, afterCursor.seq, 'exactly the broadcasts past the cursor are replayed');
  assert.equal(reconnected.received.filter(isSessionError).length, 1, 'the entry at the cursor is not replayed again');

  await closeSocket(reconnected.ws);
  await closeSocket(dataConnection);
  assert.notEqual(await dataCloseCode, 1008, 'the data socket was never refused as an unknown session');
}));

test('a data socket whose id does not exist is still refused', withBackend(async (_t, client) => {
  const ws = await openSocket(client, '/terminals/no-such-session?probe=1');
  const code = await new Promise((resolve) => ws.once('close', resolve));
  assert.equal(code, 1008);
}));
