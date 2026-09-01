import test from 'node:test';
import assert from 'node:assert/strict';

import * as ranges from '../shared/settings-ranges.ts';
import type { SettingsRange } from '../shared/settings-ranges.ts';
import * as memoryCore from '../server/core/memory-core.ts';
import * as memoryDistillCore from '../server/core/memory-distill-core.ts';
import {
  BRANCH_GC_NUMERIC_RANGES,
  POSTHOG_NUMERIC_RANGES,
  PR_REVIEW_NUMERIC_RANGES,
  VISIONS_DISPATCH_NUMERIC_RANGES,
  VISIONS_INTENT_NUMERIC_RANGES,
} from '../server/control-handlers.ts';
import { MEMORY_SPEC, MILL_METRICS_SPEC, PACK_DISTILLER_SPEC } from '../server/core/settings-mill-core.ts';
import { USAGE_INTEGER_RANGES } from '../server/usage-wiring.ts';
import { SETTINGS_MAP } from '../public/settings-map.ts';
import type { SettingsSection } from '../public/settings-map.ts';

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

test('every map number setting names a range the shared catalog carries', () => {
  const catalog: Record<string, SettingsRange | undefined> = ranges.SETTINGS_RANGES;
  const sections: readonly SettingsSection[] = SETTINGS_MAP;
  for (const setting of sections.flatMap((section) => section.settings)) {
    if (setting.control !== 'number') continue;
    const named = setting.range;
    assert.ok(named, `${setting.id} is a number control with no range`);
    assert.ok(catalog[named], `${setting.id} names ${named}, which the shared catalog does not carry`);
  }
});
