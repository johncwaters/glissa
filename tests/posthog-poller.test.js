'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPosthogPoller } = require('../server/posthog-poller.ts');

const HOST = 'https://ph.test';
const KEY = 'ph.test/1#iss-1';

const flush = async (n = 20) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

function issueRow(over = {}) {
  return {
    id: 'iss-1',
    name: 'TypeError: boom',
    status: 'active',
    aggregations: { occurrences: 120, users: 8 },
    ...over,
  };
}

function makeApi(over = {}) {
  return {
    queryIssues: async () => ({ ok: true, body: { results: [issueRow()] } }),
    listSpikeEvents: async () => ({ ok: true, body: { results: [] } }),
    listOrganizations: async () => ({ ok: true, body: { results: [] } }),
    listProjects: async () => ({ ok: true, body: { results: [] } }),
    listRecommendations: async () => ({ ok: true, body: { results: [] } }),
    ...over,
  };
}

// Build poller deps with in-memory state + captured pings, non-firing timers, and a hand-driven
// clock. `over.initialState` seeds the state store BEFORE construction (readState reads the store
// lazily, so seeding after would be ignored). Mirrors tests/pr-poller.test.js harness().
function harness(over = {}) {
  const pings = [];
  const summaries = [];
  const stateStore = { value: over.initialState ? JSON.parse(JSON.stringify(over.initialState)) : {} };
  const noFireTimer = { unref() {} };
  const deps = {
    api: makeApi(over.api),
    host: HOST,
    resolveProjects: over.resolveProjects || (async () => [{ projectId: 1, name: 'web' }]),
    spawnInvestigation: over.spawnInvestigation || (async () => ({ verdict: 'ROOT_CAUSE' })),
    telegram: (msg) => pings.push(msg),
    readState: async () => stateStore.value,
    writeState: async (s) => { stateStore.value = JSON.parse(JSON.stringify(s)); },
    setIntervalFn: over.setIntervalFn || (() => noFireTimer),
    clearIntervalFn: over.clearIntervalFn || (() => {}),
    setTimeoutFn: over.setTimeoutFn || (() => noFireTimer),
    clearTimeoutFn: () => {},
    log: { warn() {} },
    onTickComplete: (s) => summaries.push(s),
    now: over.now || (() => 1000),
    intervalMinutes: 15,
    maxConcurrentInvestigations: over.maxConcurrentInvestigations || 2,
    minUsersToInvestigate: over.minUsersToInvestigate ?? 1,
    userEscalationThreshold: over.userEscalationThreshold ?? 25,
    autoFix: over.autoFix,
    fixTimeoutSeconds: over.fixTimeoutSeconds,
    recurrenceDedupe: over.recurrenceDedupe,
    recurrenceWindowDays: over.recurrenceWindowDays,
    transientRecurrenceLimit: over.transientRecurrenceLimit,
    trafficSpikeEnabled: over.trafficSpikeEnabled,
    trafficSpikeMultiplier: over.trafficSpikeMultiplier,
    trafficSpikeMinUsers: over.trafficSpikeMinUsers,
    trafficSpikeCooldownMinutes: over.trafficSpikeCooldownMinutes,
    trafficSpikeBaselineDays: over.trafficSpikeBaselineDays,
  };
  return { deps, pings, summaries, stateStore, poller: createPosthogPoller(deps) };
}

test('start() investigates a new issue, arms an unref-d interval, stop() clears it', async () => {
  let intervalCb = null;
  let cleared = false;
  const spawnCalls = [];
  const { poller, pings } = harness({
    spawnInvestigation: async (a) => { spawnCalls.push(a); return { verdict: 'ROOT_CAUSE' }; },
    setIntervalFn: (cb) => { intervalCb = cb; return { unref() {} }; },
    clearIntervalFn: () => { cleared = true; },
  });
  await poller.start();
  await flush();

  assert.equal(spawnCalls.length, 1, 'investigated the one new issue');
  assert.equal(spawnCalls[0].issue.issueId, 'iss-1');
  assert.equal(spawnCalls[0].url, 'https://ph.test/project/1/error_tracking/iss-1');
  assert.equal(poller._state()[KEY].verdict, 'ROOT_CAUSE');
  assert.equal(poller._state()[KEY].inFlight, false);
  assert.equal(pings.length, 1, 'a ROOT_CAUSE verdict is digest-only, so only the new-issue ping fires');
  assert.match(pings[0], /^\[glissa\/posthog\] NEW ISSUE web$/m);
  assert.equal(typeof intervalCb, 'function', 'interval armed');

  await poller.stop();
  assert.ok(cleared, 'stop cleared the interval');
});

test('an issue is investigated once: a quiet second tick spends nothing', async () => {
  let spawned = 0;
  const { poller } = harness({
    spawnInvestigation: async () => { spawned += 1; return { verdict: 'ROOT_CAUSE' }; },
  });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();
  assert.equal(spawned, 1, 'the now-known unchanged issue is quiet and costs no session');
});

const SPIKING_API = {
  listSpikeEvents: async () => ({ ok: true, body: { results: [{ issue_id: 'iss-1', timestamp: '2099-01-01T00:00:00Z' }] } }),
};

test('a spike event on an undiagnosed issue pings and investigates', async () => {
  let spawned = 0;
  const { poller, pings } = harness({
    initialState: { [KEY]: { status: 'active', lastUsers: 8, verdict: null, pingedPhases: [] } },
    api: SPIKING_API,
    spawnInvestigation: async () => { spawned += 1; return { verdict: 'ROOT_CAUSE' }; },
  });
  await poller.start();
  await flush();
  assert.equal(spawned, 1);
  assert.equal(pings.length, 1);
  assert.match(pings[0], /^\[glissa\/posthog\] SPIKE web$/m);
  assert.match(pings[0], /120 occurrences \/ 8 users/);
});

// The spike endpoint keeps naming an issue for as long as it spikes, so both the ping and the
// investigation used to repeat every interval, forever, for an issue already diagnosed.
test('a persistently spiking diagnosed issue pings once and spends no further sessions', async () => {
  let spawned = 0;
  const { poller, pings } = harness({
    initialState: { [KEY]: { status: 'active', lastUsers: 8, verdict: 'ROOT_CAUSE', investigatedUsers: 8, pingedPhases: [] } },
    api: SPIKING_API,
    spawnInvestigation: async () => { spawned += 1; return { verdict: 'ROOT_CAUSE' }; },
  });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();
  await poller.tick();
  await flush();
  assert.equal(spawned, 0, 'a diagnosed issue is not re-investigated on every spike tick');
  assert.equal(pings.length, 1, 'pingedPhases dedups the spike ping across ticks');
});

