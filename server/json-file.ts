/*
 * The one atomic tmp+rename writer every durable state file in server/ commits through, plus the
 * signature-gated, chain-serialized writer the usage lane's three state files share.
 *
 * tmp+rename is what keeps a crash mid-write from leaving a half-written file behind, and the temp
 * name carries pid + counter because two processes (the pair CLI and the server) and two writes in one
 * process both legitimately race for the same target.
 */

import fs from 'node:fs';
import path from 'node:path';

type SyncFileSystem = Pick<typeof fs, 'mkdirSync' | 'writeFileSync' | 'renameSync' | 'rmSync'>;
type AsyncFileSystem = Pick<typeof fs.promises, 'mkdir' | 'writeFile' | 'rename' | 'rm' | 'appendFile'>;

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

// Windows fails a rename onto a target a scanner still holds with a transient EPERM/EACCES/EBUSY.
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

// A real sleep, not a spin; every sync caller is a cold path and this runs only after a rename failed.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// One retry plan for both loops below: null means rethrow, a number is the backoff before the next try.
function renameRetryPlan(error: unknown, attempt: number): number | null {
  if (!isRetryableRename(error, attempt)) return null;
  return renameRetryDelayMs(attempt);
}

// Two thin loops over that one plan, deliberately not unified: a shared driver would force the sync writers' callers async.
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

/**
 * One JSON line onto the end of a file, serialized PER PATH: an append-only log is only append-only if
 * two concurrent writers cannot interleave a partial line, and node's appendFile gives no such order.
 */
function appendJsonLine(filePath: string, value: unknown, {
  fsPromises = fs.promises, mkdir = false, encoding = 'utf8', mode,
}: AsyncWriteOptions = {}): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  const previous = appendChains.get(filePath) || Promise.resolve();
  const next = previous.then(async () => {
    if (mkdir) await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.appendFile(filePath, line, writeOptions(mode, encoding));
  });
  const settled = next.then(() => {}, () => {});
  appendChains.set(filePath, settled);
  settled.then(() => {
    if (appendChains.get(filePath) === settled) appendChains.delete(filePath);
  });
  return next;
}

// What is still queued for one path, so a caller draining on shutdown can await it.
function appendJsonLineIdle(filePath: string): Promise<void> {
  return appendChains.get(filePath) || Promise.resolve();
}

interface JsonStateWriter {
  write(subject: unknown, buildPayload: () => string): Promise<void>;
  reset(): void;
  idle(): Promise<void>;
}

/**
 * Signature-gated durable state writer: an unchanged payload writes nothing, every write is serialized
 * on one chain, and a failed write clears the signature so the next pass retries instead of believing
 * the file already holds what it never received.
 */
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
    // Not redundant: commit's own catch can throw (a bad logger), which must not fail the caller's pass.
    writeChain = writeChain.then(() => commit(buildPayload())).catch(() => {});
    await writeChain;
  }

  function reset(): void {
    signature = null;
  }

  return { write, reset, idle: () => writeChain };
}

export {
  appendJsonLine,
  appendJsonLineIdle,
  createJsonStateWriter,
  writeJsonAtomic,
  writeJsonAtomicSync,
  writeTextAtomic,
  writeTextAtomicSync,
};
export type { AsyncWriteOptions, JsonStateWriter, SyncWriteOptions };
