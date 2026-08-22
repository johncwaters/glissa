'use strict';

/*
 * The Visions tab's feed, end to end over the REAL sockets: an editor relay on /visions publishes a
 * sweep, and every dashboard on /control hears about it.
 *
 * The reconnect-repair decision is pinned here too. Findings are CURRENT STATE per open buffer, not the
 * one-shot moments control-replay-core retains (notify, session-error, post-turn-result), so
 * 'visions-findings' is deliberately NOT replayable: a client that missed a gap is repaired with one
 * 'visions-snapshot' of the whole map instead, which is the plan-limits precedent and the only shape
 * that can also express a uri closed while the client was away.
 *
 * SAFETY: the boot points at a throwaway temp config with ZERO projects via GLISSA_CONFIG, like every
 * other backend boot test (the boot worktree reconcile would otherwise touch real repos).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { createBackend } = require('../server/backend');
const { createReplayLog } = require('../server/control-replay-core');

const MARKDOWN_URI = 'file:///tmp/plan-visions.md';
const REPEATED_WORD_MARKDOWN = '# Title\n\nA line with with a repeat.\n';
const MESSAGE_WAIT_MS = 5000;

function withVisionsBackend(fn) {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-visions-tab-'));
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      projects: [], teams: [], repoRoots: [], visions: { enabled: true },
    }, null, 2), 'utf8');
    const prevEnv = process.env.GLISSA_CONFIG;
    process.env.GLISSA_CONFIG = cfgPath;

    const server = http.createServer();
    const backend = createBackend(server, { staticDir: null });
    server.on('request', backend.app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `ws://127.0.0.1:${server.address().port}`;
    const sockets = [];

    try {
      await fn({ base, backend, track: (ws) => { sockets.push(ws); return ws; } });
    } finally {
      for (const ws of sockets) ws.close();
      backend.shutdown();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (prevEnv == null) delete process.env.GLISSA_CONFIG;
      if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

// Recording starts before 'open' resolves: the server sends its connect frames the instant the socket
// lands, and a listener attached after awaiting 'open' can miss them (backend-control-reconnect.test.js).
function openRecordingSocket(url) {
  const ws = new WebSocket(url);
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

function sendLsp(ws, method, params) {
  ws.send(JSON.stringify({ type: 'lsp', method, params }));
}

test('a sweep reaches every connected dashboard, and a later one is repaired by the snapshot', withVisionsBackend(async ({ base, track }) => {
  const dashboard = await openRecordingSocket(`${base}/control`);
  track(dashboard.ws);
  const snapshotOnFirstConnect = await waitFor(dashboard.received, (msg) => msg.type === 'visions-snapshot');
  assert.deepEqual(snapshotOnFirstConnect.documents, [], 'nothing is open yet, so the repair frame is empty');

  const relay = await openRecordingSocket(`${base}/visions`);
  track(relay.ws);
  sendLsp(relay.ws, 'textDocument/didOpen', {
    textDocument: {
      uri: MARKDOWN_URI, languageId: 'markdown', version: 1, text: REPEATED_WORD_MARKDOWN,
    },
  });

  const pushed = await waitFor(dashboard.received, (msg) => msg.type === 'visions-findings');
  assert.equal(pushed.uri, MARKDOWN_URI);
  assert.deepEqual(pushed.diagnostics.map((d) => d.code), ['repeated-word']);
  assert.ok(Number.isFinite(pushed.ts) && pushed.ts > 0);

  // The reconnect: a second dashboard connects after the sweep and is told the current state in one frame.
  const reconnected = await openRecordingSocket(`${base}/control`);
  track(reconnected.ws);
  const repaired = await waitFor(reconnected.received, (msg) => msg.type === 'visions-snapshot');
  assert.deepEqual(repaired.documents.map((doc) => doc.uri), [MARKDOWN_URI]);
  assert.deepEqual(repaired.documents[0].diagnostics.map((d) => d.code), ['repeated-word']);

  // And closing the buffer empties both surfaces: the live push, and the next client's repair frame.
  sendLsp(relay.ws, 'textDocument/didClose', { textDocument: { uri: MARKDOWN_URI } });
  const cleared = await waitFor(dashboard.received, (msg) => msg.type === 'visions-findings' && msg.diagnostics.length === 0);
  assert.equal(cleared.uri, MARKDOWN_URI);

  const afterClose = await openRecordingSocket(`${base}/control`);
  track(afterClose.ws);
  const emptyRepair = await waitFor(afterClose.received, (msg) => msg.type === 'visions-snapshot');
  assert.deepEqual(emptyRepair.documents, []);
}));

/*
 * The intent model's round trip (docs/archive/plan-visions.md, M5), over the real control WS: a correction
 * goes up, the broadcast comes back to every dashboard, a model proposal (what a dispatch result feeds
 * in) is refused by the lock, and the next client's repair frame carries the statement that survived.
 * The dispatch itself is faked at the lane seam: no test in this repo spawns claude.
 */
