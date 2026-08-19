'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPricing } = require('../server/usage-pricing');

// The trim covers every provider the bundled snapshot covers: anthropic for Claude Code, openai for the
// Codex CLI lane. Keeping it anthropic-only silently dropped every gpt entry from a fetch, which left
// Codex usage priced from the snapshot alone and any newer gpt model unpriced.
test('fetch keeps anthropic and openai entries, drops other providers, writes cache and overlays snapshot', async () => {
  const writes = [];
  const pricing = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs({
      writeFile: async (file, text) => writes.push({ file, text }),
    }),
    fetchFn: async () => okResponse({
      'claude-test': {
        litellm_provider: 'anthropic',
        input_cost_per_token: 9,
        output_cost_per_token: 10,
        ignored: true,
      },
      'openai-test': {
        litellm_provider: 'openai',
        input_cost_per_token: 99,
        ignored: true,
      },
      'mistral-test': {
        litellm_provider: 'mistral',
        input_cost_per_token: 7,
      },
    }),
    cachePath: 'C:/cache/pricing.json',
    nowFn: () => Date.parse('2026-08-19T12:00:00.000Z'),
  });

  assert.equal(pricing.source, 'fetched');
  assert.equal(pricing.table.get('claude-test').input_cost_per_token, 9);
  // Codex needs gpt pricing, so openai survives the trim now.
  assert.equal(pricing.table.get('openai-test').input_cost_per_token, 99);
  // The widening stops at the providers the snapshot covers; it does not take the whole upstream file.
  assert.equal(pricing.table.has('mistral-test'), false);
  assert.equal(pricing.table.has('claude-sonnet-4-20250514'), true);
  assert.equal(pricing.table.has('gpt-5.5'), true, 'the bundled snapshot carries the gpt family');
  assert.equal(JSON.parse(writes[0].text).models['claude-test'].ignored, undefined);
  assert.equal(JSON.parse(writes[0].text).models['openai-test'].ignored, undefined, 'unknown fields are trimmed for every provider');
});

test('fresh cache skips fetchFn entirely', async () => {
  let fetchCalls = 0;
  const pricing = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs({
      readFile: async () => JSON.stringify({
        fetchedAt: '2026-08-19T11:00:00.000Z',
        models: { 'claude-cache': { input_cost_per_token: 3, litellm_provider: 'anthropic' } },
      }),
    }),
    fetchFn: async () => {
      fetchCalls += 1;
      return okResponse({});
    },
    nowFn: () => Date.parse('2026-08-19T12:00:00.000Z'),
  });

  assert.equal(pricing.source, 'cache');
  assert.equal(pricing.table.get('claude-cache').input_cost_per_token, 3);
  assert.equal(fetchCalls, 0);
});

test('stale cache refetches', async () => {
  let fetchCalls = 0;
  const pricing = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs({
      readFile: async () => JSON.stringify({
        fetchedAt: '2026-08-17T11:00:00.000Z',
        models: { 'claude-cache': { input_cost_per_token: 3, litellm_provider: 'anthropic' } },
      }),
    }),
    fetchFn: async () => {
      fetchCalls += 1;
      return okResponse({ 'claude-fetch': { input_cost_per_token: 7, litellm_provider: 'anthropic' } });
    },
    nowFn: () => Date.parse('2026-08-19T12:00:00.000Z'),
  });

  assert.equal(pricing.source, 'fetched');
  assert.equal(pricing.table.get('claude-fetch').input_cost_per_token, 7);
  assert.equal(fetchCalls, 1);
});

test('fetch failure falls back to stale cache, then snapshot', async () => {
  const staleCache = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs({
      readFile: async () => JSON.stringify({
        fetchedAt: '2026-08-17T11:00:00.000Z',
        models: { 'claude-cache': { input_cost_per_token: 3, litellm_provider: 'anthropic' } },
      }),
    }),
    fetchFn: async () => {
      throw new Error('offline');
    },
    nowFn: () => Date.parse('2026-08-19T12:00:00.000Z'),
  });
  assert.equal(staleCache.source, 'cache');
  assert.equal(staleCache.table.get('claude-cache').input_cost_per_token, 3);

  const snapshot = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs(),
    fetchFn: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(snapshot.source, 'snapshot');
  assert.equal(snapshot.table.has('claude-sonnet-4-20250514'), true);
});

