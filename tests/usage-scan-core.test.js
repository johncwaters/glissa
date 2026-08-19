'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideFileRead,
  projectDirCandidates,
  resolveProjectsDirs,
  splitLines,
} = require('../server/core/usage-scan-core');

test('decideFileRead covers first read, skip, append and restart', () => {
  assert.deepEqual(decideFileRead(null, { size: 10, mtimeMs: 1 }), { action: 'restart', readFrom: 0 });
  assert.deepEqual(decideFileRead({ size: 10, offset: 10, mtimeMs: 1 }, { size: 10, mtimeMs: 1 }), { action: 'skip', readFrom: 10 });
  assert.deepEqual(decideFileRead({ size: 10, offset: 10, mtimeMs: 1 }, { size: 20, mtimeMs: 2 }), { action: 'append', readFrom: 10 });
  assert.deepEqual(decideFileRead({ size: 10, offset: 10, mtimeMs: 1 }, { size: 5, mtimeMs: 2 }), { action: 'restart', readFrom: 0 });
  assert.deepEqual(decideFileRead({ size: 100, offset: 40, mtimeMs: 1 }, { size: 60, mtimeMs: 2 }), { action: 'restart', readFrom: 0 });
  assert.deepEqual(decideFileRead({ size: 10, offset: 10, mtimeMs: 1 }, { size: 10, mtimeMs: 2 }), { action: 'append', readFrom: 10 });
});

test('splitLines joins carry and preserves a trailing partial line', () => {
  assert.deepEqual(splitLines('', 'a\nb\n'), { lines: ['a', 'b'], carry: '' });
  assert.deepEqual(splitLines('a', 'b\nc'), { lines: ['ab'], carry: 'c' });
  assert.deepEqual(splitLines('a\r', '\nb'), { lines: ['a'], carry: 'b' });
  assert.deepEqual(splitLines('', 'no-newline'), { lines: [], carry: 'no-newline' });
});

test('resolveProjectsDirs honors CLAUDE_CONFIG_DIR, project basename and extra dirs', () => {
  const root = path.resolve('C:/home');
  const validProjects = new Set([
    path.join(root, '.claude', 'projects'),
    path.join(root, 'other', 'projects'),
    path.join(root, 'extra', 'projects'),
  ]);
  const dirs = resolveProjectsDirs({
    CLAUDE_CONFIG_DIR: ` ${path.join(root, '.claude', 'projects')} , ${path.join(root, 'missing')} , ${path.join(root, 'other')} `,
    HOME: root,
  }, [path.join(root, 'extra')], (candidate) => validProjects.has(candidate));
  assert.deepEqual(dirs, [
    path.join(root, '.claude', 'projects'),
    path.join(root, 'other', 'projects'),
    path.join(root, 'extra', 'projects'),
  ]);
});

test('resolveProjectsDirs throws when CLAUDE_CONFIG_DIR is set and nothing survives', () => {
  assert.throws(() => resolveProjectsDirs({ CLAUDE_CONFIG_DIR: 'C:/missing', HOME: 'C:/home' }, [], () => false), /CLAUDE_CONFIG_DIR/);
});

test('resolveProjectsDirs requires an isDirectory predicate', () => {
  assert.throws(() => resolveProjectsDirs({ HOME: 'C:/home' }, []), /isDirectory function/);
});

test('resolveProjectsDirs probes XDG and home Claude dirs when no override is set', () => {
  const env = { XDG_CONFIG_HOME: 'C:/xdg', HOME: 'C:/home' };
  const validProjects = new Set([
    path.join('C:/xdg', 'claude', 'projects'),
    path.join('C:/home', '.claude', 'projects'),
  ]);
  assert.deepEqual(resolveProjectsDirs(env, [], (candidate) => validProjects.has(candidate)), [
    path.join('C:/xdg', 'claude', 'projects'),
    path.join('C:/home', '.claude', 'projects'),
  ]);
});

test('projectDirCandidates matches resolver probes and filters blank override segments', () => {
  const root = path.resolve('C:/home');
  const candidates = projectDirCandidates({
    CLAUDE_CONFIG_DIR: ` ${path.join(root, '.claude')} ,,   , ${path.join(root, 'other', 'projects')} `,
    HOME: root,
  }, [path.join(root, 'extra')]);

  assert.deepEqual(candidates, [
    path.join(root, '.claude', 'projects'),
    path.join(root, 'other', 'projects'),
    path.join(root, 'extra', 'projects'),
  ]);
});