test('an operator correction locks the intent, survives a dispatch, and rides the snapshot repair', withVisionsBackend(async ({ base, backend, track }) => {
  const dashboard = await openRecordingSocket(`${base}/control`);
  track(dashboard.ws);
  const firstSnapshot = await waitFor(dashboard.received, (msg) => msg.type === 'visions-snapshot');
  assert.deepEqual(firstSnapshot.intent, {
    text: '', source: null, locked: false, ts: 0,
  }, 'a fresh daemon believes nothing yet');

  dashboard.ws.send(JSON.stringify({ type: 'visions-set-intent', text: '  rewriting the merge gate  ' }));
  const corrected = await waitFor(dashboard.received, (msg) => msg.type === 'visions-intent');
  assert.equal(corrected.intent.text, 'rewriting the merge gate', 'trimmed by the merge, not by the tab');
  assert.equal(corrected.intent.source, 'operator');
  assert.equal(corrected.intent.locked, true);

  // What a tier 3 result does when it lands: the lane's model-proposal path, which the lock outranks.
  const lane = backend.getVisionsLane();
  assert.equal(lane.applyModelIntent('a plan doc about spawning'), false, 'the merge refuses it, so nothing is broadcast');
  assert.equal(lane.getIntent().text, 'rewriting the merge gate');

  const reconnected = await openRecordingSocket(`${base}/control`);
  track(reconnected.ws);
  const repaired = await waitFor(reconnected.received, (msg) => msg.type === 'visions-snapshot');
  assert.equal(repaired.intent.text, 'rewriting the merge gate');
  assert.equal(repaired.intent.locked, true);

  // And clearing it hands control back: the same model proposal now lands.
  reconnected.ws.send(JSON.stringify({ type: 'visions-set-intent', text: '' }));
  await waitFor(dashboard.received, (msg) => msg.type === 'visions-intent' && msg.intent.text === '');
  assert.equal(lane.applyModelIntent('a plan doc about spawning'), true);
  assert.equal(lane.getIntent().source, 'model');
}));

test('a control client connecting with the lane off is told nothing about the visions', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-visions-off-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ projects: [], teams: [], repoRoots: [] }, null, 2), 'utf8');
  const prevEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { ws, received } = await openRecordingSocket(`ws://127.0.0.1:${server.address().port}/control`);
    await waitFor(received, (msg) => msg.type === 'client-trust');
    assert.equal(received.some((msg) => msg.type.startsWith('visions-')), false, 'an absent lane adds no frame');
    ws.close();
  } finally {
    backend.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (prevEnv == null) delete process.env.GLISSA_CONFIG;
    if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// The other half of the decision, stated where it can fail: adding either visions type to
// REPLAYABLE_EXACT would break this and force the choice to be made again on purpose.
test('visions messages are not on the control replay retention list', () => {
  const log = createReplayLog();
  log.stamp({ type: 'visions-findings', uri: MARKDOWN_URI, diagnostics: [], ts: 1 });
  log.stamp({ type: 'visions-snapshot', documents: [], ts: 2 });
  log.stamp({ type: 'session-error', session: 'probe', message: 'kept' });

  const { entries } = log.entriesSince(0);
  assert.deepEqual(entries.map((entry) => entry.type), ['session-error']);
});
