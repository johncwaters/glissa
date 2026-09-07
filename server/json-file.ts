import fs from 'node:fs';
import path from 'node:path';

type SyncFileSystem = Pick<typeof fs, 'mkdirSync' | 'writeFileSync' | 'renameSync' | 'rmSync'>;
type AsyncFileSystem = Pick<typeof fs.promises, 'mkdir' | 'writeFile' | 'rename' | 'rm' | 'appendFile'>;
type JsonStateLoadFileSystem = Pick<typeof import('node:fs/promises'), 'readFile' | 'rename'>;
type JsonStateFileSystem = AsyncFileSystem & JsonStateLoadFileSystem;

type JsonStateLoadOutcome<T> =
  | { status: 'missing' }
  | { status: 'loaded'; value: T }
  | { status: 'quarantined'; movedTo: string }
  | { status: 'unreadable'; error: unknown };

interface SyncWriteOptions {
  mode?: number;
  encoding?: BufferEncoding;
  mkdir?: boolean;
  fsSync?: SyncFileSystem;
}

interface AsyncWriteOptions {
  mode?: number;
  encoding?: BufferEncoding;
  mkdir?: boolean;
  fsPromises?: AsyncFileSystem;
}

let tmpCounter = 0;

function tmpPathFor(filePath: string): string {
  tmpCounter += 1;
  return `${filePath}.tmp.${process.pid}.${tmpCounter}`;
}

function writeOptions(mode: number | undefined, encoding: BufferEncoding): { encoding: BufferEncoding; mode?: number } {
  if (mode == null) return { encoding };
  return { encoding, mode };
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;

function renameRetryDelayMs(attempt: number): number {
  return Math.min(10 * 2 ** attempt, 50);
}

function isRetryableRename(error: unknown, attempt: number): boolean {
  if (attempt >= RENAME_ATTEMPTS - 1) return false;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RENAME_RETRY_CODES.has(code);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameRetryPlan(error: unknown, attempt: number): number | null {
  if (!isRetryableRename(error, attempt)) return null;
  return renameRetryDelayMs(attempt);
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadJsonStateFile<T>({ filePath, fsPromises, parse, nowMs }: {
  filePath: string;
  fsPromises: JsonStateLoadFileSystem;
  parse: (raw: unknown) => T | null;
  nowMs: () => number;
}): Promise<JsonStateLoadOutcome<T>> {
  let text: string;
  try {
    text = await fsPromises.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return { status: 'missing' };
    return { status: 'unreadable', error };
  }

  let value: T | null;
  try {
    value = parse(JSON.parse(text));
  } catch {
    value = null;
  }
  if (value !== null) return { status: 'loaded', value };

  const movedTo = `${filePath}.corrupt-${nowMs()}`;
  try {
    await fsPromises.rename(filePath, movedTo);
  } catch (error) {
    return { status: 'unreadable', error };
  }
  return { status: 'quarantined', movedTo };
}

function renameWithRetrySync(fsSync: SyncFileSystem, tmpPath: string, filePath: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fsSync.renameSync(tmpPath, filePath);
      return;
    } catch (error) {
      const delayMs = renameRetryPlan(error, attempt);
      if (delayMs === null) throw error;
      sleepSync(delayMs);
    }
  }
}

async function renameWithRetry(fsPromises: AsyncFileSystem, tmpPath: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsPromises.rename(tmpPath, filePath);
      return;
    } catch (error) {
      const delayMs = renameRetryPlan(error, attempt);
      if (delayMs === null) throw error;
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    }
  }
}

function writeTextAtomicSync(filePath: string, content: string, {
  mode, encoding = 'utf8', mkdir = false, fsSync = fs,
}: SyncWriteOptions = {}): void {
  if (mkdir) fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = tmpPathFor(filePath);
  fsSync.writeFileSync(tmpPath, content, writeOptions(mode, encoding));
  try {
    renameWithRetrySync(fsSync, tmpPath, filePath);
  } catch (error) {
    fsSync.rmSync(tmpPath, { force: true });
    throw error;
  }
}

function writeJsonAtomicSync(filePath: string, value: unknown, options?: SyncWriteOptions): void {
  writeTextAtomicSync(filePath, JSON.stringify(value, null, 2), options);
}