test('a diagnosed spiking issue whose blast radius crosses the threshold is re-investigated', async () => {
  let spawned = 0;
  const { poller } = harness({
    initialState: { [KEY]: { status: 'active', verdict: 'ROOT_CAUSE', investigatedUsers: 8, pingedPhases: ['spike'] } },
    api: {
      ...SPIKING_API,
      queryIssues: async () => ({ ok: true, body: { results: [issueRow({ aggregations: { occurrences: 900, users: 60 } })] } }),
    },
    spawnInvestigation: async () => { spawned += 1; return { verdict: 'NEEDS_HUMAN' }; },
  });
  await poller.start();
  await flush();
  assert.equal(spawned, 1, 'a worsened spike still earns a fresh diagnosis');
});

test('a resolved issue turning active again pings as a regression', async () => {
  const { poller, pings } = harness({
    initialState: { [KEY]: { status: 'resolved', lastUsers: 8, verdict: 'ROOT_CAUSE', pingedPhases: [] } },
  });
  await poller.start();
  await flush();
  assert.equal(pings.length, 1);
  assert.match(pings[0], /^\[glissa\/posthog\] REGRESSED web$/m);
  assert.equal(poller._state()[KEY].status, 'active', 'the entry is written back active, so it cannot re-ping');
});

test('a new issue pings NEW ISSUE once, not per tick', async () => {
  const { poller, pings } = harness({
    api: { queryIssues: async () => ({ ok: true, body: { results: [issueRow({ aggregations: { occurrences: 900, users: 60 } })] } }) },
    spawnInvestigation: async () => ({ verdict: 'ROOT_CAUSE' }),
  });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();
  const newIssue = pings.filter((p) => /NEW ISSUE/.test(p));
  assert.equal(newIssue.length, 1, 'pingedPhases dedups the new-issue ping across ticks');
});

// The detection ping follows the auto-fix major predicate: the issue itself qualifies, blast radius
// is irrelevant, so a new issue far below userEscalationThreshold still announces itself once.
test('a new issue below the escalation threshold still pings NEW ISSUE', async () => {
  const { poller, pings } = harness({
    api: { queryIssues: async () => ({ ok: true, body: { results: [issueRow({ aggregations: { occurrences: 3, users: 1 } })] } }) },
    userEscalationThreshold: 25,
    spawnInvestigation: async () => ({ verdict: 'ROOT_CAUSE' }),
  });
  await poller.start();
  await flush();
  assert.equal(pings.filter((p) => /NEW ISSUE/.test(p)).length, 1);
});

test('a NEEDS_HUMAN verdict pings once; a later re-investigation does not re-ping it', async () => {
  let tickCount = 0;
  const { poller, pings } = harness({
    api: {
      // Spike only on the third tick, forcing a second investigation of the same issue.
      listSpikeEvents: async () => {
        tickCount += 1;
        if (tickCount < 3) return { ok: true, body: { results: [] } };
        return { ok: true, body: { results: [{ issue_id: 'iss-1', timestamp: '2099-01-01T00:00:00Z' }] } };
      },
    },
    spawnInvestigation: async () => ({ verdict: 'NEEDS_HUMAN', summary: 'needs a carbon unit' }),
  });
  await poller.start();
  await flush();
  assert.equal(pings.filter((p) => /NEEDS HUMAN/.test(p)).length, 1);

  await poller.tick();
  await flush();
  await poller.tick();
  await flush();

  assert.equal(pings.filter((p) => /NEEDS HUMAN/.test(p)).length, 1, 'pingedPhases suppressed the repeat');
  assert.equal(pings.filter((p) => /SPIKE/.test(p)).length, 1, 'the spike itself still pinged');
});

test('a quiet known issue spends no session and produces no ping', async () => {
  let spawned = 0;
  const { poller, pings } = harness({
    initialState: { [KEY]: { status: 'active', lastOccurrences: 120, lastUsers: 8, verdict: 'ROOT_CAUSE', pingedPhases: [] } },
    spawnInvestigation: async () => { spawned += 1; return { verdict: 'ROOT_CAUSE' }; },
  });
  await poller.start();
  await flush();
  assert.equal(spawned, 0);
  assert.deepEqual(pings, []);
});

test('maxConcurrentInvestigations caps in-flight spawns per tick', async () => {
  let spawned = 0;
  const { poller } = harness({
    api: {
      queryIssues: async () => ({
        ok: true,
        body: { results: [issueRow({ id: 'iss-1' }), issueRow({ id: 'iss-2' }), issueRow({ id: 'iss-3' })] },
      }),
    },
    spawnInvestigation: () => { spawned += 1; return new Promise(() => {}); },
    maxConcurrentInvestigations: 1,
  });
  await poller.start();
  await flush();
  assert.equal(spawned, 1, 'only one investigation spawned under the cap');
});

test('stop() drains an in-flight investigation before resolving; none spawn after stop', async () => {
  let resolveInvestigation;
  let spawned = 0;
  const { poller } = harness({
    spawnInvestigation: () => {
      spawned += 1;
      return new Promise((resolve) => { resolveInvestigation = resolve; });
    },
  });
  await poller.start();
  await flush();
  assert.equal(spawned, 1);
  assert.equal(poller._state()[KEY].inFlight, true);

  let stopSettled = false;
  const stopPromise = poller.stop().then(() => { stopSettled = true; });
  await flush();
  assert.equal(stopSettled, false, 'stop() waits for the in-flight investigation');

  resolveInvestigation({ verdict: 'ROOT_CAUSE' });
  await stopPromise;
  assert.equal(stopSettled, true);
  assert.equal(poller._state()[KEY].inFlight, false, 'the drained investigation finished normally');

  await poller.tick();
  await flush();
  assert.equal(spawned, 1, 'no new investigation spawns after stop');
});

test('a hung investigation is force-resolved to ERROR by the timeout and frees its slot', async () => {
  const { poller, pings } = harness({
    spawnInvestigation: () => new Promise(() => {}),
    setTimeoutFn: (cb) => { cb(); return { unref() {} }; },
    maxConcurrentInvestigations: 1,
  });
  await poller.start();
  await flush();
  assert.equal(poller._state()[KEY].verdict, 'ERROR');
  assert.equal(poller._state()[KEY].inFlight, false, 'slot freed');
  assert.equal(pings.length, 2);
  assert.match(pings[0], /^\[glissa\/posthog\] NEW ISSUE web$/m);
  assert.match(pings[1], /^\[glissa\/posthog\] ERROR web$/m);
});

// queryIssues returns only the top-50 active issues of the last 24h, so absence is not death: the
// entry is assumed resolved and retained, which is also the only way a return can read as a
// regression (an active-only query can never hand back a resolved row).
test('an issue that vanished from the active list is marked resolved, not deleted, with no ping', async () => {
  const { poller, pings } = harness({
    initialState: { [KEY]: { status: 'active', verdict: 'ROOT_CAUSE', pingedPhases: [] } },
    api: { queryIssues: async () => ({ ok: true, body: { results: [] } }) },
  });
  await poller.start();
  await flush();
  assert.equal(poller._state()[KEY].status, 'resolved');
  assert.equal(poller._state()[KEY].verdict, 'ROOT_CAUSE', 'verdict history survives the disappearance');
  assert.equal(poller._state()[KEY].vanishedAt, 1000);
  assert.deepEqual(pings, []);
});

