import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MILL_METRICS_RETAIN_DAYS,
  TITLE_RACE_MS,
  buildScorecards,
  classifyPrompt,
  dispositionFor,
  initialTurnBoundaryState,
  mergeRecords,
  promptBoundaryOrNull,
  pruneRecords,
  recordFromAccumulator,
  reduceTurnBoundary,
  resolveMillMetricsConfig,
} from '../server/core/mill-metrics-core.ts';
import { STATES } from '../shared/states.ts';
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

test('classifyPrompt uses the prior turn boundary for every prompt class', () => {
  const ts = 10_000;
  const hasSeenTurnEnd = true;
  const hasSeenPriorPrompt = true;
  assert.equal(classifyPrompt({ boundary: null, hasSeenTurnEnd, hasSeenPriorPrompt, ts }), 'interruption');
  assert.equal(classifyPrompt({ boundary: { ts: ts - 5000, wasAwaitingInput: true }, hasSeenTurnEnd, hasSeenPriorPrompt, ts }), 'answer');
  assert.equal(classifyPrompt({ boundary: { ts: ts - TITLE_RACE_MS, wasAwaitingInput: false }, hasSeenTurnEnd, hasSeenPriorPrompt, ts }), 'followup');
  assert.equal(classifyPrompt({ boundary: { ts: ts - TITLE_RACE_MS + 1, wasAwaitingInput: false }, hasSeenTurnEnd, hasSeenPriorPrompt, ts }), 'ambiguous');
});

test('the first prompt of a session is a followup, not an interruption', () => {
  const ts = 10_000;
  assert.equal(classifyPrompt({ boundary: null, hasSeenTurnEnd: false, hasSeenPriorPrompt: false, ts }), 'followup');
  assert.equal(classifyPrompt({ boundary: null, hasSeenTurnEnd: true, hasSeenPriorPrompt: false, ts }), 'interruption');
  assert.equal(classifyPrompt({ boundary: null, hasSeenTurnEnd: false, hasSeenPriorPrompt: true, ts }), 'interruption');
});

test('promptBoundaryOrNull rejects every boundary shape it cannot trust', () => {
  assert.deepEqual(promptBoundaryOrNull({ ts: 5, wasAwaitingInput: true }), { ts: 5, wasAwaitingInput: true });
  assert.equal(promptBoundaryOrNull(null), null);
  assert.equal(promptBoundaryOrNull(7), null);
  assert.equal(promptBoundaryOrNull({ ts: 5 }), null);
  assert.equal(promptBoundaryOrNull({ wasAwaitingInput: true }), null);
  assert.equal(promptBoundaryOrNull({ ts: Number.NaN, wasAwaitingInput: false }), null);
  assert.equal(promptBoundaryOrNull({ ts: '5', wasAwaitingInput: false }), null);
  assert.equal(promptBoundaryOrNull({ ts: 5, wasAwaitingInput: 'yes' }), null);
});

test('a Stop hook opens a boundary the next prompt consumes once', () => {
  const opened = reduceTurnBoundary(initialTurnBoundaryState(), {
    kind: 'hook-event', event: 'Stop', state: STATES.WAITING, ts: 1000,
  });
  assert.deepEqual(opened.state, { boundary: { ts: 1000, wasAwaitingInput: true }, hasSeenTurnEnd: true, hasSeenPrompt: false });

  const consumed = reduceTurnBoundary(opened.state, { kind: 'user-prompt' });
  assert.deepEqual(consumed.boundary, { ts: 1000, wasAwaitingInput: true });
  assert.deepEqual(consumed.state, { boundary: null, hasSeenTurnEnd: true, hasSeenPrompt: true });

  const secondPrompt = reduceTurnBoundary(consumed.state, { kind: 'user-prompt' });
  assert.equal(secondPrompt.boundary, null);
  assert.equal(secondPrompt.state.hasSeenTurnEnd, true);
});

test('a prompt before any turn has ended reports no turn end', () => {
  const step = reduceTurnBoundary(initialTurnBoundaryState(), { kind: 'user-prompt' });
  assert.equal(step.boundary, null);
  assert.equal(step.state.hasSeenTurnEnd, false);
  assert.equal(step.hasSeenPriorPrompt, false);
  assert.equal(classifyPrompt({
    boundary: step.boundary,
    hasSeenTurnEnd: step.state.hasSeenTurnEnd,
    hasSeenPriorPrompt: step.hasSeenPriorPrompt,
    ts: 10_000,
  }), 'followup');
});

