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
  '  backfill             Re-run the cold-start transcript backfill',
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

function runBackfill() {
  console.log('glissa memory backfill is not yet available: transcript ingestion ships in M14.');
  return 1;
}

async function runMemoryCli(args, deps = {}) {
  const { makeStore = defaultMakeStore } = deps;
  const command = args[0];
  if (command === 'forget') return runForget(args[1], makeStore);
  if (command === 'backfill') return runBackfill();
  console.error(USAGE);
  return 1;
}

module.exports = { runMemoryCli, USAGE };
