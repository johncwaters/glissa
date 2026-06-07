'use strict';

// Unit tests for the relocated state-machine tables (session-core/state-machine.js).
// Locks the matrix shape (every state's allowed events -> target states), the two
// guards, and the entry/exit hooks against the engine in sessions.js that consumes them.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const {
  TRANSITIONS,
  GUARDS,
  ENTRY_HOOKS,
  EXIT_HOOKS,
} = require('../session-core/state-machine');
const { STATES } = require('../shared/states');

test('TRANSITIONS matrix is frozen and matches the lifecycle shape', () => {
  assert.ok(Object.isFrozen(TRANSITIONS), 'TRANSITIONS must be frozen');
  assert.deepEqual(TRANSITIONS, {
    [STATES.DORMANT]: { user_start: STATES.INITIALIZING },
    [STATES.INITIALIZING]: {
      spawn_success: STATES.STARTING,
      spawn_fail: STATES.FAILED,
    },
    [STATES.STARTING]: {
      first_output: STATES.IDLE,
      process_exit: STATES.FAILED,
    },
    [STATES.RUNNING]: {
      prompt_detected: STATES.WAITING,
      task_complete: STATES.COMPLETE,
      process_exit_ok: STATES.DONE,
      process_exit_fail: STATES.FAILED,
      user_kill: STATES.DONE,
    },
    [STATES.WAITING]: {
      user_input: STATES.RUNNING,
      user_dismiss: STATES.RUNNING,
      task_complete: STATES.COMPLETE,
      user_kill: STATES.DONE,
      process_exit_ok: STATES.DONE,
      process_exit_fail: STATES.FAILED,
    },
    [STATES.IDLE]: {
      new_output: STATES.RUNNING,
      prompt_detected: STATES.WAITING,
      task_complete: STATES.COMPLETE,
      process_exit_ok: STATES.DONE,
      process_exit_fail: STATES.FAILED,
      user_kill: STATES.DONE,
    },
    [STATES.COMPLETE]: {
      new_output: STATES.RUNNING,
      user_dismiss: STATES.IDLE,
      prompt_detected: STATES.WAITING,
      process_exit_ok: STATES.DONE,
      process_exit_fail: STATES.FAILED,
      user_kill: STATES.DONE,
    },
    [STATES.DONE]: {
      user_restart: STATES.INITIALIZING,
      user_reset: STATES.DORMANT,
    },
    [STATES.FAILED]: {
      user_restart: STATES.INITIALIZING,
      user_reset: STATES.DORMANT,
      process_exit_fail: STATES.FAILED,
    },
  });
});

test('every transition target is a known state', () => {
  const known = new Set(Object.values(STATES));
  for (const [, events] of Object.entries(TRANSITIONS)) {
    for (const target of Object.values(events)) {
      assert.ok(known.has(target), `unknown target ${target}`);
    }
  }
});

test('GUARDS.spawn_success requires the session path to exist', () => {
  assert.equal(GUARDS.spawn_success({ path: os.tmpdir() }), true);
  assert.equal(GUARDS.spawn_success({ path: `${os.tmpdir()}/no-such-dir-xyz-123` }), false);
});

test('GUARDS.user_restart only allows from DONE or FAILED', () => {
  assert.equal(GUARDS.user_restart({ state: STATES.DONE }), true);
  assert.equal(GUARDS.user_restart({ state: STATES.FAILED }), true);
  assert.equal(GUARDS.user_restart({ state: STATES.RUNNING }), false);
  assert.equal(GUARDS.user_restart({ state: STATES.WAITING }), false);
});

test('GUARDS.user_reset requires DONE/FAILED + dead PTY + no worktree', () => {
  // Allowed: finished, PTY dead, worktree already merged/discarded.
  assert.equal(GUARDS.user_reset({ state: STATES.DONE, ptyProcess: null, worktreeDir: null }), true);
  assert.equal(GUARDS.user_reset({ state: STATES.FAILED, ptyProcess: null, worktreeDir: null }), true);
  // Rejected: wrong state.
  assert.equal(GUARDS.user_reset({ state: STATES.RUNNING, ptyProcess: null, worktreeDir: null }), false);
  assert.equal(GUARDS.user_reset({ state: STATES.COMPLETE, ptyProcess: null, worktreeDir: null }), false);
  // Rejected: PTY still alive.
  assert.equal(GUARDS.user_reset({ state: STATES.DONE, ptyProcess: {}, worktreeDir: null }), false);
  // Rejected: worktree still on disk (unmerged work).
  assert.equal(GUARDS.user_reset({ state: STATES.DONE, ptyProcess: null, worktreeDir: '/tmp/wt' }), false);
});

test('ENTRY_HOOKS emit the right lifecycle events with the session name', () => {
  const captured = [];
  const fake = { name: 'sess-A', emit: (ev, payload) => captured.push([ev, payload]) };
  ENTRY_HOOKS[STATES.WAITING](fake);
  ENTRY_HOOKS[STATES.FAILED](fake);
  ENTRY_HOOKS[STATES.DONE](fake);
  assert.deepEqual(captured, [
    ['needs-attention', { name: 'sess-A' }],
    ['session-failed', { name: 'sess-A' }],
    ['session-done', { name: 'sess-A' }],
  ]);
  // COMPLETE/WAITING/FAILED/DONE have entry hooks.
  assert.equal(Object.keys(ENTRY_HOOKS).length, 4);
});

test('ENTRY_HOOKS[COMPLETE] emits post-turn-check (emit-only) with id/name/path', () => {
  const captured = [];
  const fake = {
    id: 'id-A',
    name: 'sess-A',
    path: '/tmp/sess-a',
    emit: (ev, payload) => captured.push([ev, payload]),
  };
  ENTRY_HOOKS[STATES.COMPLETE](fake);
  assert.deepEqual(captured, [
    ['post-turn-check', { id: 'id-A', name: 'sess-A', path: '/tmp/sess-a' }],
  ]);
});

test('EXIT_HOOKS clears attention only on leaving WAITING', () => {
  const captured = [];
  const fake = { name: 'sess-B', emit: (ev, payload) => captured.push([ev, payload]) };
  EXIT_HOOKS[STATES.WAITING](fake);
  assert.deepEqual(captured, [['attention-cleared', { name: 'sess-B' }]]);
  assert.equal(Object.keys(EXIT_HOOKS).length, 1);
});
