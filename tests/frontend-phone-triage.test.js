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
