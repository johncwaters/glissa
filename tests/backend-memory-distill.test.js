'use strict';

// The memory-distill lane is constructed only beside a memory store (docs/plan-visions-3.md, M15), and
// its kill switch is an explicit false rather than an opt-in true. Memory off must construct nothing.
//
// SAFETY: createBackend runs a boot worktree reconcile against the configured projects, so every boot
// here points at a throwaway temp config with ZERO projects via GLISSA_CONFIG.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createBackend } = require('../server/backend');
const { isolateTranscriptHomes } = require('./helpers/transcript-homes');

async function bootWithConfig(memory) {
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Every stopper fires on the first call, so a test reading the names and the close() below share one.
  let shutdownResult = null;
  const shutdownOnce = () => {
    shutdownResult = shutdownResult || backend.shutdown();
    return shutdownResult;
  };
  return {
    dir,
    backend,
    shutdownOnce,
    async close() {
      const outcome = shutdownOnce();
      await Promise.allSettled((outcome.stoppers || []).map((entry) => entry.promise));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
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
    assert.equal(booted.backend.getMemoryDistiller(), null);
  } finally {
    await booted.close();
  }
});

test('memory on constructs the lane and registers its shutdown stopper', async () => {
  const booted = await bootWithConfig({ enabled: true });
  try {
    const distiller = booted.backend.getMemoryDistiller();
    assert.notEqual(distiller, null);
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
    assert.notEqual(booted.backend.getMemoryStore(), null);
    assert.equal(booted.backend.getMemoryDistiller().isEnabled(), false);
  } finally {
    await booted.close();
  }
});