test('fetchEnabled false performs zero network and zero cache IO', async () => {
  const calls = [];
  const pricing = await loadPricing({
    fetchEnabled: false,
    fsPromises: fakeFs({
      readFile: async () => calls.push('readFile'),
      writeFile: async () => calls.push('writeFile'),
    }),
    fetchFn: async () => calls.push('fetch'),
  });

  assert.equal(pricing.source, 'snapshot');
  assert.equal(pricing.table.has('claude-sonnet-4-20250514'), true);
  assert.deepEqual(calls, []);
});

test('cache write failure is swallowed', async () => {
  const pricing = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs({
      writeFile: async () => {
        throw new Error('disk full');
      },
    }),
    fetchFn: async () => okResponse({ 'claude-fetch': { input_cost_per_token: 7, litellm_provider: 'anthropic' } }),
  });

  assert.equal(pricing.source, 'fetched');
  assert.equal(pricing.table.get('claude-fetch').input_cost_per_token, 7);
});

test('fetched cache round trips as fresh ISO data and expires after 24 hours', async () => {
  const cache = new Map();
  const fsPromises = fakeFs({
    readFile: async (file) => {
      if (!cache.has(file)) throw new Error('missing');
      return cache.get(file);
    },
    writeFile: async (file, text) => {
      cache.set(file, text);
    },
  });
  let fetchCalls = 0;
  let now = Date.parse('2026-08-19T12:00:00.000Z');
  const fetchFn = async () => {
    fetchCalls += 1;
    return okResponse({ [`claude-fetch-${fetchCalls}`]: { input_cost_per_token: fetchCalls, litellm_provider: 'anthropic' } });
  };

  const first = await loadPricing({
    fetchEnabled: true,
    fsPromises,
    fetchFn,
    cachePath: 'C:/cache/pricing.json',
    nowFn: () => now,
  });
  assert.equal(first.source, 'fetched');
  assert.equal(JSON.parse(cache.get('C:/cache/pricing.json')).fetchedAt, '2026-08-19T12:00:00.000Z');

  now = Date.parse('2026-08-20T11:00:00.000Z');
  const second = await loadPricing({
    fetchEnabled: true,
    fsPromises,
    fetchFn,
    cachePath: 'C:/cache/pricing.json',
    nowFn: () => now,
  });
  assert.equal(second.source, 'cache');
  assert.equal(fetchCalls, 1);
  assert.equal(second.table.get('claude-fetch-1').input_cost_per_token, 1);

  now = Date.parse('2026-08-20T13:00:00.000Z');
  const third = await loadPricing({
    fetchEnabled: true,
    fsPromises,
    fetchFn,
    cachePath: 'C:/cache/pricing.json',
    nowFn: () => now,
  });
  assert.equal(third.source, 'fetched');
  assert.equal(fetchCalls, 2);
  assert.equal(third.table.get('claude-fetch-2').input_cost_per_token, 2);
});

test('numeric fetchedAt cache entries remain fresh for backward compatibility', async () => {
  let fetchCalls = 0;
  const pricing = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs({
      readFile: async () => JSON.stringify({
        fetchedAt: Date.parse('2026-08-19T11:00:00.000Z'),
        models: { 'claude-cache': { input_cost_per_token: 3, litellm_provider: 'anthropic' } },
      }),
    }),
    fetchFn: async () => {
      fetchCalls += 1;
      return okResponse({});
    },
    nowFn: () => Date.parse('2026-08-19T12:00:00.000Z'),
  });

  assert.equal(pricing.source, 'cache');
  assert.equal(fetchCalls, 0);
});

test('fetch receives AbortSignal and timeout falls back to snapshot', async () => {
  let receivedSignal = null;
  const pricing = await loadPricing({
    fetchEnabled: true,
    fsPromises: fakeFs(),
    timeoutMs: 1,
    fetchFn: async (url, options) => {
      receivedSignal = options.signal;
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });

  assert.equal(receivedSignal instanceof AbortSignal, true);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(pricing.source, 'snapshot');
});

function fakeFs(overrides = {}) {
  return {
    readFile: async () => {
      throw new Error('missing');
    },
    mkdir: async () => {},
    writeFile: async () => {},
    ...overrides,
  };
}

function okResponse(models) {
  return {
    ok: true,
    json: async () => models,
  };
}
