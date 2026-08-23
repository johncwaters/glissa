'use strict';

// The tmp+rename writers every durable state file commits through. Windows hands back a transient
// EPERM from rename whenever a scanner still holds the destination, which cost a real projection write
// mid-suite, so the rename retries briefly and rethrows the last error rather than swallowing it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeTextAtomic, writeTextAtomicSync } = require('../server/json-file');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-atomic-'));
}

function renameError(code) {
  const error = new Error(`${code}: operation not permitted, rename`);
  error.code = code;
  return error;
}

// Counts rename attempts and fails the first `failures` of them, delegating everything else to real fs.
function flakyRenameSync(failures, code = 'EPERM') {
  const calls = { rename: 0 };
  return {
    calls,
    fsSync: {
      mkdirSync: fs.mkdirSync,
      writeFileSync: fs.writeFileSync,
      rmSync: fs.rmSync,
      renameSync(from, to) {
        calls.rename += 1;
        if (calls.rename <= failures) throw renameError(code);
        return fs.renameSync(from, to);
      },
    },
  };
}

function flakyRename(failures, code = 'EPERM') {
  const calls = { rename: 0 };
  return {
    calls,
    fsPromises: {
      mkdir: fs.promises.mkdir,
      writeFile: fs.promises.writeFile,
      rm: fs.promises.rm,
      rename(from, to) {
        calls.rename += 1;
        if (calls.rename <= failures) return Promise.reject(renameError(code));
        return fs.promises.rename(from, to);
      },
    },
  };
}

test('async: a rename that fails transiently and then succeeds still lands the write', async () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'state.json');
    const { calls, fsPromises } = flakyRename(3);
    await writeTextAtomic(target, '{"ok":true}', { fsPromises });
    assert.equal(calls.rename, 4, 'three refusals then the one that landed');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"ok":true}');
    assert.deepEqual(fs.readdirSync(dir), ['state.json'], 'no tmp sibling is left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('async: an exhausted retry rethrows the last error and leaves no tmp file', async () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'state.json');
    const { calls, fsPromises } = flakyRename(Number.POSITIVE_INFINITY);
    await assert.rejects(
      () => writeTextAtomic(target, '{"ok":true}', { fsPromises }),
      (error) => error.code === 'EPERM'
    );
    assert.equal(calls.rename, 5, 'bounded at five attempts, never an unbounded loop');
    assert.equal(fs.existsSync(target), false, 'a refused write never half-lands');
    assert.deepEqual(fs.readdirSync(dir), [], 'the tmp file is swept once the retries are spent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('async: a rename error that is not the transient shape is not retried at all', async () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'state.json');
    const { calls, fsPromises } = flakyRename(Number.POSITIVE_INFINITY, 'ENOSPC');
    await assert.rejects(
      () => writeTextAtomic(target, '{"ok":true}', { fsPromises }),
      (error) => error.code === 'ENOSPC'
    );
    assert.equal(calls.rename, 1, 'a full disk is not something waiting 120ms fixes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sync: a rename that fails transiently and then succeeds still lands the write', () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'config.json');
    const { calls, fsSync } = flakyRenameSync(2);
    writeTextAtomicSync(target, '{"port":3000}', { fsSync });
    assert.equal(calls.rename, 3);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"port":3000}');
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sync: an exhausted retry rethrows the last error and leaves no tmp file', () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'config.json');
    const { calls, fsSync } = flakyRenameSync(Number.POSITIVE_INFINITY, 'EBUSY');
    assert.throws(
      () => writeTextAtomicSync(target, '{"port":3000}', { fsSync }),
      (error) => error.code === 'EBUSY'
    );
    assert.equal(calls.rename, 5);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the retried rename keeps the atomic contract: the target is never a partial file', async () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'state.json');
    fs.writeFileSync(target, 'PREVIOUS');
    const seen = [];
    const { fsPromises } = flakyRename(3);
    const inner = fsPromises.rename;
    fsPromises.rename = (from, to) => {
      seen.push(fs.readFileSync(target, 'utf8'));
      return inner(from, to);
    };
    await writeTextAtomic(target, 'NEXT', { fsPromises });
    assert.deepEqual(seen, ['PREVIOUS', 'PREVIOUS', 'PREVIOUS', 'PREVIOUS'], 'the old bytes stand until the rename lands');
    assert.equal(fs.readFileSync(target, 'utf8'), 'NEXT');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
