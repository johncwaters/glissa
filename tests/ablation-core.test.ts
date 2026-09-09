import assert from 'node:assert/strict';
import test from 'node:test';

import {
  armOutcome,
  classifyObservedPrompts,
  emptyPromptCounts,
  mcnemarExact,
  pairArmOrder,
  pairOutcomes,
  promptCount,
  summariseAblation,
  turnBudget,
} from '../test/ablation/ablation-core.ts';
import { promptBoundaryOrNull } from '../server/core/mill-metrics-core.ts';

test('armOutcome treats an execution error as invalid ahead of the check result', () => {
  assert.equal(armOutcome('spawn did not use model haiku', true), 'invalid');
  assert.equal(armOutcome('spawn did not use model haiku', false), 'invalid');
  assert.equal(armOutcome(null, true), 'pass');
  assert.equal(armOutcome(null, false), 'fail');
});

test('turnBudget gives the ON arm one extra turn for the mandated pack read', () => {
  assert.equal(turnBudget('on', 4), 5);
  assert.equal(turnBudget('off', 4), 4);
});

test('pairArmOrder alternates across adjacent tasks and adjacent seeds', () => {
  assert.deepEqual(pairArmOrder(0, 1), ['on', 'off']);
  assert.deepEqual(pairArmOrder(1, 1), ['off', 'on']);
  assert.deepEqual(pairArmOrder(0, 2), ['off', 'on']);
  assert.deepEqual(pairArmOrder(1, 2), ['on', 'off']);
});

test('emptyPromptCounts starts every prompt class at zero in a fresh object', () => {
  assert.deepEqual(emptyPromptCounts(), {
    interruption: 0, answer: 0, followup: 0, ambiguous: 0,
  });
  assert.notEqual(emptyPromptCounts(), emptyPromptCounts());
});

test('classifyObservedPrompts scores each observed payload by its prior turn boundary', () => {
  assert.deepEqual(classifyObservedPrompts([
    { boundary: null, hasSeenTurnEnd: true, ts: 10000 },
    { boundary: { ts: 5000, wasAwaitingInput: true }, hasSeenTurnEnd: true, ts: 10000 },
    { boundary: { ts: 5000, wasAwaitingInput: false }, hasSeenTurnEnd: true, ts: 10000 },
    { boundary: { ts: 9900, wasAwaitingInput: false }, hasSeenTurnEnd: true, ts: 10000 },
  ]), {
    interruption: 1, answer: 1, followup: 1, ambiguous: 1,
  });
  assert.deepEqual(classifyObservedPrompts([]), emptyPromptCounts());
});

test('classifyObservedPrompts rejects a boundary it cannot trust', () => {
  const garbageBoundaries = [
    { boundary: 7, hasSeenTurnEnd: true, ts: 'soon' },
    { boundary: { ts: 1 }, hasSeenTurnEnd: true },
    { boundary: { ts: Number.NaN, wasAwaitingInput: false }, hasSeenTurnEnd: true, ts: 10000 },
  ];
  for (const payload of garbageBoundaries) {
    assert.equal(promptBoundaryOrNull(payload.boundary), null);
  }
  assert.deepEqual(classifyObservedPrompts(garbageBoundaries), {
    interruption: 3, answer: 0, followup: 0, ambiguous: 0,
  });
});

test('classifyObservedPrompts scores a prompt with no observed turn end as a followup', () => {
  assert.deepEqual(classifyObservedPrompts([
    {},
    null,
    { boundary: null, hasSeenTurnEnd: false, ts: 10000 },
  ]), {
    interruption: 0, answer: 0, followup: 3, ambiguous: 0,
  });
});

test('classifyObservedPrompts scores a boundary-less prompt after the first as an interruption', () => {
  assert.deepEqual(classifyObservedPrompts([
    { boundary: null, hasSeenTurnEnd: false, hasSeenPriorPrompt: false, ts: 10000 },
    { boundary: null, hasSeenTurnEnd: false, hasSeenPriorPrompt: true, ts: 20000 },
  ]), {
    interruption: 1, answer: 0, followup: 1, ambiguous: 0,
  });
});

test('promptCount sums every prompt class', () => {
  assert.equal(promptCount(emptyPromptCounts()), 0);
  assert.equal(promptCount({
    interruption: 1, answer: 2, followup: 3, ambiguous: 4,
  }), 10);
});

test('pairOutcomes separates concordant and discordant task results', () => {
  assert.deepEqual(pairOutcomes([
    { on: 'pass', off: 'pass' },
    { on: 'fail', off: 'fail' },
    { on: 'pass', off: 'fail' },
    { on: 'pass', off: 'fail' },
    { on: 'fail', off: 'pass' },
  ]), {
    pairs: 5,
    bothPass: 1,
    bothFail: 1,
    onOnly: 2,
    offOnly: 1,
    concordant: 2,
    discordant: 3,
  });
});

test('pairOutcomes refuses malformed outcomes', () => {
  assert.throws(() => pairOutcomes([{ on: 'pass', off: 'unknown' }]), /pass or fail/);
  assert.throws(() => pairOutcomes(null), /array/);
});

test('mcnemarExact computes the two-sided binomial sign test', () => {
  assert.equal(mcnemarExact(0, 0), 1);
  assert.equal(mcnemarExact(1, 0), 1);
  assert.equal(mcnemarExact(4, 4), 1);
  assert.equal(mcnemarExact(5, 0), 0.0625);
  assert.equal(mcnemarExact(6, 0), 0.03125);
  assert.equal(mcnemarExact(7, 2), 0.1796875);
});

test('mcnemarExact refuses counts outside its domain', () => {
  assert.throws(() => mcnemarExact(-1, 0), /nonnegative integer/);
  assert.throws(() => mcnemarExact(1.5, 0), /nonnegative integer/);
});

test('summariseAblation reports direction only when the exact test is significant', () => {
  assert.equal(summariseAblation([]).verdict, 'insufficient');
  assert.equal(summariseAblation([{ on: 'pass', off: 'pass' }]).verdict, 'insufficient');
  assert.equal(summariseAblation(Array.from({ length: 5 }, () => ({ on: 'pass', off: 'fail' }))).verdict, 'no-signal');
  assert.equal(summariseAblation(Array.from({ length: 6 }, () => ({ on: 'pass', off: 'fail' }))).verdict, 'on-better');
  assert.equal(summariseAblation(Array.from({ length: 6 }, () => ({ on: 'fail', off: 'pass' }))).verdict, 'off-better');
});

test('summariseAblation returns the requested compact shape', () => {
  assert.deepEqual(summariseAblation([
    { on: 'pass', off: 'pass' },
    { on: 'pass', off: 'fail' },
  ]), {
    pairs: 2,
    bothPass: 1,
    bothFail: 0,
    onOnly: 1,
    offOnly: 0,
    pValue: 1,
    verdict: 'no-signal',
  });
});
