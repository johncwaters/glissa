import { isPlainObject } from './usage-number-core.ts';
import {
  INTERVAL_MINUTES_RANGE,
  MAX_NEW_CLAIMS_RANGE,
  MAX_PROJECT_CHARS_RANGE,
  MAX_PROJECT_CLAIMS_RANGE,
  MAX_RECORD_CHARS_RANGE,
  MAX_RECORDS_PER_KIND_RANGE,
  MEMORY_RETAIN_DAY_RANGE,
  MILL_METRICS_RETAIN_DAY_RANGE,
  PACK_DISTILLER_INTERVAL_RANGE,
  PACK_DISTILLER_TIMEOUT_RANGE,
  QUIET_MS_RANGE,
  STALE_HORIZON_DAYS_RANGE,
  TIMEOUT_SECONDS_RANGE,
} from '../../shared/settings-ranges.ts';
import { SOURCE_NAMES } from './ingest-core.ts';

export interface IntegerRange {
  min: number;
  max: number;
}

export interface MillBlockSpec {
  name: string;
  booleans: readonly string[];
  integerRanges: Readonly<Record<string, IntegerRange>>;
  blocks: Readonly<Record<string, MillBlockSpec>>;
}

const NO_BLOCKS: Readonly<Record<string, MillBlockSpec>> = Object.freeze({});
const NO_RANGES: Readonly<Record<string, IntegerRange>> = Object.freeze({});

const MEMORY_DISTILL_SPEC: MillBlockSpec = Object.freeze({
  name: 'memory.distill',
  booleans: Object.freeze(['enabled']),
  integerRanges: Object.freeze({
    intervalMinutes: INTERVAL_MINUTES_RANGE,
    timeoutSeconds: TIMEOUT_SECONDS_RANGE,
    maxNewClaims: MAX_NEW_CLAIMS_RANGE,
    maxProjectClaims: MAX_PROJECT_CLAIMS_RANGE,
    maxProjectChars: MAX_PROJECT_CHARS_RANGE,
    quietMs: QUIET_MS_RANGE,
    staleHorizonDays: STALE_HORIZON_DAYS_RANGE,
  }),
  blocks: NO_BLOCKS,
});

const MEMORY_SPEC: MillBlockSpec = Object.freeze({
  name: 'memory',
  booleans: Object.freeze(['enabled']),
  integerRanges: Object.freeze({
    retainDays: MEMORY_RETAIN_DAY_RANGE,
    memoryRetainDays: MEMORY_RETAIN_DAY_RANGE,
    maxRecordChars: MAX_RECORD_CHARS_RANGE,
    maxRecordsPerKind: MAX_RECORDS_PER_KIND_RANGE,
  }),
  blocks: Object.freeze({ distill: MEMORY_DISTILL_SPEC }),
});

const PACK_DISTILLER_SPEC: MillBlockSpec = Object.freeze({
  name: 'packDistiller',
  booleans: Object.freeze(['enabled']),
  integerRanges: Object.freeze({
    intervalHours: PACK_DISTILLER_INTERVAL_RANGE,
    timeoutSeconds: PACK_DISTILLER_TIMEOUT_RANGE,
  }),
  blocks: NO_BLOCKS,
});

const MILL_METRICS_SPEC: MillBlockSpec = Object.freeze({
  name: 'millMetrics',
  booleans: Object.freeze([]),
  integerRanges: Object.freeze({ retainDays: MILL_METRICS_RETAIN_DAY_RANGE }),
  blocks: NO_BLOCKS,
});

const INGEST_SOURCES_SPEC: MillBlockSpec = Object.freeze({
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

const INGEST_SPEC: MillBlockSpec = Object.freeze({
  name: 'ingest',
  booleans: Object.freeze(['enabled']),
  integerRanges: NO_RANGES,
  blocks: Object.freeze({ sources: INGEST_SOURCES_SPEC }),
});

function validateMillBlock(block: unknown, spec: MillBlockSpec): string | null {
  if (block == null) return null;
  if (!isPlainObject(block)) return `${spec.name} must be an object`;
  for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
    if (value == null) continue;
    if (spec.booleans.includes(key)) {
      if (typeof value !== 'boolean') return `${spec.name}.${key} must be a boolean`;
      continue;
    }
    if (Object.hasOwn(spec.integerRanges, key)) {
      const range = spec.integerRanges[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < range.min || value > range.max) {
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

function pickMillBlock(stored: unknown, spec: MillBlockSpec): Record<string, unknown> | null {
  if (!isPlainObject(stored)) return null;
  const fields = stored as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of spec.booleans) {
    if (fields[key] != null) out[key] = !!fields[key];
  }
  for (const key of Object.keys(spec.integerRanges)) {
    if (fields[key] != null) out[key] = fields[key];
  }
  for (const [key, nested] of Object.entries(spec.blocks)) {
    const picked = pickMillBlock(fields[key], nested);
    if (picked) out[key] = picked;
  }
  return out;
}

function mergeMillBlock(stored: unknown, incoming: unknown, spec: MillBlockSpec): Record<string, unknown> {
  const out: Record<string, unknown> = isPlainObject(stored) ? { ...(stored as Record<string, unknown>) } : {};
  if (!isPlainObject(incoming)) return out;
  const fields = incoming as Record<string, unknown>;
  for (const key of spec.booleans) {
    if (fields[key] != null) out[key] = !!fields[key];
  }
  for (const key of Object.keys(spec.integerRanges)) {
    if (fields[key] != null) out[key] = fields[key];
  }
  for (const [key, nested] of Object.entries(spec.blocks)) {
    if (fields[key] == null) continue;
    out[key] = mergeMillBlock(out[key], fields[key], nested);
  }
  return out;
}

export { INGEST_SPEC, MEMORY_SPEC, MILL_METRICS_SPEC, PACK_DISTILLER_SPEC, mergeMillBlock, pickMillBlock, validateMillBlock };
