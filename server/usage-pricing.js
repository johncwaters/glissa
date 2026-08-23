'use strict';

const path = require('node:path');
const { glissaHomeDir } = require('./config-store');
const { normalizePricingTable } = require('./core/usage-pricing-core');
const pricingSnapshot = require('./data/claude-pricing.json');

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

async function loadPricing({
  fetchEnabled,
  fsPromises = require('node:fs/promises'),
  fetchFn = global.fetch,
  cachePath = path.join(glissaHomeDir(), 'litellm-pricing.json'),
  nowFn = Date.now,
  timeoutMs = 15000,
  logger = null,
} = {}) {
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

async function fetchPricing({ fetchFn, timeoutMs }) {
  if (typeof fetchFn !== 'function') return null;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetchFn(LITELLM_PRICING_URL, { signal: abortController.signal });
    if (!response || !response.ok) return null;
    const body = await response.json();
    return trimAnthropicModels(body);
  } finally {
    clearTimeout(timer);
  }
}

async function readCache(fsPromises, cachePath) {
  try {
    const text = await fsPromises.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.models || typeof parsed.models !== 'object') return null;
    return { fetchedAt: parsed.fetchedAt || null, models: parsed.models };
  } catch {
    return null;
  }
}

async function writeCache({ fsPromises, cachePath, fetchedAt, models, logger }) {
  try {
    await fsPromises.mkdir(path.dirname(cachePath), { recursive: true });
    await fsPromises.writeFile(cachePath, JSON.stringify({ fetchedAt, models }, null, 2));
  } catch (error) {
    if (logger && typeof logger.warn === 'function') logger.warn(`usage pricing cache write failed: ${error.message}`);
  }
}

function pricedResult(models, source, fetchedAt) {
  return {
    table: normalizePricingTable(overlaySnapshot(models)),
    source,
    fetchedAt,
  };
}

function overlaySnapshot(models) {
  return { models: { ...(pricingSnapshot.models || {}), ...(models || {}) } };
}

// Only providers the snapshot covers get through a fetch; Grok is absent on purpose (it prices itself).
const FETCH_PROVIDERS = new Set(['anthropic', 'openai']);

function trimAnthropicModels(raw) {
  const sourceModels = raw?.models && typeof raw.models === 'object' ? raw.models : raw;
  if (!sourceModels || typeof sourceModels !== 'object') return null;
  const models = {};
  for (const [key, model] of Object.entries(sourceModels)) {
    if (!model || typeof model !== 'object') continue;
    if (!FETCH_PROVIDERS.has(model.litellm_provider)) continue;
    models[key] = trimModel(model);
  }
  return models;
}

function trimModel(model) {
  const trimmed = {};
  for (const field of SNAPSHOT_FIELDS) {
    if (!Object.hasOwn(model, field)) continue;
    trimmed[field] = model[field];
  }
  return trimmed;
}

function isFresh(fetchedAt, nowMs) {
  const fetchedMs = typeof fetchedAt === 'number' ? fetchedAt : Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedMs)) return false;
  return nowMs - fetchedMs < CACHE_TTL_MS;
}

module.exports = {
  loadPricing,
  trimAnthropicModels,
  LITELLM_PRICING_URL,
  CACHE_TTL_MS,
  FETCH_PROVIDERS,
};
