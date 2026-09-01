import test from 'node:test';
import assert from 'node:assert/strict';

import { mapSignalToEvent } from '../session/core/status-mapper.ts';
import type { LifecycleEvent } from '../session/core/status-mapper.ts';
import { STATES } from '../shared/states.ts';

const ALL_STATES = Object.values(STATES);
const CONFIDENCES = ['high', 'low'];
const ACTIVE_AGENTS = [0, 1];

function expectedEvent(
  signal: string, state: string, confidence: string, activeAgents: number,
): LifecycleEvent | null {
  if (signal === 'working' || signal === 'resume') {
    if (state === STATES.IDLE || state === STATES.COMPLETE) return 'new_output';
    if (state === STATES.WAITING) return 'user_input';
    return null;
  }
  if (signal === 'ready') {
    if (activeAgents > 0) return null;
    if (state === STATES.RUNNING) return 'task_complete';
    if ((state === STATES.WAITING || state === STATES.IDLE) && confidence === 'high') return 'task_complete';
    return null;
  }
  if (signal === 'awaiting-input') {
    if (state === STATES.RUNNING || state === STATES.IDLE || state === STATES.COMPLETE) return 'prompt_detected';
    return null;
  }

  return null;
}

const SIGNALS = ['working', 'resume', 'ready', 'awaiting-input', 'session-start', 'session-end', 'totally-unknown-signal'];

for (const signal of SIGNALS) {
  for (const state of ALL_STATES) {
    for (const confidence of CONFIDENCES) {
      for (const activeAgents of ACTIVE_AGENTS) {
        const expected = expectedEvent(signal, state, confidence, activeAgents);
        const title = `signal=${signal} state=${state} confidence=${confidence} activeAgents=${activeAgents} -> ${expected === null ? 'null' : expected}`;
        test(title, () => {
          const actual = mapSignalToEvent(signal, state, confidence, activeAgents);
          assert.equal(actual, expected);
        });
      }
    }
  }
}

test('low-confidence ready only ever confirms quiescence from RUNNING, never from WAITING or IDLE', () => {
  assert.equal(mapSignalToEvent('ready', STATES.RUNNING, 'low', 0), 'task_complete');
  assert.equal(mapSignalToEvent('ready', STATES.WAITING, 'low', 0), null);
  assert.equal(mapSignalToEvent('ready', STATES.IDLE, 'low', 0), null);
});

test('activeAgents > 0 suppresses ready to task_complete even from RUNNING with high confidence', () => {
  assert.equal(mapSignalToEvent('ready', STATES.RUNNING, 'high', 1), null);
  assert.equal(mapSignalToEvent('ready', STATES.WAITING, 'high', 1), null);
  assert.equal(mapSignalToEvent('ready', STATES.IDLE, 'high', 1), null);
});

test('idle_prompt demotion: a low-confidence ready cannot complete a fresh IDLE session or a WAITING prompt', () => {
  assert.equal(mapSignalToEvent('ready', STATES.IDLE, 'low', 0), null);
  assert.equal(mapSignalToEvent('ready', STATES.WAITING, 'low', 0), null);
});

test('awaiting-input never fires from WAITING (already awaiting input) or DONE/FAILED/DORMANT/INITIALIZING/STARTING', () => {
  assert.equal(mapSignalToEvent('awaiting-input', STATES.WAITING, 'high', 0), null);
  assert.equal(mapSignalToEvent('awaiting-input', STATES.DONE, 'high', 0), null);
  assert.equal(mapSignalToEvent('awaiting-input', STATES.FAILED, 'high', 0), null);
  assert.equal(mapSignalToEvent('awaiting-input', STATES.DORMANT, 'high', 0), null);
});

test('activeAgents default parameter behaves as 0 when omitted', () => {
  assert.equal(mapSignalToEvent('ready', STATES.RUNNING, 'high'), 'task_complete');
});
