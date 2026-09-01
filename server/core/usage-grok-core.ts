import { parseJsonLine, vendorUsageEntry } from './usage-entry-core.ts';
import type { DedupIdentityEntry, UsageEntry } from './usage-entry-core.ts';
import { numberOrNull, safeNumber, stringOrNull } from './usage-number-core.ts';

interface GrokCounts {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedReadTokens?: unknown;
  cacheCreationTokens?: unknown;
  costUsdTicks?: unknown;
}

interface GrokLine {
  timestamp?: unknown;
  params?: {
    sessionId?: unknown;
    update?: { sessionUpdate?: unknown; usage?: unknown; prompt_id?: unknown } | null;
    _meta?: { agentTimestampMs?: unknown } | null;
  } | null;
}

function parseGrokUsageLine(line: unknown): UsageEntry | null {
  const raw = parseJsonLine(line, '"turn_completed"');
  if (!raw) return null;
  const parsed = raw as GrokLine;

  const update = parsed.params?.update;
  if (!update || update.sessionUpdate !== 'turn_completed') return null;
  const rawUsage = update.usage;
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const usage = rawUsage as GrokCounts & { modelUsage?: unknown };

  const modelUsage = usage.modelUsage && typeof usage.modelUsage === 'object'
    ? (usage.modelUsage as Record<string, unknown>)
    : null;
  if (!modelUsage) return null;
  const model = Object.keys(modelUsage).find((modelKey) => stringOrNull(modelKey) && modelUsage[modelKey]);
  if (!model) return null;

  const modelCountsValue = modelUsage[model];
  const modelCounts: GrokCounts = modelCountsValue && typeof modelCountsValue === 'object'
    ? (modelCountsValue as GrokCounts)
    : usage;
  const timestampMs = timestampMsFrom(parsed);
  if (!Number.isFinite(timestampMs)) return null;

  const inputTokens = safeNumber(modelCounts.inputTokens);
  const cacheRead = safeNumber(modelCounts.cachedReadTokens);
  const cacheCreate = safeNumber(modelCounts.cacheCreationTokens);
  const costUsdTicks = numberOrNull(modelCounts.costUsdTicks) ?? numberOrNull(usage.costUsdTicks);
  const uncachedInput = Math.max(0, inputTokens - cacheRead - cacheCreate);
  const outputTokens = safeNumber(modelCounts.outputTokens);
  const entry = vendorUsageEntry({
    timestampMs,
    sessionId: stringOrNull(parsed.params?.sessionId),
    model,
    input: uncachedInput,
    output: outputTokens,
    cacheCreate,
    cacheRead,
    costUSD: costUsdTicks === null
      ? grokFallbackCostUSD(model, uncachedInput, outputTokens, cacheRead, cacheCreate)
      : costUsdTicks / 10000000000,
    vendor: 'grok',
  });
  const messageId = stringOrNull(update.prompt_id);
  if (messageId === null) return entry;
  return { ...entry, messageId };
}

function grokDedupIdentity(entry: DedupIdentityEntry | null | undefined): string | null {
  if (!entry) return null;
  if (entry.messageId) return `${entry.vendor}:${entry.sessionId}:${entry.messageId}`;
  return `${entry.vendor}:${entry.sessionId}:${entry.timestampMs}:${entry.model}`;
}

function timestampMsFrom(parsed: GrokLine): number {
  const agentTimestampMs = numberOrNull(parsed.params?._meta?.agentTimestampMs);
  if (agentTimestampMs !== null) return agentTimestampMs;
  const seconds = numberOrNull(parsed.timestamp);
  if (seconds === null) return NaN;
  return seconds * 1000;
}

function grokFallbackCostUSD(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreate: number,
): number | null {
  const normalizedModel = normalizeGrokModel(model);
  if (normalizedModel !== 'grok-4.5' && normalizedModel !== 'grok-4.6') return null;
  const isLongContext = input + cacheRead + cacheCreate > 200000;
  const inputRate = isLongContext ? 4 : 2;
  const outputRate = isLongContext ? 12 : 6;
  const cacheReadRate = isLongContext ? 0.6 : 0.3;
  return ((input + cacheCreate) * inputRate + output * outputRate + cacheRead * cacheReadRate) / 1000000;
}

function normalizeGrokModel(model: unknown): string {
  const stripped = stringOrNull(model)?.replace(/^\[grok\]\s+/, '') || '';
  return stripped.endsWith('-build') ? stripped.slice(0, -6) : stripped;
}

export { grokDedupIdentity, parseGrokUsageLine };
