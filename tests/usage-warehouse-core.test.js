'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeWarehouse,
  pruneWarehouse,
  rollupFromReport,
  warehouseDailyRows,
} = require('../server/core/usage-warehouse-core');

test('mergeWarehouse replaces records with the same day and model key', () => {
  const existing = [record('2026-08-18', 'claude-a', 1)];
  const fresh = [record('2026-08-18', 'claude-a', 9)];
  assert.deepEqual(mergeWarehouse(existing, fresh, { liveDays: ['2026-08-18'] }), fresh);
});

test('mergeWarehouse drops stored records missing from authoritative live days', () => {
  const existing = [record('2026-08-18', 'claude-a', 1), record('2026-08-18', 'claude-b', 2)];
  const fresh = [record('2026-08-18', 'claude-a', 9)];
  assert.deepEqual(mergeWarehouse(existing, fresh, { liveDays: ['2026-08-18'] }), fresh);
});

test('mergeWarehouse keeps stored records outside the live window verbatim', () => {
  const older = record('2026-07-01', 'claude-a', 1);
  const fresh = [record('2026-08-18', 'claude-a', 9)];
  assert.deepEqual(mergeWarehouse([older], fresh, { liveDays: ['2026-08-18'] }), [older, ...fresh]);
});

test('pruneWarehouse keeps the retainDays boundary', () => {
  const records = [
    record('2026-08-15', 'claude-a', 1),
    record('2026-08-16', 'claude-a', 2),
    record('2026-08-19', 'claude-a', 3),
  ];
  assert.deepEqual(pruneWarehouse(records, { retainDays: 4, todayKey: '2026-08-19' }), [records[1], records[2]]);
});

test('rollupFromReport and warehouseDailyRows round trip daily rows', () => {
  const daily = [
    {
      day: '2026-08-18',
      tokens: 30,
      costUSD: 3,
      input: 30,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
      models: [
        modelRow('claude-a', 10, 1),
        modelRow('claude-b', 20, 2),
      ],
    },
    {
      day: '2026-08-19',
      tokens: 7,
      costUSD: 0.7,
      input: 7,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
      models: [modelRow('claude-c', 7, 0.7)],
    },
  ];
  assert.deepEqual(warehouseDailyRows(rollupFromReport(daily)), daily);
});

test('malformed warehouse records and daily model rows are skipped', () => {
  const records = warehouseDailyRows([record('2026-08-18', 'claude-a', 1), null, { day: '2026-08-18' }]);
  assert.equal(records.length, 1);
  assert.deepEqual(rollupFromReport([{ day: '2026-08-18', models: [null, { input: 1 }, modelRow('claude-a', 2, 0.2)] }]), [
    record('2026-08-18', 'claude-a', 2, 0.2),
  ]);
});

function record(day, model, tokens, costUSD = tokens / 10) {
  return {
    day,
    model,
    input: tokens,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    tokens,
    costUSD,
  };
}

function modelRow(model, tokens, costUSD) {
  return {
    key: model,
    model,
    tokens,
    costUSD,
    input: tokens,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
  };
}
