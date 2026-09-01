import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from '../server/backend.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { memoryStoreLane, visionsLane } from './helpers/lanes.ts';
import type { Backend } from './helpers/lanes.ts';
import { isolateTranscriptHomes } from './helpers/transcript-homes.ts';

interface BootedBackend {
  dir: string;
  backend: Backend;
  close(): Promise<void>;
}

async function bootWithConfig(extra: Record<string, unknown>): Promise<BootedBackend> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-writers-'));
  const configPath = path.join(dir, 'config.json');
  const base = { projects: [], teams: [], repoRoots: [] };
  fs.writeFileSync(configPath, JSON.stringify({ ...base, ...extra }, null, 2), 'utf8');
  const previousConfig = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;

  const restoreHomes = isolateTranscriptHomes(dir);
  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);
  return {
    dir,
    backend,
    async close() {
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

test('an accepted intent proposal reaches the memory store the lane was handed', async () => {
  const booted = await bootWithConfig({ memory: { enabled: true }, visions: { enabled: true } });
  try {
    const lane = visionsLane(booted.backend);
    const store = memoryStoreLane(booted.backend);
    assert.ok(lane, 'the visions lane is running');
    assert.ok(store, 'the memory store is running');

    lane.applyModelIntent('the writers are wired');
    await lane.whenMemoryIdle();

    assert.equal(store.stats().byKind.intent, 1);
    const written = store.records().filter((record) => record.kind === 'intent');
    assert.match(written[0].text, /^thread t-[0-9a-f]{8}: the writers are wired$/);
    assert.equal(written[0].source.kind, 'model');
    assert.equal(written[0].source.vendor, 'glissa');
  } finally {
    await booted.close();
  }
});

test('the same proposal with memory off is recorded nowhere and costs the lane nothing', async () => {
  const booted = await bootWithConfig({ visions: { enabled: true } });
  try {
    const lane = visionsLane(booted.backend);
    assert.ok(lane, 'the visions lane is running');
    assert.equal(memoryStoreLane(booted.backend), null);

    lane.applyModelIntent('nothing to write to');
    await lane.whenMemoryIdle();

    assert.equal(lane.getIntentFor(null).active.text, 'nothing to write to');
    assert.deepEqual(fs.readdirSync(booted.dir).filter((name) => name.startsWith('memory')), []);
  } finally {
    await booted.close();
  }
});
