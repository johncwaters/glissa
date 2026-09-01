import { numberOrNull } from './usage-number-core.ts';

export type ModelPrice = Record<string, unknown>;

// Loose on purpose: costing reads token counts off whatever row it is handed, parsed entry or not.
export interface PricedEntry {
  costUSD?: unknown;
  input?: unknown;
  output?: unknown;
  cacheCreate?: unknown;
  cacheCreation5m?: unknown;
  cacheCreation1h?: unknown;
  cacheRead?: unknown;
  speed?: unknown;
  model?: unknown;
}

export interface ResolvedModelPrice {
  key: string;
  price: ModelPrice;
}

interface TokenRates {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  inputAbove: number;
  outputAbove: number;
  cacheCreateAbove: number;
  cacheReadAbove: number;
}

const MARGINAL_TIER_THRESHOLD = 200000;

function normalizePricingTable(rawLiteLlmJson: unknown): Map<string, ModelPrice> {
  const container = rawLiteLlmJson as { models?: unknown } | null | undefined;
  const models = container?.models && typeof container.models === 'object'
    ? container.models
    : rawLiteLlmJson;
  const table = new Map<string, ModelPrice>();
  if (!models || typeof models !== 'object') return table;
  for (const [key, value] of Object.entries(models)) {
    if (!value || typeof value !== 'object') continue;
    table.set(key, { ...(value as ModelPrice) });
  }
  return table;
}

function lookupModelPrice(
  table: Map<string, ModelPrice> | null | undefined,
  model: string | null | undefined,
  { aliases = {} }: { aliases?: Record<string, string> } = {},
): ResolvedModelPrice | null {
  if (!(table instanceof Map) || !model) return null;
  const exact = table.get(model);
  if (exact !== undefined) return resolvedPrice(model, exact, true);
  const aliasKey = aliases[model];
  const aliased = aliasKey ? table.get(aliasKey) : undefined;
  if (aliasKey && aliased !== undefined) return resolvedPrice(aliasKey, aliased, false);

  const normalizedModel = normalizeFuzzyKey(model);
  let best: { key: string; price: ModelPrice; normalizedLength: number } | null = null;
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

function costForEntry(
  entry: PricedEntry | null | undefined,
  price: ModelPrice | null | undefined,
  { costMode = 'auto' }: { costMode?: string } = {},
): { costUSD: number; priced: boolean } {
  if (costMode === 'display') {
    const displayedCost = numberOrNull(entry?.costUSD);
    return { costUSD: displayedCost === null ? 0 : displayedCost, priced: displayedCost !== null };
  }
  if (costMode === 'auto') {
    const displayedCost = numberOrNull(entry?.costUSD);
    if (displayedCost !== null) return { costUSD: displayedCost, priced: true };
  }
  if (!price) return { costUSD: 0, priced: false };

  const input = numberOrNull(entry?.input) || 0;
  const output = numberOrNull(entry?.output) || 0;
  const own5m = numberOrNull(entry?.cacheCreation5m);
  const cacheCreation5m = own5m === null ? numberOrNull(entry?.cacheCreate) || 0 : own5m;
  const own1h = numberOrNull(entry?.cacheCreation1h);
  const cacheCreation1h = own1h === null ? 0 : own1h;
  const cacheRead = numberOrNull(entry?.cacheRead) || 0;
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

function bucketCost({ input, output, cacheCreation5m, cacheCreation1h, cacheRead, contextTokens, price, rates }: {
  input: number;
  output: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  cacheRead: number;
  contextTokens: number;
  price: ModelPrice;
  rates: TokenRates;
}): number {
  const longContextThreshold = numberOrNull(price.long_context_threshold);
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

function ratesForPrice(price: ModelPrice): TokenRates {
  const input = numberOrNull(price.input_cost_per_token) || 0;
  const output = numberOrNull(price.output_cost_per_token) || 0;
  const cacheCreate = numberOrNull(price.cache_creation_input_token_cost) ?? input * 1.25;
  const cacheRead = numberOrNull(price.cache_read_input_token_cost) ?? input * 0.1;
  const inputAbove = numberOrNull(price.input_cost_per_token_above_200k_tokens) ?? input;
  const outputAbove = numberOrNull(price.output_cost_per_token_above_200k_tokens) ?? output;
  const cacheCreateAbove = numberOrNull(price.cache_creation_input_token_cost_above_200k_tokens) ?? inputAbove * 1.25;
  const cacheReadAbove = numberOrNull(price.cache_read_input_token_cost_above_200k_tokens) ?? inputAbove * 0.1;
  return { input, output, cacheCreate, cacheRead, inputAbove, outputAbove, cacheCreateAbove, cacheReadAbove };
}

function marginalBucketCost(tokens: number, baseRate: number, aboveRate: number): number {
  const under = Math.min(tokens, MARGINAL_TIER_THRESHOLD);
  const above = Math.max(0, tokens - MARGINAL_TIER_THRESHOLD);
  return under * baseRate + above * aboveRate;
}

function normalizeFuzzyKey(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[.@-]/g, '');
}

function isExactOnlyKey(key: unknown): boolean {
  return /(?:^|[-.@])fast(?:$|[-.@])/.test(String(key || '').toLowerCase());
}

function fastMultiplierFor(entry: PricedEntry | null | undefined, price: ModelPrice | null | undefined): number {
  if (entry?.speed !== 'fast' && !String(entry?.model || '').endsWith('-fast')) return 1;
  if (price?._resolvedExact && isExactOnlyKey(price?._resolvedPricingKey)) return 1;
  // LiteLLM anthropic entries currently carry no fast multiplier, so fast entries bill at 1x until data provides one.
  return numberOrNull(price?.fast_multiplier) ?? numberOrNull(price?.fastMultiplier) ?? 1;
}

function resolvedPrice(key: string, price: ModelPrice, isExact: boolean): ResolvedModelPrice {
  return {
    key,
    price: {
      ...price,
      _resolvedExact: isExact,
      _resolvedPricingKey: key,
    },
  };
}

export { costForEntry, lookupModelPrice, normalizePricingTable, ratesForPrice };
