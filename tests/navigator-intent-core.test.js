'use strict';

/*
 * The navigator's intent model (docs/archive/plan-navigator.md, M5), at the only altitude the rules live at:
 * who may replace the statement, what a lock does, how control comes back to the model, and what is
 * done to the text on the way in. Every case here is a decision the wiring must NOT be making.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_INTENT_CHARS,
  applyModelIntent,
  applyOperatorIntent,
  createIntentState,
  intentPayload,
  isEmptyIntent,
  reviveIntentState,
  sanitizeIntentText,
} = require('../server/core/navigator-intent-core');

const NOW = 1700000000000;

test('the initial state is empty, unsourced, unlocked and unstamped', () => {
  const state = createIntentState();
  assert.deepEqual(state, {
    text: '', source: null, locked: false, ts: 0,
  });
  assert.equal(isEmptyIntent(state), true);
});

// --- The model proposal ---

test('a model proposal takes an empty statement and leaves control with the model', () => {
  const { state, changed } = applyModelIntent(createIntentState(), { text: 'refactor of the spawn path', now: NOW });
  assert.equal(changed, true);
  assert.deepEqual(state, {
    text: 'refactor of the spawn path', source: 'model', locked: false, ts: NOW,
  });
});

test('a model proposal replaces a standing model statement', () => {
  const first = applyModelIntent(createIntentState(), { text: 'first belief', now: NOW }).state;
  const { state, changed } = applyModelIntent(first, { text: 'second belief', now: NOW + 1000 });
  assert.equal(changed, true);
  assert.equal(state.text, 'second belief');
  assert.equal(state.ts, NOW + 1000);
});

test('a model proposal of the same statement changes nothing, so it costs no broadcast', () => {
  const first = applyModelIntent(createIntentState(), { text: 'same belief', now: NOW }).state;
  const again = applyModelIntent(first, { text: 'same belief', now: NOW + 60000 });
  assert.equal(again.changed, false);
  assert.equal(again.state, first, 'the very same state object, ts included');
});

test('a model with nothing to say leaves the statement standing: only an operator can clear one', () => {
  const standing = applyModelIntent(createIntentState(), { text: 'a belief worth keeping', now: NOW }).state;
  for (const empty of ['', '   ', null, undefined, 42, {}, []]) {
    const result = applyModelIntent(standing, { text: empty, now: NOW + 5000 });
    assert.equal(result.changed, false, `${JSON.stringify(empty)} must not clear the statement`);
    assert.equal(result.state.text, 'a belief worth keeping');
  }
});

// --- The lock ---

test('an operator correction takes control, locks it, and says so', () => {
  const proposed = applyModelIntent(createIntentState(), { text: 'the model guess', now: NOW }).state;
  const { state, changed } = applyOperatorIntent(proposed, { text: 'blog post arguing X for audience Y', now: NOW + 100 });
  assert.equal(changed, true);
  assert.deepEqual(state, {
    text: 'blog post arguing X for audience Y', source: 'operator', locked: true, ts: NOW + 100,
  });
});

test('a locked statement survives every model proposal, and the refusal is decided HERE', () => {
  const locked = applyOperatorIntent(createIntentState(), { text: 'what I am actually doing', now: NOW }).state;
  const result = applyModelIntent(locked, { text: 'what the model thinks I am doing', now: NOW + 60000 });
  assert.equal(result.changed, false, 'no change means no broadcast, without the caller checking the lock');
  assert.equal(result.state, locked);
  assert.equal(result.state.text, 'what I am actually doing');
  assert.equal(result.state.source, 'operator');
});

test('an operator correction replaces another operator correction and stays locked', () => {
  const first = applyOperatorIntent(createIntentState(), { text: 'first correction', now: NOW }).state;
  const { state, changed } = applyOperatorIntent(first, { text: 'second correction', now: NOW + 10 });
  assert.equal(changed, true);
  assert.equal(state.text, 'second correction');
  assert.equal(state.locked, true);
});

test('re-submitting the same correction changes nothing', () => {
  const first = applyOperatorIntent(createIntentState(), { text: 'settled', now: NOW }).state;
  assert.equal(applyOperatorIntent(first, { text: 'settled', now: NOW + 999 }).changed, false);
});

// --- Empty clears and unlocks ---

test('an operator submitting empty text clears the statement and hands control back to the model', () => {
  const locked = applyOperatorIntent(createIntentState(), { text: 'mine for now', now: NOW }).state;
  const cleared = applyOperatorIntent(locked, { text: '   ', now: NOW + 10 });
  assert.equal(cleared.changed, true);
  assert.deepEqual(cleared.state, {
    text: '', source: null, locked: false, ts: 0,
  });

  const proposed = applyModelIntent(cleared.state, { text: 'the model may speak again', now: NOW + 20 });
  assert.equal(proposed.changed, true, 'the lock is gone, not merely bypassed');
  assert.equal(proposed.state.source, 'model');
});

test('clearing an already empty statement is not a change', () => {
  assert.equal(applyOperatorIntent(createIntentState(), { text: '', now: NOW }).changed, false);
});

test('a missing text field on either path is read as empty', () => {
  assert.equal(applyOperatorIntent(createIntentState(), { now: NOW }).changed, false);
  assert.equal(applyModelIntent(createIntentState(), { now: NOW }).changed, false);
});

// --- Sanitization ---

test('text is trimmed, capped, and strings only, on both paths', () => {
  assert.equal(sanitizeIntentText('  padded  '), 'padded');
  assert.equal(sanitizeIntentText(12345), '');
  assert.equal(sanitizeIntentText({ text: 'nope' }), '');
  assert.equal(sanitizeIntentText(null), '');

  const long = 'x'.repeat(MAX_INTENT_CHARS + 120);
  assert.equal(sanitizeIntentText(long).length, MAX_INTENT_CHARS);
  assert.equal(applyModelIntent(createIntentState(), { text: long, now: NOW }).state.text.length, MAX_INTENT_CHARS);
  assert.equal(applyOperatorIntent(createIntentState(), { text: `  ${long}  `, now: NOW }).state.text.length, MAX_INTENT_CHARS);
});

// --- Durable revival ---

test('a persisted operator-locked intent revives with sanitized text and its timestamp', () => {
  const revived = reviveIntentState({
    text: '  durable operator statement  ', source: 'operator', locked: true, ts: NOW,
  });
  assert.deepEqual(revived, {
    text: 'durable operator statement', source: 'operator', locked: true, ts: NOW,
  });
});

test('a persisted model intent revives unlocked and can default a missing timestamp to zero', () => {
  assert.deepEqual(reviveIntentState({
    text: 'durable model statement', source: 'model', locked: false,
  }), {
    text: 'durable model statement', source: 'model', locked: false, ts: 0,
  });
  assert.deepEqual(reviveIntentState({
    text: 'operator source without a boolean lock', source: 'operator', locked: 'true', ts: NOW,
  }), {
    text: 'operator source without a boolean lock', source: 'operator', locked: false, ts: NOW,
  });
});

test('revival resets invalid persisted states to empty', () => {
  const invalidStates = [
    { text: 'has no domain', source: 'system', locked: false, ts: NOW },
    { text: 'model cannot be locked', source: 'model', locked: true, ts: NOW },
    { text: 'bad timestamp', source: 'operator', locked: true, ts: Number.POSITIVE_INFINITY },
    { text: 'negative timestamp', source: 'operator', locked: true, ts: -1 },
    { text: '   ', source: 'operator', locked: true, ts: NOW },
  ];
  for (const raw of invalidStates) assert.deepEqual(reviveIntentState(raw), createIntentState());
});

test('revival never throws on junk persisted values', () => {
  for (const raw of [null, undefined, 42, true, [], ['text'], 'intent']) {
    assert.doesNotThrow(() => reviveIntentState(raw));
    assert.deepEqual(reviveIntentState(raw), createIntentState());
  }
});

// --- The wire shape ---

test('the payload is a copy carrying exactly the four wire fields', () => {
  const state = applyOperatorIntent(createIntentState(), { text: 'on the wire', now: NOW }).state;
  const payload = intentPayload(state);
  assert.deepEqual(payload, {
    text: 'on the wire', source: 'operator', locked: true, ts: NOW,
  });
  payload.text = 'mutated';
  assert.equal(state.text, 'on the wire', 'nothing downstream holds the lane state itself');
  assert.deepEqual(intentPayload(null), {
    text: '', source: null, locked: false, ts: 0,
  });
});
