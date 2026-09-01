import test from 'node:test';
import assert from 'node:assert/strict';

import { createPosthogPoller } from '../server/posthog-poller.ts';
import type { PosthogPollerDependencies } from '../server/posthog-poller.ts';
import type { PosthogApi } from '../server/posthog-api.ts';

type Poller = ReturnType<typeof createPosthogPoller>;
type JobResult = Awaited<ReturnType<PosthogPollerDependencies['spawnInvestigation']>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function apiOk(body: unknown) {
  return { ok: true as const, status: 200, body };
}

function heldTimer(): NodeJS.Timeout {
  const handle = setTimeout(() => {}, 2 ** 30);
  handle.unref();
  return handle;
}

interface StateEntry {
  status?: string;
  verdict?: string | null;
  inFlight?: boolean;
  summaryLine?: string;
  vanishedAt?: number;
  recurrenceOf?: string | null;
  fix?: Record<string, unknown>;
}

interface TickProject {
  projectId: string | number;
  name?: string;
  host?: string;
  lastTickAt?: number;
  error?: string;
  issues?: Record<string, unknown>[];
}

interface TickSummary {
  type: string;
  ts: number;
  intervalMinutes: number;
  projects: TickProject[];
}

function lastTick(summaries: Record<string, unknown>[]): TickSummary {
  const summary = summaries.at(-1);
  if (!summary) throw new Error('no tick summary was reported');
  const { type, ts, intervalMinutes, projects } = summary;
  if (typeof type !== 'string' || typeof ts !== 'number' || typeof intervalMinutes !== 'number' || !Array.isArray(projects)) {
    throw new Error('the tick summary is not the control-plane shape');
  }
  return { type, ts, intervalMinutes, projects };
}

function broadcastInvestigations(summaries: Record<string, unknown>[]): Record<string, unknown>[] {
  const summary = summaries.at(-1);
  if (!summary || !Array.isArray(summary.investigations)) throw new Error('the tick summary carries no investigations');
  return summary.investigations;
}

function tickProject(summaries: Record<string, unknown>[], index = 0): TickProject {
  const project = lastTick(summaries).projects[index];
  if (!project) throw new Error(`no project at ${index} in the tick summary`);
  return project;
}

type SpawnArgs = Parameters<PosthogPollerDependencies['spawnInvestigation']>[0];

function spawnAt(calls: SpawnArgs[], index: number): SpawnArgs {
  const args = calls[index];
  if (!args) throw new Error(`no investigation spawn at ${index}`);
  return args;
}

function tickIssue(summaries: Record<string, unknown>[], index = 0): Record<string, unknown> {
  const issue = tickProject(summaries).issues?.[index];
  if (!issue) throw new Error(`no issue at ${index} in the tick summary`);
  return issue;
}

function lastTickAt(poller: Poller, projectId: string | number): unknown {
  return tickStamps(poller._state())[String(projectId)];
}

function tickStamps(stateValue: Record<string, unknown>): Record<string, unknown> {
  const meta = stateValue._meta;
  if (!isRecord(meta)) throw new Error('the state carries no _meta block');
  const stamps = meta.lastTickAt;
  if (!isRecord(stamps)) throw new Error('_meta carries no lastTickAt map');
  return stamps;
}

function investigationAt(stateValue: Record<string, unknown>, index: number): Record<string, unknown> {
  const record = investigationLog(stateValue)[index];
  if (!isRecord(record)) throw new Error(`no investigation record at ${index}`);
  return record;
}

function fixOf(poller: Poller, key: string): Record<string, unknown> {
  const { fix } = entryOf(poller, key);
  if (!fix) throw new Error(`no fix block on ${key}`);
  return fix;
}

function lastPing(pings: string[]): string {
  const ping = pings.at(-1);
  if (ping === undefined) throw new Error('no ping was sent');
  return ping;
}

function trafficBlock(stateValue: Record<string, unknown>): Record<string, unknown> {
  const traffic = stateValue._traffic;
  if (!isRecord(traffic)) throw new Error('the state carries no _traffic block');
  return traffic;
}

function reservedBlock(stateValue: Record<string, unknown>, name: string): Record<string, unknown> {
  const block = stateValue[name];
  if (!isRecord(block)) throw new Error(`the state carries no ${name} block`);
  return block;
}

function trafficProject(stateValue: Record<string, unknown>, projectId: string): Record<string, unknown> {
  const entry = trafficBlock(stateValue)[projectId];
  if (!isRecord(entry)) throw new Error(`no traffic ledger for project ${projectId}`);
  return entry;
}

function investigationLog(stateValue: Record<string, unknown>): Record<string, unknown>[] {
  const records = stateValue._investigations;
  if (!Array.isArray(records)) throw new Error('the state carries no _investigations ring');
  return records;
}

function signatureBlock(stateValue: Record<string, unknown>, key: string): Record<string, unknown> {
  const signatures = stateValue._signatures;
  if (!isRecord(signatures)) throw new Error('the _signatures block is not a map');
  const entry = signatures[key];
  if (!isRecord(entry)) throw new Error(`no signature for ${key}`);
  return entry;
}

