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
