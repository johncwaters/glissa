import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from '../server/backend.ts';
import type { ShutdownOutcome } from '../server/backend-shutdown.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { memoryDistillLane, memoryStoreLane } from './helpers/lanes.ts';
import type { Backend } from './helpers/lanes.ts';
import { isolateTranscriptHomes } from './helpers/transcript-homes.ts';

interface BootedBackend {
  dir: string;
  backend: Backend;
  shutdownOnce(): ShutdownOutcome;
  close(): Promise<void>;
}

async function bootWithConfig(memory?: Record<string, unknown>): Promise<BootedBackend> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-distill-backend-'));
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

  const outcome: { result: ShutdownOutcome | null } = { result: null };
  const shutdownOnce = (): ShutdownOutcome => {
    outcome.result = outcome.result || backend.shutdown();
    return outcome.result;
  };
  return {
    dir,
    backend,
    shutdownOnce,
    async close() {
      const settled = shutdownOnce();
      await Promise.allSettled((settled.stoppers || []).map((entry) => entry.promise));
      server.closeAllConnections();
      await closeServer(server);
      restoreHomes();
      if (previousConfig == null) delete process.env.GLISSA_CONFIG;
      if (previousConfig != null) process.env.GLISSA_CONFIG = previousConfig;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('memory off constructs no distill lane', async () => {
  const booted = await bootWithConfig(undefined);
  try {
    assert.equal(memoryDistillLane(booted.backend), null);
  } finally {
    await booted.close();
  }
});

test('memory on constructs the lane and registers its shutdown stopper', async () => {
  const booted = await bootWithConfig({ enabled: true });
  try {
    const distiller = memoryDistillLane(booted.backend);
    assert.ok(distiller, 'the lane was constructed');
    assert.equal(distiller.isEnabled(), true);
    const names = booted.shutdownOnce().stoppers.map((entry) => entry.name);
    assert.equal(names.includes('memory-distill'), true);
    assert.equal(names.indexOf('memory-distill') < names.indexOf('memory-store'), true, 'it publishes through the store');
  } finally {
    await booted.close();
  }
});

test('the distill kill switch leaves the store on and the lane inert', async () => {
  const booted = await bootWithConfig({ enabled: true, distill: { enabled: false } });
  try {
    assert.notEqual(memoryStoreLane(booted.backend), null);
    const distiller = memoryDistillLane(booted.backend);
    assert.ok(distiller, 'the lane still exists beside the store');
    assert.equal(distiller.isEnabled(), false);
  } finally {
    await booted.close();
  }
});
