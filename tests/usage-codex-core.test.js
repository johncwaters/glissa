'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  codexDedupIdentity,
  createCodexUsageState,
  parseCodexUsageLine,
} = require('../server/core/usage-codex-core');

function turnContextLine(model = 'gpt-5.5') {
  return JSON.stringify({
    timestamp: '2026-07-08T22:50:21.513Z',
    type: 'turn_context',
    payload: {
      turn_id: '019f43ec-d174-7a11-99f5-5b42d4beb5d7',
      cwd: '<redacted>',
      workspace_roots: ['<redacted>'],
      model,
    },
  });
}

function threadSettingsLine() {
  return JSON.stringify({
    timestamp: '2026-07-30T19:06:36.447Z',
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied',
      thread_settings: {
        model: 'gpt-5.6-sol',
        model_provider_id: 'openai',
        service_tier: 'default',
        cwd: '<redacted>',
      },
    },
  });
}

function tokenCountLine(overrides = {}) {
  return JSON.stringify({
    timestamp: '2026-07-08T22:50:28.569Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 11857,
          cached_input_tokens: 8576,
          output_tokens: 104,
          reasoning_output_tokens: 22,
          total_tokens: 11961,
        },
        last_token_usage: {
          input_tokens: 11857,
          cached_input_tokens: 8576,
          output_tokens: 104,
          reasoning_output_tokens: 22,
          total_tokens: 11961,
        },
        model_context_window: 258400,
      },
      rate_limits: {
        limit_id: 'codex',
        plan_type: 'plus',
      },
    },
    ...overrides,
  });
}

test('parseCodexUsageLine parses a real token_count shape', () => {
  const state = createCodexUsageState();
  parseCodexUsageLine(turnContextLine(), state);
  const parsed = parseCodexUsageLine(tokenCountLine(), state, { sessionId: 'session-a' });
  assert.deepEqual(parsed, {
    timestamp: '2026-07-08T22:50:28.569Z',
    timestampMs: 1783551028569,
    sessionId: 'session-a',
    model: 'gpt-5.5',
    input: 3281,
    output: 104,
    cacheCreate: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    cacheRead: 8576,
    costUSD: null,
    vendor: 'codex',
    messageId: null,
    requestId: null,
    isSidechain: false,
  });
});

test('parseCodexUsageLine sums last_token_usage deltas without double counting totals', () => {
  const state = createCodexUsageState();
  parseCodexUsageLine(turnContextLine(), state);
  const first = parseCodexUsageLine(tokenCountLine(), state, { sessionId: 'session-a' });
  const second = parseCodexUsageLine(tokenCountLine({
    timestamp: '2026-07-08T22:50:30.295Z',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 24108,
          cached_input_tokens: 20224,
          output_tokens: 152,
          reasoning_output_tokens: 22,
          total_tokens: 24260,
        },
        last_token_usage: {
          input_tokens: 12251,
          cached_input_tokens: 11648,
          output_tokens: 48,
          reasoning_output_tokens: 0,
          total_tokens: 12299,
        },
      },
    },
  }), state, { sessionId: 'session-a' });

  assert.equal(first.input + first.cacheRead + first.output + second.input + second.cacheRead + second.output, 24260);
});

test('parseCodexUsageLine carries model from turn_context and thread settings', () => {
  const state = createCodexUsageState();
  assert.equal(parseCodexUsageLine(turnContextLine('gpt-5.5'), state), null);
  assert.equal(parseCodexUsageLine(tokenCountLine(), state).model, 'gpt-5.5');
  assert.equal(parseCodexUsageLine(threadSettingsLine(), state), null);
  assert.equal(parseCodexUsageLine(tokenCountLine({
    timestamp: '2026-07-08T22:51:00.000Z',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 11868,
          cached_input_tokens: 8576,
          output_tokens: 106,
          reasoning_output_tokens: 22,
          total_tokens: 11974,
        },
        last_token_usage: {
          input_tokens: 11,
          cached_input_tokens: 0,
          output_tokens: 2,
          reasoning_output_tokens: 0,
          total_tokens: 13,
        },
      },
    },
  }), state).model, 'gpt-5.6-sol');
});

test('parseCodexUsageLine allows missing turn_context and rejects malformed JSON', () => {
  const parsed = parseCodexUsageLine(tokenCountLine(), createCodexUsageState());
  assert.equal(parsed.model, null);
  assert.equal(parseCodexUsageLine('{"timestamp":'), null);
  assert.equal(parseCodexUsageLine(JSON.stringify({ timestamp: 'bad', type: 'event_msg', payload: { type: 'token_count' } })), null);
});

test('parseCodexUsageLine falls back to cumulative deltas when last_token_usage is absent', () => {
  const state = createCodexUsageState();
  const first = parseCodexUsageLine(tokenCountLine({
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 4,
          output_tokens: 2,
          total_tokens: 12,
        },
      },
    },
  }), state);
  const second = parseCodexUsageLine(tokenCountLine({
    timestamp: '2026-07-08T22:50:30.295Z',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 15,
          cached_input_tokens: 5,
          output_tokens: 4,
          total_tokens: 19,
        },
      },
    },
  }), state);
  assert.equal(first.input, 6);
  assert.equal(first.cacheRead, 4);
  assert.equal(second.input, 4);
  assert.equal(second.cacheRead, 1);
  assert.equal(second.output, 2);
});

test('parseCodexUsageLine skips repeated cumulative totals', () => {
  const state = createCodexUsageState();
  const first = parseCodexUsageLine(tokenCountLine(), state);
  const repeated = parseCodexUsageLine(tokenCountLine({ timestamp: '2026-07-08T22:50:31.000Z' }), state);

  assert.equal(first.input, 3281);
  assert.equal(repeated, null);
});

test('codexDedupIdentity is deterministic', () => {
  const state = createCodexUsageState();
  parseCodexUsageLine(turnContextLine(), state);
  const parsed = parseCodexUsageLine(tokenCountLine(), state, { sessionId: 'session-a' });
  assert.equal(codexDedupIdentity(null), null);
  assert.equal(codexDedupIdentity(parsed), 'codex:session-a:1783551028569:gpt-5.5:3281:104:0:8576');
});
