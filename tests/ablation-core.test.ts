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

test('classifyObservedPrompts scores each observed payload by state and title race timing', () => {
  assert.deepEqual(classifyObservedPrompts([
    { state: 'RUNNING', stateSince: 0, ts: 10000 },
    { state: 'WAITING', stateSince: 0, ts: 10000 },
    { state: 'IDLE', stateSince: 0, ts: 10000 },
    { state: 'RUNNING', stateSince: 9900, ts: 10000 },
  ]), {
    interruption: 1, answer: 1, followup: 1, ambiguous: 1,
  });
  assert.deepEqual(classifyObservedPrompts([]), emptyPromptCounts());
});

test('classifyObservedPrompts defaults missing and garbage payload fields', () => {
  assert.deepEqual(classifyObservedPrompts([
    {},
    null,
    { state: 7, ts: 'soon' },
    { state: 'RUNNING' },
    { state: 'RUNNING', stateSince: Number.NaN, ts: 10000 },
  ]), {
    interruption: 0, answer: 0, followup: 3, ambiguous: 2,
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
