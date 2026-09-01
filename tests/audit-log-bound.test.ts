import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import type { SessionState } from '../shared/states.ts';
const CAP = 200;

function makeSession(state: SessionState) {
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
      s.transition('new_output');
      s.transition('task_complete');
      s.transition('user_dismiss');
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
      s.transition('new_output');
      s.transition('task_complete');
      s.transition('user_dismiss');
      s.transition('task_complete');
      s.transition('prompt_detected');
      s.transition('process_exit_fail');
      s.transition('process_exit_fail');
      s.transition('user_reset');
      s.transition('user_start');
      s.transition('spawn_success', { spawnCwdExists: true });
      s.transition('first_output');
    }
    assert.equal(s.auditLog.length, CAP);
  } finally {
    s.destroy();
  }
});
