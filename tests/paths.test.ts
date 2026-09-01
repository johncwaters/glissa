// shared/paths.ts - deciding when two spellings name one physical directory, and producing the one
// spelling every producer agrees on. The case that reaches CI is the 8.3 short form: a runner's
// %TEMP% is C:\Users\RUNNER~1\..., so a path derived from os.tmpdir() is short while git porcelain
// reports the long form of the very same directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalizePath, isSameDirectoryPath } from '../shared/paths.ts';
import { SHORT_NAMES_AVAILABLE, shortPathOf, withTempDir } from './helpers/short-path.ts';

const WIN = process.platform === 'win32';

test('isSameDirectoryPath matches spellings differing by separator, trailing slash, or case', { skip: !WIN }, () => {
  assert.ok(isSameDirectoryPath('C:\\repo\\project', 'C:/repo/project'), 'forward slashes, as git porcelain emits');
  assert.ok(isSameDirectoryPath('C:\\repo\\project', 'C:\\repo\\project\\'), 'trailing separator');
  assert.ok(isSameDirectoryPath('C:\\Repo\\Project', 'c:\\repo\\project'), 'Windows paths are case-insensitive');
});

test('isSameDirectoryPath keeps genuinely different directories apart', () => {
  const a = path.join(os.tmpdir(), 'glissa-paths-a');
  const b = path.join(os.tmpdir(), 'glissa-paths-b');
  assert.ok(!isSameDirectoryPath(a, b));
});

test('isSameDirectoryPath treats an 8.3 short path and its long form as one directory', { skip: !SHORT_NAMES_AVAILABLE }, () => {
  withTempDir((dir) => {
    const short = shortPathOf(dir);
    assert.ok(short, 'the volume mints an 8.3 alias');
    assert.notEqual(short.toLowerCase(), dir.toLowerCase(), 'the fixture really is a second spelling');
    assert.ok(isSameDirectoryPath(short, dir), 'short and long spellings name the same worktree');
  });
});

test('canonicalizePath expands an 8.3 short path to its long form', { skip: !SHORT_NAMES_AVAILABLE }, () => {
  withTempDir((dir) => {
    const short = shortPathOf(dir);
    assert.ok(short, 'the volume mints an 8.3 alias');
    const canonical = canonicalizePath(short);
    assert.equal(canonical.toLowerCase(), fs.realpathSync.native(dir).toLowerCase());
    assert.ok(!canonical.includes('~'), 'no 8.3 tilde survives, which is what fs.watch requires');
  });
});

test('canonicalizePath returns the input untouched when the path is not on disk', () => {
  const absent = path.join(os.tmpdir(), `glissa-paths-absent-${process.pid}`);
  assert.equal(canonicalizePath(absent), absent);
});
