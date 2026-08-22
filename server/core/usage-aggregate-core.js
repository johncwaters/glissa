'use strict';

const { dedupKeys, totalTokensOf } = require('./usage-entry-core');
const { safeNumber } = require('./usage-number-core');

function buildUsageReport(entries, { now = Date.now(), blockHours = 5, retainDays = 90, sessionsById = new Map(), tz = null } = {}) {
  const keptEntries = pruneEntries(entries, { now, retainDays }).kept;
  const totals = emptyTotals();
  const dailyByDay = new Map();
  const modelByName = new Map();
  const sessionById = new Map();

  for (const entry of keptEntries) {
    // Aggregation reads entry.costUSD as effective cost; ingest must overwrite it with priced cost per costMode.
    addEntryToTotals(totals, entry);
    const day = localDay(entry.timestampMs);
    addEntryToDailyBucket(dailyByDay, day, entry);
    addEntryToModelBucket(modelByName, entry.model || '<unknown>', entry);
    addEntryToSessionBucket(sessionById, entry, sessionsById);
  }

  return {
    ts: now,
    tz,
    blockHours,
    totals,
    daily: Array.from(dailyByDay.values()).map(serializeDailyBucket).sort((a, b) => a.day.localeCompare(b.day)),
    models: Array.from(modelByName.values()).sort((a, b) => b.tokens - a.tokens),
    sessions: Array.from(sessionById.values()).sort((a, b) => b.tokens - a.tokens),
  };
}

function pruneEntries(entries, { now = Date.now(), retainDays = 90 } = {}) {
  const cutoff = now - retainDays * 24 * 60 * 60 * 1000;
  const kept = [];
  const removedKeys = [];
  for (const entry of entries || []) {
    if (entry.timestampMs >= cutoff) {
      kept.push(entry);
      continue;
    }
    const keys = dedupKeys(entry);
    if (keys.primary) removedKeys.push(keys.primary);
  }
  return { kept, removedKeys };
}

function addEntryToDailyBucket(map, day, entry) {
  const bucket = map.get(day) || {
    day,
    tokens: 0,
    costUSD: 0,
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    entries: 0,
    modelByName: new Map(),
  };
  addEntryToTotals(bucket, entry);
  bucket.entries += 1;
  addEntryToModelBucket(bucket.modelByName, entry.model || '<unknown>', entry);
  map.set(day, bucket);
}

function addEntryToModelBucket(map, model, entry) {
  const bucket = map.get(model) || { key: model, model, tokens: 0, costUSD: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, entries: 0 };
  addEntryToTotals(bucket, entry);
  bucket.entries += 1;
  map.set(model, bucket);
}

function addEntryToSessionBucket(map, entry, sessionsById) {
  const key = entry.sessionId || '<unknown>';
  const knownSession = typeof sessionsById.get === 'function' ? sessionsById.get(key) : null;
  const entryProject = entry.cwd || entry.project || null;
  const bucket = map.get(key) || {
    id: key,
    name: knownSession?.name || key,
    project: null,
    tokens: 0,
    costUSD: 0,
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    entries: 0,
    lastTs: null,
  };
  if (bucket.project === null && entryProject) bucket.project = entryProject;
  addEntryToTotals(bucket, entry);
  bucket.entries += 1;
  bucket.lastTs = Math.max(bucket.lastTs || 0, entry.timestampMs);
  map.set(key, bucket);
}

function serializeDailyBucket(bucket) {
  const { modelByName, ...wireBucket } = bucket;
  wireBucket.models = Array.from(modelByName.values()).sort((a, b) => b.tokens - a.tokens);
  return wireBucket;
}

function addEntryToTotals(totals, entry) {
  totals.input += safeNumber(entry.input);
  totals.output += safeNumber(entry.output);
  totals.cacheCreate += safeNumber(entry.cacheCreate);
  totals.cacheRead += safeNumber(entry.cacheRead);
  totals.tokens += totalTokensOf(entry);
  totals.costUSD += safeNumber(entry.costUSD);
}

function emptyTotals() {
  return { tokens: 0, costUSD: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

function localDay(timestampMs) {
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

module.exports = {
  buildUsageReport,
  pruneEntries,
};
