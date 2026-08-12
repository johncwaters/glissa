'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseLeftRightCount, decideBranchSyncState, parseRemoteFromUpstream, decideResyncAction, firstGitErrorLine,
} = require('../server/core/branch-sync-core');

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

test('decideBranchSyncState: upstream with unparseable counts is unknown, not no-upstream', () => {
  assert.equal(decideBranchSyncState({ hasUpstream: true }), 'unknown');
  assert.equal(decideBranchSyncState({ hasUpstream: true, ahead: undefined, behind: undefined }), 'unknown');
  assert.equal(decideBranchSyncState({ hasUpstream: true, ahead: 1.5, behind: 0 }), 'unknown');
});

// --- parseRemoteFromUpstream ---

test('parseRemoteFromUpstream reads the segment before the first slash', () => {
  assert.equal(parseRemoteFromUpstream('origin/develop'), 'origin');
  assert.equal(parseRemoteFromUpstream('upstream/feature/nested'), 'upstream');
});

test('parseRemoteFromUpstream defaults to origin for a slash-less or empty value', () => {
  assert.equal(parseRemoteFromUpstream('develop'), 'origin');
  assert.equal(parseRemoteFromUpstream(''), 'origin');
  assert.equal(parseRemoteFromUpstream(null), 'origin');
  assert.equal(parseRemoteFromUpstream(undefined), 'origin');
});

// --- decideResyncAction: the resync decision table (state x checked-out -> action) ---

test('decideResyncAction: behind + checked out -> ff-merge (advances the working tree too)', () => {
  assert.equal(decideResyncAction('behind', true), 'ff-merge');
});

test('decideResyncAction: behind + NOT checked out -> ff-fetch (never touches the working tree)', () => {
  assert.equal(decideResyncAction('behind', false), 'ff-fetch');
});

test('decideResyncAction: ahead (either checked-out state) -> push', () => {
  assert.equal(decideResyncAction('ahead', true), 'push');
  assert.equal(decideResyncAction('ahead', false), 'push');
});

test('decideResyncAction: diverged never mutates, regardless of checked-out state', () => {
  assert.equal(decideResyncAction('diverged', true), 'none');
  assert.equal(decideResyncAction('diverged', false), 'none');
});

test('decideResyncAction: in-sync, no-upstream, and unknown are all none', () => {
  assert.equal(decideResyncAction('in-sync', true), 'none');
  assert.equal(decideResyncAction('no-upstream', true), 'none');
  assert.equal(decideResyncAction('unknown', true), 'none');
});

// --- firstGitErrorLine ---

test('firstGitErrorLine strips the "Command failed: ..." echo and keeps the git complaint', () => {
  const err = new Error('Command failed: git merge --ff-only origin/develop\nmerge: origin/develop - not something we can merge\n');
  assert.equal(firstGitErrorLine(err), 'merge: origin/develop - not something we can merge');
});

test('firstGitErrorLine keeps only the first non-blank line of a multi-line stderr block', () => {
  const err = new Error('Command failed: git push origin develop\n! [rejected] develop -> develop (non-fast-forward)\nerror: failed to push some refs\nhint: try pull first\n');
  assert.equal(firstGitErrorLine(err), '! [rejected] develop -> develop (non-fast-forward)');
});

test('firstGitErrorLine prefers git push errors after hook noise', () => {
  const err = new Error(
    'Command failed: git push origin develop\n'
      + 'stderr | src/renderer/src/backupsLogic.test.ts > backupsLogic > records a refused listing read instead of leaving the pane loading forever\n'
      + 'AssertionError: expected false to be true\n'
      + "error: failed to push some refs to 'https://example.invalid/repo.git'\n",
  );
  assert.equal(firstGitErrorLine(err), "error: failed to push some refs to 'https://example.invalid/repo.git'");
});

test('firstGitErrorLine strips ANSI color escapes before returning a line', () => {
  const err = new Error('Command failed: git push origin develop\n\x1b[31merror: failed to push some refs\x1b[0m\n');
  assert.equal(firstGitErrorLine(err), 'error: failed to push some refs');
});

test('firstGitErrorLine keeps the first non-blank line when no git marker is present', () => {
  const err = new Error('Command failed: git push origin develop\n\npre-push hook failed\nmore output\n');
  assert.equal(firstGitErrorLine(err), 'pre-push hook failed');
});

test('firstGitErrorLine caps the returned line at 200 characters', () => {
  const err = new Error(`Command failed: git push origin develop\n${'x'.repeat(250)}\n`);
  assert.equal(firstGitErrorLine(err).length, 200);
});

test('firstGitErrorLine falls back to a generic line for an empty/missing error', () => {
  assert.equal(firstGitErrorLine(new Error('')), 'git command failed');
  assert.equal(firstGitErrorLine(null), 'git command failed');
  assert.equal(firstGitErrorLine(undefined), 'git command failed');
});
