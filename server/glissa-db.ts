import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { decideDbOpenRefusal, homeDbRefusedError, underTestRunner } from './core/db-path-guard.ts';

const SCHEMA_VERSION = 1;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DB_FILE_NAME = 'glissa.db';
const DB_FILE_MODE = 0o600;

type SqliteModule = typeof import('node:sqlite');
type DbFileSystem = Pick<typeof nodeFs, 'closeSync' | 'openSync' | 'chmodSync' | 'mkdirSync'>;

function loadSqlite(): SqliteModule | null {
  try {
    return process.getBuiltinModule('node:sqlite') ?? null;
  } catch {
    return null;
  }
}

function isSqliteAvailable(): boolean {
  return loadSqlite() !== null;
}

function dbPathForConfig(configPath: unknown): string {
  if (typeof configPath !== 'string' || !configPath) throw new Error('dbPathForConfig needs a config file path');
  return path.join(path.dirname(configPath), DB_FILE_NAME);
}

function isBusyError(error: unknown): boolean {
  const source = (error ?? {}) as { code?: unknown; message?: unknown };
  const text = `${source.code || ''} ${source.message || ''}`;
  return /SQLITE_BUSY|database is locked/i.test(text);
}

function precreateDbFile(dbPath: string, fs: DbFileSystem): void {
  try {
    fs.closeSync(fs.openSync(dbPath, 'a', DB_FILE_MODE));
  } catch {
  }
}

function restrictDbFileMode(dbPath: string, fs: DbFileSystem): void {
  try {
    fs.chmodSync(dbPath, DB_FILE_MODE);
  } catch {
  }
}

function openDatabase(dbPath: string, { busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS, fs = nodeFs }: {
  busyTimeoutMs?: number;
  fs?: DbFileSystem;
} = {}): DatabaseSync {
  const sqlite = loadSqlite();
  if (!sqlite) throw new Error('node:sqlite is unavailable');
  const refusal = decideDbOpenRefusal({
    dbPath,
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    isTestRunner: underTestRunner(process.env),
  });

  if (refusal) throw homeDbRefusedError(refusal);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  precreateDbFile(dbPath, fs);
  const db = new sqlite.DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  db.exec('PRAGMA synchronous = NORMAL');

  db.exec('PRAGMA secure_delete = ON');
  restrictDbFileMode(dbPath, fs);
  return db;
}

function applySchema(db: DatabaseSync, statements: Iterable<string>): void {
  for (const statement of statements) db.exec(statement);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function pragmaNumber(db: DatabaseSync, pragma: string, column: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  const value = row ? row[column] : undefined;
  return typeof value === 'number' ? value : Number(value);
}

function dataVersion(db: DatabaseSync): number {
  return pragmaNumber(db, 'data_version', 'data_version');
}

function schemaVersion(db: DatabaseSync): number {
  return pragmaNumber(db, 'user_version', 'user_version');
}

export {
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
export type { DbFileSystem };
