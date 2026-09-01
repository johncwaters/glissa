import test from 'node:test';
import assert from 'node:assert/strict';

import { pushDecision, DEFAULT_DECISION_LOG_CAP } from '../session/core/decision-log.ts';
import type { DecisionEntry } from '../session/core/decision-log.ts';

function gateEntry(
  ts: number, decision: string, active: number, extra: DecisionEntry = {},
): DecisionEntry {
  return { ts, kind: 'gate', decision, active, waitMs: 0, quietMs: 0, ...extra };
}

test('appends entries in order and reports each as appended', () => {
  const log: DecisionEntry[] = [];
  assert.equal(pushDecision(log, { ts: 1, kind: 'signal', signal: 'ready' }), 'appended');
  assert.equal(pushDecision(log, { ts: 2, kind: 'notify', category: 'complete' }), 'appended');
  assert.deepEqual(log.map((e) => e.kind), ['signal', 'notify']);
});

test('trims to the cap, keeping the newest entries', () => {
  const log: DecisionEntry[] = [];
  for (let i = 0; i < 10; i++) pushDecision(log, { ts: i, kind: 'signal' }, 4);
  assert.equal(log.length, 4);
  assert.deepEqual(log.map((e) => e.ts), [6, 7, 8, 9]);
});

test('the default cap is applied when none is passed', () => {
  const log: DecisionEntry[] = [];
  for (let i = 0; i < DEFAULT_DECISION_LOG_CAP + 5; i++) pushDecision(log, { ts: i, kind: 'signal' });
  assert.equal(log.length, DEFAULT_DECISION_LOG_CAP);
  assert.equal(log[log.length - 1].ts, DEFAULT_DECISION_LOG_CAP + 4);
});

test('a repeated gate verdict collapses into the previous entry and counts repeats', () => {
  const log: DecisionEntry[] = [];
  pushDecision(log, gateEntry(100, 'gated', 2));
  assert.equal(pushDecision(log, gateEntry(200, 'gated', 2, { quietMs: 50 })), 'collapsed');
  assert.equal(pushDecision(log, gateEntry(300, 'gated', 2)), 'collapsed');
  assert.equal(log.length, 1);
  assert.equal(log[0].repeats, 3);
  assert.equal(log[0].ts, 300, 'the collapsed entry carries the newest timing');
});

test('a changed decision or a changed agent count starts a new entry', () => {
  const log: DecisionEntry[] = [];
  pushDecision(log, gateEntry(100, 'gated', 2));
  pushDecision(log, gateEntry(200, 'gated', 1));
  pushDecision(log, gateEntry(300, 'wait', 0));
  pushDecision(log, gateEntry(400, 'release', 0));
  assert.deepEqual(log.map((e) => `${e.decision}:${e.active}`), ['gated:2', 'gated:1', 'wait:0', 'release:0']);
  assert.equal(log[0].repeats, undefined, 'a lone entry is never annotated with a repeat count');
});

test('collapse never crosses kinds: an interleaved signal breaks the run', () => {
  const log: DecisionEntry[] = [];
  pushDecision(log, gateEntry(100, 'gated', 2));
  pushDecision(log, { ts: 150, kind: 'signal', signal: 'working' });
  pushDecision(log, gateEntry(200, 'gated', 2));
  assert.deepEqual(log.map((e) => e.kind), ['gate', 'signal', 'gate']);
});

test('non-gate kinds never collapse, even when identical', () => {
  const log: DecisionEntry[] = [];
  const entry: DecisionEntry = { kind: 'notify', to: 'COMPLETE', category: null, reason: 'already-notified-this-cycle' };
  pushDecision(log, { ts: 1, ...entry });
  pushDecision(log, { ts: 2, ...entry });
  assert.equal(log.length, 2, 'two silent notify decisions are two real events');
});
