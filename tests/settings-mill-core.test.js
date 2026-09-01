'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INGEST_SPEC,
  MEMORY_SPEC,
  MILL_METRICS_SPEC,
  PACK_DISTILLER_SPEC,
  mergeMillBlock,
  validateMillBlock,
} = require('../server/core/settings-mill-core');
const { resolveMemoryConfig } = require('../server/core/memory-core');
const { resolveDistillConfig } = require('../server/core/memory-distill-core');
const { resolveIngestConfig } = require('../server/core/ingest-core');
const settingsRanges = require('../shared/settings-ranges.ts');

test('an absent block is valid, so an untouched tab writes nothing', () => {
  for (const spec of [MEMORY_SPEC, MILL_METRICS_SPEC, PACK_DISTILLER_SPEC, INGEST_SPEC]) {
    assert.equal(validateMillBlock(null, spec), null);
    assert.equal(validateMillBlock(undefined, spec), null);
  }
});

test('a non-object block is refused by name', () => {
  assert.equal(validateMillBlock('on', MEMORY_SPEC), 'memory must be an object');
  assert.equal(validateMillBlock([], PACK_DISTILLER_SPEC), 'packDistiller must be an object');
});

test('every allow-listed memory toggle passes, nested block included', () => {
  const error = validateMillBlock({
    enabled: true,
    retainDays: 90,
    memoryRetainDays: 90,
    maxRecordChars: 4000,
    maxRecordsPerKind: 500,
    distill: { enabled: false, intervalMinutes: 60, timeoutSeconds: 600, maxNewClaims: 5, quietMs: 0 },
  }, MEMORY_SPEC);
  assert.equal(error, null);
});

test('an unlisted key is refused by name at every depth', () => {
  assert.equal(validateMillBlock({ dir: '/tmp/x' }, MEMORY_SPEC), 'memory.dir is not settable from the dashboard');
  assert.equal(
    validateMillBlock({ distill: { promptPath: '/tmp/x' } }, MEMORY_SPEC),
    'memory.distill.promptPath is not settable from the dashboard',
  );
  assert.equal(
    validateMillBlock({ sources: { fs: { roots: ['/'] } } }, INGEST_SPEC),
    'ingest.sources.fs.roots is not settable from the dashboard',
  );
  assert.equal(
    validateMillBlock({ specsDir: '/tmp/x' }, PACK_DISTILLER_SPEC),
    'packDistiller.specsDir is not settable from the dashboard',
  );
});

test('a wrong type is refused rather than coerced, so a string cannot enable a lane', () => {
  assert.equal(validateMillBlock({ enabled: 'yes' }, MEMORY_SPEC), 'memory.enabled must be a boolean');
  assert.equal(validateMillBlock({ enabled: 1 }, INGEST_SPEC), 'ingest.enabled must be a boolean');
  assert.equal(
    validateMillBlock({ retainDays: 90.5 }, MEMORY_SPEC),
    'memory.retainDays must be an integer between 30 and 3650',
  );
});

test('the wire bounds match the clamps each resolver would silently apply', () => {
  assert.strictEqual(MEMORY_SPEC.integerRanges.retainDays, settingsRanges.MEMORY_RETAIN_DAY_RANGE);
  assert.strictEqual(MEMORY_SPEC.blocks.distill.integerRanges.maxNewClaims, settingsRanges.MAX_NEW_CLAIMS_RANGE);
  assert.strictEqual(PACK_DISTILLER_SPEC.integerRanges.intervalHours, settingsRanges.PACK_DISTILLER_INTERVAL_RANGE);
  assert.strictEqual(MILL_METRICS_SPEC.integerRanges.retainDays, settingsRanges.MILL_METRICS_RETAIN_DAY_RANGE);
  assert.equal(
    validateMillBlock({ retainDays: 29 }, MEMORY_SPEC),
    'memory.retainDays must be an integer between 30 and 3650',
  );
  assert.equal(resolveMemoryConfig({ retainDays: 29 }).retainDays, resolveMemoryConfig(null).retainDays);
  assert.equal(
    validateMillBlock({ distill: { maxNewClaims: 501 } }, MEMORY_SPEC),
    'memory.distill.maxNewClaims must be an integer between 1 and 500',
  );
  assert.equal(
    resolveDistillConfig({ maxNewClaims: 501 }, { memoryEnabled: true }).maxNewClaims,
    resolveDistillConfig(null, { memoryEnabled: true }).maxNewClaims,
  );
});

test('mill measurement accepts its settings and rejects out-of-range or unknown keys', () => {
  assert.equal(validateMillBlock({ retainDays: 90 }, MILL_METRICS_SPEC), null);
  assert.equal(
    validateMillBlock({ retainDays: 6 }, MILL_METRICS_SPEC),
    'millMetrics.retainDays must be an integer between 7 and 3650',
  );
  assert.equal(
    validateMillBlock({ recordsPath: '/tmp/mill.json' }, MILL_METRICS_SPEC),
    'millMetrics.recordsPath is not settable from the dashboard',
  );
});

test('every ingest source the lane resolves has a settable gate and no settable bound', () => {
  const resolved = resolveIngestConfig({ enabled: true });
  for (const source of Object.keys(resolved.sources)) {
    assert.equal(validateMillBlock({ sources: { [source]: { enabled: true } } }, INGEST_SPEC), null);
    assert.equal(
      validateMillBlock({ sources: { [source]: { maxBytes: 1 } } }, INGEST_SPEC),
      `ingest.sources.${source}.maxBytes is not settable from the dashboard`,
    );
  }
});

test('a merge writes the allow-listed keys and keeps every other stored one', () => {
  const merged = mergeMillBlock(
    { enabled: false, retainDays: 365, futureKnob: 7, distill: { quietMs: 500, futureKnob: 9 } },
    { enabled: true, distill: { enabled: false } },
    MEMORY_SPEC,
  );
  assert.deepEqual(merged, {
    enabled: true,
    retainDays: 365,
    futureKnob: 7,
    distill: { quietMs: 500, futureKnob: 9, enabled: false },
  });
});

test('a merge over no stored block builds one, and a truthy non-boolean cannot smuggle a value in', () => {
  assert.deepEqual(mergeMillBlock(null, { enabled: true }, PACK_DISTILLER_SPEC), { enabled: true });
  assert.deepEqual(mergeMillBlock(undefined, { enabled: 'yes' }, INGEST_SPEC), { enabled: true });
});
