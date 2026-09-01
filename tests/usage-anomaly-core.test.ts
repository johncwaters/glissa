import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dailyBaseline,
  detectBurnAnomaly,
  detectDailyAnomaly,
} from '../server/core/usage-anomaly-core.ts';

test('dailyBaseline needs seven usable history days', () => {
  assert.equal(dailyBaseline(days(6, 2), { excludeDay: '2026-08-19' }), null);
});

test('detectDailyAnomaly requires both absolute and relative conditions', () => {
  const baseline = { meanUsd: 10, meanTokens: 100, days: 7 };
  assert.equal(detectDailyAnomaly({ todayUsd: 4, todayTokens: 1000, baseline, minUsd: 5, factor: 0.2 }), null);
  assert.equal(detectDailyAnomaly({ todayUsd: 6, todayTokens: 1000, baseline, minUsd: 5, factor: 1.8 }), null);
});

test('detectDailyAnomaly flags when both conditions match', () => {
  const baseline = dailyBaseline([...days(7, 10), { day: '2026-08-19', costUSD: 99, tokens: 990 }], { excludeDay: '2026-08-19' });
  assert.deepEqual(detectDailyAnomaly({ todayUsd: 20, todayTokens: 200, baseline }), {
    kind: 'daily',
    todayUsd: 20,
    todayTokens: 200,
    baselineUsd: 10,
    ratio: 2,
  });
});

test('detectDailyAnomaly stays quiet with a null baseline', () => {
  assert.equal(detectDailyAnomaly({ todayUsd: 20, todayTokens: 200, baseline: null }), null);
});

test('detectBurnAnomaly excludes gap blocks', () => {
  const alert = detectBurnAnomaly({
    currentTokensPerMinute: 300000,
    completedBlocks: [
      block(60000, 1000),
      block(60000, 2000),
      { ...block(60000, 1000000), isGap: true },
      block(60000, 3000),
    ],
    minTokensPerMinute: 200000,
    factor: 2.5,
  });
  assert.deepEqual(alert, { kind: 'burn', current: 300000, baseline: 2000, ratio: 150 });
});

test('detectBurnAnomaly needs three completed blocks with entries', () => {
  assert.equal(detectBurnAnomaly({
    currentTokensPerMinute: 300000,
    completedBlocks: [block(60000, 1000), block(60000, 2000), { ...block(60000, 3000), entries: 0 }],
  }), null);
});

test('detectBurnAnomaly applies ratio math', () => {
  assert.deepEqual(detectBurnAnomaly({
    currentTokensPerMinute: 250000,
    completedBlocks: [block(60000, 100000), block(60000, 100000), block(60000, 100000)],
    minTokensPerMinute: 200000,
    factor: 2.5,
  }), { kind: 'burn', current: 250000, baseline: 100000, ratio: 2.5 });
});

function days(count: number, costUSD: number) {
  return Array.from({ length: count }, (_, index) => ({
    day: `2026-08-${String(index + 1).padStart(2, '0')}`,
    costUSD,
    tokens: costUSD * 100,
  }));
}

function block(durationMs: number, tokens: number) {
  return {
    startTs: 0,
    endTs: durationMs,
    isGap: false,
    tokens,
    entries: 1,
  };
}
