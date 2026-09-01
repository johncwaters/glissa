'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ranges = require('../shared/settings-ranges.ts');
const memoryCore = require('../server/core/memory-core.ts');
const memoryDistillCore = require('../server/core/memory-distill-core.ts');
const {
  BRANCH_GC_NUMERIC_RANGES,
  POSTHOG_NUMERIC_RANGES,
  PR_REVIEW_NUMERIC_RANGES,
  VISIONS_DISPATCH_NUMERIC_RANGES,
  VISIONS_INTENT_NUMERIC_RANGES,
} = require('../server/control-handlers.ts');
const { MEMORY_SPEC, MILL_METRICS_SPEC, PACK_DISTILLER_SPEC } = require('../server/core/settings-mill-core.ts');
const { USAGE_INTEGER_RANGES } = require('../server/usage-wiring.ts');

test('server resolvers and wire specs reuse the shared range objects', () => {
  assert.strictEqual(memoryCore.MEMORY_RETAIN_DAY_RANGE, ranges.MEMORY_RETAIN_DAY_RANGE);
  assert.strictEqual(memoryCore.MAX_RECORD_CHARS_RANGE, ranges.MAX_RECORD_CHARS_RANGE);
  assert.strictEqual(memoryCore.MAX_RECORDS_PER_KIND_RANGE, ranges.MAX_RECORDS_PER_KIND_RANGE);
  assert.strictEqual(memoryDistillCore.INTERVAL_MINUTES_RANGE, ranges.INTERVAL_MINUTES_RANGE);
  assert.strictEqual(memoryDistillCore.TIMEOUT_SECONDS_RANGE, ranges.TIMEOUT_SECONDS_RANGE);
  assert.strictEqual(memoryDistillCore.MAX_NEW_CLAIMS_RANGE, ranges.MAX_NEW_CLAIMS_RANGE);
  assert.strictEqual(memoryDistillCore.QUIET_MS_RANGE, ranges.QUIET_MS_RANGE);
  assert.strictEqual(MEMORY_SPEC.integerRanges.retainDays, ranges.MEMORY_RETAIN_DAY_RANGE);
  assert.strictEqual(MILL_METRICS_SPEC.integerRanges.retainDays, ranges.MILL_METRICS_RETAIN_DAY_RANGE);
  assert.strictEqual(PACK_DISTILLER_SPEC.integerRanges.intervalHours, ranges.PACK_DISTILLER_INTERVAL_RANGE);
  assert.strictEqual(PACK_DISTILLER_SPEC.integerRanges.timeoutSeconds, ranges.PACK_DISTILLER_TIMEOUT_RANGE);
  assert.strictEqual(USAGE_INTEGER_RANGES, ranges.USAGE_INTEGER_RANGES);
  assert.strictEqual(PR_REVIEW_NUMERIC_RANGES.intervalMinutes, ranges.PR_REVIEW_INTERVAL_RANGE);
  assert.strictEqual(BRANCH_GC_NUMERIC_RANGES.staleDays, ranges.BRANCH_GC_STALE_DAYS_RANGE);
  assert.strictEqual(VISIONS_DISPATCH_NUMERIC_RANGES.quietMs, ranges.VISIONS_QUIET_MS_RANGE);
  assert.strictEqual(VISIONS_INTENT_NUMERIC_RANGES.threadTtlMs, ranges.VISIONS_INTENT_THREAD_TTL_MS_RANGE);
  assert.strictEqual(POSTHOG_NUMERIC_RANGES.fixTimeoutSeconds, ranges.POSTHOG_FIX_TIMEOUT_RANGE);
});

test('every map number resolves directly to the shared catalog', async () => {
  const { SETTINGS_MAP } = await import('../public/settings-map.mjs');
  for (const setting of SETTINGS_MAP.flatMap((section) => section.settings)) {
    if (setting.control !== 'number') continue;
    assert.strictEqual(ranges.SETTINGS_RANGES[setting.range], ranges[setting.range], setting.id);
  }
});
