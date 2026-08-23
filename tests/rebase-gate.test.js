'use strict';

// The pure auto-rebase gate: every skip reason, the allowed/refused state split, and the conflict
// cooldown. These tests ARE the statement of the guard ordering (the module deliberately does not
// describe it in prose), so a reordering that changes which reason wins fails here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideAutoRebase, AUTO_REBASE_STATES } = require('../session/core/rebase-gate');
const { STATES } = require('../shared/states');

// The shape of a worktree that SHOULD be rebased: enabled, quiescent, clean, behind, nothing pending.
function eligible(extra = {}) {
  return {
    enabled: true,
    state: STATES.IDLE,
    mergeStatus: 'none',
    dirty: false,
    checkRunning: false,
    behind: '2',
    rebaseInProgress: false,
    teardownPending: false,
    currentKey: 'headsha::targetsha',
    lastConflictKey: null,
    ...extra,
  };
}

const reasonFor = (extra) => decideAutoRebase(eligible(extra)).reason;

test('a clean, quiescent, behind worktree is rebased', () => {
  assert.deepEqual(decideAutoRebase(eligible()), { action: 'rebase' });
});

test('every skip reason fires for its own condition', () => {
  assert.equal(reasonFor({ enabled: false }), 'disabled');
  assert.equal(reasonFor({ teardownPending: true }), 'teardown');
  assert.equal(reasonFor({ mergeStatus: 'merging' }), 'merging');
  assert.equal(reasonFor({ mergeStatus: 'parked' }), 'parked');
  assert.equal(reasonFor({ state: STATES.RUNNING }), 'busy');
  assert.equal(reasonFor({ rebaseInProgress: true }), 'rebase-in-progress');
  assert.equal(reasonFor({ dirty: true }), 'dirty');
  assert.equal(reasonFor({ checkRunning: true }), 'check-running');
  assert.equal(reasonFor({ behind: '0' }), 'current');
  assert.equal(reasonFor({ lastConflictKey: 'headsha::targetsha' }), 'conflict-cooldown');
});

// A worktree may only be rewritten while nothing is running in it. WAITING is the load-bearing
// exclusion: the merge gate accepts it, this one must not (a permission prompt pauses a turn that
// resumes into the files a rebase would have rewritten).
test('only quiescent states are rebased; every live-work state is busy', () => {
  for (const state of [STATES.IDLE, STATES.COMPLETE, STATES.DONE, STATES.FAILED, STATES.DORMANT]) {
    assert.deepEqual(decideAutoRebase(eligible({ state })), { action: 'rebase' }, `${state} is rebasable`);
  }
  for (const state of [STATES.RUNNING, STATES.WAITING, STATES.STARTING, STATES.INITIALIZING]) {
    assert.equal(reasonFor({ state }), 'busy', `${state} is busy`);
  }
  assert.deepEqual([...AUTO_REBASE_STATES].sort(), ['COMPLETE', 'DONE', 'DORMANT', 'FAILED', 'IDLE']);
});

test('guard order: the most specific reason wins when several conditions hold at once', () => {
  assert.equal(reasonFor({ enabled: false, dirty: true, state: STATES.RUNNING }), 'disabled');
  assert.equal(reasonFor({ teardownPending: true, mergeStatus: 'merging' }), 'teardown');
  assert.equal(reasonFor({ mergeStatus: 'merging', state: STATES.RUNNING }), 'merging');
  assert.equal(reasonFor({ mergeStatus: 'parked', dirty: true }), 'parked');
  assert.equal(reasonFor({ state: STATES.RUNNING, dirty: true }), 'busy');
  assert.equal(reasonFor({ rebaseInProgress: true, dirty: true }), 'rebase-in-progress');
  assert.equal(reasonFor({ dirty: true, behind: '0' }), 'dirty');
  assert.equal(reasonFor({ checkRunning: true, behind: '0' }), 'check-running');
  assert.equal(reasonFor({ dirty: true, checkRunning: true }), 'dirty', 'dirty is still read first');
  assert.equal(reasonFor({ behind: '0', lastConflictKey: 'headsha::targetsha' }), 'current');
});

test('behind reads the same whether it arrives as git output or a number', () => {
  for (const behind of ['0', '', 0, null, undefined]) {
    assert.equal(reasonFor({ behind }), 'current', `${JSON.stringify(behind)} means up to date`);
  }
  for (const behind of ['1', 3]) {
    assert.deepEqual(decideAutoRebase(eligible({ behind })), { action: 'rebase' });
  }
});

test('the cooldown holds only while the key is unchanged and non-empty', () => {
  assert.equal(reasonFor({ lastConflictKey: 'headsha::targetsha' }), 'conflict-cooldown');
  // The target moved: worth another attempt, the conflict may be gone.
  assert.deepEqual(
    decideAutoRebase(eligible({ currentKey: 'headsha::newtarget', lastConflictKey: 'headsha::targetsha' })),
    { action: 'rebase' },
  );
  // An unresolvable signature keys on nothing, so it must never masquerade as a matching cooldown.
  assert.deepEqual(
    decideAutoRebase(eligible({ currentKey: '', lastConflictKey: '' })),
    { action: 'rebase' },
  );
});

test('a call with no arguments at all is a disabled skip, never a rebase', () => {
  assert.deepEqual(decideAutoRebase(), { action: 'skip', reason: 'disabled' });
});

// The advisory post-rebase check runs a real test suite INSIDE the worktree, so a second rebase while
// it runs rewrites the files that run is reading - and on Windows the run's open handles can fail the
// rebase outright. Two integration-branch moves minutes apart is all it takes.
test('a worktree with an advisory check running is not rebased under it', () => {
  assert.deepEqual(
    decideAutoRebase(eligible({ checkRunning: true })),
    { action: 'skip', reason: 'check-running' }
  );
  assert.deepEqual(decideAutoRebase(eligible({ checkRunning: false })), { action: 'rebase' });
});

test('checkRunning sits beside dirty in the order: both are "something is using this worktree"', () => {
  // Everything ABOVE dirty still wins over it, exactly as it does over dirty itself.
  assert.equal(reasonFor({ checkRunning: true, enabled: false }), 'disabled');
  assert.equal(reasonFor({ checkRunning: true, teardownPending: true }), 'teardown');
  assert.equal(reasonFor({ checkRunning: true, mergeStatus: 'merging' }), 'merging');
  assert.equal(reasonFor({ checkRunning: true, mergeStatus: 'parked' }), 'parked');
  assert.equal(reasonFor({ checkRunning: true, state: STATES.RUNNING }), 'busy');
  assert.equal(reasonFor({ checkRunning: true, rebaseInProgress: true }), 'rebase-in-progress');
  // And it wins over everything below.
  assert.equal(reasonFor({ checkRunning: true, lastConflictKey: 'headsha::targetsha' }), 'check-running');
});
