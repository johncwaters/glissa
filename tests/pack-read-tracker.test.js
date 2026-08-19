'use strict';

// Pure pack-read telemetry core: path classification (Windows-shaped paths compare
// case-insensitively and slash-agnostically), per-pack counts, and the after-notice counter that
// makes the M4 staleness channel's effect measurable.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePath,
  packForPath,
  createPackReadState,
  notePackRead,
  armNoticeCounter,
  packReadStats,
  summarizePackReads,
  clearPackReads,
} = require('../session/core/pack-read-tracker');

const WIN_PACK = { name: 'glissa', dir: 'C:\\Users\\dev\\.glissa\\packs\\built\\glissa\\current' };
const POSIX_PACK = { name: 'glissa', dir: '/home/dev/.glissa/packs/built/glissa/current' };

test('normalizePath: both slash kinds, repeats, trailing slash and dot segments collapse', () => {
  assert.equal(normalizePath('C:\\a\\b'), 'c:/a/b');
  assert.equal(normalizePath('C:/a//b/'), 'c:/a/b');
  assert.equal(normalizePath('C:/a/./b'), 'c:/a/b');
  assert.equal(normalizePath('C:/a/x/../b'), 'c:/a/b');
  assert.equal(normalizePath('  C:/a/b  '), 'c:/a/b');
  assert.equal(normalizePath(''), '');
  assert.equal(normalizePath(null), '');
});

test('normalizePath: case folding follows path SHAPE, not the host platform', () => {
  // A drive letter or UNC prefix means Windows semantics wherever the test runs; a posix path keeps
  // its case, because two files there really can differ only by case.
  assert.equal(normalizePath('c:/Users/Dev/File.md'), 'c:/users/dev/file.md');
  assert.equal(normalizePath('\\\\server\\share\\Pack'), '//server/share/pack');
  assert.equal(normalizePath('/home/dev/File.md'), '/home/dev/File.md');
});

test('packForPath: a file inside the pack dir is attributed, anything else is null', () => {
  assert.equal(packForPath('C:\\Users\\dev\\.glissa\\packs\\built\\glissa\\current\\CLAUDE.md', [WIN_PACK]), 'glissa');
  assert.equal(packForPath('c:/users/DEV/.glissa/packs/built/glissa/current/.claude/rules/01-x.md', [WIN_PACK]), 'glissa');
  assert.equal(packForPath('C:\\Users\\dev\\Projects\\glissa\\AGENTS.md', [WIN_PACK]), null);
  assert.equal(packForPath('/home/dev/.glissa/packs/built/glissa/current/CLAUDE.md', [POSIX_PACK]), 'glissa');
  assert.equal(packForPath('/home/dev/Projects/glissa/AGENTS.md', [POSIX_PACK]), null);
});

test('packForPath: a sibling dir sharing the pack name prefix is not a pack read', () => {
  // Plain startsWith would swallow ".../current-old/x.md"; the separator is part of the rule.
  assert.equal(packForPath('C:/Users/dev/.glissa/packs/built/glissa/current-old/x.md', [WIN_PACK]), null);
});

test('packForPath: the longest matching dir wins, so a nested pack is not credited to its container', () => {
  const outer = { name: 'outer', dir: '/packs/outer' };
  const inner = { name: 'inner', dir: '/packs/outer/inner' };
  assert.equal(packForPath('/packs/outer/inner/CLAUDE.md', [outer, inner]), 'inner');
  assert.equal(packForPath('/packs/outer/CLAUDE.md', [outer, inner]), 'outer');
});

test('packForPath: malformed inputs are ignored rather than thrown on', () => {
  assert.equal(packForPath(undefined, [POSIX_PACK]), null);
  assert.equal(packForPath('/home/dev/x.md', null), null);
  assert.equal(packForPath('/home/dev/x.md', [{ name: 'no-dir' }, null, 42]), null);
});

test('notePackRead counts per pack and stamps the last read', () => {
  const state = createPackReadState();
  assert.equal(notePackRead(state, 'glissa', 1000), true);
  notePackRead(state, 'glissa', 2000);
  notePackRead(state, 'company', 3000);
  assert.deepEqual(packReadStats(state, 'glissa'), { reads: 2, lastReadAt: 2000, readsSinceNotice: null });
  assert.deepEqual(packReadStats(state, 'company'), { reads: 1, lastReadAt: 3000, readsSinceNotice: null });
  assert.deepEqual(packReadStats(state, 'never-read'), { reads: 0, lastReadAt: null, readsSinceNotice: null });
  assert.equal(notePackRead(state, '', 4000), false);
});

test('readsSinceNotice is null until a notice arms it, then counts only later reads', () => {
  const state = createPackReadState();
  notePackRead(state, 'glissa', 1000);
  notePackRead(state, 'glissa', 1100);
  assert.equal(packReadStats(state, 'glissa').readsSinceNotice, null);

  armNoticeCounter(state, 2000);
  assert.equal(packReadStats(state, 'glissa').readsSinceNotice, 0, 'arming resets, it does not backfill');
  assert.equal(packReadStats(state, 'never-read').readsSinceNotice, 0, 'an unread pack reports 0, not null, once armed');

  notePackRead(state, 'glissa', 2100);
  assert.equal(packReadStats(state, 'glissa').reads, 3, 'the lifetime count keeps running');
  assert.equal(packReadStats(state, 'glissa').readsSinceNotice, 1);

  armNoticeCounter(state, 3000);
  assert.equal(packReadStats(state, 'glissa').readsSinceNotice, 0, 'a second notice restarts the window');
});

test('summarizePackReads reports one row per delivered pack, in delivery order', () => {
  const state = createPackReadState();
  notePackRead(state, 'beta', 5000);
  const delivered = [{ name: 'alpha', version: 'v1' }, { name: 'beta', version: 'v2' }];
  assert.deepEqual(summarizePackReads(state, delivered), [
    { name: 'alpha', version: 'v1', reads: 0, lastReadAt: null, readsSinceNotice: null },
    { name: 'beta', version: 'v2', reads: 1, lastReadAt: 5000, readsSinceNotice: null },
  ]);
  assert.deepEqual(summarizePackReads(state, []), []);
});

test('clearPackReads drops counts and disarms the notice window (a respawn re-resolves delivery)', () => {
  const state = createPackReadState();
  notePackRead(state, 'glissa', 1000);
  armNoticeCounter(state, 2000);
  clearPackReads(state);
  assert.deepEqual(packReadStats(state, 'glissa'), { reads: 0, lastReadAt: null, readsSinceNotice: null });
});
