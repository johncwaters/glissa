'use strict';

/*
 * The one atomic tmp+rename writer every durable state file in server/ commits through, plus the
 * signature-gated, chain-serialized writer the usage lane's three state files share.
 *
 * tmp+rename is what keeps a crash mid-write from leaving a half-written file behind, and the temp
 * name carries pid + counter because two processes (the pair CLI and the server) and two writes in one
 * process both legitimately race for the same target.
 */

const fs = require('node:fs');
const path = require('node:path');

/** @typedef {{ mode?: number, encoding?: BufferEncoding, mkdir?: boolean, fsSync?: typeof fs }} SyncWriteOptions */
/** @typedef {{ mode?: number, encoding?: BufferEncoding, mkdir?: boolean, fsPromises?: typeof fs.promises }} AsyncWriteOptions */

let tmpCounter = 0;

function tmpPathFor(filePath) {
  tmpCounter += 1;
  return `${filePath}.tmp.${process.pid}.${tmpCounter}`;
}

/** @param {number | undefined} mode @param {BufferEncoding} encoding */
function writeOptions(mode, encoding) {
  if (mode == null) return { encoding };
  return { encoding, mode };
}

// Windows fails a rename onto a target a scanner still holds with a transient EPERM/EACCES/EBUSY.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;

function renameRetryDelayMs(attempt) {
  return Math.min(10 * 2 ** attempt, 50);
}

function isRetryableRename(error, attempt) {
  if (attempt >= RENAME_ATTEMPTS - 1) return false;
  return RENAME_RETRY_CODES.has(error?.code);
}

// A real sleep, not a spin; every sync caller is a cold path and this runs only after a rename failed.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// One retry plan for both loops below: null means rethrow, a number is the backoff before the next try.
function renameRetryPlan(error, attempt) {
  if (!isRetryableRename(error, attempt)) return null;
  return renameRetryDelayMs(attempt);
}

// Two thin loops over that one plan, deliberately not unified: a shared driver would force the sync writers' callers async.
function renameWithRetrySync(fsSync, tmpPath, filePath) {
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

async function renameWithRetry(fsPromises, tmpPath, filePath) {
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

/** @param {string} filePath @param {string} content @param {SyncWriteOptions} [options] */
function writeTextAtomicSync(filePath, content, {
  mode, encoding = 'utf8', mkdir = false, fsSync = fs,
} = {}) {
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

/** @param {string} filePath @param {unknown} value @param {SyncWriteOptions} [options] */
function writeJsonAtomicSync(filePath, value, options) {
  writeTextAtomicSync(filePath, JSON.stringify(value, null, 2), options);
}

/** @param {string} filePath @param {string} content @param {AsyncWriteOptions} [options] */
async function writeTextAtomic(filePath, content, {
  mode, encoding = 'utf8', mkdir = false, fsPromises = fs.promises,
} = {}) {
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

/** @param {string} filePath @param {unknown} value @param {AsyncWriteOptions} [options] */
async function writeJsonAtomic(filePath, value, options) {
  await writeTextAtomic(filePath, JSON.stringify(value, null, 2), options);
}

/** @type {Map<string, Promise<void>>} */
const appendChains = new Map();

/**
 * One JSON line onto the end of a file, serialized PER PATH: an append-only log is only append-only if
 * two concurrent writers cannot interleave a partial line, and node's appendFile gives no such order.
 * @param {string} filePath
 * @param {unknown} value
 * @param {AsyncWriteOptions} [options]
 */
function appendJsonLine(filePath, value, {
  fsPromises = fs.promises, mkdir = false, encoding = 'utf8', mode,
} = {}) {
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
function appendJsonLineIdle(filePath) {
  return appendChains.get(filePath) || Promise.resolve();
}

/**
 * Signature-gated durable state writer: an unchanged payload writes nothing, every write is serialized
 * on one chain, and a failed write clears the signature so the next pass retries instead of believing
 * the file already holds what it never received.
 */
/**
 * @param {{ filePath: string, fsPromises?: typeof fs.promises, warn?: (error: unknown) => void }} options
 */
function createJsonStateWriter({ filePath, fsPromises = fs.promises, warn = () => {} }) {
  /** @type {string|null} */
  let signature = null;
  let writeChain = Promise.resolve();

  async function commit(payload) {
    try {
      await writeTextAtomic(filePath, payload, { fsPromises, mkdir: true });
    } catch (error) {
      warn(error);
      signature = null;
    }
  }

  /** @param {unknown} subject @param {() => string} buildPayload */
  async function write(subject, buildPayload) {
    const next = JSON.stringify(subject);
    if (next === signature) return;
    signature = next;
    // Not redundant: commit's own catch can throw (a bad logger), which must not fail the caller's pass.
    writeChain = writeChain.then(() => commit(buildPayload())).catch(() => {});
    await writeChain;
  }

  function reset() {
    signature = null;
  }

  return { write, reset, idle: () => writeChain };
}

module.exports = {
  appendJsonLine,
  appendJsonLineIdle,
  createJsonStateWriter,
  writeJsonAtomic,
  writeJsonAtomicSync,
  writeTextAtomic,
  writeTextAtomicSync,
};
