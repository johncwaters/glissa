'use strict';

const { addEntryToTotals, emptyTotals } = require('./usage-entry-core');

const HOUR_MS = 60 * 60 * 1000;

function buildBlocks(entriesAsc, { blockHours = 5, now = Date.now() } = {}) {
  const duration = blockHours * HOUR_MS;
  const blocks = [];
  /** @type {ReturnType<typeof newUsageBlock> | null} */
  let current = null;
  let previousEntryTs = null;
  const sortedEntries = (entriesAsc || [])
    .filter((entry) => Number.isFinite(entry?.timestampMs))
    .slice()
    .sort((a, b) => a.timestampMs - b.timestampMs);

  for (const entry of sortedEntries) {
    const entryTs = entry.timestampMs;
    if (!current) {
      current = newUsageBlock(hourFloor(entryTs), duration);
      blocks.push(current);
    }
    const sinceStart = entryTs - current.startTs;
    const sinceLast = previousEntryTs === null ? 0 : entryTs - previousEntryTs;
    if (previousEntryTs !== null && sinceLast > duration) {
      current = addGapAndNewBlock(blocks, previousEntryTs, entryTs, duration);
    }
    if (sinceLast <= duration && sinceStart > duration) {
      current = newUsageBlock(hourFloor(entryTs), duration);
      blocks.push(current);
    }
    addEntry(current, entry);
    previousEntryTs = entryTs;
  }

  for (const block of blocks) {
    block.isActive = !block.isGap && block.lastEntryTs !== null && now - block.lastEntryTs < duration && now < block.endTs;
  }

  const activeBlock = blocks.find((block) => block.isActive) || null;
  const completedBlocks = blocks.filter((block) => !block.isGap && !block.isActive);
  const max = completedBlocks.reduce((best, block) => Math.max(best, block.tokens), 0);
  const tokenLimit = max > 0 && activeBlock
    ? { max, pct: activeBlock.tokens / max, warn: activeBlock.tokens / max >= 0.8 }
    : null;
  return { blocks, activeBlock, tokenLimit };
}

function burnRate(block) {
  if (!block) return null;
  const elapsedMs = block.lastEntryTs - block.firstEntryTs;
  if (elapsedMs <= 0) return null;
  const minutes = elapsedMs / 60000;
  return {
    tokensPerMinute: block.tokens / minutes,
    tokensPerMinuteExCache: (block.input + block.output) / minutes,
    costPerHour: block.costUSD / (minutes / 60),
  };
}

function projectBlock(block, burn, now = Date.now()) {
  if (!block || !burn) return null;
  const remainingMinutes = Math.max(0, (block.endTs - now) / 60000);
  return {
    projectedTokens: block.tokens + burn.tokensPerMinute * remainingMinutes,
    projectedCostUSD: block.costUSD + (burn.costPerHour / 60) * remainingMinutes,
    remainingMinutes,
  };
}

function addGapAndNewBlock(blocks, previousEntryTs, entryTs, duration) {
  blocks.push({ ...newUsageBlock(previousEntryTs + duration, duration), endTs: entryTs, isGap: true });
  const block = newUsageBlock(hourFloor(entryTs), duration);
  blocks.push(block);
  return block;
}

function newUsageBlock(startTs, duration) {
  return {
    startTs,
    endTs: startTs + duration,
    isGap: false,
    isActive: false,
    ...emptyTotals(),
    entries: 0,
    firstEntryTs: null,
    lastEntryTs: null,
  };
}

function addEntry(block, entry) {
  addEntryToTotals(block, entry);
  block.entries += 1;
  block.firstEntryTs = block.firstEntryTs === null ? entry.timestampMs : block.firstEntryTs;
  block.lastEntryTs = entry.timestampMs;
}

function hourFloor(timestampMs) {
  return Math.floor(timestampMs / HOUR_MS) * HOUR_MS;
}

module.exports = {
  buildBlocks,
  burnRate,
  projectBlock,
};
