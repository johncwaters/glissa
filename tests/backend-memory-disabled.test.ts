import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from '../server/backend.ts';
import { CONFIG_SCALAR_KEYS } from '../shared/contracts/index.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { memoryStoreLane } from './helpers/lanes.ts';
import type { Backend } from './helpers/lanes.ts';
import { isolateTranscriptHomes } from './helpers/transcript-homes.ts';

interface BootedBackend {
  dir: string;
  backend: Backend;
  close(): Promise<void>;
}

async function bootWithConfig(memory?: Record<string, unknown>): Promise<BootedBackend> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-backend-'));
  const configPath = path.join(dir, 'config.json');
  const base = { projects: [], teams: [], repoRoots: [] };
  fs.writeFileSync(configPath, JSON.stringify(memory === undefined ? base : { ...base, memory }, null, 2), 'utf8');
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

test('a config with no memory block constructs no store and touches no memory directory', async () => {
  const booted = await bootWithConfig(undefined);
  try {
    assert.equal(memoryStoreLane(booted.backend), null);
    assert.deepEqual(fs.readdirSync(booted.dir).filter((name) => name.startsWith('memory')), []);
  } finally {
    await booted.close();
  }
});

test('memory enabled false is as inert as an absent block', async () => {
  const booted = await bootWithConfig({ enabled: false, retainDays: 90 });
  try {
    assert.equal(memoryStoreLane(booted.backend), null);
    assert.equal(fs.existsSync(path.join(booted.dir, 'memory')), false);
  } finally {
    await booted.close();
  }
});

test('memory enabled true constructs the store beside the resolved config file', async () => {
  const booted = await bootWithConfig({ enabled: true });
  try {
    const store = memoryStoreLane(booted.backend);
    assert.ok(store, 'the store was constructed');
    assert.equal(store.dir, path.join(booted.dir, 'memory'));
    assert.equal(fs.existsSync(path.join(booted.dir, 'memory', 'hmac-key')), true);
  } finally {
    await booted.close();
  }
});

test('memory is in no control-WS settable key list', () => {
  assert.equal(CONFIG_SCALAR_KEYS.some((key) => key.toLowerCase().includes('memory')), false);
});
