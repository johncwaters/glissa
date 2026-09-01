import nodeFsPromises from 'node:fs/promises';
import path from 'node:path';

import { glissaHomeDir } from './config-store.ts';
import { normalizePricingTable } from './core/usage-pricing-core.ts';
import type { ModelPrice } from './core/usage-pricing-core.ts';
import pricingSnapshot from './data/claude-pricing.json' with { type: 'json' };

const LITELLM_PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_FIELDS = Object.freeze([
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_creation_input_token_cost',
  'cache_read_input_token_cost',
  'cache_creation_input_token_cost_above_200k_tokens',
  'cache_read_input_token_cost_above_200k_tokens',
  'input_cost_per_token_above_200k_tokens',
  'output_cost_per_token_above_200k_tokens',
  'cache_creation_input_token_cost_above_1hr_above_200k_tokens',
  'long_context_threshold',
  'max_input_tokens',
  'litellm_provider',
  'fast_multiplier',
]);

type ModelTable = Record<string, Record<string, unknown>>;
type PricingFileSystem = Pick<typeof nodeFsPromises, 'readFile' | 'mkdir' | 'writeFile'>;

interface PricingResult {
  table: Map<string, ModelPrice>;
  source: string;
  fetchedAt: string | number | null;
}

interface CachedPricing {
  fetchedAt: string | number | null;
  models: ModelTable;
}

interface LoadPricingOptions {
  fetchEnabled?: boolean;
  fsPromises?: PricingFileSystem;
  fetchFn?: typeof fetch;
  cachePath?: string;
  nowFn?: () => number;
  timeoutMs?: number;
  logger?: Pick<Console, 'warn'> | null;
}

// Only providers the snapshot covers get through a fetch; Grok is absent on purpose (it prices itself).
const FETCH_PROVIDERS = new Set(['anthropic', 'openai']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimModel(model: Record<string, unknown>): Record<string, unknown> {
  const trimmed: Record<string, unknown> = {};
  for (const field of SNAPSHOT_FIELDS) {
    if (!Object.hasOwn(model, field)) continue;
    trimmed[field] = model[field];
  }
  return trimmed;
}

function trimAnthropicModels(raw: unknown): ModelTable | null {
  const container = raw as { models?: unknown } | null | undefined;
  const sourceModels = container?.models && typeof container.models === 'object' ? container.models : raw;
  if (!sourceModels || typeof sourceModels !== 'object') return null;
  const models: ModelTable = {};
  for (const [key, model] of Object.entries(sourceModels)) {
    if (!model || typeof model !== 'object') continue;
    const record = model as Record<string, unknown>;
    if (!FETCH_PROVIDERS.has(String(record.litellm_provider))) continue;
    models[key] = trimModel(record);
  }
  return models;
}

function overlaySnapshot(models: ModelTable | null): { models: Record<string, unknown> } {
  return { models: { ...(pricingSnapshot.models || {}), ...(models || {}) } };
}

function pricedResult(models: ModelTable | null, source: string, fetchedAt: string | number | null): PricingResult {
  return {
    table: normalizePricingTable(overlaySnapshot(models)),
    source,
    fetchedAt,
  };
}

async function fetchPricing(
  { fetchFn, timeoutMs }: { fetchFn: typeof fetch | undefined; timeoutMs: number },
): Promise<ModelTable | null> {
  if (typeof fetchFn !== 'function') return null;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetchFn(LITELLM_PRICING_URL, { signal: abortController.signal });
    if (!response || !response.ok) return null;
    const body: unknown = await response.json();
    return trimAnthropicModels(body);
  } finally {
    clearTimeout(timer);
  }
}

async function readCache(fsPromises: PricingFileSystem, cachePath: string): Promise<CachedPricing | null> {
  try {
    const text = await fsPromises.readFile(cachePath, 'utf8');
    const parsed: unknown = JSON.parse(String(text));
    if (!parsed || typeof parsed !== 'object') return null;
    const doc = parsed as { fetchedAt?: unknown; models?: unknown };
    if (!doc.models || typeof doc.models !== 'object') return null;
    const fetchedAt = typeof doc.fetchedAt === 'string' || typeof doc.fetchedAt === 'number' ? doc.fetchedAt : null;
    return { fetchedAt, models: doc.models as ModelTable };
  } catch {
    return null;
  }
}

async function writeCache({ fsPromises, cachePath, fetchedAt, models, logger }: {
  fsPromises: PricingFileSystem;
  cachePath: string;
  fetchedAt: string;
  models: ModelTable;
  logger: Pick<Console, 'warn'> | null;
}): Promise<void> {
  try {
    await fsPromises.mkdir(path.dirname(cachePath), { recursive: true });
    await fsPromises.writeFile(cachePath, JSON.stringify({ fetchedAt, models }, null, 2));
  } catch (error) {
    if (logger && typeof logger.warn === 'function') logger.warn(`usage pricing cache write failed: ${errorMessage(error)}`);
  }
}

function isFresh(fetchedAt: string | number | null, nowMs: number): boolean {
  const fetchedMs = typeof fetchedAt === 'number' ? fetchedAt : Date.parse(String(fetchedAt));
  if (!Number.isFinite(fetchedMs)) return false;
  return nowMs - fetchedMs < CACHE_TTL_MS;
}

async function loadPricing({
  fetchEnabled,
  fsPromises = nodeFsPromises,
  fetchFn = globalThis.fetch,
  cachePath = path.join(glissaHomeDir(), 'litellm-pricing.json'),
  nowFn = Date.now,
  timeoutMs = 15000,
  logger = null,
}: LoadPricingOptions = {}): Promise<PricingResult> {
  if (!fetchEnabled) {
    return { table: normalizePricingTable(pricingSnapshot), source: 'snapshot', fetchedAt: null };
  }

  const cache = await readCache(fsPromises, cachePath);
  if (cache && isFresh(cache.fetchedAt, nowFn())) {
    return pricedResult(cache.models, 'cache', cache.fetchedAt);
  }

  const fetched = await fetchPricing({ fetchFn, timeoutMs }).catch(() => null);
  if (fetched) {
    const fetchedAt = nowFn();
    const cacheFetchedAt = new Date(fetchedAt).toISOString();
    await writeCache({ fsPromises, cachePath, fetchedAt: cacheFetchedAt, models: fetched, logger });
    return pricedResult(fetched, 'fetched', fetchedAt);
  }
  if (cache) return pricedResult(cache.models, 'cache', cache.fetchedAt);
  return { table: normalizePricingTable(pricingSnapshot), source: 'snapshot', fetchedAt: null };
}

export {
  CACHE_TTL_MS,
  FETCH_PROVIDERS,
  LITELLM_PRICING_URL,
  loadPricing,
  trimAnthropicModels,
};
export type { LoadPricingOptions, PricingResult };
