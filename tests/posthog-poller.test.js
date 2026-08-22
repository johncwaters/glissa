'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPosthogPoller } = require('../server/posthog-poller');

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
    autoFix: over.autoFix,
    fixTimeoutSeconds: over.fixTimeoutSeconds,
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
// is irrelevant, so a new issue affecting one user still announces itself once.
test('a new issue with a tiny blast radius still pings NEW ISSUE', async () => {
  const { poller, pings } = harness({
    api: { queryIssues: async () => ({ ok: true, body: { results: [issueRow({ aggregations: { occurrences: 3, users: 1 } })] } }) },
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

// The default row is a first sighting, which is major on its own.
const MAJOR = { autoFix: true };

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
    spawnInvestigation: async (a) => { calls.push(a); return { verdict: 'ROOT_CAUSE' }; },
  });
  await poller.start();
  await flush();
  assert.equal(calls[0].mode, 'investigate');
  assert.equal(calls[0].timeoutMs, 900000);
});

test('autoFix dispatches a fix for a brand-new issue whatever its blast radius', async () => {
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
  });
  assert.deepEqual(summaries.at(-1).investigations.map((r) => r.id), ['iss-1@4200'], 'and rides the broadcast');
});

test('archiveInvestigation removes one record and persists the removal', async () => {
  const { poller, stateStore } = harness({
    spawnInvestigation: async () => ({ verdict: 'NEEDS_HUMAN', summary: 'needs a carbon unit' }),
    now: () => 1000,
  });
  await poller.start();
  await flush();

  const res = await poller.archiveInvestigation('iss-1@1000');
  assert.equal(res.ok, true);
  assert.deepEqual(res.investigations, [], 'the removed record leaves the broadcast list');
  await flush();
  assert.deepEqual(stateStore.value._investigations, [], 'persisted');

  const again = await poller.archiveInvestigation('iss-1@1000');
  assert.deepEqual(again, { ok: false, error: 'Unknown investigation' }, 'it is gone, not hidden');
  assert.deepEqual(poller.investigations(), []);
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
});
