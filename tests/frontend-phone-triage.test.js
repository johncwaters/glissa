'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// triage-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/phone/triage-core.mjs');

const row = (id, state) => ({ id, state });
const ids = (rows) => rows.map((r) => r.id);

test('orderSessionsForTriage: blocked and broken sessions lead, then finished, then live', async () => {
  const { orderSessionsForTriage } = await importCore();
  const ordered = orderSessionsForTriage([
    row('idle', 'IDLE'),
    row('running', 'RUNNING'),
    row('complete', 'COMPLETE'),
    row('failed', 'FAILED'),
    row('waiting', 'WAITING'),
  ]);
  assert.deepEqual(ids(ordered), ['waiting', 'failed', 'complete', 'running', 'idle']);
});

test('orderSessionsForTriage: sessions in the same state keep their incoming order', async () => {
  const { orderSessionsForTriage } = await importCore();
  const ordered = orderSessionsForTriage([
    row('alpha', 'WAITING'),
    row('bravo', 'RUNNING'),
    row('charlie', 'WAITING'),
    row('delta', 'RUNNING'),
  ]);
  assert.deepEqual(ids(ordered), ['alpha', 'charlie', 'bravo', 'delta']);
});

test('orderSessionsForTriage: every unranked state shares one resting group in incoming order', async () => {
  const { orderSessionsForTriage } = await importCore();
  const ordered = orderSessionsForTriage([
    row('dormant', 'DORMANT'),
    row('done', 'DONE'),
    row('idle', 'IDLE'),
    row('starting', 'STARTING'),
    row('waiting', 'WAITING'),
  ]);
  assert.deepEqual(ids(ordered), ['waiting', 'dormant', 'done', 'idle', 'starting']);
});

test('orderSessionsForTriage: an unknown state never outranks a real signal', async () => {
  const { orderSessionsForTriage } = await importCore();
  const ordered = orderSessionsForTriage([row('mystery', 'BANANA'), row('failed', 'FAILED')]);
  assert.deepEqual(ids(ordered), ['failed', 'mystery']);
});

test('orderSessionsForTriage: does not mutate its input and tolerates empty input', async () => {
  const { orderSessionsForTriage } = await importCore();
  const input = [row('running', 'RUNNING'), row('waiting', 'WAITING')];
  orderSessionsForTriage(input);
  assert.deepEqual(ids(input), ['running', 'waiting']);
  assert.deepEqual(orderSessionsForTriage([]), []);
  assert.deepEqual(orderSessionsForTriage(undefined), []);
});

test('countSessionsNeedingAttention: every WAITING counts', async () => {
  const { countSessionsNeedingAttention } = await importCore();
  assert.equal(countSessionsNeedingAttention([row('a', 'WAITING'), row('b', 'WAITING')]), 2);
});

test('countSessionsNeedingAttention: a COMPLETE counts only while it is unseen', async () => {
  const { countSessionsNeedingAttention } = await importCore();
  const unseenComplete = { id: 'a', state: 'COMPLETE', unseen: true };
  const seenComplete = { id: 'b', state: 'COMPLETE', unseen: false };
  const undeclaredComplete = { id: 'c', state: 'COMPLETE' };
  assert.equal(countSessionsNeedingAttention([unseenComplete]), 1);
  assert.equal(countSessionsNeedingAttention([seenComplete]), 0);
  // An absent flag is not an unseen flag: a caller that never tracked it must not inflate the count.
  assert.equal(countSessionsNeedingAttention([undeclaredComplete]), 0);
  assert.equal(countSessionsNeedingAttention([unseenComplete, seenComplete, undeclaredComplete]), 1);
});

test('countSessionsNeedingAttention: the unseen flag only applies to COMPLETE', async () => {
  const { countSessionsNeedingAttention } = await importCore();
  assert.equal(countSessionsNeedingAttention([{ id: 'a', state: 'RUNNING', unseen: true }]), 0);
  assert.equal(countSessionsNeedingAttention([{ id: 'a', state: 'IDLE', unseen: true }]), 0);
  assert.equal(countSessionsNeedingAttention([{ id: 'a', state: 'WAITING', unseen: false }]), 1);
});

// The desktop rail head (focus-view.js attentionIds) counts WAITING plus unseen COMPLETE and nothing
// else. Both surfaces render the same "{n} NEED YOU" string, so this pins the phone to that rule.
test('countSessionsNeedingAttention: FAILED and RUNNING are not counted, matching the desktop rail head', async () => {
  const { countSessionsNeedingAttention } = await importCore();
  assert.equal(countSessionsNeedingAttention([
    row('a', 'WAITING'),
    row('b', 'FAILED'),
    { id: 'c', state: 'COMPLETE', unseen: true },
    row('d', 'RUNNING'),
    row('e', 'IDLE'),
    row('f', 'DORMANT'),
  ]), 2);
});

test('countSessionsNeedingAttention: nothing to report reads as zero', async () => {
  const { countSessionsNeedingAttention } = await importCore();
  assert.equal(countSessionsNeedingAttention([row('a', 'RUNNING'), row('b', 'DORMANT')]), 0);
  assert.equal(countSessionsNeedingAttention([]), 0);
  assert.equal(countSessionsNeedingAttention(undefined), 0);
});

test('attentionSummaryText: resting reads as a sentence, never an empty slot', async () => {
  const { attentionSummaryText } = await importCore();
  assert.equal(attentionSummaryText(0), 'ALL CLEAR');
  assert.equal(attentionSummaryText(-1), 'ALL CLEAR');
  assert.equal(attentionSummaryText(1), '1 NEEDS YOU');
  assert.equal(attentionSummaryText(4), '4 NEED YOU');
});
