'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_INTENT_CHARS,
  applyModelIntent,
  createIntentState,
  intentPayload,
  isEmptyIntent,
  reviveIntentState,
  sanitizeIntentText,
} = require('../server/core/visions-intent-core');

const NOW = 1700000000000;

test('the initial state is empty, unsourced and unstamped', () => {
  const state = createIntentState();
  assert.deepEqual(state, {
    text: '', source: null, ts: 0,
  });
  assert.equal(isEmptyIntent(state), true);
});

test('a model proposal takes an empty statement and marks the model as source', () => {
  const { state, changed } = applyModelIntent(createIntentState(), { text: 'refactor of the spawn path', now: NOW });
  assert.equal(changed, true);
  assert.deepEqual(state, {
    text: 'refactor of the spawn path', source: 'model', ts: NOW,
  });
});

test('a model proposal replaces any standing statement', () => {
  const first = applyModelIntent(createIntentState(), { text: 'first belief', now: NOW }).state;
  const { state, changed } = applyModelIntent(first, { text: 'second belief', now: NOW + 1000 });
  assert.equal(changed, true);
  assert.deepEqual(state, {
    text: 'second belief', source: 'model', ts: NOW + 1000,
  });
});

test('a model proposal of the same statement changes nothing', () => {
  const first = applyModelIntent(createIntentState(), { text: 'same belief', now: NOW }).state;
  const again = applyModelIntent(first, { text: 'same belief', now: NOW + 60000 });
  assert.equal(again.changed, false);
  assert.equal(again.state, first);
});

test('a model with nothing to say leaves the statement standing', () => {
  const standing = applyModelIntent(createIntentState(), { text: 'a belief worth keeping', now: NOW }).state;
  for (const empty of ['', '   ', null, undefined, 42, {}, []]) {
    const result = applyModelIntent(standing, { text: empty, now: NOW + 5000 });
    assert.equal(result.changed, false, `${JSON.stringify(empty)} must not clear the statement`);
    assert.equal(result.state.text, 'a belief worth keeping');
  }
});

test('text is trimmed, capped, and strings only', () => {
  assert.equal(sanitizeIntentText('  padded  '), 'padded');
  assert.equal(sanitizeIntentText(12345), '');
  assert.equal(sanitizeIntentText({ text: 'nope' }), '');
  assert.equal(sanitizeIntentText(null), '');

  const long = 'x'.repeat(MAX_INTENT_CHARS + 120);
  assert.equal(sanitizeIntentText(long).length, MAX_INTENT_CHARS);
  assert.equal(applyModelIntent(createIntentState(), { text: long, now: NOW }).state.text.length, MAX_INTENT_CHARS);
});

test('a persisted model intent revives with sanitized text and timestamp', () => {
  assert.deepEqual(reviveIntentState({
    text: '  durable model statement  ', source: 'model', ts: NOW,
  }), {
    text: 'durable model statement', source: 'model', ts: NOW,
  });
});

test('a persisted model intent can default a missing timestamp to zero', () => {
  assert.deepEqual(reviveIntentState({
    text: 'durable model statement', source: 'model',
  }), {
    text: 'durable model statement', source: 'model', ts: 0,
  });
});

test('a legacy locked intent revives without the lock and accepts a model proposal', () => {
  const revived = reviveIntentState({
    text: '  durable operator statement  ', source: 'operator', locked: true, ts: NOW,
  });
  assert.deepEqual(revived, {
    text: 'durable operator statement', source: 'model', ts: NOW,
  });

  const proposed = applyModelIntent(revived, { text: 'new model belief', now: NOW + 1000 });
  assert.equal(proposed.changed, true);
  assert.deepEqual(proposed.state, {
    text: 'new model belief', source: 'model', ts: NOW + 1000,
  });
});

test('revival resets invalid persisted states to empty', () => {
  const invalidStates = [
    { text: 'has no domain', source: 'system', ts: NOW },
    { text: 'bad timestamp', source: 'model', ts: Number.POSITIVE_INFINITY },
    { text: 'negative timestamp', source: 'model', ts: -1 },
    { text: '   ', source: 'model', ts: NOW },
  ];
  for (const raw of invalidStates) assert.deepEqual(reviveIntentState(raw), createIntentState());
});

test('revival never throws on junk persisted values', () => {
  for (const raw of [null, undefined, 42, true, [], ['text'], 'intent']) {
    assert.doesNotThrow(() => reviveIntentState(raw));
    assert.deepEqual(reviveIntentState(raw), createIntentState());
  }
});

test('the payload is a copy carrying exactly the wire fields', () => {
  const state = applyModelIntent(createIntentState(), { text: 'on the wire', now: NOW }).state;
  const payload = intentPayload(state);
  assert.deepEqual(payload, {
    text: 'on the wire', source: 'model', ts: NOW,
  });
  payload.text = 'mutated';
  assert.equal(state.text, 'on the wire');
  assert.deepEqual(intentPayload(null), {
    text: '', source: null, ts: 0,
  });
});
