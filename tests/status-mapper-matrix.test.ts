// Exhaustive signal x state x confidence x activeAgents matrix for the pure
// decision function session/core/status-mapper.ts mapSignalToEvent. Expected
// outcomes are derived from the documented semantics (AGENTS.md "Status
// Detection" section) and the module's own inline comments, laid out as an
// explicit data table so a future semantic change fails with a readable
// per-case diff instead of one opaque assertion.
//
// Documented rules exercised here:
//  - working/resume wakes a quiescent card: IDLE/COMPLETE -> new_output,
//    WAITING -> user_input, anything else -> null. Confidence/activeAgents
//    are irrelevant to this signal.
//  - ready (Stop) completes a turn, but is gated:
//      * activeAgents > 0 always suppresses to null (background sub-agent
//        still running; the main agent will auto-resume).
//      * RUNNING always completes regardless of confidence (authoritative
//        hook mid-turn Stop, or title fallback that only ever fires from a
//        seen spinner).
//      * WAITING/IDLE only complete on confidence 'high' (idle_prompt is
//        demoted to 'low' and may only confirm quiescence from RUNNING).
//      * every other state -> null.
//  - awaiting-input (authoritative-only) fires prompt_detected from
//    RUNNING/IDLE/COMPLETE, null elsewhere.
//  - session-start/session-end and any unrecognized signal are pure
//    telemetry: always null, regardless of state/confidence/activeAgents.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mapSignalToEvent } from '../session/core/status-mapper.ts';
import type { LifecycleEvent } from '../session/core/status-mapper.ts';
import { STATES } from '../shared/states.ts';

const ALL_STATES = Object.values(STATES);
const CONFIDENCES = ['high', 'low'];
const ACTIVE_AGENTS = [0, 1];

// Independent re-derivation of the documented decision table (not a copy of
// the source switch) so the test is an oracle, not a tautology.
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
  // session-start, session-end, and any unrecognized signal: telemetry only.
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

// Targeted call-outs for the semantics most likely to regress silently.

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
