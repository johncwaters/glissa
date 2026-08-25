'use strict';

// Mill control-WS boundary: memory settable only via an allow-list of scalar toggles, everything else refused by name.

const { isPlainObject } = require('./usage-number-core');
const {
  MEMORY_RETAIN_DAY_RANGE,
  MAX_RECORD_CHARS_RANGE,
  MAX_RECORDS_PER_KIND_RANGE,
} = require('./memory-core');
const {
  INTERVAL_MINUTES_RANGE,
  TIMEOUT_SECONDS_RANGE,
  MAX_NEW_CLAIMS_RANGE,
  QUIET_MS_RANGE,
} = require('./memory-distill-core');
const { SOURCE_NAMES } = require('./ingest-core');

const NO_BLOCKS = Object.freeze({});
const NO_RANGES = Object.freeze({});

const MEMORY_DISTILL_SPEC = Object.freeze({
  name: 'memory.distill',
  booleans: Object.freeze(['enabled']),
  integerRanges: Object.freeze({
    intervalMinutes: INTERVAL_MINUTES_RANGE,
    timeoutSeconds: TIMEOUT_SECONDS_RANGE,
    maxNewClaims: MAX_NEW_CLAIMS_RANGE,
    quietMs: QUIET_MS_RANGE,
  }),
  blocks: NO_BLOCKS,
});

const MEMORY_SPEC = Object.freeze({
  name: 'memory',
  booleans: Object.freeze(['enabled']),
  integerRanges: Object.freeze({
    retainDays: MEMORY_RETAIN_DAY_RANGE,
    // The legacy alias resolveMemoryConfig still prefers over retainDays, settable so a config that
    // already carries it stays editable from the dialog instead of silently outranking it.
    memoryRetainDays: MEMORY_RETAIN_DAY_RANGE,
    maxRecordChars: MAX_RECORD_CHARS_RANGE,
    maxRecordsPerKind: MAX_RECORDS_PER_KIND_RANGE,
  }),
  blocks: Object.freeze({ distill: MEMORY_DISTILL_SPEC }),
});

// The lane clamps nothing (a falsy value falls back to its default), so these bounds are the wire's
// own: a one-hour floor and a thirty-day ceiling are the values that could not possibly be meant.
const PACK_DISTILLER_SPEC = Object.freeze({
  name: 'packDistiller',
  booleans: Object.freeze(['enabled']),
  integerRanges: Object.freeze({
    intervalHours: Object.freeze({ min: 1, max: 720 }),
    timeoutSeconds: Object.freeze({ min: 60, max: 7200 }),
  }),
  blocks: NO_BLOCKS,
});

/*
 * Only the gates cross the wire. Every source's ring bound, poll period and digest quota stays
 * file-only: they are the lane's load-bearing memory ceiling, not a preference, and `fs.roots` plus
 * `shellHistory.shells` name directories and files, which the allow-list refuses by construction.
 */
const INGEST_SOURCES_SPEC = Object.freeze({
  name: 'ingest.sources',
  booleans: Object.freeze([]),
  integerRanges: NO_RANGES,
  blocks: Object.freeze(Object.fromEntries(SOURCE_NAMES.map((source) => [source, Object.freeze({
    name: `ingest.sources.${source}`,
    booleans: Object.freeze(['enabled']),
    integerRanges: NO_RANGES,
    blocks: NO_BLOCKS,
  })]))),
});

const INGEST_SPEC = Object.freeze({
  name: 'ingest',
  booleans: Object.freeze(['enabled']),
  integerRanges: NO_RANGES,
  blocks: Object.freeze({ sources: INGEST_SOURCES_SPEC }),
});

/**
 * A settings block against its allow-list. Returns the first error message, or null when every key is
 * settable and well typed. A wrong type is REJECTED, never coerced, matching every other block here.
 */
function validateMillBlock(block, spec) {
  if (block == null) return null;
  if (!isPlainObject(block)) return `${spec.name} must be an object`;
  for (const [key, value] of Object.entries(block)) {
    if (value == null) continue;
    if (spec.booleans.includes(key)) {
      if (typeof value !== 'boolean') return `${spec.name}.${key} must be a boolean`;
      continue;
    }
    if (Object.hasOwn(spec.integerRanges, key)) {
      const range = spec.integerRanges[key];
      if (!Number.isInteger(value) || value < range.min || value > range.max) {
        return `${spec.name}.${key} must be an integer between ${range.min} and ${range.max}`;
      }
      continue;
    }
    if (Object.hasOwn(spec.blocks, key)) {
      const error = validateMillBlock(value, spec.blocks[key]);
      if (error) return error;
      continue;
    }
    return `${spec.name}.${key} is not settable from the dashboard`;
  }
  return null;
}

/*
 * The mirror of mergeMillBlock for the way OUT: the stored block projected down to its allow-list, so
 * a file-only key (a watched root, a db path) is never echoed by the settings reply or its broadcast.
 * A block the operator never configured stays null, which is what keeps an untouched config identical.
 */
function pickMillBlock(stored, spec) {
  if (!isPlainObject(stored)) return null;
  const out = {};
  for (const key of spec.booleans) {
    if (stored[key] != null) out[key] = !!stored[key];
  }
  for (const key of Object.keys(spec.integerRanges)) {
    if (stored[key] != null) out[key] = stored[key];
  }
  for (const [key, nested] of Object.entries(spec.blocks)) {
    const picked = pickMillBlock(stored[key], nested);
    if (picked) out[key] = picked;
  }
  return out;
}

/** The stored block with the allow-listed keys of `incoming` written over it, everything else kept. */
function mergeMillBlock(stored, incoming, spec) {
  const out = isPlainObject(stored) ? { ...stored } : {};
  if (!isPlainObject(incoming)) return out;
  for (const key of spec.booleans) {
    if (incoming[key] != null) out[key] = !!incoming[key];
  }
  for (const key of Object.keys(spec.integerRanges)) {
    if (incoming[key] != null) out[key] = incoming[key];
  }
  for (const [key, nested] of Object.entries(spec.blocks)) {
    if (incoming[key] == null) continue;
    out[key] = mergeMillBlock(out[key], incoming[key], nested);
  }
  return out;
}

module.exports = {
  INGEST_SPEC,
  MEMORY_SPEC,
  PACK_DISTILLER_SPEC,
  mergeMillBlock,
  pickMillBlock,
  validateMillBlock,
};
