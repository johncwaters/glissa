import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendJsonLine, appendJsonLineIdle } from '../server/json-file.ts';
import type { AsyncWriteOptions } from '../server/json-file.ts';

type AsyncFileSystem = NonNullable<AsyncWriteOptions['fsPromises']>;

function tempFile(name: string): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-append-'));
  return { dir, filePath: path.join(dir, name) };
}

function parsedField(filePath: string, field: string): unknown[] {
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    .map((line) => {
      const record: unknown = JSON.parse(line);
      if (typeof record !== 'object' || record === null || !(field in record)) return null;
      return record[field as keyof typeof record];
    });
}

test('concurrent appends to one path land whole and in call order', async () => {
  const { dir, filePath } = tempFile('canon-202608.jsonl');
  try {
    const writes: Promise<void>[] = [];
    for (let index = 0; index < 50; index += 1) {
      writes.push(appendJsonLine(filePath, { index, filler: 'x'.repeat(1024) }, { mkdir: true }));
    }
    await Promise.all(writes);
    assert.equal(fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).length, 50);
    assert.deepEqual(parsedField(filePath, 'index'), writes.map((_value, index) => index));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appends to different paths do not block each other and each file is complete', async () => {
  const { dir } = tempFile('unused');
  try {
    const first = path.join(dir, 'canon-202607.jsonl');
    const second = path.join(dir, 'canon-202608.jsonl');
    await Promise.all([
      appendJsonLine(first, { at: 1 }, { mkdir: true }),
      appendJsonLine(second, { at: 2 }, { mkdir: true }),
      appendJsonLine(first, { at: 3 }, { mkdir: true }),
    ]);
    assert.deepEqual(parsedField(first, 'at'), [1, 3]);
    assert.deepEqual(parsedField(second, 'at'), [2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed append does not wedge the chain for the next writer', async () => {
  const { dir, filePath } = tempFile('canon-202608.jsonl');
  try {
    const refusingDisk: AsyncFileSystem = {
      mkdir: fs.promises.mkdir,
      writeFile: fs.promises.writeFile,
      rename: fs.promises.rename,
      rm: fs.promises.rm,
      appendFile: async () => { throw new Error('disk gone'); },
    };
    const failing = appendJsonLine(filePath, { at: 1 }, { mkdir: false, fsPromises: refusingDisk });
    await assert.rejects(failing, /disk gone/);
    await appendJsonLine(filePath, { at: 2 }, { mkdir: true });
    assert.deepEqual(parsedField(filePath, 'at'), [2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendJsonLineIdle drains what is queued and settles when nothing is', async () => {
  const { dir, filePath } = tempFile('canon-202608.jsonl');
  try {
    assert.equal(await appendJsonLineIdle(filePath), undefined);
    void appendJsonLine(filePath, { at: 1 }, { mkdir: true });
    void appendJsonLine(filePath, { at: 2 }, { mkdir: true });
    await appendJsonLineIdle(filePath);
    assert.equal(fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
