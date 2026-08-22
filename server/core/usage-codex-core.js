'use strict';

const { parseJsonLine, vendorUsageEntry } = require('./usage-entry-core');
const { safeNumber, stringOrNull } = require('./usage-number-core');

function createCodexUsageState() {
  return { model: null, totalTokenUsage: null };
}

function parseCodexUsageLine(line, state = createCodexUsageState(), { sessionId = null } = {}) {
  const parsed = parseJsonLine(line);
  if (!parsed) return null;
  if (parsed.type === 'turn_context') return recordTurnContext(parsed, state);
  if (parsed.payload?.type === 'thread_settings_applied') return recordThreadSettings(parsed, state);
  if (parsed.payload?.type !== 'token_count') return null;

  const timestampMs = Date.parse(parsed.timestamp);
  if (!Number.isFinite(timestampMs)) return null;

  const info = parsed.payload.info;
  if (!info || typeof info !== 'object') return null;
  const totalUsage = usageObjectOrNull(info.total_token_usage);
  if (isSameUsage(totalUsage, state.totalTokenUsage)) return null;
  const tokenUsage = usageObjectOrNull(info.last_token_usage) || deltaFromTotal(totalUsage, state.totalTokenUsage);
  if (!tokenUsage) return null;
  state.totalTokenUsage = totalUsage;

  const inputTokens = safeNumber(tokenUsage.input_tokens);
  const cacheRead = safeNumber(tokenUsage.cached_input_tokens);
  return vendorUsageEntry({
    timestampMs,
    sessionId: stringOrNull(sessionId),
    model: state.model,
    input: Math.max(0, inputTokens - cacheRead),
    output: safeNumber(tokenUsage.output_tokens),
    cacheCreate: safeNumber(tokenUsage.cache_write_input_tokens),
    cacheRead,
    costUSD: null,
    vendor: 'codex',
  });
}

function codexDedupIdentity(entry) {
  // Codex token_count entries have no message id, so timestamp plus session and counters define identity.
  if (!entry) return null;
  return [
    entry.vendor,
    entry.sessionId,
    entry.timestampMs,
    entry.model,
    entry.input,
    entry.output,
    entry.cacheCreate,
    entry.cacheRead,
  ].join(':');
}

function recordTurnContext(parsed, state) {
  state.model = stringOrNull(parsed.payload?.model);
  return null;
}

function recordThreadSettings(parsed, state) {
  const threadSettings = parsed.payload.thread_settings;
  if (!threadSettings || typeof threadSettings !== 'object') return null;
  state.model = stringOrNull(threadSettings.model) || state.model;
  return null;
}

function usageObjectOrNull(value) {
  if (!value || typeof value !== 'object') return null;
  return value;
}

function isSameUsage(left, right) {
  if (!left || !right) return false;
  return safeNumber(left.input_tokens) === safeNumber(right.input_tokens)
    && safeNumber(left.cached_input_tokens) === safeNumber(right.cached_input_tokens)
    && safeNumber(left.cache_write_input_tokens) === safeNumber(right.cache_write_input_tokens)
    && safeNumber(left.output_tokens) === safeNumber(right.output_tokens)
    && safeNumber(left.reasoning_output_tokens) === safeNumber(right.reasoning_output_tokens)
    && safeNumber(left.total_tokens) === safeNumber(right.total_tokens);
}

function deltaFromTotal(totalUsage, previousTotalUsage) {
  if (!totalUsage) return null;
  if (!previousTotalUsage) return totalUsage;
  return {
    input_tokens: safeNumber(totalUsage.input_tokens) - safeNumber(previousTotalUsage.input_tokens),
    cached_input_tokens: safeNumber(totalUsage.cached_input_tokens) - safeNumber(previousTotalUsage.cached_input_tokens),
    cache_write_input_tokens: safeNumber(totalUsage.cache_write_input_tokens) - safeNumber(previousTotalUsage.cache_write_input_tokens),
    output_tokens: safeNumber(totalUsage.output_tokens) - safeNumber(previousTotalUsage.output_tokens),
    reasoning_output_tokens: safeNumber(totalUsage.reasoning_output_tokens) - safeNumber(previousTotalUsage.reasoning_output_tokens),
    total_tokens: safeNumber(totalUsage.total_tokens) - safeNumber(previousTotalUsage.total_tokens),
  };
}

module.exports = {
  codexDedupIdentity,
  createCodexUsageState,
  parseCodexUsageLine,
};
