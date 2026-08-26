'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isUnder } = require('../server/core/db-path-guard');
const { createMemoryStore } = require('../server/memory-store');
const { resolveMemoryConfig } = require('../server/core/memory-core');

const FIXTURE_SESSION_ID = /^(?:sess|s)-\d+$/;
const DB_SIDECAR_SUFFIXES = ['', '-wal', '-shm'];
const QUIET = { log() {}, warn() {} };

function describeCount(records) {
  const remembered = records.filter((record) => record.kind !== 'tombstone').length;
  return `${records.length} record(s), ${remembered} of them remembered text`;
}

function parseArgs(argv) {
  const rest = [];
  let memoryDir = null;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--memory-dir') {
      index += 1;
      memoryDir = argv[index] || null;
      continue;
    }
    rest.push(arg);
  }
  return { dbPath: rest[0] || null, memoryDir, dryRun };
}

function isExistingDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function fixtureReason(record) {
  if (record.kind === 'tombstone') return null;
  const sessionId = record.source ? record.source.sessionId : null;
  if (typeof sessionId === 'string' && FIXTURE_SESSION_ID.test(sessionId)) return 'session';
  const project = record.project;
  if (typeof project !== 'string' || project === '') return null;
  if (!path.isAbsolute(project)) return 'project';
  if (isExistingDirectory(project) || isExistingDirectory(path.dirname(project))) return null;
  return 'project';
}

// Ingest offsets for transcripts that were temp fixtures: dead weight, and a re-read of a gone file is a no-op.
function staleTempTails(store, tmpDir) {
  const state = store.tailState();
  const files = state?.files ? Object.keys(state.files) : [];
  return files.filter((file) => isUnder(file, tmpDir) && !fs.existsSync(file));
}

function backupDatabase(dbPath, now) {
  const stamp = `.bak-${now}`;
  const copied = [];
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    const source = `${dbPath}${suffix}`;
    if (!fs.existsSync(source)) continue;
    const target = `${dbPath}${stamp}${suffix}`;
    fs.copyFileSync(source, target);
    copied.push(target);
  }
  return copied;
}

async function purgeFixtures({ dbPath, memoryDir = null, dryRun = false, now = () => Date.now(), out = console }) {
  const resolvedDb = path.resolve(dbPath);
  const dir = memoryDir ? path.resolve(memoryDir) : path.join(path.dirname(resolvedDb), 'memory');
  const store = createMemoryStore({
    dir,
    dbPath: resolvedDb,
    config: { ...resolveMemoryConfig(null), enabled: true },
    logger: QUIET,
  });
  if (!store) {
    out.error('The memory store could not be opened: this Node build has no node:sqlite (needs 22.16+).');
    return { ok: false, before: 0, after: 0, removed: 0, tails: 0, indexed: null, backups: [] };
  }
  try {
    const before = store.records();
    const doomed = before.map((record) => ({ record, reason: fixtureReason(record) })).filter((entry) => entry.reason);
    const byProject = doomed.filter((entry) => entry.reason === 'project').length;
    const staleTails = staleTempTails(store, os.tmpdir());
    out.log(`before: ${describeCount(before)}`);
    out.log(`fixtures: ${doomed.length} (${byProject} by project key, ${doomed.length - byProject} by session id)`);
    out.log(`stale temp tail offsets: ${staleTails.length}`);
    if (dryRun || doomed.length + staleTails.length === 0) {
      out.log(dryRun ? 'dry run: nothing written' : 'nothing to purge');
      return { ok: true, before: before.length, after: before.length, removed: 0, tails: 0, indexed: null, backups: [] };
    }
    const backups = backupDatabase(resolvedDb, now());
    for (const target of backups) out.log(`backup: ${target}`);
    let removed = 0;
    for (const entry of doomed) {
      const outcome = await store.forget(entry.record.id);
      removed += outcome?.ok ? outcome.removed : 0;
    }
    if (staleTails.length > 0) store.forgetTails(staleTails);
    const indexed = store.rebuildSearchIndex();
    if (!store.checkpoint()) out.log('wal checkpoint refused: the expunged frames are freed on close instead');
    const after = store.records();
    out.log(`removed: ${removed} record(s), ${staleTails.length} tail offset(s), search index rebuilt to ${indexed} row(s)`);
    out.log(`after: ${describeCount(after)}`);
    return { ok: true, before: before.length, after: after.length, removed, tails: staleTails.length, indexed, backups };
  } finally {
    await store.stop().catch(() => {});
  }
}

async function main(argv) {
  const { dbPath, memoryDir, dryRun } = parseArgs(argv);
  if (!dbPath) {
    console.error('Usage: node scripts/memory-purge-fixtures.js <db-path> [--memory-dir <dir>] [--dry-run]');
    return 1;
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`No database at ${dbPath}`);
    return 1;
  }
  const result = await purgeFixtures({ dbPath, memoryDir, dryRun });
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { fixtureReason, purgeFixtures };
