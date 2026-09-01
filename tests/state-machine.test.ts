import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSITIONS,
  GUARDS,
  ENTRY_HOOKS,
  EXIT_HOOKS,
} from '../session/core/state-machine.ts';
import type { HookSession } from '../session/core/state-machine.ts';
import { STATES, KILLABLE_STATES } from '../shared/states.ts';
import type { SessionState } from '../shared/states.ts';

function entryHookFor(state: SessionState) {
  const hook = ENTRY_HOOKS[state];
  assert.ok(hook, `${state} must have an entry hook`);
  return hook;
}

function exitHookFor(state: SessionState) {
  const hook = EXIT_HOOKS[state];
  assert.ok(hook, `${state} must have an exit hook`);
  return hook;
}

function capturingSession(fields: Omit<HookSession, 'emit'>, captured: [string, unknown][]): HookSession {
  return { ...fields, emit: (event, payload) => captured.push([event, payload]) };
}

test('TRANSITIONS matrix is frozen and matches the lifecycle shape', () => {
  assert.ok(Object.isFrozen(TRANSITIONS), 'TRANSITIONS must be frozen');
  assert.deepEqual(TRANSITIONS, {
    [STATES.DORMANT]: { user_start: STATES.INITIALIZING },
    [STATES.INITIALIZING]: {
      spawn_success: STATES.STARTING,
      spawn_fail: STATES.FAILED,
      user_kill: STATES.DONE,
    },
    [STATES.STARTING]: {
      first_output: STATES.IDLE,
      process_exit: STATES.FAILED,
      user_kill: STATES.DONE,
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
      process_exit_ok: STATES.FAILED,
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

test('GUARDS.spawn_success accepts only a caller-probed spawn cwd', () => {
  assert.equal(GUARDS.spawn_success({}, { spawnCwdExists: true }), true);
  assert.equal(GUARDS.spawn_success({}, { spawnCwdExists: false }), false);
  assert.equal(GUARDS.spawn_success({}, {}), false);
});

test('INITIALIZING and STARTING accept user_kill, and FAILED accepts a clean exit', () => {
  assert.equal(TRANSITIONS[STATES.INITIALIZING].user_kill, STATES.DONE);
  assert.equal(TRANSITIONS[STATES.STARTING].user_kill, STATES.DONE);
  assert.equal(TRANSITIONS[STATES.FAILED].process_exit_ok, STATES.FAILED);
});

test('KILLABLE_STATES matches every state with a user_kill transition', () => {
  const transitionKillableStates = Object.values(STATES).filter((state) => TRANSITIONS[state]?.user_kill);
  assert.deepEqual(KILLABLE_STATES, transitionKillableStates);
});

test('GUARDS.user_restart only allows from DONE or FAILED', () => {
  assert.equal(GUARDS.user_restart({ state: STATES.DONE }), true);
  assert.equal(GUARDS.user_restart({ state: STATES.FAILED }), true);
  assert.equal(GUARDS.user_restart({ state: STATES.RUNNING }), false);
  assert.equal(GUARDS.user_restart({ state: STATES.WAITING }), false);
});

test('GUARDS.user_reset requires DONE/FAILED + dead PTY + no worktree', () => {
  assert.equal(GUARDS.user_reset({ state: STATES.DONE, ptyProcess: null, worktreeDir: null }), true);
  assert.equal(GUARDS.user_reset({ state: STATES.FAILED, ptyProcess: null, worktreeDir: null }), true);

  assert.equal(GUARDS.user_reset({ state: STATES.RUNNING, ptyProcess: null, worktreeDir: null }), false);
  assert.equal(GUARDS.user_reset({ state: STATES.COMPLETE, ptyProcess: null, worktreeDir: null }), false);

  assert.equal(GUARDS.user_reset({ state: STATES.DONE, ptyProcess: {}, worktreeDir: null }), false);

  assert.equal(GUARDS.user_reset({ state: STATES.DONE, ptyProcess: null, worktreeDir: '/tmp/wt' }), false);
});

test('ENTRY_HOOKS emit the right lifecycle events with the session name', () => {
  const captured: [string, unknown][] = [];
  const fake = capturingSession({ name: 'sess-A' }, captured);
  entryHookFor(STATES.WAITING)(fake);
  entryHookFor(STATES.FAILED)(fake);
  entryHookFor(STATES.DONE)(fake);
  assert.deepEqual(captured, [
    ['needs-attention', { name: 'sess-A' }],
    ['session-failed', { name: 'sess-A' }],
    ['session-done', { name: 'sess-A' }],
  ]);

  assert.equal(Object.keys(ENTRY_HOOKS).length, 4);
});

test('ENTRY_HOOKS[COMPLETE] emits post-turn-check (emit-only) with id/name/path', () => {
  const captured: [string, unknown][] = [];
  const fake = capturingSession({ id: 'id-A', name: 'sess-A', path: '/tmp/sess-a' }, captured);
  entryHookFor(STATES.COMPLETE)(fake);
  assert.deepEqual(captured, [
    ['post-turn-check', { id: 'id-A', name: 'sess-A', path: '/tmp/sess-a' }],
  ]);
});

test('EXIT_HOOKS clears attention only on leaving WAITING', () => {
  const captured: [string, unknown][] = [];
  const fake = capturingSession({ name: 'sess-B' }, captured);
  exitHookFor(STATES.WAITING)(fake);
  assert.deepEqual(captured, [['attention-cleared', { name: 'sess-B' }]]);
  assert.equal(Object.keys(EXIT_HOOKS).length, 1);
});
