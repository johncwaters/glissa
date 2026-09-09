import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { idForEntry, pruneAgedFiles } from '../server/prune-files.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-06T00:00:00.000Z');
const directories: string[] = [];

after(() => {
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
});

function workspace(name: string, files: Record<string, number>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `glissa-prune-${name}-`));
  directories.push(directory);
  for (const [name_, ageDays] of Object.entries(files)) {
    const filePath = path.join(directory, name_);
    fs.writeFileSync(filePath, '{}\n', 'utf8');
    const stamp = new Date(NOW - (ageDays * DAY_MS));
    fs.utimesSync(filePath, stamp, stamp);
  }
  return directory;
}

test('the suffix list decides which entries the walk even considers', () => {
  assert.equal(idForEntry('abc.checkpoint.json', ['.checkpoint.json', '.jsonl']), 'abc');
  assert.equal(idForEntry('abc.jsonl', ['.checkpoint.json', '.jsonl']), 'abc');
  assert.equal(idForEntry('abc.md', ['.jsonl']), null);
  assert.equal(idForEntry('abc.jsonl', ['.checkpoint.json']), null);
});

test('only files older than the retain window are removed, and their ids are reported', async () => {
  const directory = workspace('window', { 'old.jsonl': 40, 'recent.jsonl': 20, 'notes.md': 40 });
  const removed = await pruneAgedFiles({ directory, suffixes: ['.jsonl'], retainDays: 30, now: NOW });
  assert.deepEqual(removed, ['old']);
  assert.equal(fs.existsSync(path.join(directory, 'old.jsonl')), false);
  assert.equal(fs.existsSync(path.join(directory, 'recent.jsonl')), true);
  assert.equal(fs.existsSync(path.join(directory, 'notes.md')), true, 'an unlisted suffix is never touched');
});

test('a retained id survives the walk however old its file is', async () => {
  const directory = workspace('retained', { 'live.jsonl': 90, 'dead.jsonl': 90 });
  const removed = await pruneAgedFiles({
    directory,
    suffixes: ['.jsonl'],
    retainDays: 30,
    now: NOW,
    isRetainedId: (id) => id === 'live',
  });
  assert.deepEqual(removed, ['dead']);
  assert.equal(fs.existsSync(path.join(directory, 'live.jsonl')), true);
});

test('a missing directory is not an error, since a lane prunes before it ever writes', async () => {
  assert.deepEqual(
    await pruneAgedFiles({ directory: path.join(os.tmpdir(), 'glissa-prune-absent'), suffixes: ['.jsonl'], retainDays: 30 }),
    [],
  );
});

test('one id with two suffixes is reported once per file removed', async () => {
  const directory = workspace('pair', { 'gone.jsonl': 90, 'gone.checkpoint.json': 90 });
  const removed = await pruneAgedFiles({
    directory,
    suffixes: ['.checkpoint.json', '.jsonl'],
    retainDays: 7,
    now: NOW,
  });
  assert.deepEqual(removed.sort(), ['gone', 'gone']);
});

test('directory mode removes an aged directory and preserves a live directory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-prune-directories-'));
  directories.push(directory);
  for (const name of ['old', 'live']) {
    const target = path.join(directory, name);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'upload.txt'), 'upload');
    fs.utimesSync(target, new Date(NOW - 90 * DAY_MS), new Date(NOW - 90 * DAY_MS));
  }
  const removed = await pruneAgedFiles({
    directory, suffixes: [''], retainDays: 7, now: NOW, entryMode: 'directory', isRetainedId: (id) => id === 'live',
  });
  assert.deepEqual(removed, ['old']);
  assert.equal(fs.existsSync(path.join(directory, 'old')), false);
  assert.equal(fs.existsSync(path.join(directory, 'live')), true);
});
