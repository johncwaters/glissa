import type { TokenCountsSource, UsageEntryLike, UsageTotals } from './usage-entry-core.ts';
import { addEntryToTotals, emptyTotals } from './usage-entry-core.ts';

export interface UsageBlock extends UsageTotals {
  startTs: number;
  endTs: number;
  isGap: boolean;
  isActive: boolean;
  entries: number;
  firstEntryTs: number | null;
  lastEntryTs: number | null;
}

export interface BurnRate {
  tokensPerMinute: number;
  tokensPerMinuteExCache: number;
  costPerHour: number;
}

const HOUR_MS = 60 * 60 * 1000;

function buildBlocks(
  entriesAsc: UsageEntryLike[] | null | undefined,
  { blockHours = 5, now = Date.now() }: { blockHours?: number; now?: number } = {},
): { blocks: UsageBlock[]; activeBlock: UsageBlock | null; tokenLimit: { max: number; pct: number; warn: boolean } | null } {
  const duration = blockHours * HOUR_MS;
  const blocks: UsageBlock[] = [];
  let current: UsageBlock | null = null;
  let previousEntryTs: number | null = null;
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

function burnRate(
  block: (TokenCountsSource & { tokens?: number; firstEntryTs?: number | null; lastEntryTs?: number | null }) | null | undefined,
): BurnRate | null {
  if (!block) return null;
  const elapsedMs = (block.lastEntryTs ?? 0) - (block.firstEntryTs ?? 0);
  if (elapsedMs <= 0) return null;
  const minutes = elapsedMs / 60000;
  return {
    tokensPerMinute: (block.tokens ?? 0) / minutes,
    tokensPerMinuteExCache: ((block.input ?? 0) + (block.output ?? 0)) / minutes,
    costPerHour: (block.costUSD ?? 0) / (minutes / 60),
  };
}

function projectBlock(
  block: { tokens?: number; costUSD?: number | null; endTs?: number } | null | undefined,
  burn: BurnRate | null | undefined,
  now: number = Date.now(),
): { projectedTokens: number; projectedCostUSD: number; remainingMinutes: number } | null {
  if (!block || !burn) return null;
  const remainingMinutes = Math.max(0, ((block.endTs ?? 0) - now) / 60000);
  return {
    projectedTokens: (block.tokens ?? 0) + burn.tokensPerMinute * remainingMinutes,
    projectedCostUSD: (block.costUSD ?? 0) + (burn.costPerHour / 60) * remainingMinutes,
    remainingMinutes,
  };
}

function addGapAndNewBlock(
  blocks: UsageBlock[],
  previousEntryTs: number,
  entryTs: number,
  duration: number,
): UsageBlock {
  blocks.push({ ...newUsageBlock(previousEntryTs + duration, duration), endTs: entryTs, isGap: true });
  const block = newUsageBlock(hourFloor(entryTs), duration);
  blocks.push(block);
  return block;
}

function newUsageBlock(startTs: number, duration: number): UsageBlock {
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

function addEntry(block: UsageBlock, entry: UsageEntryLike): void {
  addEntryToTotals(block, entry);
  block.entries += 1;
  block.firstEntryTs = block.firstEntryTs === null ? entry.timestampMs : block.firstEntryTs;
  block.lastEntryTs = entry.timestampMs;
}

function hourFloor(timestampMs: number): number {
  return Math.floor(timestampMs / HOUR_MS) * HOUR_MS;
}

export { buildBlocks, burnRate, projectBlock };
