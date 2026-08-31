'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  DEFAULT_MILL_METRICS_RETAIN_DAYS,
  TITLE_RACE_MS,
  buildScorecards,
  classifyPrompt,
  classifyReadPath,
  dispositionFor,
  mergeRecords,
  pruneRecords,
  recordFromAccumulator,
  resolveMillMetricsConfig,
} = require('../server/core/mill-metrics-core.ts');
const { MAX_PACK_FILES_PER_SESSION } = require('../shared/contracts/mill-metrics.ts');

const ROOT = path.resolve(path.parse(process.cwd()).root, 'mill-metrics-fixture');
const PACK_DIR = path.join(ROOT, 'packs', 'alpha');

function prompts(overrides = {}) {
  return { interruption: 0, answer: 0, followup: 0, ambiguous: 0, ...overrides };
}

function pack(overrides = {}) {
  return {
    name: 'alpha',
    version: 'v1',
    tokenEstimate: 100,
    filesRead: 0,
    files: [],
    filesDropped: 0,
    opened: false,
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    sessionId: 's1',
    day: '2026-08-30',
    startedAt: Date.parse('2026-08-30T10:00:00Z'),
    endedAt: Date.parse('2026-08-30T11:00:00Z'),
    agent: 'claude-code',
    readDetection: 'available',
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

function accumulator(overrides = {}) {
  return {
    sessionId: 'live',
    startedAt: Date.parse('2026-08-30T12:00:00Z'),
    agent: 'claude-code',
    readDetection: 'available',
    prompts: prompts(),
    packs: new Map([['alpha', {
      version: 'v1', tokenEstimate: 100, dir: PACK_DIR, files: new Set(), filesDropped: 0,
    }]]),
    ...overrides,
  };
}

test('classifyReadPath accepts contained absolute files and rejects untrusted paths', () => {
  assert.deepEqual(
    classifyReadPath(path.join(PACK_DIR, 'rules', 'one.md'), [{ name: 'alpha', dir: PACK_DIR }]),
    { pack: 'alpha', relPath: path.join('rules', 'one.md') },
  );
  assert.equal(classifyReadPath(path.join(ROOT, 'outside.md'), [{ name: 'alpha', dir: PACK_DIR }]), null);
  assert.equal(classifyReadPath(path.join(PACK_DIR, '..', 'outside.md'), [{ name: 'alpha', dir: PACK_DIR }]), null);
  assert.equal(classifyReadPath(path.join(PACK_DIR, '..secret'), [{ name: 'alpha', dir: PACK_DIR }]), null);
  assert.equal(classifyReadPath('relative.md', [{ name: 'alpha', dir: PACK_DIR }]), null);
  assert.equal(classifyReadPath(null, [{ name: 'alpha', dir: PACK_DIR }]), null);
});

test('classifyReadPath chooses the longest delivered directory', () => {
  const variantDir = path.join(PACK_DIR, 'variant');
  assert.deepEqual(
    classifyReadPath(path.join(variantDir, 'CLAUDE.md'), [
      { name: 'alpha', dir: PACK_DIR },
      { name: 'alpha-variant', dir: variantDir },
    ]),
    { pack: 'alpha-variant', relPath: 'CLAUDE.md' },
  );
});

test('classifyReadPath can compare case-insensitively without making the core platform-aware', () => {
  const upperDirectory = path.join(ROOT, 'PACKS', 'ALPHA');
  const lowerFile = path.join(ROOT, 'packs', 'alpha', 'File.md');
  assert.equal(classifyReadPath(lowerFile, [{ name: 'alpha', dir: upperDirectory }]), null);
  assert.deepEqual(
    classifyReadPath(lowerFile, [{ name: 'alpha', dir: upperDirectory }], { caseInsensitive: true }),
    { pack: 'alpha', relPath: 'File.md' },
  );
});

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

test('recordFromAccumulator keeps the file union needed after restart', () => {
  const files = new Set(['rules/b.md', 'rules/a.md']);
  const found = recordFromAccumulator(accumulator({
    prompts: prompts({ interruption: 2 }),
    packs: new Map([['alpha', { version: 'v2', tokenEstimate: 200, dir: PACK_DIR, files, filesDropped: 3 }]]),
  }), {
    endedAt: Date.parse('2026-08-30T13:00:00Z'),
    disposition: 'user-kill',
    finalState: 'DONE',
    tokens: 123,
    costUSD: 0.5,
  });
  assert.equal(found.day, '2026-08-30');
  assert.deepEqual(found.packs[0].files, ['rules/a.md', 'rules/b.md']);
  assert.equal(found.packs[0].filesRead, 2);
  assert.equal(found.packs[0].filesDropped, 3);
  assert.equal(found.packs[0].opened, true);
  assert.equal(found.tokens, 123);
});

test('two runs of one session id fold into a single record rather than replacing each other', () => {
  const firstRun = record({
    startedAt: 100,
    endedAt: 200,
    tokens: 10,
    costUSD: 1,
    prompts: prompts({ interruption: 2, ambiguous: 1 }),
    packs: [pack({ filesRead: 1, files: ['a.md'], filesDropped: 1, opened: true })],
  });
  const secondRun = record({
    startedAt: 300,
    endedAt: 400,
    tokens: 5,
    costUSD: 0.5,
    disposition: 'user-kill',
    prompts: prompts({ interruption: 3 }),
    packs: [pack({ filesRead: 1, files: ['b.md'], filesDropped: 2, opened: true })],
  });
  const other = record({ sessionId: 's2', endedAt: 150 });
  const merged = mergeRecords([firstRun, other], [secondRun]);
  const folded = merged.find((entry) => entry.sessionId === 's1');
  assert.equal(merged.length, 2);
  assert.equal(folded.startedAt, 100);
  assert.equal(folded.endedAt, 400);
  assert.equal(folded.disposition, 'user-kill');
  assert.equal(folded.tokens, 15);
  assert.equal(folded.costUSD, 1.5);
  assert.equal(folded.prompts.interruption, 5);
  assert.equal(folded.prompts.ambiguous, 1);
  assert.deepEqual(folded.packs[0].files, ['a.md', 'b.md']);
  assert.equal(folded.packs[0].filesRead, 2);
  assert.equal(folded.packs[0].filesDropped, 3);
  assert.equal(folded.packs[0].opened, true);
});

test('a restarted session that read the pack before the restart still counts as opened', () => {
  const beforeRestart = record({
    startedAt: 100,
    endedAt: 200,
    packs: [pack({ filesRead: 1, files: ['a.md'], opened: true })],
  });
  const afterRestart = record({ startedAt: 300, endedAt: 400 });
  const scorecard = buildScorecards(mergeRecords([beforeRestart], [afterRestart])).alpha;
  assert.equal(scorecard.deliveries, 1);
  assert.equal(scorecard.openedSessions, 1);
  assert.equal(scorecard.openRate, 1);
});

test('a session with a persisted run and a live run is one delivery, still live', () => {
  const persisted = record({ startedAt: 100, endedAt: 200, tokens: 40 });
  const live = record({
    startedAt: 300,
    endedAt: null,
    disposition: null,
    tokens: 60,
    packs: [pack({ filesRead: 1, files: ['a.md'], opened: true })],
  });
  const scorecard = buildScorecards([persisted], [live]).alpha;
  assert.equal(scorecard.deliveries, 1);
  assert.equal(scorecard.liveSessions, 1);
  assert.equal(scorecard.openedSessions, 1);
  assert.equal(scorecard.opened.meanTokens, 100);
  assert.equal(scorecard.opened.abortRate, null);
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

test('buildScorecards excludes hook-unavailable deliveries from every value denominator', () => {
  const opened = record({
    sessionId: 'opened',
    prompts: prompts({ interruption: 2, ambiguous: 1 }),
    packs: [pack({ filesRead: 2, files: ['a.md', 'b.md'], opened: true })],
  });
  const unopened = record({
    sessionId: 'unopened',
    disposition: 'user-kill',
    tokens: 50,
    prompts: prompts({ interruption: 1, ambiguous: 2 }),
  });
  const unavailable = record({
    sessionId: 'unavailable',
    readDetection: 'unavailable',
    endedAt: null,
    disposition: 'user-kill',
    tokens: 999,
    prompts: prompts({ interruption: 99, ambiguous: 99 }),
    packs: [pack({ filesRead: 1, files: ['ignored.md'], opened: true })],
  });
  const scorecard = buildScorecards([opened, unopened, unavailable]).alpha;
  assert.equal(scorecard.deliveries, 3);
  assert.equal(scorecard.measurableDeliveries, 2);
  assert.equal(scorecard.unmeasurableDeliveries, 1);
  assert.equal(scorecard.openedSessions, 1);
  assert.equal(scorecard.openRate, 0.5);
  assert.equal(scorecard.distinctFilesRead, 2);
  assert.equal(scorecard.medianFilesRead, 1);
  assert.equal(scorecard.liveSessions, 0);
  assert.equal(scorecard.ambiguousPrompts, 3);
  assert.deepEqual(scorecard.opened, { sessions: 1, meanInterruptions: 2, abortRate: 0, meanTokens: 100 });
  assert.deepEqual(scorecard.unopened, { sessions: 1, meanInterruptions: 1, abortRate: 1, meanTokens: 50 });
});

test('zero denominators stay null and live accumulators add no abort denominator', () => {
  const unavailableOnly = buildScorecards([record({ readDetection: 'unavailable' })]).alpha;
  assert.equal(unavailableOnly.openRate, null);
  assert.equal(unavailableOnly.firstDay, null);
  assert.deepEqual(unavailableOnly.opened, { sessions: 0, meanInterruptions: null, abortRate: null, meanTokens: null });

  const live = accumulator({
    prompts: prompts({ interruption: 3, ambiguous: 1 }),
    packs: new Map([['alpha', {
      version: 'v1', tokenEstimate: 100, dir: PACK_DIR, files: new Set(['a.md', 'b.md']), filesDropped: 0,
    }]]),
  });
  const liveScorecard = buildScorecards([], [recordFromAccumulator(live)]).alpha;
  assert.equal(liveScorecard.liveSessions, 1);
  assert.equal(liveScorecard.opened.abortRate, null);
  assert.equal(liveScorecard.opened.meanInterruptions, 3);
});

test('a fold of two capped runs stays inside the persisted cap and counts the overflow', () => {
  const filesFor = (prefix) => Array.from(
    { length: MAX_PACK_FILES_PER_SESSION },
    (_, index) => `${prefix}-${String(index).padStart(4, '0')}.md`,
  );
  const firstRun = record({
    startedAt: 100,
    endedAt: 200,
    packs: [pack({ filesRead: MAX_PACK_FILES_PER_SESSION, files: filesFor('first'), opened: true })],
  });
  const secondRun = record({
    startedAt: 300,
    endedAt: 400,
    packs: [pack({ filesRead: MAX_PACK_FILES_PER_SESSION, files: filesFor('second'), filesDropped: 2, opened: true })],
  });
  const folded = mergeRecords([firstRun], [secondRun])[0];
  assert.equal(folded.packs[0].files.length, MAX_PACK_FILES_PER_SESSION);
  assert.equal(folded.packs[0].filesRead, MAX_PACK_FILES_PER_SESSION);
  assert.equal(folded.packs[0].filesDropped, MAX_PACK_FILES_PER_SESSION + 2);
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

test('a fold is measurable when any run was, and only measurable runs contribute reads', () => {
  const measurableRun = record({
    startedAt: 100,
    endedAt: 200,
    packs: [pack({ filesRead: 1, files: ['a.md'], opened: true })],
  });
  const blindRun = record({
    startedAt: 300,
    endedAt: 400,
    readDetection: 'unavailable',
    packs: [pack({ filesRead: 3, files: ['ghost.md'], opened: true })],
  });
  const blindRestart = buildScorecards(mergeRecords([measurableRun], [blindRun])).alpha;
  assert.equal(blindRestart.measurableDeliveries, 1);
  assert.equal(blindRestart.openedSessions, 1);
  assert.equal(blindRestart.distinctFilesRead, 1);

  const blindFirst = buildScorecards(mergeRecords([{ ...blindRun, startedAt: 100, endedAt: 200 }], [{ ...measurableRun, startedAt: 300, endedAt: 400 }])).alpha;
  assert.equal(blindFirst.measurableDeliveries, 1);
  assert.deepEqual(blindFirst.medianFilesRead, 1);
  assert.equal(blindFirst.distinctFilesRead, 1);
});

test('a pack delivered only while reads were blind stays unmeasurable after the fold', () => {
  const packEntry = (files) => ({
    version: 'v1', tokenEstimate: 100, dir: PACK_DIR, files: new Set(files), filesDropped: 0,
  });
  const measurableRun = recordFromAccumulator(accumulator({
    startedAt: 100,
    packs: new Map([['alpha', packEntry(['a.md'])]]),
  }), { endedAt: 200 });
  const blindRun = recordFromAccumulator(accumulator({
    startedAt: 300,
    readDetection: 'unavailable',
    packs: new Map([['alpha', packEntry([])], ['beta', packEntry([])]]),
  }), { endedAt: 400 });
  const scorecards = buildScorecards(mergeRecords([measurableRun], [blindRun]));
  assert.equal(scorecards.alpha.measurableDeliveries, 1);
  assert.equal(scorecards.alpha.openRate, 1);
  assert.equal(scorecards.beta.deliveries, 1);
  assert.equal(scorecards.beta.measurableDeliveries, 0);
  assert.equal(scorecards.beta.unmeasurableDeliveries, 1);
  assert.equal(scorecards.beta.openRate, null);
  assert.equal(scorecards.beta.unopened.sessions, 0);
});

test('a retention the wire would refuse falls back rather than reaching the lane', () => {
  assert.deepEqual(resolveMillMetricsConfig({ retainDays: 180 }), { retainDays: 180 });
  assert.equal(resolveMillMetricsConfig({ retainDays: 6 }).retainDays, DEFAULT_MILL_METRICS_RETAIN_DAYS);
  assert.equal(resolveMillMetricsConfig({ retainDays: 3651 }).retainDays, DEFAULT_MILL_METRICS_RETAIN_DAYS);
  assert.equal(resolveMillMetricsConfig({ retainDays: 90.5 }).retainDays, DEFAULT_MILL_METRICS_RETAIN_DAYS);
  assert.equal(resolveMillMetricsConfig(null).retainDays, DEFAULT_MILL_METRICS_RETAIN_DAYS);
});

test('distinct files are unioned across measurable sessions', () => {
  const first = record({ packs: [pack({ filesRead: 2, files: ['a.md', 'b.md'], opened: true })] });
  const second = record({ sessionId: 's2', packs: [pack({ filesRead: 2, files: ['b.md', 'c.md'], opened: true })] });
  assert.equal(buildScorecards([first, second]).alpha.distinctFilesRead, 3);
});
