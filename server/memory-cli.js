'use strict';

// `glissa memory` - the cold-path operator commands over the long-term memory store.
//
// Lives in server/ for the same reason server/pack-cli.js does: package.json "files" whitelists bin
// entries one by one but ships server/ wholesale.

const USAGE = [
  'Usage: glissa memory <command>',
  '',
  'Commands:',
  '  forget <id|pattern>  Expunge a remembered record, or the matched text in every record',
  '  backfill             Read the gap since the last pass out of the local agent transcripts',
  '  distill [--dry-run]  Rebuild the published projection from the canon with one headless pass',
].join('\n');

function defaultMakeStore() {
  const { resolveConfigPath, loadConfigFile } = require('./config-store');
  const { createMemoryStore } = require('./memory-store');
  const { configSiblingPath } = require('./pairings-store');
  const { DB_FILE_NAME } = require('./glissa-db');
  const { resolveMemoryConfig } = require('./core/memory-core');
  const path = require('node:path');
  const configPath = resolveConfigPath();
  const loaded = loadConfigFile(configPath, { exitOnError: false });
  const resolved = resolveMemoryConfig(loaded?.config ? loaded.config.memory : null);
  return createMemoryStore({
    dir: configSiblingPath(configPath, 'memory'),
    // The same machine-wide database the server opens, so a CLI pass beside it is one connection more.
    dbPath: path.join(path.dirname(configPath), DB_FILE_NAME),
    // An operator running this command IS the authorization, exactly like `glissa pack distill`; the
    // enabled flag gates the automatic lane, not a deliberate expunge.
    config: { ...resolved, enabled: true },
  });
}

// The store is null when node:sqlite is unavailable, which is the one way the whole lane stays off.
function reportNoStore() {
  console.error('The memory store could not be opened: this Node build has no node:sqlite (needs 22.16+).');
  return 1;
}

async function runForget(needle, makeStore) {
  if (!needle) {
    console.error('Nothing to forget: pass a record id (m-...) or a text pattern.');
    return 1;
  }
  const store = makeStore();
  if (!store) return reportNoStore();
  try {
    const result = await store.forget(needle);
    // A busy database is not an empty search; reporting "nothing matched" told the operator their
    // secret was absent when it is still on disk.
    if (result && result.reason === 'locked') {
      console.error('The memory database was busy for the whole timeout. Nothing was written: retry in a moment.');
      return 1;
    }
    if (!result || !result.ok) {
      console.log('No remembered record matched. Nothing was written.');
      return 1;
    }
    console.log(`Removed ${result.removed} record(s), redacted ${result.redacted}, across ${result.segments} segment(s).`);
    console.log(`Tombstone: ${result.tombstoneId || '(not written)'}`);
    console.log(`Projection rebuilt under ${store.distDir}`);
    return 0;
  } finally {
    await store.stop();
  }
}

// The lane ledger is loaded before the pass, not during it: an ephemeral lane's transcript must be
// excluded on the FIRST file this reads, not once an async load happens to land.
async function defaultMakeIngest(store) {
  const { createMemoryIngest, earliestLaneEntryMs } = require('./memory-ingest-wiring');
  const { createLaneLedger } = require('./usage-lane-ledger');
  const { resolveConfigPath } = require('./config-store');
  const { configSiblingPath } = require('./pairings-store');
  const ledger = createLaneLedger({ ledgerPath: configSiblingPath(resolveConfigPath(), 'usage-lanes.json') });
  await ledger.load();
  return createMemoryIngest({
    store,
    laneMap: () => ledger.laneMap(),
    laneFloorMs: () => earliestLaneEntryMs(ledger),
  });
}

async function runBackfill(makeStore, makeIngest) {
  const store = makeStore();
  if (!store) return reportNoStore();
  const ingest = await makeIngest(store);
  try {
    const result = await ingest.backfill();
    if (result.reason === 'locked') {
      console.error('The memory database was busy for the whole timeout. Nothing was read: retry in a moment.');
      return 1;
    }
    if (!result.ok) {
      console.error(`The backfill did not run: ${result.reason}.`);
      return 1;
    }
    const stats = ingest.stats();
    console.log(`Read ${result.bytesRead} byte(s) across ${result.files} transcript(s).`);
    console.log(`Remembered ${stats.written} record(s); ${stats.rejected} were refused by the write gates.`);
    if (result.partial) console.log('The byte budget was reached: run it again to continue where it stopped.');
    console.log(`Offsets: ${ingest.statePath}`);
    return 0;
  } finally {
    await ingest.stop();
    await store.stop();
  }
}

// An operator running this command IS the authorization, so the lane's own enabled flag is bypassed
// exactly the way `glissa pack distill` bypasses config.packDistiller.
function defaultMakeDistiller(store) {
  const { loadConfigFile, resolveConfigPath } = require('./config-store');
  const { createMemoryDistiller } = require('./memory-distill');
  const { resolveDistillConfig } = require('./core/memory-distill-core');
  const loaded = loadConfigFile(resolveConfigPath(), { exitOnError: false });
  const raw = loaded?.config?.memory ? loaded.config.memory.distill : null;
  return createMemoryDistiller({
    store,
    config: { ...resolveDistillConfig(raw, { memoryEnabled: true }), enabled: true },
  });
}

async function runDistill(makeStore, makeDistiller, { dryRun }) {
  const store = makeStore();
  if (!store) return reportNoStore();
  const distiller = makeDistiller(store);
  try {
    const result = await distiller.runOnce({ dryRun, force: true });
    if (result.status === 'locked') {
      console.error('The memory database was busy for the whole timeout. Nothing was written: retry in a moment.');
      return 1;
    }
    if (result.status === 'error') {
      console.error(`The distill run did not finish: ${result.reason}.`);
      return 1;
    }
    if (dryRun) {
      console.log(`${result.records} record(s) would be distilled. Nothing was spawned.`);
      return 0;
    }
    if (result.pending) {
      console.log(`Held for review under ${store.pendingDir}: ${result.reason}.`);
      return 1;
    }
    if (result.status === 'current') {
      console.log('The published projection already said it. Nothing was written.');
      return 0;
    }
    console.log(`Published ${result.published ? 'a new build' : 'nothing new'} at ${result.version}.`);
    console.log(`Projection: ${store.projectionPath}`);
    return 0;
  } finally {
    await distiller.stop();
    await store.stop();
  }
}

async function runMemoryCli(args, deps = {}) {
  const {
    makeStore = defaultMakeStore, makeIngest = defaultMakeIngest, makeDistiller = defaultMakeDistiller,
  } = deps;
  const command = args[0];
  if (command === 'forget') return runForget(args[1], makeStore);
  if (command === 'backfill') return runBackfill(makeStore, makeIngest);
  if (command === 'distill') return runDistill(makeStore, makeDistiller, { dryRun: args.includes('--dry-run') });
  console.error(USAGE);
  return 1;
}

module.exports = { runMemoryCli, USAGE };
