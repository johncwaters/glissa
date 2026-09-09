import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MILL_METRICS_RETAIN_DAYS,
  TITLE_RACE_MS,
  buildScorecards,
  classifyPrompt,
  dispositionFor,
  mergeRecords,
  pruneRecords,
  recordFromAccumulator,
  resolveMillMetricsConfig,
} from '../server/core/mill-metrics-core.ts';
import type {
  MillMetricAccumulatorShape,
  MillMetricPackAccumulator,
} from '../server/core/mill-metrics-core.ts';
import type {
  MillMetricPack,
  MillMetricPromptCounts,
  MillMetricSession,
} from '../shared/contracts/mill-metrics.ts';

function prompts(overrides: Partial<MillMetricPromptCounts> = {}): MillMetricPromptCounts {
  return { interruption: 0, answer: 0, followup: 0, ambiguous: 0, ...overrides };
}

function pack(overrides: Partial<MillMetricPack> = {}): MillMetricPack {
  return {
    name: 'alpha',
    version: 'v1',
    tokenEstimate: 100,
    ...overrides,
  };
}

function record(overrides: Partial<MillMetricSession> = {}): MillMetricSession {
  return {
    sessionId: 's1',
    day: '2026-08-30',
    startedAt: Date.parse('2026-08-30T10:00:00Z'),
    endedAt: Date.parse('2026-08-30T11:00:00Z'),
    agent: 'claude-code',
    disposition: 'natural',
    finalState: 'DONE',
    tokens: 100,
    costUSD: 1,
    resumeSessionId: null,
    prompts: prompts(),
    packs: [pack()],
    ...overrides,
  };
}

function accumulator(overrides: Partial<MillMetricAccumulatorShape> = {}): MillMetricAccumulatorShape {
  return {
    sessionId: 'live',
    startedAt: Date.parse('2026-08-30T12:00:00Z'),
    agent: 'claude-code',
    prompts: prompts(),
    packs: new Map<string, MillMetricPackAccumulator>([['alpha', {
      version: 'v1', tokenEstimate: 100,
    }]]),
    ...overrides,
  };
}

test('classifyPrompt keeps the title race separate from real interruptions', () => {
  const ts = 10_000;
  assert.equal(classifyPrompt({ state: 'RUNNING', stateSince: ts - TITLE_RACE_MS, ts }), 'interruption');
  assert.equal(classifyPrompt({ state: 'RUNNING', stateSince: ts - TITLE_RACE_MS + 1, ts }), 'ambiguous');
  assert.equal(classifyPrompt({ state: 'WAITING', stateSince: 0, ts }), 'answer');
  assert.equal(classifyPrompt({ state: 'IDLE', stateSince: 0, ts }), 'followup');
  assert.equal(classifyPrompt({ state: 'FAILED', stateSince: 0, ts }), 'followup');
});

test('only an operator abandoning live work counts as an abort', () => {
  assert.equal(dispositionFor('operator-abort'), 'user-kill');
  assert.equal(dispositionFor('close-out'), 'natural');
  assert.equal(dispositionFor('natural'), 'natural');
  assert.equal(dispositionFor(undefined), 'natural');
});

test('recordFromAccumulator keeps delivery, prompt, and accounting values', () => {
  const found = recordFromAccumulator(accumulator({
    prompts: prompts({ interruption: 2 }),
    packs: new Map<string, MillMetricPackAccumulator>([['alpha', { version: 'v2', tokenEstimate: 200 }]]),
  }), {
    endedAt: Date.parse('2026-08-30T13:00:00Z'),
    disposition: 'user-kill',
    finalState: 'DONE',
    tokens: 123,
    costUSD: 0.5,
  });
  assert.ok(found);
  assert.equal(found.day, '2026-08-30');
  assert.deepEqual(found.packs, [{ name: 'alpha', version: 'v2', tokenEstimate: 200 }]);
  assert.equal(found.prompts.interruption, 2);
  assert.equal(found.tokens, 123);
  assert.equal(found.costUSD, 0.5);
});

test('two runs of one session id fold into a single record rather than replacing each other', () => {
  const firstRun = record({
    startedAt: 100,
    endedAt: 200,
    tokens: 10,
    costUSD: 1,
    prompts: prompts({ interruption: 2, ambiguous: 1 }),
    packs: [pack({ version: 'v1', tokenEstimate: 100 })],
  });
  const secondRun = record({
    startedAt: 300,
    endedAt: 400,
    tokens: 5,
    costUSD: 0.5,
    disposition: 'user-kill',
    prompts: prompts({ interruption: 3 }),
    packs: [pack({ version: 'v2', tokenEstimate: 200 })],
  });
  const other = record({ sessionId: 's2', endedAt: 150 });
  const merged = mergeRecords([firstRun, other], [secondRun]);
  const folded = merged.find((entry) => entry.sessionId === 's1');
  assert.ok(folded);
  assert.equal(merged.length, 2);
  assert.equal(folded.startedAt, 100);
  assert.equal(folded.endedAt, 400);
  assert.equal(folded.disposition, 'user-kill');
  assert.equal(folded.tokens, 15);
  assert.equal(folded.costUSD, 1.5);
  assert.equal(folded.prompts.interruption, 5);
  assert.equal(folded.prompts.ambiguous, 1);
  assert.deepEqual(folded.packs, [{ name: 'alpha', version: 'v2', tokenEstimate: 200 }]);
});

