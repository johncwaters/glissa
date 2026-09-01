import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type WebSocket from 'ws';

import { createBackend } from '../server/backend.ts';
import { dashboardClient, openRecordingSocket } from './helpers/dashboard-ws.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { ingestLane, memoryIngestLane, visionsLane } from './helpers/lanes.ts';
import type { Backend } from './helpers/lanes.ts';
import { isolateTranscriptHomes } from './helpers/transcript-homes.ts';

interface ControlFrame {
  type: string;
}

interface BootedBackend {
  dir: string;
  backend: Backend;
  server: Server;
  track(ws: WebSocket): WebSocket;
  close(): Promise<void>;
}

async function boot(extra: Record<string, unknown>): Promise<BootedBackend> {
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
  await listenOnLoopback(server);
  const sockets: WebSocket[] = [];
  return {
    dir,
    backend,
    server,
    track: (ws: WebSocket) => { sockets.push(ws); return ws; },
    async close() {
      for (const ws of sockets) ws.close();
      backend.shutdown();
      server.closeAllConnections();
      await closeServer(server);
      restoreHomes();
      if (previousConfig == null) delete process.env.GLISSA_CONFIG;
      if (previousConfig != null) process.env.GLISSA_CONFIG = previousConfig;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(() => resolve(), 150).unref(); });
}

test('memory on with ingest off runs the source and nothing else of that lane', async () => {
  const booted = await boot({ memory: { enabled: true } });
  try {
    assert.equal(ingestLane(booted.backend), null, 'no ring, no batch timer, no digest');
    const ingest = memoryIngestLane(booted.backend);
    assert.ok(ingest, 'the memory ingest consumer exists');
    assert.ok(ingest.source, 'the agent-log source was constructed for the memory lane');
    assert.equal(ingest.source.isDisabled, false);
  } finally {
    await booted.close();
  }
});

test('with ingest off no ingest frame reaches the control WS', async () => {
  const booted = await boot({ memory: { enabled: true } });
  try {
    const dash = await dashboardClient(boundPort(booted.server));
    const { ws, received } = await openRecordingSocket<ControlFrame>(dash);
    booted.track(ws);
    await settle();
    assert.ok(received.some((message) => message.type === 'snapshot'), 'the ordinary snapshot still lands');
    assert.deepEqual(received.filter((message) => String(message.type).startsWith('ingest-')), []);
  } finally {
    await booted.close();
  }
});

test('the dispatch digest stays unwired, so memory alone never widens a prompt', async () => {
  const booted = await boot({ memory: { enabled: true }, visions: { enabled: true }, ingest: { enabled: false } });
  try {
    assert.equal(ingestLane(booted.backend), null);
    const visions = visionsLane(booted.backend);
    const ingest = memoryIngestLane(booted.backend);
    assert.ok(visions, 'the visions lane is running');
    assert.ok(ingest, 'the memory ingest consumer exists');

    assert.equal(visions.latestContextSeq(), null);
    assert.notEqual(ingest.source, null);
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
    assert.notEqual(ingestLane(booted.backend), null);
    const ingest = memoryIngestLane(booted.backend);
    assert.ok(ingest, 'the memory ingest consumer exists');
    assert.equal(ingest.source, null, 'one source, two targets');
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
    const lane = ingestLane(booted.backend);
    const ingest = memoryIngestLane(booted.backend);
    assert.ok(lane, 'the ingest lane is running');
    assert.ok(ingest, 'the memory ingest consumer exists');
    assert.equal(lane.agentLogsEnabled, false);
    assert.notEqual(ingest.source, null);
  } finally {
    await booted.close();
  }
});

test('memory off constructs no ingest consumer at all', async () => {
  const booted = await boot({});
  try {
    assert.equal(memoryIngestLane(booted.backend), null);
    assert.deepEqual(fs.readdirSync(booted.dir).filter((name) => name.startsWith('memory')), []);
  } finally {
    await booted.close();
  }
});
