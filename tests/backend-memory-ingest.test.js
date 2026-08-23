'use strict';

/*
 * `memory.enabled` implies the agent-log SOURCE and nothing else (docs/plan-visions-3.md, M14, operator
 * decision 2026-08-22). This is the pin for the half that could go wrong quietly: with memory on and
 * `config.ingest` absent, the source must be running, and yet NO ingest frame may reach the control WS
 * and no dispatch digest may exist. One switch, not three, and no widening of what leaves the machine.
 *
 * SAFETY: every boot points at a throwaway temp config via GLISSA_CONFIG with zero projects, and the
 * three vendor transcript homes are redirected to empty temp directories, so no test here reads the
 * operator's own conversations.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createBackend } = require('../server/backend');
const { dashboardClient } = require('./helpers/dashboard-ws');
const { isolateTranscriptHomes } = require('./helpers/transcript-homes');
const WebSocket = require('ws');

async function boot(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-ingest-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [], teams: [], repoRoots: [], ...extra,
  }, null, 2), 'utf8');
  const previousConfig = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;
  const restoreHomes = isolateTranscriptHomes(dir);
  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  return {
    dir,
    backend,
    server,
    track: (ws) => { sockets.push(ws); return ws; },
    async close() {
      for (const ws of sockets) ws.close();
      backend.shutdown();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      restoreHomes();
      if (previousConfig == null) delete process.env.GLISSA_CONFIG;
      if (previousConfig != null) process.env.GLISSA_CONFIG = previousConfig;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The connect frames land the instant the socket does, so recording starts before 'open' resolves.
function openRecordingSocket(dash) {
  const ws = new WebSocket(dash.url('/control'), dash.options);
  const received = [];
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => resolve({ ws, received }));
  });
}

function settle() {
  return new Promise((resolve) => { setTimeout(resolve, 150).unref(); });
}

test('memory on with ingest off runs the source and nothing else of that lane', async () => {
  const booted = await boot({ memory: { enabled: true } });
  try {
    assert.equal(booted.backend.getIngestLane(), null, 'no ring, no batch timer, no digest');
    const ingest = booted.backend.getMemoryIngest();
    assert.notEqual(ingest, null);
    assert.notEqual(ingest.source, null, 'the agent-log source was constructed for the memory lane');
    assert.equal(ingest.source.isDisabled, false);
  } finally {
    await booted.close();
  }
});

test('with ingest off no ingest frame reaches the control WS', async () => {
  const booted = await boot({ memory: { enabled: true } });
  try {
    const dash = await dashboardClient(booted.server.address().port);
    const { ws, received } = await openRecordingSocket(dash);
    booted.track(ws);
    await settle();
    assert.ok(received.some((message) => message.type === 'snapshot'), 'the ordinary snapshot still lands');
    assert.deepEqual(received.filter((message) => String(message.type).startsWith('ingest-')), []);
  } finally {
    await booted.close();
  }
});

test('the dispatch digest stays unwired, so memory alone never widens a prompt', async () => {
  const booted = await boot({ memory: { enabled: true }, visions: { enabled: true } });
  try {
    assert.equal(booted.backend.getIngestLane(), null);
    // Null is what the Visions lane reports when it was handed no digest and no movement signal at all.
    assert.equal(booted.backend.getVisionsLane().latestContextSeq(), null);
    assert.notEqual(booted.backend.getMemoryIngest().source, null);
  } finally {
    await booted.close();
  }
});

test('with the ingest lane running the memory consumer rides ITS source rather than a second one', async () => {
  const booted = await boot({
    memory: { enabled: true },
    ingest: { enabled: true, sources: { agentLogs: { enabled: true } } },
  });
  try {
    assert.notEqual(booted.backend.getIngestLane(), null);
    assert.equal(booted.backend.getMemoryIngest().source, null, 'one source, two targets');
  } finally {
    await booted.close();
  }
});

test('an ingest lane whose agent-log source is off still leaves memory a source of its own', async () => {
  const booted = await boot({
    memory: { enabled: true },
    ingest: { enabled: true, sources: { terminal: { enabled: true } } },
  });
  try {
    assert.equal(booted.backend.getIngestLane().agentLogsEnabled, false);
    assert.notEqual(booted.backend.getMemoryIngest().source, null);
  } finally {
    await booted.close();
  }
});

test('memory off constructs no ingest consumer at all', async () => {
  const booted = await boot({});
  try {
    assert.equal(booted.backend.getMemoryIngest(), null);
    assert.deepEqual(fs.readdirSync(booted.dir).filter((name) => name.startsWith('memory')), []);
  } finally {
    await booted.close();
  }
});
