'use strict';

// Memory is opt-in and file-only (docs/plan-visions-3.md, M12). Off must construct NOTHING: no store
// object, no timer, no directory beside the config file. And on, it must be unreachable from the
// unauthenticated control WebSocket, so no settable key list may carry it.
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
const { CONFIG_SCALAR_KEYS } = require('../shared/contracts');

async function bootWithConfig(memory) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-backend-'));
  const configPath = path.join(dir, 'config.json');
  const base = { projects: [], teams: [], repoRoots: [] };
  fs.writeFileSync(configPath, JSON.stringify(memory === undefined ? base : { ...base, memory }, null, 2), 'utf8');
  const previousConfig = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;
  // memory.enabled implies the agent-log source, so the vendor homes go somewhere empty first.
  const restoreHomes = isolateTranscriptHomes(dir);
  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    dir,
    backend,
    async close() {
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

test('a config with no memory block constructs no store and touches no memory directory', async () => {
  const booted = await bootWithConfig(undefined);
  try {
    assert.equal(booted.backend.getMemoryStore(), null);
    assert.deepEqual(fs.readdirSync(booted.dir).filter((name) => name.startsWith('memory')), []);
  } finally {
    await booted.close();
  }
});

test('memory enabled false is as inert as an absent block', async () => {
  const booted = await bootWithConfig({ enabled: false, retainDays: 90 });
  try {
    assert.equal(booted.backend.getMemoryStore(), null);
    assert.equal(fs.existsSync(path.join(booted.dir, 'memory')), false);
  } finally {
    await booted.close();
  }
});

test('memory enabled true constructs the store beside the resolved config file', async () => {
  const booted = await bootWithConfig({ enabled: true });
  try {
    const store = booted.backend.getMemoryStore();
    assert.notEqual(store, null);
    assert.equal(store.dir, path.join(booted.dir, 'memory'));
    assert.equal(fs.existsSync(path.join(booted.dir, 'memory', 'hmac-key')), true);
  } finally {
    await booted.close();
  }
});

test('memory is in no control-WS settable key list', () => {
  assert.equal(CONFIG_SCALAR_KEYS.some((key) => key.toLowerCase().includes('memory')), false);
});