test('the full vanish-then-return cycle classifies the return as a regression', async () => {
  let present = true;
  const { poller, pings } = harness({
    initialState: { [KEY]: { status: 'active', verdict: 'ROOT_CAUSE', investigatedUsers: 8, pingedPhases: [] } },
    api: { queryIssues: async () => ({ ok: true, body: { results: present ? [issueRow()] : [] } }) },
    spawnInvestigation: async () => ({ verdict: 'ROOT_CAUSE' }),
  });

  present = false;
  await poller.start();
  await flush();
  assert.equal(poller._state()[KEY].status, 'resolved');

  present = true;
  await poller.tick();
  await flush();
  assert.equal(pings.length, 1);
  assert.match(pings[0], /^\[glissa\/posthog\] REGRESSED web$/m);
  assert.equal(poller._state()[KEY].status, 'active', 'written back active, so it cannot re-ping');
  assert.equal(poller._state()[KEY].vanishedAt, undefined, 'the vanish stamp is cleared on return');
});

test('an in-flight investigation is never pruned by its issue falling off the list', async () => {
  let vanished = false;
  const { poller } = harness({
    api: { queryIssues: async () => ({ ok: true, body: { results: vanished ? [] : [issueRow()] } }) },
    spawnInvestigation: () => new Promise(() => {}),
  });
  await poller.start();
  await flush();
  assert.equal(poller._state()[KEY].inFlight, true);

  vanished = true;
  await poller.tick();
  await flush();
  assert.equal(poller._state()[KEY].inFlight, true, 'the entry survived, so concurrency stays correct');
});

test('an entry gone longer than the retention window is finally pruned', async () => {
  const RETENTION_MS = 7 * 86400000;
  const { poller } = harness({
    initialState: { [KEY]: { status: 'resolved', verdict: 'ROOT_CAUSE', vanishedAt: 1, pingedPhases: [] } },
    api: { queryIssues: async () => ({ ok: true, body: { results: [] } }) },
    now: () => 1 + RETENTION_MS,
  });
  await poller.start();
  await flush();
  assert.equal(poller._state()[KEY], undefined, 'aged out on the clock, not on one absent tick');
});

test('a failed issue query reports that project without killing the cycle', async () => {
  const seen = [];
  const { poller, summaries } = harness({
    resolveProjects: async () => [{ projectId: 1, name: 'web' }, { projectId: 2, name: 'api' }],
    api: {
      queryIssues: async (projectId) => {
        seen.push(projectId);
        if (projectId === 1) return { ok: false, error: 'HTTP 500' };
        return { ok: true, body: { results: [issueRow()] } };
      },
    },
  });
  await poller.start();
  await flush();
  assert.deepEqual(seen, [1, 2], 'the second project was still polled');
  const reported = summaries.at(-1).projects;
  assert.deepEqual(reported.map((p) => p.projectId), [1, 2]);
  assert.equal(reported[0].error, 'HTTP 500', 'the failure is reported, not hidden by omission');
  assert.equal(reported[1].error, undefined);
});

test('onTickComplete emits the dashboard broadcast payload', async () => {
  const { poller, summaries } = harness({
    spawnInvestigation: async () => ({ verdict: 'NEEDS_HUMAN' }),
  });
  await poller.start();
  await flush();
  const summary = summaries.at(-1);
  assert.equal(summary.type, 'posthog-status');
  assert.equal(summary.ts, 1000);
  assert.equal(summary.intervalMinutes, 15, 'the dashboard needs the interval to judge staleness');
  assert.equal(summary.projects.length, 1);
  const project = summary.projects[0];
  assert.equal(project.projectId, 1);
  assert.equal(project.name, 'web');
  assert.equal(project.host, HOST);
  assert.equal(project.lastTickAt, 1000);
  assert.deepEqual(project.issues, [{
    issueId: 'iss-1',
    title: 'TypeError: boom',
    change: 'new',
    occurrences: 120,
    users: 8,
    verdict: null,
    summaryLine: null,
    history: [{ ts: 1000, occurrences: 120 }],
    inFlight: true,
    url: 'https://ph.test/project/1/error_tracking/iss-1',
  }], 'the snapshot describes the tick, so the verdict is still null while the session runs');
});

test('onTickComplete reports a project whose issue query failed instead of dropping it', async () => {
  const { poller, summaries } = harness({
    api: { queryIssues: async () => ({ ok: false, error: 'HTTP 401' }) },
  });
  await poller.start();
  await flush();
  const project = summaries.at(-1).projects[0];
  assert.equal(project.projectId, 1);
  assert.equal(project.name, 'web');
  assert.equal(project.error, 'HTTP 401');
  assert.deepEqual(project.issues, []);
  assert.equal(project.lastTickAt, 0, 'no successful poll yet, so no stamp to report');
});

test('onTickComplete includes a persisted investigation summary line', async () => {
  const { poller, summaries } = harness({
    initialState: {
      [KEY]: {
        status: 'active',
        lastOccurrences: 120,
        lastUsers: 8,
        verdict: 'NEEDS_HUMAN',
        summaryLine: 'checkout fails after payment',
        investigatedUsers: 8,
        pingedPhases: [],
      },
    },
  });
  await poller.start();
  await flush();
  const issue = summaries.at(-1).projects[0].issues[0];
  assert.equal(issue.verdict, 'NEEDS_HUMAN');
  assert.equal(issue.summaryLine, 'checkout fails after payment');
  assert.deepEqual(issue.history, [{ ts: 1000, occurrences: 120 }]);
  assert.equal(issue.inFlight, false);
});

test('onTickComplete carries the persisted occurrence history', async () => {
  const { poller, summaries } = harness({
    initialState: {
      [KEY]: {
        status: 'active',
        lastOccurrences: 100,
        lastUsers: 8,
        history: [{ ts: 500, occurrences: 100 }],
        pingedPhases: [],
      },
    },
  });
  await poller.start();
  await flush();
  const issue = summaries.at(-1).projects[0].issues[0];
  assert.deepEqual(issue.history, [{ ts: 500, occurrences: 100 }, { ts: 1000, occurrences: 120 }]);
});

// Stamping lastTickAt after the queries left the whole query window invisible to the next tick, so a
// spike arriving mid-tick was never seen. The next tick's cutoff is this tick's START.
test('the spike cutoff is the tick START time, so a mid-tick spike is still seen next tick', async () => {
  let clock = 1000;
  const { poller } = harness({
    api: {
      queryIssues: async () => { clock += 5000; return { ok: true, body: { results: [issueRow()] } }; },
      listSpikeEvents: async () => ({ ok: true, body: { results: [] } }),
    },
    now: () => clock,
  });
  await poller.start();
  await flush();
  assert.equal(poller._state()._meta.lastTickAt[1], 1000, 'stamped before the query advanced the clock');
});

