'use strict';

// appendJsonLine is the append-only canon's write primitive (docs/plan-visions-3.md, M12). Its whole
// job beyond a bare appendFile is per-path serialization: two writers must never interleave a line.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { appendJsonLine, appendJsonLineIdle } = require('../server/json-file');

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-append-'));
  return { dir, filePath: path.join(dir, name) };
}

test('concurrent appends to one path land whole and in call order', async () => {
  const { dir, filePath } = tempFile('canon-202608.jsonl');
  try {
    const writes = [];
    for (let index = 0; index < 50; index += 1) {
      writes.push(appendJsonLine(filePath, { index, filler: 'x'.repeat(1024) }, { mkdir: true }));
    }
    await Promise.all(writes);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 50);
    assert.deepEqual(lines.map((line) => JSON.parse(line).index), writes.map((_value, index) => index));
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
    assert.deepEqual(
      fs.readFileSync(first, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).at),
      [1, 3]
    );
    assert.deepEqual(
      fs.readFileSync(second, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).at),
      [2]
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed append does not wedge the chain for the next writer', async () => {
  const { dir, filePath } = tempFile('canon-202608.jsonl');
  try {
    const failing = appendJsonLine(filePath, { at: 1 }, {
      mkdir: false,
      fsPromises: { appendFile: async () => { throw new Error('disk gone'); } },
    });
    await assert.rejects(failing, /disk gone/);
    await appendJsonLine(filePath, { at: 2 }, { mkdir: true });
    assert.deepEqual(
      fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).at),
      [2]
    );
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
