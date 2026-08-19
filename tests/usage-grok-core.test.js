'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  grokDedupIdentity,
  parseGrokUsageLine,
} = require('../server/core/usage-grok-core');

function grokLine(overrides = {}) {
  return JSON.stringify({
    timestamp: 1787144451,
    method: '_x.ai/session/update',
    params: {
      sessionId: '01a01a1b-b6b2-7501-a8ae-cc5ca10576a3',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: '8950c9f0-457b-4739-b022-57f8076fb3fd',
        stop_reason: 'rate_limit',
        usage: {
          inputTokens: 174641,
          outputTokens: 581,
          totalTokens: 175222,
          cachedReadTokens: 123136,
          reasoningTokens: 191,
          modelCalls: 4,
          apiDurationMs: 21699,
          costUsdTicks: 1680640000,
          modelUsage: {
            'grok-4.6': {
              inputTokens: 174641,
              outputTokens: 581,
              totalTokens: 175222,
              cachedReadTokens: 123136,
              reasoningTokens: 191,
              modelCalls: 4,
              apiDurationMs: 21699,
              costUsdTicks: 1680640000,
            },
          },
          numTurns: 4,
        },
      },
      _meta: {
        eventId: '01a01a1b-b6b2-7501-a8ae-cc5ca10576a3-309',
        agentTimestampMs: 1787144451578,
      },
    },
    ...overrides,
  });
}

test('parseGrokUsageLine accepts a real turn_completed usage shape', () => {
  const parsed = parseGrokUsageLine(grokLine());
  assert.deepEqual(parsed, {
    timestamp: '2026-08-19T13:00:51.578Z',
    timestampMs: 1787144451578,
    sessionId: '01a01a1b-b6b2-7501-a8ae-cc5ca10576a3',
    model: 'grok-4.6',
    input: 51505,
    output: 581,
    cacheCreate: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    cacheRead: 123136,
    costUSD: 0.168064,
    vendor: 'grok',
    messageId: '8950c9f0-457b-4739-b022-57f8076fb3fd',
    requestId: null,
    isSidechain: false,
  });
});

test('parseGrokUsageLine rejects non-turn_completed and malformed rows', () => {
  assert.equal(parseGrokUsageLine(grokLine({
    params: {
      sessionId: 'session-a',
      update: { sessionUpdate: 'tool_call' },
      _meta: { agentTimestampMs: 1787144451578 },
    },
  })), null);
  assert.equal(parseGrokUsageLine('{"timestamp":'), null);
  assert.equal(parseGrokUsageLine(JSON.stringify({ params: { update: { sessionUpdate: 'turn_completed' } } })), null);
});

test('parseGrokUsageLine converts costUsdTicks and cacheCreationTokens', () => {
  const parsed = parseGrokUsageLine(grokLine({
    params: {
      sessionId: 'session-a',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'prompt-a',
        usage: {
          modelUsage: {
            'grok-4.5': {
              inputTokens: 1000,
              cachedReadTokens: 300,
              cacheCreationTokens: 200,
              outputTokens: 50,
              costUsdTicks: 1234567890,
            },
          },
        },
      },
      _meta: {
        agentTimestampMs: 1787144451578,
      },
    },
  }));
  assert.equal(parsed.input, 500);
  assert.equal(parsed.cacheCreate, 200);
  assert.equal(parsed.cacheRead, 300);
  assert.equal(parsed.costUSD, 0.123456789);
});

test('parseGrokUsageLine falls back from missing cost and agent timestamp', () => {
  const parsed = parseGrokUsageLine(grokLine({
    timestamp: 1787144451,
    params: {
      sessionId: 'session-a',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'prompt-a',
        usage: {
          modelUsage: {
            'grok-4.5': {
              inputTokens: 10,
              outputTokens: 2,
              cachedReadTokens: 3,
            },
          },
        },
      },
      _meta: {},
    },
  }));
  assert.equal(parsed.timestampMs, 1787144451000);
  assert.equal(parsed.costUSD, 0.0000269);
});

test('parseGrokUsageLine computes ccusage fallback cost for known Grok models', () => {
  const parsed = parseGrokUsageLine(grokLine({
    params: {
      sessionId: 'session-a',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'prompt-a',
        usage: {
          modelUsage: {
            'grok-4.5-build': {
              inputTokens: 510000,
              outputTokens: 1000,
              cachedReadTokens: 500000,
            },
          },
        },
      },
      _meta: {
        agentTimestampMs: 1787144451578,
      },
    },
  }));
  assert.equal(parsed.input, 10000);
  assert.equal(parsed.cacheRead, 500000);
  assert.equal(parsed.costUSD, 0.352);
});

test('parseGrokUsageLine leaves cost empty for unknown models without ticks', () => {
  const parsed = parseGrokUsageLine(grokLine({
    params: {
      sessionId: 'session-a',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'prompt-a',
        usage: {
          modelUsage: {
            'grok-never-priced-build': {
              inputTokens: 10,
              outputTokens: 2,
              cachedReadTokens: 3,
            },
          },
        },
      },
      _meta: {
        agentTimestampMs: 1787144451578,
      },
    },
  }));
  assert.equal(parsed.costUSD, null);
});

test('grokDedupIdentity uses prompt id with timestamp fallback', () => {
  const parsed = parseGrokUsageLine(grokLine());
  assert.equal(grokDedupIdentity(null), null);
  assert.equal(
    grokDedupIdentity(parsed),
    'grok:01a01a1b-b6b2-7501-a8ae-cc5ca10576a3:8950c9f0-457b-4739-b022-57f8076fb3fd',
  );
  assert.equal(
    grokDedupIdentity({ ...parsed, messageId: null }),
    'grok:01a01a1b-b6b2-7501-a8ae-cc5ca10576a3:1787144451578:grok-4.6',
  );
});
