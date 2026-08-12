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
  assert.deepEqual(pings, [], 'a ROOT_CAUSE verdict is digest-only, never a ping');
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

test('a new issue already over the escalation threshold pings HIGH IMPACT once, not per tick', async () => {
  const { poller, pings } = harness({
    api: { queryIssues: async () => ({ ok: true, body: { results: [issueRow({ aggregations: { occurrences: 900, users: 60 } })] } }) },
    spawnInvestigation: async () => ({ verdict: 'ROOT_CAUSE' }),
  });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();
  const highImpact = pings.filter((p) => /HIGH IMPACT/.test(p));
  assert.equal(highImpact.length, 1, 'pingedPhases dedups the high-impact ping across ticks');
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
  assert.equal(pings.length, 1);
  assert.match(pings[0], /^\[glissa\/posthog\] ERROR web$/m);
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

test('a failed issue query skips the project without killing the cycle', async () => {
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
  assert.deepEqual(summaries.at(-1).projects.map((p) => p.projectId), [2]);
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

// --- investigateNow: the operator's manual re-investigation (Radar row action) ---

test('investigateNow re-runs an already diagnosed issue the tick would have left alone', async () => {
  const spawnCalls = [];
  const { poller } = harness({
    spawnInvestigation: async (a) => { spawnCalls.push(a); return { verdict: 'ROOT_CAUSE', summary: 'again' }; },
  });
  await poller.start();
  await flush();
  assert.equal(spawnCalls.length, 1, 'the first tick investigated it once');

  await poller.tick();
  await flush();
  assert.equal(spawnCalls.length, 1, 'a quiet, already diagnosed issue is not re-investigated by a tick');

  const res = poller.investigateNow({ projectId: 1, issueId: 'iss-1' });
  assert.deepEqual(res, { ok: true });
  await flush();

  assert.equal(spawnCalls.length, 2, 'the manual request spawned a fresh investigation');
  assert.equal(spawnCalls[1].issue.issueId, 'iss-1');
  assert.equal(spawnCalls[1].url, 'https://ph.test/project/1/error_tracking/iss-1');
  assert.equal(poller._state()[KEY].inFlight, false, 'in-flight cleared when it finished');
});

test('investigateNow refuses a second run while one is in flight', async () => {
  let release = null;
  const { poller } = harness({
    spawnInvestigation: () => new Promise((resolve) => { release = () => resolve({ verdict: 'ROOT_CAUSE' }); }),
  });
  await poller.start();
  await flush();
  assert.equal(poller._state()[KEY].inFlight, true, 'the boot investigation is still running');

  const res = poller.investigateNow({ projectId: 1, issueId: 'iss-1' });
  assert.equal(res.ok, false);
  assert.match(res.error, /already running/);

  release();
  await flush();
});

test('investigateNow refuses an issue the latest poll never saw', async () => {
  const { poller } = harness();
  await poller.start();
  await flush();

  const res = poller.investigateNow({ projectId: 1, issueId: 'iss-unknown' });
  assert.equal(res.ok, false);
  assert.match(res.error, /latest poll/);
});

test('investigateNow honours the concurrency cap instead of over-spending slots', async () => {
  const releases = [];
  const { poller } = harness({
    maxConcurrentInvestigations: 1,
    spawnInvestigation: () => new Promise((resolve) => releases.push(() => resolve({ verdict: 'ROOT_CAUSE' }))),
    api: { queryIssues: async () => ({ ok: true, body: { results: [issueRow(), issueRow({ id: 'iss-2' })] } }) },
  });
  await poller.start();
  await flush();
  assert.equal(releases.length, 1, 'the cap allowed one investigation');

  const res = poller.investigateNow({ projectId: 1, issueId: 'iss-2' });
  assert.equal(res.ok, false);
  assert.match(res.error, /slots are busy/);

  for (const release of releases) release();
  await flush();
});

test('investigateNow refuses once the poller is stopping', async () => {
  const { poller } = harness();
  await poller.start();
  await flush();
  await poller.stop();

  const res = poller.investigateNow({ projectId: 1, issueId: 'iss-1' });
  assert.equal(res.ok, false);
});