test('a session with a persisted run and a live run is one delivery, still live', () => {
  const persisted = record({ startedAt: 100, endedAt: 200, tokens: 40 });
  const live = record({
    startedAt: 300,
    endedAt: null,
    disposition: null,
    tokens: 60,
  });
  const scorecard = buildScorecards([persisted], [live]).alpha;
  assert.equal(scorecard.deliveries, 1);
  assert.equal(scorecard.liveSessions, 1);
  assert.equal(scorecard.outcomes.meanTokens, 100);
  assert.equal(scorecard.outcomes.abortRate, null);
});

test('pruneRecords keeps the inclusive day window and fails safe on an uncomputable cutoff', () => {
  const records = [
    record({ sessionId: 'old', day: '2026-08-23' }),
    record({ sessionId: 'cutoff', day: '2026-08-24' }),
    record({ sessionId: 'today', day: '2026-08-30' }),
  ];
  assert.deepEqual(
    pruneRecords(records, { retainDays: 7, todayKey: '2026-08-30' }).map((entry) => entry.sessionId),
    ['cutoff', 'today'],
  );
  assert.equal(pruneRecords(records, { retainDays: 0, todayKey: 'bad' }).length, 3);
});

test('buildScorecards includes every delivery in the outcome denominators', () => {
  const first = record({
    sessionId: 'first',
    prompts: prompts({ interruption: 2, ambiguous: 1 }),
  });
  const second = record({
    sessionId: 'second',
    disposition: 'user-kill',
    tokens: 50,
    prompts: prompts({ interruption: 1, ambiguous: 2 }),
  });
  const live = record({
    sessionId: 'live',
    endedAt: null,
    disposition: 'user-kill',
    tokens: 999,
    prompts: prompts({ interruption: 99, ambiguous: 99 }),
  });
  const scorecard = buildScorecards([first, second, live]).alpha;
  assert.equal(scorecard.deliveries, 3);
  assert.equal(scorecard.liveSessions, 1);
  assert.equal(scorecard.ambiguousPrompts, 102);
  assert.deepEqual(scorecard.outcomes, { sessions: 3, meanInterruptions: 34, abortRate: 2 / 3, meanTokens: 383 });
});

test('zero denominators stay null and live accumulators add no abort denominator', () => {
  const live = accumulator({
    prompts: prompts({ interruption: 3, ambiguous: 1 }),
  });
  const liveRecord = recordFromAccumulator(live, { tokens: null, disposition: null });
  assert.ok(liveRecord);
  const liveScorecard = buildScorecards([], [liveRecord]).alpha;
  assert.ok(liveScorecard);
  assert.equal(liveScorecard.liveSessions, 1);
  assert.equal(liveScorecard.outcomes.abortRate, null);
  assert.equal(liveScorecard.outcomes.meanTokens, null);
  assert.equal(liveScorecard.outcomes.meanInterruptions, 3);
});

test('a restart keeps a session alive for retention instead of expiring it with its first run', () => {
  const original = record({ day: '2026-08-01', startedAt: Date.parse('2026-08-01T10:00:00Z'), endedAt: Date.parse('2026-08-01T11:00:00Z') });
  const restart = record({ day: '2026-08-30', startedAt: Date.parse('2026-08-30T10:00:00Z'), endedAt: Date.parse('2026-08-30T11:00:00Z') });
  const folded = mergeRecords([original], [restart]);
  assert.equal(pruneRecords(folded, { retainDays: 7, todayKey: '2026-08-30' }).length, 1);
  const scorecard = buildScorecards(folded).alpha;
  assert.equal(scorecard.firstDay, '2026-08-01');
  assert.equal(scorecard.lastDay, '2026-08-30');
});

test('a retention the wire would refuse falls back rather than reaching the lane', () => {
  assert.deepEqual(resolveMillMetricsConfig({ retainDays: 180 }), { retainDays: 180 });
  assert.equal(resolveMillMetricsConfig({ retainDays: 6 }).retainDays, DEFAULT_MILL_METRICS_RETAIN_DAYS);
  assert.equal(resolveMillMetricsConfig({ retainDays: 3651 }).retainDays, DEFAULT_MILL_METRICS_RETAIN_DAYS);
  assert.equal(resolveMillMetricsConfig({ retainDays: 90.5 }).retainDays, DEFAULT_MILL_METRICS_RETAIN_DAYS);
  assert.equal(resolveMillMetricsConfig(null).retainDays, DEFAULT_MILL_METRICS_RETAIN_DAYS);
});
