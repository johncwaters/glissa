'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildUsageReport, pruneEntries } = require('../server/core/usage-aggregate-core');

function entry(timestampMs, sessionId, model, tokens, costUSD = 1) {
  return {
    timestampMs,
    sessionId,
    model,
    input: tokens.input || 0,
    output: tokens.output || 0,
    cacheCreate: tokens.cacheCreate || 0,
    cacheRead: tokens.cacheRead || 0,
    costUSD,
    messageId: `${sessionId}-${timestampMs}`,
    requestId: 'request-a',
  };
}

test('buildUsageReport uses local date buckets and rolls up totals, models and sessions', () => {
  const first = entry(new Date(2026, 7, 18, 23, 59, 0).getTime(), 'session-a', 'claude-a', { input: 1, output: 2 }, 0.5);
  const second = entry(new Date(2026, 7, 19, 0, 1, 0).getTime(), 'session-b', 'claude-b', { cacheCreate: 3, cacheRead: 4 }, 1.5);
  const sessionsById = new Map([['session-a', { name: 'Alpha' }]]);
  const report = buildUsageReport([first, second], {
    now: new Date(2026, 7, 20).getTime(),
    retainDays: 30,
    sessionsById,
    tz: 'America/Denver',
  });
  assert.deepEqual(report.daily.map((day) => day.day), ['2026-08-18', '2026-08-19']);
  assert.deepEqual(report.totals, { tokens: 10, costUSD: 2, input: 1, output: 2, cacheCreate: 3, cacheRead: 4 });
  assert.deepEqual(report.daily[0].models.map((model) => ({ model: model.model, tokens: model.tokens, costUSD: model.costUSD })), [
    { model: 'claude-a', tokens: 3, costUSD: 0.5 },
  ]);
  assert.equal(report.models.find((model) => model.key === 'claude-a').tokens, 3);
  assert.equal(Object.hasOwn(report.models.find((model) => model.key === 'claude-a'), 'day'), false);
  assert.equal(report.sessions.find((session) => session.id === 'session-a').name, 'Alpha');
  assert.equal(report.sessions.find((session) => session.id === 'session-b').tokens, 7);
});

test('pruneEntries keeps retained entries and returns removed dedup keys', () => {
  const now = Date.UTC(2026, 7, 20);
  const oldEntry = entry(now - 3 * 24 * 60 * 60 * 1000, 'session-a', 'claude-a', { input: 1 });
  const freshEntry = entry(now - 1 * 24 * 60 * 60 * 1000, 'session-b', 'claude-b', { input: 1 });
  const pruned = pruneEntries([oldEntry, freshEntry, { timestampMs: oldEntry.timestampMs, messageId: null }], { now, retainDays: 2 });
  assert.deepEqual(pruned.kept, [freshEntry]);
  assert.deepEqual(pruned.removedKeys, [`session-a-${oldEntry.timestampMs}:request-a`]);
});