function entryOf(poller: Poller, key: string): StateEntry {
  const entry = poller._state()[key];
  if (!isRecord(entry)) throw new Error(`no state entry for ${key}`);
  return entry;
}

const HOST = 'https://ph.test';
const KEY = 'ph.test/1#iss-1';

const flush = async (n = 20) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function issueRow(over: Record<string, unknown> = {}) {
  return {
    id: 'iss-1',
    name: 'TypeError: boom',
    status: 'active',
    aggregations: { occurrences: 120, users: 8 },
    ...over,
  };
}

function makeApi(over: Partial<PosthogApi> = {}): PosthogApi {
  return {
    host: HOST,
    queryTrafficBuckets: async () => apiOk({}),
    updateIssueStatus: async () => apiOk({}),
    queryIssues: async () => (apiOk({ results: [issueRow()] })),
    listSpikeEvents: async () => (apiOk({ results: [] })),
    listOrganizations: async () => (apiOk({ results: [] })),
    listProjects: async () => (apiOk({ results: [] })),
    listRecommendations: async () => (apiOk({ results: [] })),
    ...over,
  };
}

type HarnessOverrides = Omit<Partial<PosthogPollerDependencies>, 'api'> & {
  initialState?: Record<string, unknown>;
  api?: Partial<PosthogApi>;
};

function harness(over: HarnessOverrides = {}) {
  const pings: string[] = [];
  const summaries: Record<string, unknown>[] = [];
  const stateStore: { value: Record<string, unknown> } = {
    value: over.initialState ? JSON.parse(JSON.stringify(over.initialState)) : {},
  };
  const deps: PosthogPollerDependencies = {
    api: makeApi(over.api),
    host: HOST,
    resolveProjects: over.resolveProjects || (async () => [{ projectId: 1, name: 'web' }]),
    spawnInvestigation: over.spawnInvestigation || (async () => ({ verdict: 'ROOT_CAUSE' })),
    telegram: (message) => { pings.push(message); },
    readState: async () => stateStore.value,
    writeState: async (next) => { stateStore.value = JSON.parse(JSON.stringify(next)); },
    setIntervalFn: over.setIntervalFn || (() => heldTimer()),
    clearIntervalFn: over.clearIntervalFn || (() => {}),
    setTimeoutFn: over.setTimeoutFn || (() => heldTimer()),
    clearTimeoutFn: () => {},
    log: { warn() {} },
    onTickComplete: (status) => { summaries.push(status); },
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
  const armed: { cb: (() => void) | null } = { cb: null };
  let cleared = false;
  const spawnCalls: Parameters<PosthogPollerDependencies['spawnInvestigation']>[0][] = [];
  const { poller, pings } = harness({
    spawnInvestigation: async (args) => { spawnCalls.push(args); return { verdict: 'ROOT_CAUSE' }; },
    setIntervalFn: (fn) => { armed.cb = fn; return heldTimer(); },
    clearIntervalFn: () => { cleared = true; },
  });
  await poller.start();
  await flush();

  assert.equal(spawnCalls.length, 1, 'investigated the one new issue');
  assert.equal(spawnCalls[0].issue.issueId, 'iss-1');
  assert.equal(spawnCalls[0].url, 'https://ph.test/project/1/error_tracking/iss-1');
  assert.equal(entryOf(poller, KEY).verdict, 'ROOT_CAUSE');
  assert.equal(entryOf(poller, KEY).inFlight, false);
  assert.equal(pings.length, 1, 'a ROOT_CAUSE verdict is digest-only, so only the new-issue ping fires');
  assert.match(pings[0], /^\[glissa\/posthog\] NEW ISSUE web$/m);
  assert.equal(typeof armed.cb, 'function', 'interval armed');

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
  listSpikeEvents: async () => (apiOk({ results: [{ issue_id: 'iss-1', timestamp: '2099-01-01T00:00:00Z' }] })),
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
      queryIssues: async () => (apiOk({ results: [issueRow({ aggregations: { occurrences: 900, users: 60 } })] })),
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
  assert.equal(entryOf(poller, KEY).status, 'active', 'the entry is written back active, so it cannot re-ping');
});

test('a new issue pings NEW ISSUE once, not per tick', async () => {
  const { poller, pings } = harness({
    api: { queryIssues: async () => (apiOk({ results: [issueRow({ aggregations: { occurrences: 900, users: 60 } })] })) },
    spawnInvestigation: async () => ({ verdict: 'ROOT_CAUSE' }),
  });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();
  const newIssue = pings.filter((p) => /NEW ISSUE/.test(p));
  assert.equal(newIssue.length, 1, 'pingedPhases dedups the new-issue ping across ticks');
});