async function writeTextAtomic(filePath: string, content: string, {
  mode, encoding = 'utf8', mkdir = false, fsPromises = fs.promises,
}: AsyncWriteOptions = {}): Promise<void> {
  if (mkdir) await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = tmpPathFor(filePath);
  await fsPromises.writeFile(tmpPath, content, writeOptions(mode, encoding));
  try {
    await renameWithRetry(fsPromises, tmpPath, filePath);
  } catch (error) {
    try {
      await fsPromises.rm(tmpPath, { force: true });
    } catch {}
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown, options?: AsyncWriteOptions): Promise<void> {
  await writeTextAtomic(filePath, JSON.stringify(value, null, 2), options);
}

const appendChains = new Map<string, Promise<void>>();

function appendChained(filePath: string, payload: string, {
  fsPromises = fs.promises, mkdir = false, encoding = 'utf8', mode,
}: AsyncWriteOptions = {}): Promise<void> {
  const previous = appendChains.get(filePath) || Promise.resolve();
  const next = previous.then(async () => {
    if (mkdir) await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.appendFile(filePath, payload, writeOptions(mode, encoding));
  });
  const settled = next.then(() => {}, () => {});
  appendChains.set(filePath, settled);
  settled.then(() => {
    if (appendChains.get(filePath) === settled) appendChains.delete(filePath);
  });
  return next;
}

function appendJsonLine(filePath: string, value: unknown, options?: AsyncWriteOptions): Promise<void> {
  return appendChained(filePath, `${JSON.stringify(value)}\n`, options);
}

function appendJsonLines(filePath: string, values: unknown[], options?: AsyncWriteOptions): Promise<void> {
  if (values.length === 0) return Promise.resolve();
  return appendChained(filePath, values.map((value) => `${JSON.stringify(value)}\n`).join(''), options);
}

function appendJsonLineIdle(filePath: string): Promise<void> {
  return appendChains.get(filePath) || Promise.resolve();
}

interface JsonStateWriter {
  write(subject: unknown, buildPayload: () => string): Promise<void>;
  reset(): void;
  idle(): Promise<void>;
}

function createJsonStateWriter({ filePath, fsPromises = fs.promises, warn = () => {} }: {
  filePath: string;
  fsPromises?: AsyncFileSystem;
  warn?: (error: unknown) => void;
}): JsonStateWriter {
  let signature: string | null = null;
  let writeChain: Promise<void> = Promise.resolve();

  async function commit(payload: string): Promise<void> {
    try {
      await writeTextAtomic(filePath, payload, { fsPromises, mkdir: true });
    } catch (error) {
      warn(error);
      signature = null;
    }
  }

  async function write(subject: unknown, buildPayload: () => string): Promise<void> {
    const next = JSON.stringify(subject);
    if (next === signature) return;
    signature = next;

    writeChain = writeChain.then(() => commit(buildPayload())).catch(() => {});
    await writeChain;
  }

  function reset(): void {
    signature = null;
  }

  return { write, reset, idle: () => writeChain };
}

interface JsonStateStore {
  load(): Promise<void>;
  write(subject: unknown, buildPayload: () => string): Promise<void>;
  idle(): Promise<void>;
}

function createJsonStateStore<T>({
  name,
  filePath,
  fsPromises = fs.promises,
  parse,
  adopt,
  nowMs = Date.now,
  warn = () => {},
}: {
  name: string;
  filePath: string | null;
  fsPromises?: JsonStateFileSystem;
  parse: (raw: unknown) => T | null;
  adopt: (loadedValue: T | null) => void;
  nowMs?: () => number;
  warn?: (message: string, fields: Record<string, string>) => void;
}): JsonStateStore {
  const writer = filePath
    ? createJsonStateWriter({
      filePath,
      fsPromises,
      warn: (error: unknown) => warn(`${name} write failed`, { error: errorText(error) }),
    })
    : null;
  let isFileReadable = true;
  let loadPromise: Promise<void> | null = null;

  function load(): Promise<void> {
    const statePath = filePath;
    if (!statePath) return Promise.resolve();
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const outcome = await loadJsonStateFile({ filePath: statePath, fsPromises, parse, nowMs });
      if (outcome.status === 'unreadable') {
        isFileReadable = false;
        loadPromise = null;
        warn(`${name} unreadable`, { path: statePath, error: errorText(outcome.error) });
        return;
      }
      if (outcome.status === 'quarantined') warn(`${name} quarantined`, { path: statePath, movedTo: outcome.movedTo });
      isFileReadable = true;
      adopt(outcome.status === 'loaded' ? outcome.value : null);
      writer?.reset();
    })();
    return loadPromise;
  }

  async function write(subject: unknown, buildPayload: () => string): Promise<void> {
    if (!writer || !isFileReadable) return;
    await writer.write(subject, buildPayload);
  }

  return { load, write, idle: () => (writer ? writer.idle() : Promise.resolve()) };
}

export {
  appendJsonLine,
  appendJsonLineIdle,
  appendJsonLines,
  createJsonStateStore,
  createJsonStateWriter,
  loadJsonStateFile,
  writeJsonAtomic,
  writeJsonAtomicSync,
  writeTextAtomic,
  writeTextAtomicSync,
};
export type { AsyncWriteOptions, JsonStateLoadOutcome, JsonStateStore, JsonStateWriter, SyncWriteOptions };