test('only the very first prompt of a session falls back to followup', () => {
  const firstPrompt = reduceTurnBoundary(initialTurnBoundaryState(), { kind: 'user-prompt' });
  assert.equal(classifyPrompt({
    boundary: firstPrompt.boundary,
    hasSeenTurnEnd: firstPrompt.state.hasSeenTurnEnd,
    hasSeenPriorPrompt: firstPrompt.hasSeenPriorPrompt,
    ts: 10_000,
  }), 'followup');

  const secondPrompt = reduceTurnBoundary(firstPrompt.state, { kind: 'user-prompt' });
  assert.equal(secondPrompt.state.hasSeenTurnEnd, false);
  assert.equal(secondPrompt.hasSeenPriorPrompt, true);
  assert.equal(classifyPrompt({
    boundary: secondPrompt.boundary,
    hasSeenTurnEnd: secondPrompt.state.hasSeenTurnEnd,
    hasSeenPriorPrompt: secondPrompt.hasSeenPriorPrompt,
    ts: 20_000,
  }), 'interruption');
});

test('a turn end keeps the prompts a session has already seen', () => {
  const afterPrompt = reduceTurnBoundary(initialTurnBoundaryState(), { kind: 'user-prompt' }).state;
  const afterStop = reduceTurnBoundary(afterPrompt, {
    kind: 'hook-event', event: 'Stop', state: STATES.WAITING, ts: 1000,
  }).state;
  assert.equal(afterStop.hasSeenPrompt, true);
});

test('only a WAITING or COMPLETE transition and a Stop hook open a boundary', () => {
  const start = initialTurnBoundaryState();
  assert.deepEqual(reduceTurnBoundary(start, { kind: 'hook-event', event: 'PreToolUse', state: STATES.RUNNING, ts: 1000 }).state, start);
  assert.deepEqual(reduceTurnBoundary(start, { kind: 'state-change', to: STATES.RUNNING, ts: 1000 }).state, start);
  assert.deepEqual(reduceTurnBoundary(start, { kind: 'state-change', to: STATES.COMPLETE, ts: 1000 }).state, {
    boundary: { ts: 1000, wasAwaitingInput: false }, hasSeenTurnEnd: true, hasSeenPrompt: false,
  });
  assert.deepEqual(reduceTurnBoundary(start, { kind: 'state-change', to: STATES.WAITING, ts: 1000 }).state, {
    boundary: { ts: 1000, wasAwaitingInput: true }, hasSeenTurnEnd: true, hasSeenPrompt: false,
  });
  assert.deepEqual(reduceTurnBoundary(start, { kind: 'hook-event', event: 'stop', state: STATES.RUNNING, ts: 1000 }).state, {
    boundary: { ts: 1000, wasAwaitingInput: false }, hasSeenTurnEnd: true, hasSeenPrompt: false,
  });
});

test('work resuming without a prompt retires the boundary so the next prompt is an interruption', () => {
  const afterWaiting = reduceTurnBoundary(initialTurnBoundaryState(), { kind: 'state-change', to: STATES.WAITING, ts: 1000 }).state;
  const waitingResumed = reduceTurnBoundary(afterWaiting, { kind: 'state-change', to: STATES.RUNNING, ts: 2000 }).state;
  assert.deepEqual(waitingResumed, { boundary: null, hasSeenTurnEnd: true, hasSeenPrompt: false });
  const promptAfterWaiting = reduceTurnBoundary(waitingResumed, { kind: 'user-prompt' });
  assert.equal(classifyPrompt({
    boundary: promptAfterWaiting.boundary,
    hasSeenTurnEnd: promptAfterWaiting.state.hasSeenTurnEnd,
    hasSeenPriorPrompt: promptAfterWaiting.hasSeenPriorPrompt,
    ts: 600_000,
  }), 'interruption');

  const afterComplete = reduceTurnBoundary(initialTurnBoundaryState(), { kind: 'state-change', to: STATES.COMPLETE, ts: 1000 }).state;
  const completeResumed = reduceTurnBoundary(afterComplete, { kind: 'state-change', to: STATES.RUNNING, ts: 2000 }).state;
  assert.deepEqual(completeResumed, { boundary: null, hasSeenTurnEnd: true, hasSeenPrompt: false });
  const promptAfterComplete = reduceTurnBoundary(completeResumed, { kind: 'user-prompt' });
  assert.equal(classifyPrompt({
    boundary: promptAfterComplete.boundary,
    hasSeenTurnEnd: promptAfterComplete.state.hasSeenTurnEnd,
    hasSeenPriorPrompt: promptAfterComplete.hasSeenPriorPrompt,
    ts: 600_000,
  }), 'interruption');
});

test('a prompt answered while the session still waits keeps scoring as an answer', () => {
  const afterWaiting = reduceTurnBoundary(initialTurnBoundaryState(), { kind: 'state-change', to: STATES.WAITING, ts: 1000 }).state;
  const prompt = reduceTurnBoundary(afterWaiting, { kind: 'user-prompt' });
  assert.equal(classifyPrompt({
    boundary: prompt.boundary,
    hasSeenTurnEnd: prompt.state.hasSeenTurnEnd,
    hasSeenPriorPrompt: prompt.hasSeenPriorPrompt,
    ts: 600_000,
  }), 'answer');
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