test('a new issue below the escalation threshold still pings NEW ISSUE', async () => {
  const { poller, pings } = harness({
    api: { queryIssues: async () => (apiOk({ results: [issueRow({ aggregations: { occurrences: 3, users: 1 } })] })) },
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
      listSpikeEvents: async () => {
        tickCount += 1;
        if (tickCount < 3) return apiOk({ results: [] });
        return apiOk({ results: [{ issue_id: 'iss-1', timestamp: '2099-01-01T00:00:00Z' }] });
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
      queryIssues: async () => apiOk({
        results: [issueRow({ id: 'iss-1' }), issueRow({ id: 'iss-2' }), issueRow({ id: 'iss-3' })],
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
  const investigation: { resolve: ((result: JobResult) => void) | null } = { resolve: null };
  let spawned = 0;
  const { poller } = harness({
    spawnInvestigation: () => {
      spawned += 1;
      return new Promise((resolve) => { investigation.resolve = resolve; });
    },
  });
  await poller.start();
  await flush();
  assert.equal(spawned, 1);
  assert.equal(entryOf(poller, KEY).inFlight, true);

  let stopSettled = false;
  const stopPromise = poller.stop().then(() => { stopSettled = true; });
  await flush();
  assert.equal(stopSettled, false, 'stop() waits for the in-flight investigation');

  const settle = investigation.resolve;
  assert.ok(settle, 'an investigation is in flight');
  settle({ verdict: 'ROOT_CAUSE' });
  await stopPromise;
  assert.equal(stopSettled, true);
  assert.equal(entryOf(poller, KEY).inFlight, false, 'the drained investigation finished normally');

  await poller.tick();
  await flush();
  assert.equal(spawned, 1, 'no new investigation spawns after stop');
});

test('a hung investigation is force-resolved to ERROR by the timeout and frees its slot', async () => {
  const { poller, pings } = harness({
    spawnInvestigation: () => new Promise(() => {}),
    setTimeoutFn: (fn) => { fn(); return heldTimer(); },
    maxConcurrentInvestigations: 1,
  });
  await poller.start();
  await flush();
  assert.equal(entryOf(poller, KEY).verdict, 'ERROR');
  assert.equal(entryOf(poller, KEY).inFlight, false, 'slot freed');
  assert.equal(pings.length, 2);
  assert.match(pings[0], /^\[glissa\/posthog\] NEW ISSUE web$/m);
  assert.match(pings[1], /^\[glissa\/posthog\] ERROR web$/m);
});

test('an issue that vanished from the active list is marked resolved, not deleted, with no ping', async () => {
  const { poller, pings } = harness({
    initialState: { [KEY]: { status: 'active', verdict: 'ROOT_CAUSE', pingedPhases: [] } },
    api: { queryIssues: async () => (apiOk({ results: [] })) },
  });
  await poller.start();
  await flush();
  assert.equal(entryOf(poller, KEY).status, 'resolved');
  assert.equal(entryOf(poller, KEY).verdict, 'ROOT_CAUSE', 'verdict history survives the disappearance');
  assert.equal(entryOf(poller, KEY).vanishedAt, 1000);
  assert.deepEqual(pings, []);
});

test('the full vanish-then-return cycle classifies the return as a regression', async () => {
  let present = true;
  const { poller, pings } = harness({
    initialState: { [KEY]: { status: 'active', verdict: 'ROOT_CAUSE', investigatedUsers: 8, pingedPhases: [] } },
    api: { queryIssues: async () => (apiOk({ results: present ? [issueRow()] : [] })) },
    spawnInvestigation: async () => ({ verdict: 'ROOT_CAUSE' }),
  });

  present = false;
  await poller.start();
  await flush();
  assert.equal(entryOf(poller, KEY).status, 'resolved');

  present = true;
  await poller.tick();
  await flush();
  assert.equal(pings.length, 1);
  assert.match(pings[0], /^\[glissa\/posthog\] REGRESSED web$/m);
  assert.equal(entryOf(poller, KEY).status, 'active', 'written back active, so it cannot re-ping');
  assert.equal(entryOf(poller, KEY).vanishedAt, undefined, 'the vanish stamp is cleared on return');
});

test('an in-flight investigation is never pruned by its issue falling off the list', async () => {
  let vanished = false;
  const { poller } = harness({
    api: { queryIssues: async () => (apiOk({ results: vanished ? [] : [issueRow()] })) },
    spawnInvestigation: () => new Promise(() => {}),
  });
  await poller.start();
  await flush();
  assert.equal(entryOf(poller, KEY).inFlight, true);

  vanished = true;
  await poller.tick();
  await flush();
  assert.equal(entryOf(poller, KEY).inFlight, true, 'the entry survived, so concurrency stays correct');
});

test('an entry gone longer than the retention window is finally pruned', async () => {
  const RETENTION_MS = 7 * 86400000;
  const { poller } = harness({
    initialState: { [KEY]: { status: 'resolved', verdict: 'ROOT_CAUSE', vanishedAt: 1, pingedPhases: [] } },
    api: { queryIssues: async () => (apiOk({ results: [] })) },
    now: () => 1 + RETENTION_MS,
  });
  await poller.start();
  await flush();
  assert.equal(poller._state()[KEY], undefined, 'aged out on the clock, not on one absent tick');
});

test('a failed issue query reports that project without killing the cycle', async () => {
  const seen: (string | number)[] = [];
  const { poller, summaries } = harness({
    resolveProjects: async () => [{ projectId: 1, name: 'web' }, { projectId: 2, name: 'api' }],
    api: {
      queryIssues: async (projectId) => {
        seen.push(projectId);
        if (projectId === 1) return { ok: false, error: 'HTTP 500' };
        return apiOk({ results: [issueRow()] });
      },
    },
  });
  await poller.start();
  await flush();
  assert.deepEqual(seen, [1, 2], 'the second project was still polled');
  const reported = lastTick(summaries).projects;
  assert.deepEqual(reported.map((project) => project.projectId), [1, 2]);
  assert.equal(tickProject(summaries, 0).error, 'HTTP 500', 'the failure is reported, not hidden by omission');
  assert.equal(tickProject(summaries, 1).error, undefined);
});

test('onTickComplete emits the dashboard broadcast payload', async () => {
  const { poller, summaries } = harness({
    spawnInvestigation: async () => ({ verdict: 'NEEDS_HUMAN' }),
  });
  await poller.start();
  await flush();
  const summary = lastTick(summaries);
  assert.equal(summary.type, 'posthog-status');
  assert.equal(summary.ts, 1000);
  assert.equal(summary.intervalMinutes, 15, 'the dashboard needs the interval to judge staleness');
  assert.equal(summary.projects.length, 1);
  const project = tickProject(summaries);
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
  const project = tickProject(summaries);
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
  const issue = tickIssue(summaries);
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
  const issue = tickIssue(summaries);
  assert.deepEqual(issue.history, [{ ts: 500, occurrences: 100 }, { ts: 1000, occurrences: 120 }]);
});

test('the spike cutoff is the tick START time, so a mid-tick spike is still seen next tick', async () => {
  let clock = 1000;
  const { poller } = harness({
    api: {
      queryIssues: async () => { clock += 5000; return apiOk({ results: [issueRow()] }); },
      listSpikeEvents: async () => (apiOk({ results: [] })),
    },
    now: () => clock,
  });
  await poller.start();
  await flush();
  assert.equal(lastTickAt(poller, 1), 1000, 'stamped before the query advanced the clock');
});

test('re-entrancy guard: an overlapping tick returns early', async () => {
  let queryCalls = 0;
  const gateRelease: { resolve: (() => void) | null } = { resolve: null };
  const gate = new Promise<void>((resolve) => { gateRelease.resolve = resolve; });
  const { poller } = harness({
    api: { queryIssues: async () => { queryCalls += 1; await gate; return apiOk({ results: [] }); } },
  });
  const first = poller.tick();
  const second = poller.tick();
  await second;
  await flush();
  assert.equal(queryCalls, 1, 'second tick short-circuited while the first was running');
  const releaseGate = gateRelease.resolve;
  assert.ok(releaseGate, 'the gate is parked');
  releaseGate();
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


const MAJOR = { autoFix: true, userEscalationThreshold: 5 };

function fixResult(over: Record<string, unknown> = {}): JobResult {
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
  const calls: SpawnArgs[] = [];
  const { poller } = harness({
    ...MAJOR,
    fixTimeoutSeconds: 1800,
    spawnInvestigation: async (args) => { calls.push(args); return fixResult(); },
  });
  await poller.start();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(spawnAt(calls, 0).mode, 'fix');
  assert.equal(spawnAt(calls, 0).timeoutMs, 1800000, 'a fix gets its own ceiling, not the investigation one');
});

test('autoFix off keeps every dispatch an investigation on the investigation timeout', async () => {
  const calls: SpawnArgs[] = [];
  const { poller } = harness({
    userEscalationThreshold: 5,
    spawnInvestigation: async (args) => { calls.push(args); return { verdict: 'ROOT_CAUSE' }; },
  });
  await poller.start();
  await flush();
  assert.equal(spawnAt(calls, 0).mode, 'investigate');
  assert.equal(spawnAt(calls, 0).timeoutMs, 900000);
});

test('autoFix dispatches a fix for a new issue under the escalation threshold', async () => {
  const calls: SpawnArgs[] = [];
  const { poller } = harness({
    autoFix: true,
    spawnInvestigation: async (args) => { calls.push(args); return { verdict: 'ROOT_CAUSE' }; },
  });
  await poller.start();
  await flush();
  assert.equal(spawnAt(calls, 0).mode, 'fix', 'blast radius gates the ping, not the fix');
});

test('a fix job takes a shared concurrency slot, never a second pool', async () => {
  let spawned = 0;
  const { poller } = harness({
    ...MAJOR,
    api: {
      queryIssues: async () => apiOk({ results: [issueRow({ id: 'iss-1' }), issueRow({ id: 'iss-2' })] }),
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
  const entry = entryOf(poller, KEY);
  assert.equal(entry.verdict, 'FIXED');
  assert.equal(entry.inFlight, false);
  assert.deepEqual(entry.fix, {
    at: 4200,
    verdict: 'FIXED',
    reproduced: true,
    prUrl: 'https://github.com/o/r/pull/7',
  });
  const record = investigationAt(stateStore.value, 0);
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

test('a fixed issue that keeps spiking with growing users is not redispatched every tick', async () => {
  let users = 8;
  let spawned = 0;
  const { poller } = harness({
    ...MAJOR,
    api: {
      ...SPIKING_API,
      queryIssues: async () => apiOk({ results: [issueRow({ aggregations: { occurrences: 120, users } })] }),
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

test('an issue that regresses after a fix is fixed again, and pings again', async () => {
  let present = true;
  let spawned = 0;
  const { poller, pings } = harness({
    ...MAJOR,
    api: { queryIssues: async () => (apiOk({ results: present ? [issueRow()] : [] })) },
    spawnInvestigation: async () => { spawned += 1; return fixResult(); },
  });
  await poller.start();
  await flush();
  present = false;
  await poller.tick();
  await flush();
  assert.equal(entryOf(poller, KEY).status, 'resolved', 'absence is assumed resolution');
  present = true;
  await poller.tick();
  await flush();
  assert.equal(spawned, 2, 'a genuine regression earns a second fix');
  assert.equal(pings.filter((p) => p.includes('FIXED')).length, 2);
});

test('stop() waits for a timed-out fix job to finish discarding its worktree', async () => {
  const order: string[] = [];
  const gitWorkspace = {
    create: async () => { order.push('create'); return { cwd: '/wt', isGit: true, branch: 'b' }; },
    discard: async (_input: { workspace: { cwd: string } }) => {
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      order.push('discard');
    },
  };
  const { poller } = harness({
    ...MAJOR,
    setTimeoutFn: (fn) => { fn(); return heldTimer(); },
    spawnInvestigation: async ({ signal }) => {
      const workspace = await gitWorkspace.create();
      try {
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) { resolve(); return; }
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
  assert.match(lastPing(pings), /^\[glissa\/posthog\] NEEDS HUMAN web$/m);
  assert.doesNotMatch(lastPing(pings), /PR:/);
  assert.equal(investigationAt(stateStore.value, 0).prUrl, null);
  assert.equal(fixOf(poller, KEY).verdict, 'NEEDS_HUMAN');
});

test('a hung fix is force-resolved to ERROR, freeing its slot and naming the mode', async () => {
  const { poller, pings } = harness({
    ...MAJOR,
    spawnInvestigation: () => new Promise(() => {}),
    setTimeoutFn: (fn) => { fn(); return heldTimer(); },
    maxConcurrentInvestigations: 1,
  });
  await poller.start();
  await flush();
  assert.equal(entryOf(poller, KEY).verdict, 'ERROR');
  assert.equal(entryOf(poller, KEY).inFlight, false, 'slot freed');
  assert.equal(fixOf(poller, KEY).verdict, 'ERROR', 'the failed attempt is still recorded');
  assert.match(lastPing(pings), /^\[glissa\/posthog\] ERROR web$/m);
});

test('a fix the wiring downgraded is recorded as the investigation it actually was', async () => {
  const { poller, stateStore } = harness({
    ...MAJOR,
    spawnInvestigation: async () => ({ verdict: 'ROOT_CAUSE', summary: 'no repo to fix in', mode: 'investigate' }),
  });
  await poller.start();
  await flush();
  assert.equal(entryOf(poller, KEY).fix, null, 'nothing was fixed, so nothing claims to have been');
  assert.equal(investigationAt(stateStore.value, 0).mode, 'investigate');
});


test('a completed investigation appends one record to the persisted log', async () => {
  const { poller, stateStore, summaries } = harness({
    spawnInvestigation: async () => ({ verdict: 'TRANSIENT', summary: 'one-off dependency blip' }),
    now: () => 4200,
  });
  await poller.start();
  await flush();

  const log = investigationLog(stateStore.value);
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
  assert.deepEqual(broadcastInvestigations(summaries).map((row) => row.id), ['iss-1@4200'], 'and rides the broadcast');
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
  assert.equal(investigationAt(stateStore.value, 0).archived, true, 'persisted');

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
  assert.equal(investigationAt(stateStore.value, 0).archivedAt, 777000);
});

test('the 7-day purge runs on state load and on the tick persist, and spares unarchived records', async () => {
  const day = 86400000;
  const bootAt = 100 * day;
  const record = (id: string, over: Record<string, unknown> = {}) => ({
    id, key: KEY, projectId: 1, projectName: 'web', host: HOST, issueId: 'iss-1',
    title: 'boom', url: '', verdict: 'ROOT_CAUSE', summaryLine: null, at: 1, archived: false, ...over,
  });
  const { poller, stateStore } = harness({
    initialState: {
      _investigations: [
        record('stale@1', { archived: true, archivedAt: bootAt - (8 * day) }),
        record('recent@2', { archived: true, archivedAt: bootAt - day }),
        record('legacy@3', { archived: true, at: bootAt - (9 * day) }),
        record('live@4', { at: 1 }),
      ],
    },
    now: () => bootAt,
  });
  await poller.start();
  await flush();

  const ids = investigationLog(stateStore.value).map((r) => r.id);
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
  assert.equal(investigationLog(stateStore.value).length, 1, 'still inside the window at boot');

  clock = 1000 + (8 * day);
  await poller.tick();
  await flush();
  assert.deepEqual(investigationLog(stateStore.value), [], 'the tick persisted the purge with no other change');
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
      [KEY]: {
        status: 'resolved', lastOccurrences: 120, lastUsers: 8, verdict: null, pingedPhases: [],
      },
    },
    spawnInvestigation: async () => ({ verdict: 'ERROR', summary: 'no result file' }),
    now: () => 5000,
  });
  await poller.start();
  await flush();

  assert.equal(investigationLog(stateStore.value).length, 1);
  assert.equal(entryOf(poller, KEY).verdict, 'ERROR', 'the per-issue entry is untouched by the log');
});

test('the investigations log is never treated as an issue entry', async () => {
  const { poller } = harness({
    spawnInvestigation: async () => ({ verdict: 'ROOT_CAUSE', summary: 'fixed upstream' }),
    now: () => 1000,
  });
  await poller.start();
  await flush();
  tickStamps(poller._state())[1] = 0;
  const { poller: gone, stateStore: goneStore } = harness({
    initialState: poller._state(),
    api: { queryIssues: async () => (apiOk({ results: [] })) },
    now: () => 9000,
  });
  await gone.start();
  await flush();
  assert.ok(Array.isArray(goneStore.value._investigations), 'still a plain array');
  assert.equal(goneStore.value._investigations.length, 1, 'the record outlives its issue');
  assert.equal(goneStore.value._investigations[0].archived, false);
});


const CHUNK_A = 'TypeError: Failed to fetch dynamically imported module: https://shop.example.com/assets/maplibre-gl-B3nQ.js';
const CHUNK_B = 'TypeError: Failed to fetch dynamically imported module: https://shop.example.com/assets/maplibre-gl-Zk91.js';
const CHUNK_SUMMARY = 'A crawler failed to lazy-load the map chunk; no code defect.';

function chunkRow(id: string, name: string, users = 1) {
  return issueRow({ id, name, aggregations: { occurrences: 4, users } });
}

function seedCluster(over: Record<string, unknown> = {}) {
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
  const spawned: string[] = [];
  const { poller, stateStore, pings } = harness({
    api: { queryIssues: async () => (apiOk({ results: issues })) },
    spawnInvestigation: async (args) => {
      spawned.push(String(args.issue.issueId));
      return { verdict: 'TRANSIENT', summary: CHUNK_SUMMARY };
    },
    now: () => 1000,
  });
  await poller.start();
  await flush();
  assert.deepEqual(spawned, ['iss-1'], 'the first sighting is investigated normally');
  assert.equal(signatureBlock(stateStore.value, 'ph.test/1#iss-1').recurrences, 0, 'the transient opened a cluster');

  issues = [chunkRow('iss-2', CHUNK_B)];
  await poller.tick();
  await flush();

  const key = 'ph.test/1#iss-2';
  assert.deepEqual(spawned, ['iss-1'], 'the twin issue never spawned a session');
  assert.equal(entryOf(poller, key).verdict, 'TRANSIENT');
  assert.match(String(entryOf(poller, key).summaryLine), /matches prior transient issue iss-1/);
  assert.equal(entryOf(poller, key).recurrenceOf, 'ph.test/1#iss-1');
  assert.equal(signatureBlock(stateStore.value, 'ph.test/1#iss-1').recurrences, 1, 'the counter lives on the prior');
  assert.deepEqual(signatureBlock(stateStore.value, 'ph.test/1#iss-1').recurredIssueIds, ['iss-2']);
  assert.equal(investigationLog(stateStore.value).length, 2, 'the deduped verdict still reaches the inbox');
  assert.equal(investigationAt(stateStore.value, 1).verdict, 'TRANSIENT');
  assert.deepEqual(pings.filter((ping) => /RECURRING/.test(ping)), [], 'a first repeat is not worth a phone buzz');
});

test('a deduped issue is quiet on the next tick: the verdict is its own now', async () => {
  let spawned = 0;
  const { poller } = harness({
    initialState: seedCluster(),
    api: { queryIssues: async () => (apiOk({ results: [chunkRow('iss-2', CHUNK_B)] })) },
    spawnInvestigation: async () => { spawned += 1; return { verdict: 'TRANSIENT', summary: CHUNK_SUMMARY }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();
  assert.equal(spawned, 0, 'no session, on either tick');
  assert.equal(signatureBlock(poller._state(), 'ph.test/1#iss-1').recurrences, 1, 'counted exactly once');
});

test('the configured repeat escalates: a real investigation runs and the phone hears about it', async () => {
  const spawned: string[] = [];
  const { poller, pings } = harness({
    initialState: seedCluster({ recurrences: 2 }),
    api: { queryIssues: async () => (apiOk({ results: [chunkRow('iss-4', CHUNK_B)] })) },
    spawnInvestigation: async (args) => { spawned.push(String(args.issue.issueId)); return { verdict: 'ROOT_CAUSE', summary: 'real defect' }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();

  assert.deepEqual(spawned, ['iss-4'], 'the third repeat is paid for');
  const recurring = pings.filter((ping) => /RECURRING/.test(ping));
  assert.equal(recurring.length, 1);
  assert.match(String(recurring[0]), /^\[glissa\/posthog\] RECURRING web$/m);
  assert.match(String(recurring[0]), /recurring transient escalated: repeat 3 within 7 days of issue iss-1/);
  const cluster = signatureBlock(poller._state(), 'ph.test/1#iss-1');
  assert.equal(cluster.escalated, true, 'the cluster stops being reusable');
  assert.equal(cluster.recurrences, 3);
  assert.equal(entryOf(poller, 'ph.test/1#iss-4').verdict, 'ROOT_CAUSE');
});

test('an escalated cluster never dedupes again and never re-pings', async () => {
  const spawned: string[] = [];
  const { poller, pings } = harness({
    initialState: seedCluster({ recurrences: 3, escalated: true }),
    api: { queryIssues: async () => (apiOk({ results: [chunkRow('iss-5', CHUNK_B)] })) },
    spawnInvestigation: async (args) => { spawned.push(String(args.issue.issueId)); return { verdict: 'TRANSIENT', summary: CHUNK_SUMMARY }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();
  assert.deepEqual(spawned, ['iss-5']);
  assert.deepEqual(pings.filter((ping) => /RECURRING/.test(ping)), [], 'the escalation ping already fired for this cluster');
});

test('two same-cluster escalations planned in one tick fire one ping, not two', async () => {
  const spawned: string[] = [];
  const { poller, pings } = harness({
    initialState: seedCluster({ recurrences: 2 }),
    api: {
      queryIssues: async () => apiOk({ results: [chunkRow('iss-6', CHUNK_B), chunkRow('iss-7', CHUNK_A)] }),
    },
    spawnInvestigation: async (args) => { spawned.push(String(args.issue.issueId)); return { verdict: 'ROOT_CAUSE', summary: 'real defect' }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();
  assert.deepEqual(spawned.sort(), ['iss-6', 'iss-7'], 'both escalated twins are investigated');
  assert.equal(pings.filter((ping) => /RECURRING/.test(ping)).length, 1, 'the cluster escalates once');
});

test('a repeat affecting more than one user escalates on its first sighting', async () => {
  const spawned: string[] = [];
  const { poller, pings } = harness({
    initialState: seedCluster(),
    api: { queryIssues: async () => (apiOk({ results: [chunkRow('iss-3', CHUNK_B, 4)] })) },
    spawnInvestigation: async (args) => { spawned.push(String(args.issue.issueId)); return { verdict: 'NEEDS_HUMAN', summary: 'wider than a crawler' }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();

  assert.deepEqual(spawned, ['iss-3'], 'a blast radius past one carbon unit is not a transient');
  const escalation = pings.find((ping) => /RECURRING web/.test(ping));
  assert.match(String(escalation), /now affecting more than one user/);
  assert.equal(signatureBlock(poller._state(), 'ph.test/1#iss-1').escalated, true);
});

test('a spiking repeat escalates rather than reusing the old verdict', async () => {
  const spawned: string[] = [];
  const { poller, pings } = harness({
    initialState: seedCluster(),
    api: {
      queryIssues: async () => (apiOk({ results: [chunkRow('iss-6', CHUNK_B)] })),
      listSpikeEvents: async () => (apiOk({ results: [{ issue_id: 'iss-6', timestamp: '2099-01-01T00:00:00Z' }] })),
    },
    spawnInvestigation: async (args) => { spawned.push(String(args.issue.issueId)); return { verdict: 'ROOT_CAUSE', summary: 'real defect' }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();

  assert.deepEqual(spawned, ['iss-6']);
  assert.ok(pings.some((p) => /RECURRING web/.test(p) && /spiking/.test(p)), 'the escalation names the spike');
});

test('an unrelated error is never deduped into an existing cluster', async () => {
  const spawned: string[] = [];
  const { poller } = harness({
    initialState: seedCluster(),
    api: {
      queryIssues: async () => apiOk({ results: [chunkRow('iss-7', 'RangeError: invoice pagination cursor out of bounds')] }),
    },
    spawnInvestigation: async (args) => { spawned.push(String(args.issue.issueId)); return { verdict: 'ROOT_CAUSE', summary: 'off by one' }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();
  assert.deepEqual(spawned, ['iss-7']);
});

test('the recurrenceDedupe kill switch restores the prior behavior exactly', async () => {
  const spawned: string[] = [];
  const { poller, stateStore, pings } = harness({
    recurrenceDedupe: false,
    initialState: seedCluster(),
    api: { queryIssues: async () => (apiOk({ results: [chunkRow('iss-2', CHUNK_B)] })) },
    spawnInvestigation: async (args) => { spawned.push(String(args.issue.issueId)); return { verdict: 'TRANSIENT', summary: CHUNK_SUMMARY }; },
    now: () => 2000,
  });
  await poller.start();
  await flush();

  assert.deepEqual(spawned, ['iss-2'], 'every issue is investigated, as before');
  assert.deepEqual(pings.filter((ping) => /RECURRING/.test(ping)), []);
  assert.equal(signatureBlock(stateStore.value, 'ph.test/1#iss-1').recurrences, 0, 'no cluster bookkeeping happens');
  assert.equal(reservedBlock(stateStore.value, '_signatures')['ph.test/1#iss-2'], undefined, 'and the transient verdict opens none');
});

test('a state file written before recurrence memory existed loads and behaves as before', async () => {
  const spawned: string[] = [];
  const { poller, stateStore } = harness({
    initialState: {
      'ph.test/1#iss-1': {
        status: 'resolved', lastOccurrences: 4, lastUsers: 1, verdict: 'TRANSIENT', summaryLine: CHUNK_SUMMARY, pingedPhases: [],
      },
    },
    api: { queryIssues: async () => (apiOk({ results: [chunkRow('iss-1', CHUNK_A), chunkRow('iss-2', CHUNK_B)] })) },
    spawnInvestigation: async (args) => { spawned.push(String(args.issue.issueId)); return { verdict: 'ROOT_CAUSE', summary: 'real defect' }; },
    now: () => 1000,
  });
  await poller.start();
  await flush();
  assert.deepEqual(spawned.sort(), ['iss-1', 'iss-2'], 'an old verdict with no cluster dedupes nothing');
  assert.equal(stateStore.value._signatures, undefined, 'a non-transient verdict writes no registry');
});

test('a cluster past the recurrence window is pruned and stops deduping', async () => {
  const day = 86400000;
  const spawned: string[] = [];
  const { poller, stateStore } = harness({
    initialState: seedCluster({ lastAt: 1000 }),
    api: { queryIssues: async () => (apiOk({ results: [chunkRow('iss-8', CHUNK_B)] })) },
    spawnInvestigation: async (args) => { spawned.push(String(args.issue.issueId)); return { verdict: 'ROOT_CAUSE', summary: 'real defect' }; },
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
    api: { queryIssues: async () => (apiOk({ results: [] })) },
    now: () => 2000,
  });
  await poller.start();
  await flush();
  assert.ok(signatureBlock(poller._state(), 'ph.test/1#iss-1'), 'reconcileVanished skipped the underscore key');
});


const HOUR_MS = 3600000;

function trafficBody(currentUsers: number, baselineUsers = 10, hours = 48) {
  return {
    ok: true as const,
    buckets: Array.from({ length: hours }, (_, i) => ({ bucket: `h${i}`, users: baselineUsers })),
    currentUsers,
  };
}

type TrafficReply = Awaited<ReturnType<PosthogApi['queryTrafficBuckets']>>;

function trafficHarness(bodies: (TrafficReply | (() => TrafficReply))[], over: HarnessOverrides = {}) {
  const trafficCalls: { projectId: unknown; opts: unknown }[] = [];
  const built = harness({
    ...over,
    api: {
      queryIssues: async () => (apiOk({ results: [] })),
      queryTrafficBuckets: async (projectId, opts) => {
        trafficCalls.push({ projectId, opts });
        const body = bodies[Math.min(trafficCalls.length - 1, bodies.length - 1)];
        if (!body) throw new Error('the traffic harness ran out of replies');
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
  assert.deepEqual(trafficBlock(stateStore.value)['1'], {
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
  assert.equal(trafficProject(poller._state(), '1').peakUsers, 90);
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
  assert.equal(trafficProject(poller._state(), '1').lastPingedUsers, 200);
});

test('traffic falling back to normal clears the state without a ping', async () => {
  const { poller, pings } = trafficHarness([trafficBody(87), trafficBody(11)], { now: () => HOUR_MS });
  await poller.start();
  await flush();
  await poller.tick();
  await flush();

  assert.equal(pings.length, 1, 'spike over is not news');
  assert.equal(trafficProject(poller._state(), '1').active, false);
});

test('a baseline shorter than a day never pings', async () => {
  const { poller, pings } = trafficHarness([trafficBody(500, 2, 12)], { now: () => HOUR_MS });
  await poller.start();
  await flush();
  assert.deepEqual(pings, []);
});

test('a traffic query that throws leaves issue triage untouched and never pings', async () => {
  const spawned: string[] = [];
  const { poller, pings } = trafficHarness([() => { throw new Error('no query scope'); }], {
    api: { queryIssues: async () => (apiOk({ results: [issueRow()] })) },
    spawnInvestigation: async (args) => { spawned.push(String(args.issue.issueId)); return { verdict: 'ROOT_CAUSE' }; },
  });
  await poller.start();
  await flush();

  assert.deepEqual(spawned, ['iss-1'], 'the issue lane ran to completion');
  assert.equal(entryOf(poller, KEY).verdict, 'ROOT_CAUSE');
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
  assert.ok(trafficBlock(poller._state())['1'], 'reconcileVanished skipped the underscore key');
});

test('the configured baseline window reaches the query', async () => {
  const { poller, trafficCalls } = trafficHarness([trafficBody(1)], { trafficSpikeBaselineDays: 14 });
  await poller.start();
  await flush();
  const opts = trafficCalls[0]?.opts;
  assert.ok(isRecord(opts), 'the traffic query carried options');
  assert.equal(opts.baselineDays, 14);
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
  const { poller, pings } = harness({ api: { queryIssues: async () => (apiOk({ results: [] })) } });
  await poller.start();
  await flush();
  assert.deepEqual(pings, []);
});
