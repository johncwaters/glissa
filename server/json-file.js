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

let tmpCounter = 0;

function tmpPathFor(filePath) {
  tmpCounter += 1;
  return `${filePath}.tmp.${process.pid}.${tmpCounter}`;
}

function writeOptions(mode, encoding) {
  if (mode == null) return { encoding };
  return { encoding, mode };
}

function writeTextAtomicSync(filePath, content, { mode, encoding = 'utf8', mkdir = false } = {}) {
  if (mkdir) fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = tmpPathFor(filePath);
  fs.writeFileSync(tmpPath, content, writeOptions(mode, encoding));
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

function writeJsonAtomicSync(filePath, value, options) {
  writeTextAtomicSync(filePath, JSON.stringify(value, null, 2), options);
}

async function writeTextAtomic(filePath, content, {
  mode, encoding = 'utf8', mkdir = false, fsPromises = fs.promises,
} = {}) {
  if (mkdir) await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = tmpPathFor(filePath);
  await fsPromises.writeFile(tmpPath, content, writeOptions(mode, encoding));
  try {
    await fsPromises.rename(tmpPath, filePath);
  } catch (error) {
    try {
      await fsPromises.rm(tmpPath, { force: true });
    } catch {}
    throw error;
  }
}

async function writeJsonAtomic(filePath, value, options) {
  await writeTextAtomic(filePath, JSON.stringify(value, null, 2), options);
}

const appendChains = new Map();

/**
 * One JSON line onto the end of a file, serialized PER PATH: an append-only log is only append-only if
 * two concurrent writers cannot interleave a partial line, and node's appendFile gives no such order.
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
function createJsonStateWriter({ filePath, fsPromises = fs.promises, warn = () => {} }) {
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