test('re-entrancy guard: an overlapping tick returns early', async () => {
  let queryCalls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { poller } = harness({
    api: { queryIssues: async () => { queryCalls += 1; await gate; return { ok: true, body: { results: [] } }; } },
  });
  const first = poller.tick();
  const second = poller.tick();
  await second;
  await flush();
  assert.equal(queryCalls, 1, 'second tick short-circuited while the first was running');
  release();
  await first;
});

test('start() clears a stale inFlight left by a crash so the issue is re-investigated', async () => {
  let spawned = 0;
  const { poller } = harness({
    initialState: { [KEY]: { status: 'active', inFlight: true, verdict: null, pingedPhases: [] } },
    api: SPIKING_API,
    spawnInvestigation: async () => { spawned += 1; return { verdict: 'ROOT_CAUSE' }; },
  });
  await poller.start();
  await flush();
  assert.equal(spawned, 1, 'a stale in-flight marker does not wedge the issue forever');
});

// --- Auto-fix dispatch: a MAJOR issue gets an agent that reproduces and repairs, not one that only
// diagnoses. Opt-in, and it rides the same slots, the same inFlight bookkeeping and the same drain.

// The default row is a first sighting with 8 users, so a threshold of 5 also makes it high impact.
const MAJOR = { autoFix: true, userEscalationThreshold: 5 };

function fixResult(over = {}) {
  return {
    verdict: 'FIXED',
    summary: 'guarded the null socket',
    reproduced: true,
    prUrl: 'https://github.com/o/r/pull/7',
    mode: 'fix',
    ...over,
  };
}

test('autoFix dispatches a fix job for a major issue, with the fix timeout', async () => {
  const calls = [];
  const { poller } = harness({
    ...MAJOR,
    fixTimeoutSeconds: 1800,
    spawnInvestigation: async (a) => { calls.push(a); return fixResult(); },
  });
  await poller.start();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'fix');
  assert.equal(calls[0].timeoutMs, 1800000, 'a fix gets its own ceiling, not the investigation one');
});

test('autoFix off keeps every dispatch an investigation on the investigation timeout', async () => {
  const calls = [];
  const { poller } = harness({
    userEscalationThreshold: 5,
    spawnInvestigation: async (a) => { calls.push(a); return { verdict: 'ROOT_CAUSE' }; },
  });
  await poller.start();
  await flush();
  assert.equal(calls[0].mode, 'investigate');
  assert.equal(calls[0].timeoutMs, 900000);
});

test('autoFix dispatches a fix for a new issue under the escalation threshold', async () => {
  const calls = [];
  const { poller } = harness({
    autoFix: true,
    spawnInvestigation: async (a) => { calls.push(a); return { verdict: 'ROOT_CAUSE' }; },
  });
  await poller.start();
  await flush();
  assert.equal(calls[0].mode, 'fix', 'blast radius gates the ping, not the fix');
});

test('a fix job takes a shared concurrency slot, never a second pool', async () => {
  let spawned = 0;
  const { poller } = harness({
    ...MAJOR,
    api: {
      queryIssues: async () => ({
        ok: true,
        body: { results: [issueRow({ id: 'iss-1' }), issueRow({ id: 'iss-2' })] },
      }),
    },
    spawnInvestigation: () => { spawned += 1; return new Promise(() => {}); },
    maxConcurrentInvestigations: 1,
  });
  await poller.start();
  await flush();
  assert.equal(spawned, 1);
});

test('a FIXED verdict pings once with the repro status and the pull request', async () => {
  const { poller, pings } = harness({ ...MAJOR, spawnInvestigation: async () => fixResult() });
  await poller.start();
  await flush();
  // The observation ping fires first: a new issue is announced when it is SEEN, and the fix verdict
  // is a second, differently-kinded ping rather than a replacement for it.
  assert.equal(pings.length, 2);
  assert.match(pings[0], /^\[glissa\/posthog\] NEW ISSUE web$/m);
  assert.match(pings[1], /^\[glissa\/posthog\] FIXED web$/m);
  assert.match(pings[1], /reproduced, then fixed/);
  assert.match(pings[1], /PR: https:\/\/github\.com\/o\/r\/pull\/7/);
});

test('a completed fix is folded onto the entry and into the inbox record', async () => {
  const { poller, stateStore } = harness({
    ...MAJOR, spawnInvestigation: async () => fixResult(), now: () => 4200,
  });
  await poller.start();
  await flush();
  const entry = poller._state()[KEY];
  assert.equal(entry.verdict, 'FIXED');
  assert.equal(entry.inFlight, false);
  assert.deepEqual(entry.fix, {
    at: 4200,
    verdict: 'FIXED',
    reproduced: true,
    prUrl: 'https://github.com/o/r/pull/7',
  });
  const record = stateStore.value._investigations[0];
  assert.equal(record.mode, 'fix');
  assert.equal(record.prUrl, 'https://github.com/o/r/pull/7');
});

test('a completed fix is not redispatched on the next tick', async () => {
  let spawned = 0;
  const { poller, pings } = harness({
    ...MAJOR,
    spawnInvestigation: async () => { spawned += 1; return fixResult(); },
  });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();
  await poller.tick();
  await flush();
  assert.equal(spawned, 1, 'the fixed issue is quiet now and costs nothing per tick');
  assert.equal(pings.filter((p) => p.includes('FIXED')).length, 1, 'and it pings once, not once per tick');
});

// The spike endpoint keeps naming an issue for as long as the spike lasts, so a redispatch keyed on
// the classification alone would spend a fix session every interval on an issue that already has one.
test('a fixed issue that keeps spiking with growing users is not redispatched every tick', async () => {
  let users = 8;
  let spawned = 0;
  const { poller } = harness({
    ...MAJOR,
    api: {
      ...SPIKING_API,
      queryIssues: async () => ({
        ok: true,
        body: { results: [issueRow({ aggregations: { occurrences: 120, users } })] },
      }),
    },
    spawnInvestigation: async () => { spawned += 1; return fixResult(); },
  });
  await poller.start();
  await flush();
  for (const grown of [40, 400]) {
    users = grown;
    await poller.tick();
    await flush();
  }
  assert.equal(spawned, 1, 'the blast radius was already past the threshold when the fix ran');
});

// The other half of the churn rule: a fix that did not hold must be allowed to run again, and its
// pull request must not be opened in silence (pingedPhases is carried forward forever, so the fix
// ping is deliberately not deduped through it).
test('an issue that regresses after a fix is fixed again, and pings again', async () => {
  let present = true;
  let spawned = 0;
  const { poller, pings } = harness({
    ...MAJOR,
    api: { queryIssues: async () => ({ ok: true, body: { results: present ? [issueRow()] : [] } }) },
    spawnInvestigation: async () => { spawned += 1; return fixResult(); },
  });
  await poller.start();
  await flush();
  present = false;
  await poller.tick();
  await flush();
  assert.equal(poller._state()[KEY].status, 'resolved', 'absence is assumed resolution');
  present = true;
  await poller.tick();
  await flush();
  assert.equal(spawned, 2, 'a genuine regression earns a second fix');
  assert.equal(pings.filter((p) => p.includes('FIXED')).length, 2);
});

