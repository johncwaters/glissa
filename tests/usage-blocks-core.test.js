'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildBlocks, burnRate, projectBlock } = require('../server/core/usage-blocks-core');

function entry(timestampMs, input, cacheRead = 0, costUSD = 1) {
  return {
    timestampMs,
    input,
    output: 0,
    cacheCreate: 0,
    cacheRead,
    costUSD,
  };
}

test('buildBlocks floors starts to UTC hours and starts a new block after duration from start', () => {
  const firstTs = Date.UTC(2026, 7, 18, 10, 30);
  const laterTs = Date.UTC(2026, 7, 18, 15, 1);
  const report = buildBlocks([entry(firstTs, 10), entry(laterTs, 20)], { blockHours: 5, now: Date.UTC(2026, 7, 19) });
  assert.equal(report.blocks.length, 2);
  assert.equal(report.blocks[0].startTs, Date.UTC(2026, 7, 18, 10));
  assert.equal(report.blocks[1].startTs, Date.UTC(2026, 7, 18, 15));
});

test('buildBlocks sorts finite timestamp entries without mutating input', () => {
  const firstTs = Date.UTC(2026, 7, 18, 10, 0);
  const laterTs = Date.UTC(2026, 7, 18, 11, 0);
  const shuffled = [entry(laterTs, 20), { timestampMs: Number.NaN, input: 99 }, entry(firstTs, 10)];
  const report = buildBlocks(shuffled, { blockHours: 5, now: Date.UTC(2026, 7, 18, 12, 0) });
  const sortedReport = buildBlocks([entry(firstTs, 10), entry(laterTs, 20)], { blockHours: 5, now: Date.UTC(2026, 7, 18, 12, 0) });
  assert.deepEqual(report.blocks, sortedReport.blocks);
  assert.equal(shuffled[0].timestampMs, laterTs);
});

test('buildBlocks uses strict greater-than duration boundaries', () => {
  const startTs = Date.UTC(2026, 7, 18, 10, 0);
  const exactBoundaryTs = Date.UTC(2026, 7, 18, 15, 0);
  const overBoundaryTs = exactBoundaryTs + 1;
  const exactReport = buildBlocks([entry(startTs, 10), entry(exactBoundaryTs, 20)], { blockHours: 5, now: Date.UTC(2026, 7, 19) });
  const overReport = buildBlocks([entry(startTs, 10), entry(overBoundaryTs, 20)], { blockHours: 5, now: Date.UTC(2026, 7, 19) });
  assert.equal(exactReport.blocks.length, 1);
  assert.equal(overReport.blocks.length, 3);
  assert.equal(overReport.blocks[1].isGap, true);
});

test('buildBlocks emits a gap and marks active blocks from last entry freshness', () => {
  const firstTs = Date.UTC(2026, 7, 18, 10, 0);
  const laterTs = Date.UTC(2026, 7, 18, 16, 1);
  const now = Date.UTC(2026, 7, 18, 17, 0);
  const report = buildBlocks([entry(firstTs, 10), entry(laterTs, 20)], { blockHours: 5, now });
  assert.equal(report.blocks.length, 3);
  assert.equal(report.blocks[1].isGap, true);
  assert.equal(report.blocks[1].startTs, Date.UTC(2026, 7, 18, 15, 0));
  assert.equal(report.blocks[1].endTs, laterTs);
  assert.equal(report.activeBlock, report.blocks[2]);
  assert.equal(report.blocks[2].isActive, true);
});

test('burnRate returns token and cost rates, and projection extends to block end', () => {
  const startTs = Date.UTC(2026, 7, 18, 10, 0);
  const now = Date.UTC(2026, 7, 18, 11, 0);
  const block = buildBlocks([entry(startTs, 60, 0, 2), entry(now, 0, 30, 1)], { blockHours: 5, now }).activeBlock;
  const burn = burnRate(block, now);
  assert.equal(burn.tokensPerMinute, 1.5);
  assert.equal(burn.tokensPerMinuteExCache, 1);
  assert.equal(burn.costPerHour, 3);
  assert.deepEqual(projectBlock(block, burn, now), {
    projectedTokens: 450,
    projectedCostUSD: 15,
    remainingMinutes: 240,
  });
  assert.equal(burnRate({ firstEntryTs: now, lastEntryTs: now, tokens: 1, input: 1, output: 0, costUSD: 1 }, now), null);
});

test('burnRate uses first-to-last entry span for past blocks', () => {
  const startTs = Date.UTC(2026, 7, 18, 10, 0);
  const block = buildBlocks([
    entry(startTs, 600, 0, 1),
    entry(startTs + 2 * 60 * 1000, 600, 0, 1),
  ], { blockHours: 5, now: Date.UTC(2026, 7, 19) }).blocks[0];
  const burn = burnRate(block, Date.UTC(2026, 7, 19));
  assert.equal(burn.tokensPerMinute, 600);
});

test('token limit uses the largest completed non-gap block and warns at 80 percent', () => {
  const completedTs = Date.UTC(2026, 7, 18, 10, 0);
  const activeTs = Date.UTC(2026, 7, 18, 20, 0);
  const report = buildBlocks([
    entry(completedTs, 100),
    entry(activeTs, 80),
  ], { blockHours: 5, now: Date.UTC(2026, 7, 18, 20, 30) });
  assert.equal(report.tokenLimit.max, 100);
  assert.equal(report.tokenLimit.pct, 0.8);
  assert.equal(report.tokenLimit.warn, true);
});

test('token limit is null without a completed non-gap non-active baseline', () => {
  const activeTs = Date.UTC(2026, 7, 18, 20, 0);
  const report = buildBlocks([entry(activeTs, 80)], { blockHours: 5, now: Date.UTC(2026, 7, 18, 20, 30) });
  assert.equal(report.tokenLimit, null);
});
