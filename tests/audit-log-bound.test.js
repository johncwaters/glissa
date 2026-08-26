'use strict';

// The audit log is bounded, on EVERY append path (2026-08 review, section 2). It was not: the
// ordinary transition trimmed after pushing, while the self-transition branch pushed and returned
// early, so a session repeating a self-transition - a restart loop firing process_exit_fail against
// an already FAILED state - grew the array without limit until something else transitioned.

const test = require('node:test');
const assert = require('node:assert/strict');

const { Session } = require('../session/sessions');
const { STATES } = require('../shared/states');

const CAP = 200;

function makeSession(state) {
  const s = new Session({ id: 'audit-test', name: 'audit', path: process.cwd() });
  s.state = state;
  return s;
}

test('a repeated self-transition cannot grow the audit log past the cap', () => {
  const s = makeSession(STATES.FAILED);
  try {
    for (let i = 0; i < CAP * 3; i += 1) {
      assert.equal(s.transition('process_exit_fail', { code: 1 }), true, 'the self-transition is legal');
    }
    assert.equal(s.state, STATES.FAILED);
    assert.equal(s.auditLog.length, CAP);
    assert.equal(s.auditLog.every((entry) => entry.selfTransition === true), true);
  } finally {
    s.destroy();
  }
});

test('ordinary transitions are still capped, and the newest entries are the ones kept', () => {
  const s = makeSession(STATES.IDLE);
  try {
    for (let i = 0; i < CAP; i += 1) {
      s.transition('new_output');    // IDLE/COMPLETE -> RUNNING
      s.transition('task_complete');  // RUNNING -> COMPLETE
      s.transition('user_dismiss');   // COMPLETE -> IDLE
    }
    assert.equal(s.auditLog.length, CAP);
    assert.equal(s.auditLog[s.auditLog.length - 1].to, STATES.IDLE, 'the tail is the most recent transition');
  } finally {
    s.destroy();
  }
});

test('a mixed stream of self and real transitions stays at the cap', () => {
  const s = makeSession(STATES.IDLE);
  try {
    for (let i = 0; i < CAP * 2; i += 1) {
      s.transition('new_output');    // IDLE -> RUNNING
      s.transition('task_complete');  // RUNNING -> COMPLETE
      s.transition('user_dismiss');   // COMPLETE -> IDLE
      s.transition('task_complete');  // IDLE -> COMPLETE
      s.transition('prompt_detected'); // COMPLETE -> WAITING
      s.transition('process_exit_fail'); // WAITING -> FAILED
      s.transition('process_exit_fail'); // already FAILED: a self-transition
      s.transition('user_reset');     // FAILED -> DORMANT
      s.transition('user_start');     // DORMANT -> INITIALIZING
      s.transition('spawn_success', { spawnCwdExists: true });  // INITIALIZING -> STARTING
      s.transition('first_output');   // STARTING -> IDLE
    }
    assert.equal(s.auditLog.length, CAP);
  } finally {
    s.destroy();
  }
});
