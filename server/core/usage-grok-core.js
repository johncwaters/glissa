'use strict';

const { parseJsonLine, vendorUsageEntry } = require('./usage-entry-core');
const { numberOrNull, safeNumber, stringOrNull } = require('./usage-number-core');

function parseGrokUsageLine(line) {
  const parsed = parseJsonLine(line, '"turn_completed"');
  if (!parsed) return null;

  const update = parsed.params?.update;
  if (!update || update.sessionUpdate !== 'turn_completed') return null;
  const usage = update.usage;
  if (!usage || typeof usage !== 'object') return null;

  const modelUsage = usage.modelUsage && typeof usage.modelUsage === 'object' ? usage.modelUsage : null;
  if (!modelUsage) return null;
  const model = Object.keys(modelUsage).find((modelKey) => stringOrNull(modelKey) && modelUsage[modelKey]);
  if (!model) return null;

  const modelCounts = modelUsage[model] && typeof modelUsage[model] === 'object' ? modelUsage[model] : usage;
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

function grokDedupIdentity(entry) {
  // Grok turn_completed entries carry prompt_id, with timestamp fallback for older rows.
  if (!entry) return null;
  if (entry.messageId) return `${entry.vendor}:${entry.sessionId}:${entry.messageId}`;
  return `${entry.vendor}:${entry.sessionId}:${entry.timestampMs}:${entry.model}`;
}

function timestampMsFrom(parsed) {
  const agentTimestampMs = numberOrNull(parsed.params?._meta?.agentTimestampMs);
  if (agentTimestampMs !== null) return agentTimestampMs;
  const seconds = numberOrNull(parsed.timestamp);
  if (seconds === null) return NaN;
  return seconds * 1000;
}

function grokFallbackCostUSD(model, input, output, cacheRead, cacheCreate) {
  const normalizedModel = normalizeGrokModel(model);
  if (normalizedModel !== 'grok-4.5' && normalizedModel !== 'grok-4.6') return null;
  const isLongContext = input + cacheRead + cacheCreate > 200000;
  const inputRate = isLongContext ? 4 : 2;
  const outputRate = isLongContext ? 12 : 6;
  const cacheReadRate = isLongContext ? 0.6 : 0.3;
  return ((input + cacheCreate) * inputRate + output * outputRate + cacheRead * cacheReadRate) / 1000000;
}

function normalizeGrokModel(model) {
  const stripped = stringOrNull(model)?.replace(/^\[grok\]\s+/, '') || '';
  return stripped.endsWith('-build') ? stripped.slice(0, -6) : stripped;
}

module.exports = {
  grokDedupIdentity,
  parseGrokUsageLine,
};