// A fix job unwinds through its worktree discard, and on the TIMEOUT path the race that freed the
// slot has already resolved. stop() must still wait for that unwind, or a shutdown (or a settings
// restart) leaves the throwaway checkout behind for the next instance to trip over.
test('stop() waits for a timed-out fix job to finish discarding its worktree', async () => {
  const order = [];
  const gitWorkspace = {
    create: async () => { order.push('create'); return { cwd: '/wt', isGit: true, branch: 'b' }; },
    discard: async () => {
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      order.push('discard');
    },
  };
  const { poller } = harness({
    ...MAJOR,
    setTimeoutFn: (cb) => { cb(); return { unref() {} }; },
    spawnInvestigation: async ({ signal }) => {
      const workspace = await gitWorkspace.create();
      try {
        await new Promise((resolve) => {
          if (signal.aborted) { resolve(); return; }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { verdict: 'ERROR', summary: 'fix timed out', mode: 'fix' };
      } finally {
        await gitWorkspace.discard({ workspace });
      }
    },
  });
  await poller.start();
  await poller.stop();
  order.push('stopped');
  assert.deepEqual(order, ['create', 'discard', 'stopped']);
});

test('a fix that only needs a carbon unit reuses the needs_human ping and records no PR', async () => {
  const { poller, pings, stateStore } = harness({
    ...MAJOR,
    spawnInvestigation: async () => fixResult({ verdict: 'NEEDS_HUMAN', prUrl: null, reproduced: false }),
  });
  await poller.start();
  await flush();
  assert.match(pings.at(-1), /^\[glissa\/posthog\] NEEDS HUMAN web$/m);
  assert.doesNotMatch(pings.at(-1), /PR:/);
  assert.equal(stateStore.value._investigations[0].prUrl, null);
  assert.equal(poller._state()[KEY].fix.verdict, 'NEEDS_HUMAN');
});

test('a hung fix is force-resolved to ERROR, freeing its slot and naming the mode', async () => {
  const { poller, pings } = harness({
    ...MAJOR,
    spawnInvestigation: () => new Promise(() => {}),
    setTimeoutFn: (cb) => { cb(); return { unref() {} }; },
    maxConcurrentInvestigations: 1,
  });
  await poller.start();
  await flush();
  assert.equal(poller._state()[KEY].verdict, 'ERROR');
  assert.equal(poller._state()[KEY].inFlight, false, 'slot freed');
  assert.equal(poller._state()[KEY].fix.verdict, 'ERROR', 'the failed attempt is still recorded');
  assert.match(pings.at(-1), /^\[glissa\/posthog\] ERROR web$/m);
});

test('a fix the wiring downgraded is recorded as the investigation it actually was', async () => {
  const { poller, stateStore } = harness({
    ...MAJOR,
    spawnInvestigation: async () => ({ verdict: 'ROOT_CAUSE', summary: 'no repo to fix in', mode: 'investigate' }),
  });
  await poller.start();
  await flush();
  assert.equal(poller._state()[KEY].fix, null, 'nothing was fixed, so nothing claims to have been');
  assert.equal(stateStore.value._investigations[0].mode, 'investigate');
});

// --- Investigations inbox: the persisted log the Radar review section renders ---

test('a completed investigation appends one record to the persisted log', async () => {
  const { poller, stateStore, summaries } = harness({
    spawnInvestigation: async () => ({ verdict: 'TRANSIENT', summary: 'one-off dependency blip' }),
    now: () => 4200,
  });
  await poller.start();
  await flush();

  const log = stateStore.value._investigations;
  assert.equal(log.length, 1, 'the silent verdict still lands in the inbox');
  assert.deepEqual(log[0], {
    id: 'iss-1@4200',
    key: KEY,
    projectId: 1,
    projectName: 'web',
    host: HOST,
    issueId: 'iss-1',
    title: 'TypeError: boom',
    url: 'https://ph.test/project/1/error_tracking/iss-1',
    verdict: 'TRANSIENT',
    summaryLine: 'one-off dependency blip',
    mode: 'investigate',
    prUrl: null,
    at: 4200,
    archived: false,
  });
  assert.deepEqual(summaries.at(-1).investigations.map((r) => r.id), ['iss-1@4200'], 'and rides the broadcast');
});

test('archiveInvestigation hides one record, persists it, and is idempotent', async () => {
  const { poller, stateStore } = harness({
    spawnInvestigation: async () => ({ verdict: 'NEEDS_HUMAN', summary: 'needs a carbon unit' }),
    now: () => 1000,
  });
  await poller.start();
  await flush();

  const res = await poller.archiveInvestigation('iss-1@1000');
  assert.equal(res.ok, true);
  assert.deepEqual(res.investigations, [], 'the archived record leaves the broadcast list');
  await flush();
  assert.equal(stateStore.value._investigations[0].archived, true, 'persisted');

  assert.equal((await poller.archiveInvestigation('iss-1@1000')).ok, true, 'idempotent');
  assert.deepEqual(poller.investigations(), []);
});

test('archiveInvestigation stamps archivedAt so the record ages from the operator action', async () => {
  let clock = 1000;
  const { poller, stateStore } = harness({
    spawnInvestigation: async () => ({ verdict: 'ROOT_CAUSE' }),
    now: () => clock,
  });
  await poller.start();
  await flush();

  clock = 777000;
  await poller.archiveInvestigation('iss-1@1000');
  await flush();
  assert.equal(stateStore.value._investigations[0].archivedAt, 777000);
});

test('the 7-day purge runs on state load and on the tick persist, and spares unarchived records', async () => {
  const day = 86400000;
  const bootAt = 100 * day;
  const record = (id, over = {}) => ({
    id, key: KEY, projectId: 1, projectName: 'web', host: HOST, issueId: 'iss-1',
    title: 'boom', url: '', verdict: 'ROOT_CAUSE', summaryLine: null, at: 1, archived: false, ...over,
  });
  const { poller, stateStore } = harness({
    initialState: {
      _investigations: [
        record('stale@1', { archived: true, archivedAt: bootAt - (8 * day) }),
        record('recent@2', { archived: true, archivedAt: bootAt - day }),
        // Archived by a deploy that predates the archivedAt stamp: aged from `at` instead.
        record('legacy@3', { archived: true, at: bootAt - (9 * day) }),
        record('live@4', { at: 1 }),
      ],
    },
    now: () => bootAt,
  });
  await poller.start();
  await flush();

  const ids = stateStore.value._investigations.map((r) => r.id);
  assert.ok(!ids.includes('stale@1'), 'an archived record past the window is gone from the file');
  assert.ok(!ids.includes('legacy@3'), 'and so is one with no archivedAt but an old completion time');
  assert.ok(ids.includes('recent@2'), 'a recently archived record is kept');
  assert.ok(ids.includes('live@4'), 'an unarchived record is never purged by age');
});

test('a purge on an otherwise clean tick still persists', async () => {
  const day = 86400000;
  let clock = 1000;
  const { poller, stateStore } = harness({
    initialState: {
      _investigations: [{
        id: 'old@1', key: KEY, projectId: 1, projectName: 'web', host: HOST, issueId: 'iss-1',
        title: 'boom', url: '', verdict: 'ROOT_CAUSE', summaryLine: null, at: 1,
        archived: true, archivedAt: 1000,
      }],
    },
    api: { queryIssues: async () => ({ ok: false, error: 'down' }) },
    now: () => clock,
  });
  await poller.start();
  await flush();
  assert.equal(stateStore.value._investigations.length, 1, 'still inside the window at boot');

  clock = 1000 + (8 * day);
  await poller.tick();
  await flush();
  assert.deepEqual(stateStore.value._investigations, [], 'the tick persisted the purge with no other change');
});

test('archiveInvestigation refuses an unknown or malformed id', async () => {
  const { poller } = harness({ now: () => 1000 });
  await poller.start();
  await flush();

  assert.deepEqual(await poller.archiveInvestigation('iss-9@1'), { ok: false, error: 'Unknown investigation' });
  assert.deepEqual(await poller.archiveInvestigation('nonsense'), { ok: false, error: 'Invalid investigation id' });
  assert.deepEqual(await poller.archiveInvestigation(''), { ok: false, error: 'id is required' });
});

test('a state file written by an older server (no _investigations) loads and starts a log', async () => {
  const { poller, stateStore } = harness({
    initialState: {
      // A resolved entry reappearing in the active list classifies as regressed, so this boots
      // straight into an investigation with no _investigations key anywhere in the file.
      [KEY]: {
        status: 'resolved', lastOccurrences: 120, lastUsers: 8, verdict: null, pingedPhases: [],
      },
    },
    spawnInvestigation: async () => ({ verdict: 'ERROR', summary: 'no result file' }),
    now: () => 5000,
  });
  await poller.start();
  await flush();

  assert.equal(stateStore.value._investigations.length, 1);
  assert.equal(stateStore.value[KEY].verdict, 'ERROR', 'the per-issue entry is untouched by the log');
});

test('the investigations log is never treated as an issue entry', async () => {
  const { poller } = harness({
    spawnInvestigation: async () => ({ verdict: 'ROOT_CAUSE', summary: 'fixed upstream' }),
    now: () => 1000,
  });
  await poller.start();
  await flush();
  // Second tick with the issue gone: reconcileVanished walks every key and must skip the log.
  poller._state()._meta.lastTickAt[1] = 0;
  const { poller: gone, stateStore: goneStore } = harness({
    initialState: poller._state(),
    api: { queryIssues: async () => ({ ok: true, body: { results: [] } }) },
    now: () => 9000,
  });
  await gone.start();
  await flush();
  assert.ok(Array.isArray(goneStore.value._investigations), 'still a plain array');
  assert.equal(goneStore.value._investigations.length, 1, 'the record outlives its issue');
  assert.equal(goneStore.value._investigations[0].archived, false);
});

// --- recurrence dedupe and escalation (server/core/posthog-recurrence.js) ---
//
// PostHog mints a new issue id whenever an error's grouping fingerprint shifts, so one non-event
// bought two full investigations hours apart, both concluding TRANSIENT. These cover the lane's
// cross-issue memory: the second id costs nothing, and a pattern that changes stops trusting it.

const CHUNK_A = 'TypeError: Failed to fetch dynamically imported module: https://shop.example.com/assets/maplibre-gl-B3nQ.js';
const CHUNK_B = 'TypeError: Failed to fetch dynamically imported module: https://shop.example.com/assets/maplibre-gl-Zk91.js';
const CHUNK_SUMMARY = 'A crawler failed to lazy-load the map chunk; no code defect.';

function chunkRow(id, name, users = 1) {
  return issueRow({ id, name, aggregations: { occurrences: 4, users } });
}

// A cluster as the lane would have written it after one TRANSIENT verdict on iss-1.
function seedCluster(over = {}) {
  return {
    _signatures: {
      'ph.test/1#iss-1': {
        projectId: '1',
        issueId: 'iss-1',
        title: CHUNK_A,
        summaryLine: CHUNK_SUMMARY,
        firstAt: 1000,
        lastAt: 1000,
        recurrences: 0,
        escalated: false,
        recurredIssueIds: [],
        ...over,
      },
    },
  };
}

test('a fresh issue id for an already-diagnosed transient is deduped, not investigated', async () => {
  let issues = [chunkRow('iss-1', CHUNK_A)];
  const spawned = [];
  const { poller, stateStore, pings } = harness({
    api: { queryIssues: async () => ({ ok: true, body: { results: issues } }) },
    spawnInvestigation: async (a) => {
      spawned.push(a.issue.issueId);
      return { verdict: 'TRANSIENT', summary: CHUNK_SUMMARY };
    },
    now: () => 1000,
  });
  await poller.start();
  await flush();
  assert.deepEqual(spawned, ['iss-1'], 'the first sighting is investigated normally');
  assert.equal(stateStore.value._signatures['ph.test/1#iss-1'].recurrences, 0, 'the transient opened a cluster');

  issues = [chunkRow('iss-2', CHUNK_B)];
  await poller.tick();
  await flush();

  const key = 'ph.test/1#iss-2';
  assert.deepEqual(spawned, ['iss-1'], 'the twin issue never spawned a session');
  assert.equal(poller._state()[key].verdict, 'TRANSIENT');
  assert.match(poller._state()[key].summaryLine, /matches prior transient issue iss-1/);
  assert.equal(poller._state()[key].recurrenceOf, 'ph.test/1#iss-1');
  assert.equal(stateStore.value._signatures['ph.test/1#iss-1'].recurrences, 1, 'the counter lives on the prior');
  assert.deepEqual(stateStore.value._signatures['ph.test/1#iss-1'].recurredIssueIds, ['iss-2']);
  assert.equal(stateStore.value._investigations.length, 2, 'the deduped verdict still reaches the inbox');
  assert.equal(stateStore.value._investigations[1].verdict, 'TRANSIENT');
  assert.deepEqual(pings.filter((p) => /RECURRING/.test(p)), [], 'a first repeat is not worth a phone buzz');
});

test('a deduped issue is quiet on the next tick: the verdict is its own now', async () => {
  let spawned = 0;
  const { poller } = harness({
    initialState: seedCluster(),
    api: { queryIssues: async () => ({ ok: true, body: { results: [chunkRow('iss-2', CHUNK_B)] } }) },
    spawnInvestigation: async () => { spawned += 1; return { verdict: 'TRANSIENT', summary: CHUNK_SUMMARY }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();
  assert.equal(spawned, 0, 'no session, on either tick');
  assert.equal(poller._state()._signatures['ph.test/1#iss-1'].recurrences, 1, 'counted exactly once');
});

test('the configured repeat escalates: a real investigation runs and the phone hears about it', async () => {
  const spawned = [];
  const { poller, pings } = harness({
    initialState: seedCluster({ recurrences: 2 }),
    api: { queryIssues: async () => ({ ok: true, body: { results: [chunkRow('iss-4', CHUNK_B)] } }) },
    spawnInvestigation: async (a) => { spawned.push(a.issue.issueId); return { verdict: 'ROOT_CAUSE', summary: 'real defect' }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();

  assert.deepEqual(spawned, ['iss-4'], 'the third repeat is paid for');
  const recurring = pings.filter((p) => /RECURRING/.test(p));
  assert.equal(recurring.length, 1);
  assert.match(recurring[0], /^\[glissa\/posthog\] RECURRING web$/m);
  assert.match(recurring[0], /recurring transient escalated: repeat 3 within 7 days of issue iss-1/);
  const cluster = poller._state()._signatures['ph.test/1#iss-1'];
  assert.equal(cluster.escalated, true, 'the cluster stops being reusable');
  assert.equal(cluster.recurrences, 3);
  assert.equal(poller._state()['ph.test/1#iss-4'].verdict, 'ROOT_CAUSE');
});

test('an escalated cluster never dedupes again and never re-pings', async () => {
  const spawned = [];
  const { poller, pings } = harness({
    initialState: seedCluster({ recurrences: 3, escalated: true }),
    api: { queryIssues: async () => ({ ok: true, body: { results: [chunkRow('iss-5', CHUNK_B)] } }) },
    spawnInvestigation: async (a) => { spawned.push(a.issue.issueId); return { verdict: 'TRANSIENT', summary: CHUNK_SUMMARY }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();
  assert.deepEqual(spawned, ['iss-5']);
  assert.deepEqual(pings.filter((p) => /RECURRING/.test(p)), [], 'the escalation ping already fired for this cluster');
});

test('two same-cluster escalations planned in one tick fire one ping, not two', async () => {
  const spawned = [];
  const { poller, pings } = harness({
    initialState: seedCluster({ recurrences: 2 }),
    api: {
      queryIssues: async () => ({
        ok: true,
        body: { results: [chunkRow('iss-6', CHUNK_B), chunkRow('iss-7', CHUNK_A)] },
      }),
    },
    spawnInvestigation: async (a) => { spawned.push(a.issue.issueId); return { verdict: 'ROOT_CAUSE', summary: 'real defect' }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();
  assert.deepEqual(spawned.sort(), ['iss-6', 'iss-7'], 'both escalated twins are investigated');
  assert.equal(pings.filter((p) => /RECURRING/.test(p)).length, 1, 'the cluster escalates once');
});

test('a repeat affecting more than one user escalates on its first sighting', async () => {
  const spawned = [];
  const { poller, pings } = harness({
    initialState: seedCluster(),
    api: { queryIssues: async () => ({ ok: true, body: { results: [chunkRow('iss-3', CHUNK_B, 4)] } }) },
    spawnInvestigation: async (a) => { spawned.push(a.issue.issueId); return { verdict: 'NEEDS_HUMAN', summary: 'wider than a crawler' }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();

  assert.deepEqual(spawned, ['iss-3'], 'a blast radius past one carbon unit is not a transient');
  const escalation = pings.find((p) => /RECURRING web/.test(p));
  assert.match(escalation, /now affecting more than one user/);
  assert.equal(poller._state()._signatures['ph.test/1#iss-1'].escalated, true);
});

test('a spiking repeat escalates rather than reusing the old verdict', async () => {
  const spawned = [];
  const { poller, pings } = harness({
    initialState: seedCluster(),
    api: {
      queryIssues: async () => ({ ok: true, body: { results: [chunkRow('iss-6', CHUNK_B)] } }),
      listSpikeEvents: async () => ({ ok: true, body: { results: [{ issue_id: 'iss-6', timestamp: '2099-01-01T00:00:00Z' }] } }),
    },
    spawnInvestigation: async (a) => { spawned.push(a.issue.issueId); return { verdict: 'ROOT_CAUSE', summary: 'real defect' }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();

  assert.deepEqual(spawned, ['iss-6']);
  assert.ok(pings.some((p) => /RECURRING web/.test(p) && /spiking/.test(p)), 'the escalation names the spike');
});

test('an unrelated error is never deduped into an existing cluster', async () => {
  const spawned = [];
  const { poller } = harness({
    initialState: seedCluster(),
    api: {
      queryIssues: async () => ({
        ok: true,
        body: { results: [chunkRow('iss-7', 'RangeError: invoice pagination cursor out of bounds')] },
      }),
    },
    spawnInvestigation: async (a) => { spawned.push(a.issue.issueId); return { verdict: 'ROOT_CAUSE', summary: 'off by one' }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();
  assert.deepEqual(spawned, ['iss-7']);
});

test('the recurrenceDedupe kill switch restores the prior behavior exactly', async () => {
  const spawned = [];
  const { poller, stateStore, pings } = harness({
    recurrenceDedupe: false,
    initialState: seedCluster(),
    api: { queryIssues: async () => ({ ok: true, body: { results: [chunkRow('iss-2', CHUNK_B)] } }) },
    spawnInvestigation: async (a) => { spawned.push(a.issue.issueId); return { verdict: 'TRANSIENT', summary: CHUNK_SUMMARY }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();

  assert.deepEqual(spawned, ['iss-2'], 'every issue is investigated, as before');
  assert.deepEqual(pings.filter((p) => /RECURRING/.test(p)), []);
  assert.equal(stateStore.value._signatures['ph.test/1#iss-1'].recurrences, 0, 'no cluster bookkeeping happens');
  assert.equal(stateStore.value._signatures['ph.test/1#iss-2'], undefined, 'and the transient verdict opens none');
});

test('a state file written before recurrence memory existed loads and behaves as before', async () => {
  const spawned = [];
  const { poller, stateStore } = harness({
    // An old file records a TRANSIENT verdict on iss-1 with no cluster anywhere, and iss-1 has since
    // been assumed resolved, so its reappearance is a regression.
    initialState: {
      'ph.test/1#iss-1': {
        status: 'resolved', lastOccurrences: 4, lastUsers: 1, verdict: 'TRANSIENT', summaryLine: CHUNK_SUMMARY, pingedPhases: [],
      },
    },
    api: { queryIssues: async () => ({ ok: true, body: { results: [chunkRow('iss-1', CHUNK_A), chunkRow('iss-2', CHUNK_B)] } }) },
    spawnInvestigation: async (a) => { spawned.push(a.issue.issueId); return { verdict: 'ROOT_CAUSE', summary: 'real defect' }; },
    now: () => 1000,
  });
  await poller.start();
  await flush();
  assert.deepEqual(spawned.sort(), ['iss-1', 'iss-2'], 'an old verdict with no cluster dedupes nothing');
  assert.equal(stateStore.value._signatures, undefined, 'a non-transient verdict writes no registry');
});

test('a cluster past the recurrence window is pruned and stops deduping', async () => {
  const day = 86400000;
  const spawned = [];
  const { poller, stateStore } = harness({
    initialState: seedCluster({ lastAt: 1000 }),
    api: { queryIssues: async () => ({ ok: true, body: { results: [chunkRow('iss-8', CHUNK_B)] } }) },
    spawnInvestigation: async (a) => { spawned.push(a.issue.issueId); return { verdict: 'ROOT_CAUSE', summary: 'real defect' }; },
    now: () => 1000 + (8 * day),
  });
  await poller.start();
  await flush();
  assert.deepEqual(spawned, ['iss-8'], 'a week-old transient is not evidence');
  assert.deepEqual(stateStore.value._signatures, {}, 'and the dead cluster went with the tick');
});

test('the signature registry is never treated as an issue entry', async () => {
  const { poller } = harness({
    initialState: seedCluster(),
    api: { queryIssues: async () => ({ ok: true, body: { results: [] } }) },
    now: () => 2000,
  });
  await poller.start();
  await flush();
  assert.ok(poller._state()._signatures['ph.test/1#iss-1'], 'reconcileVanished skipped the underscore key');
});

// ---------------------------------------------------------------------------
// The traffic spike lane: same tick, its own state slice, failure-isolated from issue triage.
// ---------------------------------------------------------------------------

const HOUR_MS = 3600000;

// A flat baseline of `users` per hour over two days, i.e. a project with a very stable normal.
function trafficBody(currentUsers, baselineUsers = 10, hours = 48) {
  return {
    ok: true,
    buckets: Array.from({ length: hours }, (_, i) => ({ bucket: `h${i}`, users: baselineUsers })),
    currentUsers,
  };
}

// A poller harness whose api answers the traffic query from a queue of bodies (one per tick).
function trafficHarness(bodies, over = {}) {
  const trafficCalls = [];
  const built = harness({
    ...over,
    api: {
      queryIssues: async () => ({ ok: true, body: { results: [] } }),
      queryTrafficBuckets: async (projectId, opts) => {
        trafficCalls.push({ projectId, opts });
        const body = bodies[Math.min(trafficCalls.length - 1, bodies.length - 1)];
        if (typeof body === 'function') return body();
        return body;
      },
      ...over.api,
    },
  });
  return { ...built, trafficCalls };
}

test('a traffic spike pings once and persists its state slice', async () => {
  const { poller, pings, stateStore } = trafficHarness([trafficBody(87)], { now: () => HOUR_MS });
  await poller.start();
  await flush();

  assert.equal(pings.length, 1);
  assert.match(pings[0], /^\[glissa\/posthog\] TRAFFIC SPIKE web$/m);
  assert.match(pings[0], /87 users in the last hour, ~8\.7x normal \(p90 10\)/);
  assert.equal(pings[0].includes('occurrences'), false, 'a project-level ping carries no issue counts');
  assert.deepEqual(stateStore.value._traffic['1'], {
    active: true, lastPingAt: HOUR_MS, lastPingedUsers: 87, peakUsers: 87,
  });
});

test('a spike that persists across ticks is not re-pinged', async () => {
  const { poller, pings } = trafficHarness([trafficBody(87), trafficBody(90)], { now: () => HOUR_MS });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();

  assert.equal(pings.length, 1, 'the second tick saw the same spike, already reported');
  assert.equal(poller._state()._traffic['1'].peakUsers, 90);
});

test('a spike that doubles again escalates with its own label', async () => {
  const { poller, pings } = trafficHarness([trafficBody(87), trafficBody(200)], { now: () => HOUR_MS });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();

  assert.equal(pings.length, 2);
  assert.match(pings[1], /^\[glissa\/posthog\] TRAFFIC CLIMBING web$/m);
  assert.match(pings[1], /200 users in the last hour/);
  assert.equal(poller._state()._traffic['1'].lastPingedUsers, 200);
});

test('traffic falling back to normal clears the state without a ping', async () => {
  const { poller, pings } = trafficHarness([trafficBody(87), trafficBody(11)], { now: () => HOUR_MS });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();

  assert.equal(pings.length, 1, 'spike over is not news');
  assert.equal(poller._state()._traffic['1'].active, false);
});

test('a baseline shorter than a day never pings', async () => {
  const { poller, pings } = trafficHarness([trafficBody(500, 2, 12)], { now: () => HOUR_MS });
  await poller.start();
  await flush();
  assert.deepEqual(pings, []);
});

test('a traffic query that throws leaves issue triage untouched and never pings', async () => {
  const spawned = [];
  const { poller, pings } = trafficHarness([() => { throw new Error('no query scope'); }], {
    api: { queryIssues: async () => ({ ok: true, body: { results: [issueRow()] } }) },
    spawnInvestigation: async (a) => { spawned.push(a.issue.issueId); return { verdict: 'ROOT_CAUSE' }; },
  });
  await poller.start();
  await flush();

  assert.deepEqual(spawned, ['iss-1'], 'the issue lane ran to completion');
  assert.equal(poller._state()[KEY].verdict, 'ROOT_CAUSE');
  assert.deepEqual(pings.filter((p) => /TRAFFIC/.test(p)), [], 'a broken traffic query never buzzes the operator');
  assert.equal(poller._state()._traffic, undefined, 'and wrote no state slice');
});

test('a failed traffic response is logged, not thrown, and leaves the slice alone', async () => {
  const { poller, pings } = trafficHarness([{ ok: false, error: 'HTTP 403' }]);
  await poller.start();
  await flush();
  assert.deepEqual(pings, []);
  assert.equal(poller._state()._traffic, undefined);
});

test('the traffic slice is never treated as an issue entry', async () => {
  const { poller } = trafficHarness([trafficBody(87)], { now: () => HOUR_MS });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();
  assert.ok(poller._state()._traffic['1'], 'reconcileVanished skipped the underscore key');
});

test('the configured baseline window reaches the query', async () => {
  const { poller, trafficCalls } = trafficHarness([trafficBody(1)], { trafficSpikeBaselineDays: 14 });
  await poller.start();
  await flush();
  assert.equal(trafficCalls[0].opts.baselineDays, 14);
});

test('trafficSpikeEnabled: false makes zero traffic calls', async () => {
  const { poller, pings, trafficCalls } = trafficHarness([trafficBody(87)], {
    trafficSpikeEnabled: false, now: () => HOUR_MS,
  });
  await poller.start();
  await flush();
  assert.equal(trafficCalls.length, 0);
  assert.deepEqual(pings, []);
  assert.equal(poller._state()._traffic, undefined);
});

test('an api with no traffic method (an older client) is skipped rather than crashed on', async () => {
  const { poller, pings } = harness({ api: { queryIssues: async () => ({ ok: true, body: { results: [] } }) } });
  await poller.start();
  await flush();
  assert.deepEqual(pings, []);
});
