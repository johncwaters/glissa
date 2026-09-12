import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJsonStateStore, loadJsonStateFile, writeTextAtomic, writeTextAtomicSync } from '../server/json-file.ts';
import type { AsyncWriteOptions, SyncWriteOptions } from '../server/json-file.ts';

type AsyncFileSystem = NonNullable<AsyncWriteOptions['fsPromises']>;
type SyncFileSystem = NonNullable<SyncWriteOptions['fsSync']>;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-atomic-'));
}

function renameError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: operation not permitted, rename`);
  error.code = code;
  return error;
}

function failsWithCode(code: string): (error: unknown) => boolean {
  return (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function flakyRenameSync(failures: number, code = 'EPERM'): { calls: { rename: number }; fsSync: SyncFileSystem } {
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

function flakyRename(failures: number, code = 'EPERM'): { calls: { rename: number }; fsPromises: AsyncFileSystem } {
  const calls = { rename: 0 };
  return {
    calls,
    fsPromises: {
      mkdir: fs.promises.mkdir,
      writeFile: fs.promises.writeFile,
      appendFile: fs.promises.appendFile,
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
    await assert.rejects(() => writeTextAtomic(target, '{"ok":true}', { fsPromises }), failsWithCode('EPERM'));
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
    await assert.rejects(() => writeTextAtomic(target, '{"ok":true}', { fsPromises }), failsWithCode('ENOSPC'));
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
    assert.throws(() => writeTextAtomicSync(target, '{"port":3000}', { fsSync }), failsWithCode('EBUSY'));
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
    const seen: string[] = [];
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

test('the state loader distinguishes missing, loaded, quarantined, and unreadable files', async () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'state.json');
    const missing = await loadJsonStateFile({ filePath: target, fsPromises: fs.promises, parse: (raw) => raw, nowMs: () => 10 });
    assert.deepEqual(missing, { status: 'missing' });

    fs.writeFileSync(target, '{"saved":true}');
    const loaded = await loadJsonStateFile({ filePath: target, fsPromises: fs.promises, parse: (raw) => raw, nowMs: () => 10 });
    assert.deepEqual(loaded, { status: 'loaded', value: { saved: true } });

    const original = '{}';
    fs.writeFileSync(target, original);
    const quarantined = await loadJsonStateFile({ filePath: target, fsPromises: fs.promises, parse: () => null, nowMs: () => 42 });
    const movedTo = `${target}.corrupt-42`;
    assert.deepEqual(quarantined, { status: 'quarantined', movedTo });
    assert.equal(fs.readFileSync(movedTo, 'utf8'), original);

    const unreadable = await loadJsonStateFile({
      filePath: target,
      fsPromises: { ...fs.promises, readFile: async () => { throw renameError('EACCES'); } },
      parse: (raw) => raw,
      nowMs: () => 10,
    });
    assert.equal(unreadable.status, 'unreadable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the state store stops writing while the file is unreadable and resumes once it loads again', async () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'state.json');
    const corruptBytes = 'not json at all';
    fs.writeFileSync(target, corruptBytes);
    let quarantineFails = true;
    const adopted: Array<{ saved: number } | null> = [];
    const warnings: string[] = [];
    const store = createJsonStateStore<{ saved: number }>({
      name: 'ledger',
      filePath: target,
      fsPromises: {
        ...fs.promises,
        rename: (from, to) => {
          if (quarantineFails && String(to).includes('.corrupt-')) return Promise.reject(renameError('EACCES'));
          return fs.promises.rename(from, to);
        },
      },
      nowMs: () => 42,
      parse: (raw) => (raw && typeof raw === 'object' ? raw as { saved: number } : null),
      adopt: (loadedValue) => { adopted.push(loadedValue); },
      warn: (message) => { warnings.push(message); },
    });

    await store.load();
    assert.deepEqual(warnings, ['ledger unreadable']);
    assert.deepEqual(adopted, [], 'an unreadable file hands the caller nothing to adopt');

    await store.write({ saved: 1 }, () => '{"saved":1}');
    assert.equal(fs.readFileSync(target, 'utf8'), corruptBytes, 'the bytes stand while the file is unreadable');

    quarantineFails = false;
    fs.writeFileSync(target, '{"saved":7}');
    await store.load();
    assert.deepEqual(adopted, [{ saved: 7 }], 'the loaded value reaches the caller');

    await store.write({ saved: 8 }, () => '{"saved":8}');
    await store.idle();
    assert.equal(fs.readFileSync(target, 'utf8'), '{"saved":8}', 'a readable file takes writes again');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the state store quarantines a corrupt file once and warns with both paths', async () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'state.json');
    const corruptBytes = '{ invalid';
    fs.writeFileSync(target, corruptBytes);
    const adopted: Array<{ saved: number } | null> = [];
    const warnings: Array<{ message: string; fields: Record<string, string> }> = [];
    const store = createJsonStateStore<{ saved: number }>({
      name: 'warehouse',
      filePath: target,
      nowMs: () => 42,
      parse: () => null,
      adopt: (loadedValue) => { adopted.push(loadedValue); },
      warn: (message, fields) => { warnings.push({ message, fields }); },
    });

    await store.load();
    await store.load();

    assert.deepEqual(warnings, [{ message: 'warehouse quarantined', fields: { path: target, movedTo: `${target}.corrupt-42` } }]);
    assert.deepEqual(adopted, [null], 'a quarantined file leaves the caller with no value');
    assert.equal(fs.readFileSync(`${target}.corrupt-42`, 'utf8'), corruptBytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a state store without a path reads nothing and writes nothing', async () => {
  const adopted: Array<{ saved: number } | null> = [];
  const warnings: string[] = [];
  const store = createJsonStateStore<{ saved: number }>({
    name: 'budget state',
    filePath: null,
    parse: (raw) => raw as { saved: number },
    adopt: (loadedValue) => { adopted.push(loadedValue); },
    warn: (message) => { warnings.push(message); },
  });

  await store.load();
  await store.write({ saved: 1 }, () => {
    throw new Error('a store with no path never builds a payload');
  });
  await store.idle();

  assert.deepEqual(adopted, []);
  assert.deepEqual(warnings, []);
});
