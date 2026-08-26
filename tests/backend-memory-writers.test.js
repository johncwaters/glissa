'use strict';

// M13 of docs/plan-visions-3.md: with memory on, the Visions lane must actually HOLD the store, which is
// only true because the store is now constructed above the lane in backend.js.
//
// SAFETY: the boot points at a throwaway temp config with ZERO projects via GLISSA_CONFIG, like every
// other backend boot test (the boot worktree reconcile would otherwise touch real repos).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createBackend } = require('../server/backend');
const { isolateTranscriptHomes } = require('./helpers/transcript-homes');

async function bootWithConfig(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-writers-'));
  const configPath = path.join(dir, 'config.json');
  const base = { projects: [], teams: [], repoRoots: [] };
  fs.writeFileSync(configPath, JSON.stringify({ ...base, ...extra }, null, 2), 'utf8');
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

test('an accepted intent proposal reaches the memory store the lane was handed', async () => {
  const booted = await bootWithConfig({ memory: { enabled: true }, visions: { enabled: true } });
  try {
    const lane = booted.backend.getLane('visions');
    const store = booted.backend.getLane('memory-store');
    assert.notEqual(lane, null);
    assert.notEqual(store, null);

    lane.applyModelIntent('the writers are wired');
    await lane.whenMemoryIdle();

    assert.equal(store.stats().byKind.intent, 1);
    const written = store.records().filter((record) => record.kind === 'intent');
    assert.equal(written[0].text, 'the writers are wired');
    assert.equal(written[0].source.kind, 'model');
    assert.equal(written[0].source.vendor, 'glissa');
  } finally {
    await booted.close();
  }
});

test('the same proposal with memory off is recorded nowhere and costs the lane nothing', async () => {
  const booted = await bootWithConfig({ visions: { enabled: true } });
  try {
    const lane = booted.backend.getLane('visions');
    assert.equal(booted.backend.getLane('memory-store'), null);

    lane.applyModelIntent('nothing to write to');
    await lane.whenMemoryIdle();

    assert.equal(lane.getIntentFor(null).text, 'nothing to write to');
    assert.deepEqual(fs.readdirSync(booted.dir).filter((name) => name.startsWith('memory')), []);
  } finally {
    await booted.close();
  }
});
