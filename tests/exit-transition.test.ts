import test from 'node:test';
import assert from 'node:assert/strict';

import { decideExitTransition } from '../session/core/exit-transition.ts';
import { STATES } from '../shared/states.ts';

test('STARTING with no first output -> process_exit with no_output_before_exit reason', () => {
  const { event, detail } = decideExitTransition(STATES.STARTING, 1, null, false);
  assert.equal(event, 'process_exit');
  assert.deepEqual(detail, { exitCode: 1, signal: null, reason: 'no_output_before_exit' });
});

test('STARTING with no first output wins even on a clean exit code', () => {
  const { event, detail } = decideExitTransition(STATES.STARTING, 0, null, false);
  assert.equal(event, 'process_exit');
  assert.equal(detail.reason, 'no_output_before_exit');
});

test('clean exit (code 0) after first output -> process_exit_ok, no reason', () => {
  const { event, detail } = decideExitTransition(STATES.RUNNING, 0, null, true);
  assert.equal(event, 'process_exit_ok');
  assert.equal(detail.reason, undefined);
  assert.deepEqual(detail, { exitCode: 0, signal: null });
});

test('STARTING with first output and a non-zero exit -> process_exit, no reason', () => {
  const { event, detail } = decideExitTransition(STATES.STARTING, 1, null, true);
  assert.equal(event, 'process_exit');
  assert.deepEqual(detail, { exitCode: 1, signal: null });
});

test('non-STARTING state with a non-zero exit -> process_exit_fail', () => {
  const { event, detail } = decideExitTransition(STATES.RUNNING, 1, 'SIGTERM', true);
  assert.equal(event, 'process_exit_fail');
  assert.deepEqual(detail, { exitCode: 1, signal: 'SIGTERM' });
});

test('WAITING state with a non-zero exit -> process_exit_fail', () => {
  const { event } = decideExitTransition(STATES.WAITING, 137, null, true);
  assert.equal(event, 'process_exit_fail');
});
