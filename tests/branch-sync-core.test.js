'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseLeftRightCount, decideBranchSyncState } = require('../server/core/branch-sync-core');

// --- parseLeftRightCount: "<behind><TAB><ahead>" per `git rev-list --left-right --count U...B` ---

test('parseLeftRightCount reads "behind<TAB>ahead" in that order', () => {
  assert.deepEqual(parseLeftRightCount('1\t2'), { behind: 1, ahead: 2 });
});

test('parseLeftRightCount tolerates a trailing newline and CRLF', () => {
  assert.deepEqual(parseLeftRightCount('3\t0\n'), { behind: 3, ahead: 0 });
  assert.deepEqual(parseLeftRightCount('0\t4\r\n'), { behind: 0, ahead: 4 });
});

test('parseLeftRightCount tolerates surrounding whitespace and runs of spaces', () => {
  assert.deepEqual(parseLeftRightCount('  2   5  '), { behind: 2, ahead: 5 });
});

test('parseLeftRightCount handles the in-sync case (both zero)', () => {
  assert.deepEqual(parseLeftRightCount('0\t0'), { behind: 0, ahead: 0 });
});

test('parseLeftRightCount returns null for empty input', () => {
  assert.equal(parseLeftRightCount(''), null);
  assert.equal(parseLeftRightCount(null), null);
  assert.equal(parseLeftRightCount(undefined), null);
});

test('parseLeftRightCount returns null for malformed git output', () => {
  assert.equal(parseLeftRightCount('fatal: bad revision'), null);
  assert.equal(parseLeftRightCount('1'), null);
  assert.equal(parseLeftRightCount('1\t2\t3'), null);
  assert.equal(parseLeftRightCount('a\tb'), null);
  assert.equal(parseLeftRightCount('-1\t2'), null);
});

// --- decideBranchSyncState ---

test('decideBranchSyncState: no upstream wins regardless of counts', () => {
  assert.equal(decideBranchSyncState({ hasUpstream: false, ahead: 5, behind: 5 }), 'no-upstream');
  assert.equal(decideBranchSyncState({ hasUpstream: false, ahead: 0, behind: 0 }), 'no-upstream');
});

test('decideBranchSyncState: both zero is in-sync', () => {
  assert.equal(decideBranchSyncState({ hasUpstream: true, ahead: 0, behind: 0 }), 'in-sync');
});

test('decideBranchSyncState: ahead only', () => {
  assert.equal(decideBranchSyncState({ hasUpstream: true, ahead: 3, behind: 0 }), 'ahead');
});

test('decideBranchSyncState: behind only', () => {
  assert.equal(decideBranchSyncState({ hasUpstream: true, ahead: 0, behind: 2 }), 'behind');
});

test('decideBranchSyncState: both nonzero is diverged', () => {
  assert.equal(decideBranchSyncState({ hasUpstream: true, ahead: 1, behind: 1 }), 'diverged');
});
