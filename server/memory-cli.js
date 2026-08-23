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
].join('\n');

function defaultMakeStore() {
  const { resolveConfigPath, loadConfigFile } = require('./config-store');
  const { createMemoryStore } = require('./memory-store');
  const { configSiblingPath } = require('./pairings-store');
  const { resolveMemoryConfig } = require('./core/memory-core');
  const configPath = resolveConfigPath();
  const loaded = loadConfigFile(configPath, { exitOnError: false });
  const resolved = resolveMemoryConfig(loaded?.config ? loaded.config.memory : null);
  return createMemoryStore({
    dir: configSiblingPath(configPath, 'memory'),
    // An operator running this command IS the authorization, exactly like `glissa pack distill`; the
    // enabled flag gates the automatic lane, not a deliberate expunge.
    config: { ...resolved, enabled: true },
  });
}

async function runForget(needle, makeStore) {
  if (!needle) {
    console.error('Nothing to forget: pass a record id (m-...) or a text pattern.');
    return 1;
  }
  const store = makeStore();
  try {
    const result = await store.forget(needle);
    // A held canon lock is not an empty search; reporting "nothing matched" told the operator their
    // secret was absent when it is still on disk.
    if (result && result.reason === 'locked') {
      console.error('Another process holds the memory store lock. Nothing was written: retry in a moment.');
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
  const ingest = await makeIngest(store);
  try {
    const result = await ingest.backfill();
    // A live server takes the same lock for its pass, and two passes over one tail-state file double-read.
    if (result.reason === 'locked') {
      console.error('Another process holds the memory store lock, most likely a running Glissa. Nothing was read.');
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

async function runMemoryCli(args, deps = {}) {
  const { makeStore = defaultMakeStore, makeIngest = defaultMakeIngest } = deps;
  const command = args[0];
  if (command === 'forget') return runForget(args[1], makeStore);
  if (command === 'backfill') return runBackfill(makeStore, makeIngest);
  console.error(USAGE);
  return 1;
}

module.exports = { runMemoryCli, USAGE };
