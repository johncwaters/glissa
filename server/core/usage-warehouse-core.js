'use strict';

const { safeNumber, stringOrNull } = require('./usage-number-core');

function rollupFromReport(daily) {
  const records = [];
  for (const dayRow of daily || []) {
    const day = stringOrNull(dayRow?.day);
    if (!day) continue;
    for (const modelRow of dayRow.models || []) {
      const model = stringOrNull(modelRow?.model);
      if (!model) continue;
      records.push(recordFromModelRow(day, modelRow));
    }
  }
  return records;
}

function mergeWarehouse(existingRecords, freshRecords, { liveDays } = {}) {
  const liveDaySet = new Set((liveDays || []).filter((day) => stringOrNull(day)));
  const freshByKey = new Map();
  for (const freshRecord of freshRecords || []) {
    const record = normalizeRecord(freshRecord);
    if (!record) continue;
    freshByKey.set(recordKey(record), record);
  }

  const mergedByKey = new Map();
  for (const existingRecord of existingRecords || []) {
    const record = normalizeRecord(existingRecord);
    if (!record) continue;
    if (freshByKey.has(recordKey(record))) continue;
    if (liveDaySet.has(record.day)) continue;
    mergedByKey.set(recordKey(record), record);
  }

  for (const freshRecord of freshByKey.values()) {
    mergedByKey.set(recordKey(freshRecord), freshRecord);
  }

  return Array.from(mergedByKey.values()).sort(compareRecords);
}

function pruneWarehouse(records, { retainDays, todayKey } = {}) {
  const cutoffDay = cutoffDayKey(todayKey, retainDays);
  // An uncomputable cutoff must fail safe: dropping durable history is the one unrecoverable outcome.
  if (!cutoffDay) {
    return (records || []).map(normalizeRecord).filter(Boolean).sort(compareRecords);
  }
  return (records || [])
    .map(normalizeRecord)
    .filter((record) => record && record.day >= cutoffDay)
    .sort(compareRecords);
}

function warehouseDailyRows(records) {
  const dailyByDay = new Map();
  for (const rawRecord of records || []) {
    const record = normalizeRecord(rawRecord);
    if (!record) continue;
    const bucket = dailyByDay.get(record.day) || newDailyBucket(record.day);
    addRecordToDailyBucket(bucket, record);
    dailyByDay.set(record.day, bucket);
  }
  return Array.from(dailyByDay.values()).sort((a, b) => a.day.localeCompare(b.day));
}

function recordFromModelRow(day, modelRow) {
  return normalizeRecord({
    day,
    model: modelRow.model,
    input: modelRow.input,
    output: modelRow.output,
    cacheCreate: modelRow.cacheCreate,
    cacheRead: modelRow.cacheRead,
    tokens: modelRow.tokens,
    costUSD: modelRow.costUSD,
  });
}

function normalizeRecord(record) {
  const day = stringOrNull(record?.day);
  const model = stringOrNull(record?.model);
  if (!day || !model) return null;
  return {
    day,
    model,
    input: safeNumber(record.input),
    output: safeNumber(record.output),
    cacheCreate: safeNumber(record.cacheCreate),
    cacheRead: safeNumber(record.cacheRead),
    tokens: safeNumber(record.tokens),
    costUSD: safeNumber(record.costUSD),
  };
}

function cutoffDayKey(todayKey, retainDays) {
  if (!stringOrNull(todayKey)) return null;
  if (!Number.isInteger(retainDays) || retainDays < 1) return null;
  const todayMs = Date.parse(`${todayKey}T00:00:00Z`);
  if (!Number.isFinite(todayMs)) return null;
  const cutoffMs = todayMs - (retainDays - 1) * 24 * 60 * 60 * 1000;
  return new Date(cutoffMs).toISOString().slice(0, 10);
}

function addRecordToDailyBucket(bucket, record) {
  bucket.input += record.input;
  bucket.output += record.output;
  bucket.cacheCreate += record.cacheCreate;
  bucket.cacheRead += record.cacheRead;
  bucket.tokens += record.tokens;
  bucket.costUSD += record.costUSD;
  bucket.models.push({
    key: record.model,
    model: record.model,
    tokens: record.tokens,
    costUSD: record.costUSD,
    input: record.input,
    output: record.output,
    cacheCreate: record.cacheCreate,
    cacheRead: record.cacheRead,
  });
}

function newDailyBucket(day) {
  return {
    day,
    tokens: 0,
    costUSD: 0,
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    models: [],
  };
}

function recordKey(record) {
  return `${record.day}\u0000${record.model}`;
}

function compareRecords(a, b) {
  const dayOrder = a.day.localeCompare(b.day);
  if (dayOrder !== 0) return dayOrder;
  return a.model.localeCompare(b.model);
}

module.exports = {
  mergeWarehouse,
  pruneWarehouse,
  rollupFromReport,
  warehouseDailyRows,
};
