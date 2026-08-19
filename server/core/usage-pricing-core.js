'use strict';

const MARGINAL_TIER_THRESHOLD = 200000;

function normalizePricingTable(rawLiteLlmJson) {
  const models = rawLiteLlmJson?.models && typeof rawLiteLlmJson.models === 'object'
    ? rawLiteLlmJson.models
    : rawLiteLlmJson;
  const table = new Map();
  if (!models || typeof models !== 'object') return table;
  for (const [key, value] of Object.entries(models)) {
    if (!value || typeof value !== 'object') continue;
    table.set(key, { ...value });
  }
  return table;
}

function lookupModelPrice(table, model, { aliases = {} } = {}) {
  if (!(table instanceof Map) || !model) return null;
  if (table.has(model)) return resolvedPrice(model, table.get(model), true);
  const aliasKey = aliases[model];
  if (aliasKey && table.has(aliasKey)) return resolvedPrice(aliasKey, table.get(aliasKey), false);

  const normalizedModel = normalizeFuzzyKey(model);
  let best = null;
  for (const [key, price] of table.entries()) {
    if (isExactOnlyKey(key)) continue;
    const normalizedKey = normalizeFuzzyKey(key);
    if (!normalizedKey) continue;
    if (!normalizedModel.includes(normalizedKey) && !normalizedKey.includes(normalizedModel)) continue;
    if (best && best.normalizedLength >= normalizedKey.length) continue;
    best = { key, price, normalizedLength: normalizedKey.length };
  }
  if (!best) return null;
  return resolvedPrice(best.key, best.price, false);
}

function costForEntry(entry, price, { costMode = 'auto' } = {}) {
  if (costMode === 'display') {
    const displayedCost = finiteNumber(entry?.costUSD);
    return { costUSD: displayedCost === null ? 0 : displayedCost, priced: displayedCost !== null };
  }
  if (costMode === 'auto') {
    const displayedCost = finiteNumber(entry?.costUSD);
    if (displayedCost !== null) return { costUSD: displayedCost, priced: true };
  }
  if (!price) return { costUSD: 0, priced: false };

  const input = finiteNumber(entry?.input) || 0;
  const output = finiteNumber(entry?.output) || 0;
  const own5m = finiteNumber(entry?.cacheCreation5m);
  const cacheCreation5m = own5m === null ? finiteNumber(entry?.cacheCreate) || 0 : own5m;
  const own1h = finiteNumber(entry?.cacheCreation1h);
  const cacheCreation1h = own1h === null ? 0 : own1h;
  const cacheRead = finiteNumber(entry?.cacheRead) || 0;
  const contextTokens = input + cacheRead + cacheCreation5m + cacheCreation1h;
  const rates = ratesForPrice(price);
  const cost = bucketCost({
    input,
    output,
    cacheCreation5m,
    cacheCreation1h,
    cacheRead,
    contextTokens,
    price,
    rates,
  });
  const multiplier = fastMultiplierFor(entry, price);
  return { costUSD: cost * multiplier, priced: true };
}

function bucketCost({ input, output, cacheCreation5m, cacheCreation1h, cacheRead, contextTokens, price, rates }) {
  const longContextThreshold = finiteNumber(price.long_context_threshold);
  if (longContextThreshold !== null && contextTokens <= longContextThreshold) {
    return input * rates.input
      + output * rates.output
      + cacheCreation5m * rates.cacheCreate
      + cacheCreation1h * (rates.input * 2)
      + cacheRead * rates.cacheRead;
  }
  if (longContextThreshold !== null && contextTokens > longContextThreshold) {
    return input * rates.inputAbove
      + output * rates.outputAbove
      + cacheCreation5m * rates.cacheCreateAbove
      + cacheCreation1h * (rates.inputAbove * 2)
      + cacheRead * rates.cacheReadAbove;
  }
  return marginalBucketCost(input, rates.input, rates.inputAbove)
    + marginalBucketCost(output, rates.output, rates.outputAbove)
    + marginalBucketCost(cacheCreation5m, rates.cacheCreate, rates.cacheCreateAbove)
    + marginalBucketCost(cacheCreation1h, rates.input * 2, rates.inputAbove * 2)
    + marginalBucketCost(cacheRead, rates.cacheRead, rates.cacheReadAbove);
}

function ratesForPrice(price) {
  const input = finiteNumber(price.input_cost_per_token) || 0;
  const output = finiteNumber(price.output_cost_per_token) || 0;
  const cacheCreate = finiteNumber(price.cache_creation_input_token_cost) ?? input * 1.25;
  const cacheRead = finiteNumber(price.cache_read_input_token_cost) ?? input * 0.1;
  const inputAbove = finiteNumber(price.input_cost_per_token_above_200k_tokens) ?? input;
  const outputAbove = finiteNumber(price.output_cost_per_token_above_200k_tokens) ?? output;
  const cacheCreateAbove = finiteNumber(price.cache_creation_input_token_cost_above_200k_tokens) ?? inputAbove * 1.25;
  const cacheReadAbove = finiteNumber(price.cache_read_input_token_cost_above_200k_tokens) ?? inputAbove * 0.1;
  return { input, output, cacheCreate, cacheRead, inputAbove, outputAbove, cacheCreateAbove, cacheReadAbove };
}

function marginalBucketCost(tokens, baseRate, aboveRate) {
  const under = Math.min(tokens, MARGINAL_TIER_THRESHOLD);
  const above = Math.max(0, tokens - MARGINAL_TIER_THRESHOLD);
  return under * baseRate + above * aboveRate;
}

function normalizeFuzzyKey(value) {
  return String(value || '').toLowerCase().replace(/[.@-]/g, '');
}

function isExactOnlyKey(key) {
  return /(?:^|[-.@])fast(?:$|[-.@])/.test(String(key || '').toLowerCase());
}

function fastMultiplierFor(entry, price) {
  if (entry?.speed !== 'fast' && !String(entry?.model || '').endsWith('-fast')) return 1;
  if (price?._resolvedExact && isExactOnlyKey(price?._resolvedPricingKey)) return 1;
  // LiteLLM anthropic entries currently carry no fast multiplier, so fast entries bill at 1x until data provides one.
  return finiteNumber(price?.fast_multiplier) ?? finiteNumber(price?.fastMultiplier) ?? 1;
}

function resolvedPrice(key, price, isExact) {
  return {
    key,
    price: {
      ...price,
      _resolvedExact: isExact,
      _resolvedPricingKey: key,
    },
  };
}

function finiteNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

module.exports = {
  costForEntry,
  lookupModelPrice,
  normalizePricingTable,
};
