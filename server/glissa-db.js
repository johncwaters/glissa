'use strict';

/*
 * The machine-wide `node:sqlite` database, beside the resolved config file. Long-term memory is its
 * first tenant, which is why every table it owns is prefixed `memory_`; a second tenant adds its own
 * prefix and its own DDL, never a second file.
 *
 * `node:sqlite` is REQUIRED, never fallen back from: two substrates means two sets of bugs. A caller
 * feature-detects with isSqliteAvailable() and stays off with one warning when it is missing.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { decideDbOpenRefusal, homeDbRefusedError, underTestRunner } = require('./core/db-path-guard');

// The shape every tenant's tables are created at. A future change is a read-old write-new pass in code.
const SCHEMA_VERSION = 1;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DB_FILE_NAME = 'glissa.db';
const DB_FILE_MODE = 0o600;

function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch {
    return null;
  }
}

function isSqliteAvailable() {
  return loadSqlite() !== null;
}

function dbPathForConfig(configPath) {
  if (typeof configPath !== 'string' || !configPath) throw new Error('dbPathForConfig needs a config file path');
  return path.join(path.dirname(configPath), DB_FILE_NAME);
}

// SQLITE_BUSY survives busy_timeout only when another writer held the lock for the whole window.
function isBusyError(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  return /SQLITE_BUSY|database is locked/i.test(text);
}

/*
 * Remembered text lives in here, so it gets the mode the canon files had. The file is PRE-CREATED at
 * 0600 rather than only chmod'd afterwards: sqlite creates it 0666-and-umask, which leaves a window
 * where a world-readable database holds remembered text. The chmod stays for a file an older build
 * already created wide. POSIX only, best effort both ways.
 */
function precreateDbFile(dbPath, fs) {
  try {
    fs.closeSync(fs.openSync(dbPath, 'a', DB_FILE_MODE));
  } catch {
    // An unopenable path fails again, and more usefully, in the sqlite open below.
  }
}

function restrictDbFileMode(dbPath, fs) {
  try {
    fs.chmodSync(dbPath, DB_FILE_MODE);
  } catch {
    // A Windows fs reports no meaningful mode, and a chmod failure must never cost the database.
  }
}

/**
 * @param {string} dbPath the database file; its directory is created if absent.
 * @returns {import('node:sqlite').DatabaseSync}
 */
function openDatabase(dbPath, { busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS, fs = nodeFs } = {}) {
  const sqlite = loadSqlite();
  if (!sqlite) throw new Error('node:sqlite is unavailable');
  const refusal = decideDbOpenRefusal({
    dbPath,
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    isTestRunner: underTestRunner(process.env),
  });
  // Before the mkdir: a refused open must not so much as create the directory it declined to write in.
  if (refusal) throw homeDbRefusedError(refusal);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  precreateDbFile(dbPath, fs);
  const db = new sqlite.DatabaseSync(dbPath);
  // WAL plus a busy timeout IS the cross-process arbiter: a CLI pass beside a live server waits, not fails.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  db.exec('PRAGMA synchronous = NORMAL');
  /*
   * A forgotten secret must not survive in a freed page. Without this, `forget` deletes the row and
   * leaves its plaintext readable with `grep -a` on the file, which the file-era tmp+rename segment
   * rewrite did not. It is one of THREE parts (see memory-db.scrubSearchIndex and checkpoint): the
   * index keeps its own copy, and the WAL keeps the frames.
   */
  db.exec('PRAGMA secure_delete = ON');
  restrictDbFileMode(dbPath, fs);
  return db;
}

function applySchema(db, statements) {
  for (const statement of statements) db.exec(statement);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/*
 * Changes only when ANOTHER connection commits, which is the whole cross-process story after the
 * lockfile: a reader compares it against what it last saw and reloads instead of watching the filesystem.
 */
function dataVersion(db) {
  return db.prepare('PRAGMA data_version').get().data_version;
}

function schemaVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

module.exports = {
  DB_FILE_MODE,
  DB_FILE_NAME,
  DEFAULT_BUSY_TIMEOUT_MS,
  SCHEMA_VERSION,
  applySchema,
  dataVersion,
  dbPathForConfig,
  isBusyError,
  isSqliteAvailable,
  openDatabase,
  schemaVersion,
};
