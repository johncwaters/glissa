import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { tokensFromUsage } from '../server/backend-lanes.ts';
import { createMillMetricsStore } from '../server/mill-metrics-store.ts';
import { createMillMetricsLane, createMillMetricsWiring } from '../server/mill-metrics-wiring.ts';
import type { MillMetricsStoreInstance } from '../server/mill-metrics-store.ts';
import { MAX_PACK_FILES_PER_SESSION } from '../shared/contracts/mill-metrics.ts';
import type { MillMetricSession } from '../shared/contracts/mill-metrics.ts';

interface StoredEvent {
  kind: string;
  sessionId: string;
  pack?: string;
  relPath?: string;
  promptClass?: string;
  disposition?: string | null;
  finalState?: string;
  transition?: string;
  version?: string;
  tokenEstimate?: number | null;
  agent?: string;
  readDetection?: string;
  ts?: number;
}

interface FakeStore extends MillMetricsStoreInstance {
  events: StoredEvent[];
  closed: MillMetricSession[];
  retainDays?: number;
}

interface VendorTotals {
  tokens: number | null;
  costUSD: number | null;
  identity?: string | null;
}

interface DeliveredPayload {
  packs: { name: string; version: string; dir: string; tokenEstimate?: number | null }[];
  agent: string;
  readDetection: 'available' | 'unavailable';
  ts: number;
}

const NOW = Date.parse('2026-08-30T12:00:00Z');
const PACK_DIR = path.resolve(path.parse(process.cwd()).root, 'mill-metrics-wiring', 'alpha');

function storedEventAt(store: FakeStore, index: number): StoredEvent {
  const event = store.events.at(index);
  assert.ok(event);
  return event;
}

function closedAt(store: FakeStore, index: number): MillMetricSession {
  const record = store.closed[index];
  assert.ok(record);
  return record;
}

function fakeStore(overrides: Partial<FakeStore> = {}): FakeStore {
  const events: StoredEvent[] = [];
  const closed: MillMetricSession[] = [];
  return {
    events,
    closed,
    appendEvent: (event: unknown) => { events.push(event as StoredEvent); },
    closeSession: (record: unknown) => { closed.push(record as MillMetricSession); },
    records: () => closed,
    load: async () => {},
    takeQueuedRecords: () => [],
    adoptQueuedRecords: () => {},
    whenIdle: async () => {},
    ...overrides,
  };
}

function delivered(overrides: Partial<DeliveredPayload> = {}): DeliveredPayload {
  return {
    packs: [{ name: 'alpha', version: 'v1', dir: PACK_DIR }],
    agent: 'claude-code',
    readDetection: 'available',
    ts: NOW,
    ...overrides,
  };
}

test('a delivered pack read is recorded once per relative file', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered());
  const payload = { tool_name: 'Read', tool_input: { file_path: path.join(PACK_DIR, 'rules.md') } };
  wiring.port.onHookEvent('s1', 'PostToolUse', payload);
  wiring.port.onHookEvent('s1', 'posttooluse', payload);
  assert.equal(store.events.filter((event) => event.kind === 'pack-read').length, 1);
  assert.equal(wiring.scorecards().alpha.distinctFilesRead, 1);
});

test('reads outside delivered directories and non-Read events are ignored', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered());
  wiring.port.onHookEvent('s1', 'PostToolUse', {
    tool_name: 'Read', tool_input: { file_path: path.join(path.dirname(PACK_DIR), 'outside.md') },
  });
  wiring.port.onHookEvent('s1', 'PostToolUse', {
    tool_name: 'Bash', tool_input: { file_path: path.join(PACK_DIR, 'rules.md') },
  });
  wiring.port.onHookEvent('s1', 'Stop', {
    tool_name: 'Read', tool_input: { file_path: path.join(PACK_DIR, 'rules.md') },
  });
  assert.equal(store.events.filter((event) => event.kind === 'pack-read').length, 0);
});

test('prompt classes are accumulated only for measured sessions', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPromptSubmitted('missing', { state: 'RUNNING', stateSince: 0, ts: NOW });
  wiring.port.onPacksDelivered('s1', delivered());
  wiring.port.onPromptSubmitted('s1', { state: 'RUNNING', stateSince: NOW - 5000, ts: NOW });
  wiring.port.onPromptSubmitted('s1', { state: 'WAITING', stateSince: NOW - 5000, ts: NOW });
  assert.deepEqual(store.events.filter((event) => event.kind === 'prompt').map((event) => event.promptClass), [
    'interruption',
    'answer',
  ]);
});

test('a session with no delivered packs creates no closed record', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'operator-abort', finalState: 'DONE' });
  assert.deepEqual(store.closed, []);
  assert.deepEqual(store.events, []);
});

test('session end persists disposition and the tokens this run added', () => {
  const store = fakeStore();
  let vendorTotals = { tokens: 200, costUSD: 0.5 };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW + 1000,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 1434, costUSD: 3 };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'operator-abort', finalState: 'DONE' });
  assert.equal(store.closed.length, 1);
  assert.equal(closedAt(store, 0).tokens, 1234);
  assert.equal(closedAt(store, 0).costUSD, 2.5);
  assert.equal(closedAt(store, 0).disposition, 'user-kill');
  assert.equal(storedEventAt(store, -1).kind, 'session-end');
  assert.equal(storedEventAt(store, -1).disposition, 'user-kill');
});

test('a close-out and a sleep-kill reach the same transition without scoring as aborts', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered());
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'close-out', finalState: 'DONE' });
  wiring.port.onPacksDelivered('s2', delivered());
  wiring.port.onSessionEnd('s2', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.deepEqual(store.closed.map((record) => record.disposition), ['natural', 'natural']);
});

test('a session torn down while live closes with no disposition instead of staying live', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered());
  wiring.port.onSessionTeardown('s1');
  assert.equal(store.closed.length, 1);
  assert.equal(closedAt(store, 0).disposition, null);
  assert.equal(closedAt(store, 0).endedAt, NOW);
  assert.equal(wiring.scorecards().alpha.liveSessions, 0);
});

test('recorded pack files are capped per session and the overflow is counted', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered());
  for (let index = 0; index < MAX_PACK_FILES_PER_SESSION + 5; index += 1) {
    wiring.port.onHookEvent('s1', 'PostToolUse', {
      tool_name: 'Read', tool_input: { file_path: path.join(PACK_DIR, `rules-${index}.md`) },
    });
  }
  wiring.port.onHookEvent('s1', 'PostToolUse', {
    tool_name: 'Read', tool_input: { file_path: path.join(PACK_DIR, `${'deep/'.repeat(120)}rules.md`) },
  });
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'operator-abort', finalState: 'DONE' });
  assert.equal(store.events.filter((event) => event.kind === 'pack-read').length, MAX_PACK_FILES_PER_SESSION);
  assert.equal(closedAt(store, 0).packs[0].filesRead, MAX_PACK_FILES_PER_SESSION);
  assert.equal(closedAt(store, 0).packs[0].filesDropped, 6);
});

test('live scorecards report the tokens the run has added so far', () => {
  const store = fakeStore();
  let vendorTotals = { tokens: 500, costUSD: 1 };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 900, costUSD: 1.5 };
  const scorecard = wiring.scorecards().alpha;
  assert.equal(scorecard.liveSessions, 1);
  assert.equal(scorecard.unopened.meanTokens, 400);
  assert.equal(scorecard.unopened.abortRate, null);
});

test('a run whose usage is unscanned when it starts waits for a real baseline instead of guessing zero', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = null;
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  assert.equal(wiring.scorecards().alpha.unopened.meanTokens, null);
  vendorTotals = { tokens: 9000, costUSD: 20 };
  assert.equal(wiring.scorecards().alpha.unopened.meanTokens, 0);
  vendorTotals = { tokens: 9200, costUSD: 20.5 };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 200);
  assert.equal(closedAt(store, 0).costUSD, 0.5);
});

test('a conversation created mid-run is billed to this run in full, on top of what was banked', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = { tokens: 100, costUSD: 1, identity: 'conv-a' };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 400, costUSD: 2, identity: 'conv-a' };
  assert.equal(wiring.scorecards().alpha.unopened.meanTokens, 300);
  vendorTotals = { tokens: 50, costUSD: 0.5, identity: 'conv-b' };
  assert.equal(wiring.scorecards().alpha.unopened.meanTokens, 350);
  vendorTotals = { tokens: 120, costUSD: 0.9, identity: 'conv-b' };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 420);
  assert.equal(Math.round((closedAt(store, 0).costUSD ?? 0) * 100) / 100, 1.9);
  assert.equal(closedAt(store, 0).resumeSessionId, 'conv-b');
});

test('a total that moves backward banks the delta already earned instead of erasing it', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = { tokens: 100, costUSD: 1, identity: 'conv-a' };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 900, costUSD: 3, identity: 'conv-a' };
  assert.equal(wiring.scorecards().alpha.unopened.meanTokens, 800);
  vendorTotals = { tokens: 40, costUSD: 0.4, identity: 'conv-a' };
  assert.equal(wiring.scorecards().alpha.unopened.meanTokens, 800);
  vendorTotals = { tokens: 90, costUSD: 0.9, identity: 'conv-a' };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 850);
  assert.equal(Math.round((closedAt(store, 0).costUSD ?? 0) * 100) / 100, 2.5);
});

test('an identity that only arrives after the baseline is not treated as a new conversation', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = { tokens: 9000, costUSD: 20, identity: null };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 9200, costUSD: 20.5, identity: 'conv-a' };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 200);
  assert.equal(closedAt(store, 0).resumeSessionId, 'conv-a');
});

test('measurement starts live and a retention change swaps the store behind it', async () => {
  const order: string[] = [];
  const stores: FakeStore[] = [];
  let millMetricsConfig = { retainDays: 90 };
  const lane = createMillMetricsLane({
    resolveConfig: () => millMetricsConfig,
    createStore: ({ retainDays }) => {
      const store = fakeStore({ retainDays, whenIdle: async () => { order.push('drain'); } });
      order.push(`open:${retainDays}`);
      stores.push(store);
      return store;
    },
    nowFn: () => NOW,
  });
  lane.port.onPacksDelivered('s1', delivered());
  assert.equal(lane.scorecards().alpha.liveSessions, 1);

  millMetricsConfig = { retainDays: 30 };
  await lane.restartIfConfigChanged();
  assert.deepEqual(order, ['open:90', 'drain', 'open:30']);
  assert.equal(lane.currentStore(), stores[1]);

  lane.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(stores[0]?.closed.length, 0);
  assert.equal(stores[1]?.closed.length, 1);

  assert.equal(stores.length, 2);
});

function gatedLane(
  order: string[],
  stores: FakeStore[],
  gate: { promise: Promise<void>; open: () => void },
  initialConfig: { retainDays: number },
  logger: Pick<Console, 'warn'> | null = null,
) {
  let millMetricsConfig = initialConfig;
  const lane = createMillMetricsLane({
    resolveConfig: () => millMetricsConfig,
    logger,
    createStore: ({ retainDays }) => {
      const index = stores.length;
      const store = fakeStore({
        retainDays,
        whenIdle: async () => {
          order.push(`drain:${retainDays}`);
          if (index === 0) await gate.promise;
        },
      });
      order.push(`open:${retainDays}`);
      stores.push(store);
      return store;
    },
    nowFn: () => NOW,
  });
  return { lane, setConfig: (next: { retainDays: number }) => { millMetricsConfig = next; } };
}

function openGate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((settle) => { open = () => settle(); });
  return { promise, open };
}

const tick = () => new Promise<void>((settle) => { setImmediate(() => settle()); });

test('a session closing while the store is swapping is replayed into the replacement', async () => {
  const order: string[] = [];
  const stores: FakeStore[] = [];
  const gate = openGate();
  const { lane, setConfig } = gatedLane(order, stores, gate, { retainDays: 90 });
  lane.port.onPacksDelivered('s1', delivered());
  setConfig({ retainDays: 30 });
  const swap = lane.restartIfConfigChanged();
  await tick();
  assert.equal(lane.currentStore(), null);
  lane.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  gate.open();
  await swap;
  assert.equal(stores.length, 2);
  assert.equal(stores[0]?.closed.length, 0);
  assert.equal(stores[1]?.closed.length, 1);
  assert.equal(stores[1].events.filter((event) => event.kind === 'session-end').length, 1);
});

test('two settings changes during one drain end on a single open store', async () => {
  const order: string[] = [];
  const stores: FakeStore[] = [];
  const gate = openGate();
  const { lane, setConfig } = gatedLane(order, stores, gate, { retainDays: 90 });
  lane.port.onPacksDelivered('s1', delivered());
  setConfig({ retainDays: 30 });
  const first = lane.restartIfConfigChanged();
  await tick();
  setConfig({ retainDays: 60 });
  const second = lane.restartIfConfigChanged();
  lane.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  gate.open();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['open:90', 'drain:90', 'open:60']);
  assert.equal(stores.length, 2);
  assert.equal(lane.currentStore(), stores[1]);
  assert.equal(stores[1]?.closed.length, 1);
});

test('shutdown during a store swap drains the replacement as well', async () => {
  const order: string[] = [];
  const stores: FakeStore[] = [];
  const gate = openGate();
  const { lane, setConfig } = gatedLane(order, stores, gate, { retainDays: 90 });
  lane.port.onPacksDelivered('s1', delivered());
  setConfig({ retainDays: 30 });
  void lane.restartIfConfigChanged();
  await tick();
  lane.port.onSessionTeardown('s1');
  const idle = lane.whenIdle();
  gate.open();
  await idle;
  assert.deepEqual(order, ['open:90', 'drain:90', 'open:30', 'drain:30']);
  assert.equal(stores[1]?.closed.length, 1);
});

test('a swap buffer filled with events gives ground to a close instead of dropping it', async () => {
  const order: string[] = [];
  const stores: FakeStore[] = [];
  const gate = openGate();
  const warnings: string[] = [];
  const { lane, setConfig } = gatedLane(order, stores, gate, { retainDays: 90 }, {
    warn: (message: string) => { warnings.push(message); },
  });
  lane.port.onPacksDelivered('s1', delivered());
  setConfig({ retainDays: 30 });
  const swap = lane.restartIfConfigChanged();
  await tick();
  for (let index = 0; index < 600; index += 1) {
    lane.port.onPromptSubmitted('s1', { state: 'RUNNING', stateSince: NOW - 5000, ts: NOW });
  }
  lane.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  gate.open();
  await swap;
  assert.equal(stores[1]?.closed.length, 1);
  assert.equal(stores[1].events.length, 499);
  assert.ok(warnings.some((message) => /dropping an event to keep a close/.test(message)));
});

test('a conversation first identified after the packs land is billed to this run in full', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = null;
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 300, costUSD: 0.75, identity: 'conv-a' };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 300);
  assert.equal(closedAt(store, 0).costUSD, 0.75);
});

test('a conversation known at delivery but scanned later still bills only what this run added', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = { tokens: null, costUSD: null, identity: 'conv-a' };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 9000, costUSD: 20, identity: 'conv-a' };
  assert.equal(wiring.scorecards().alpha.unopened.meanTokens, 0);
  vendorTotals = { tokens: 9200, costUSD: 20.5, identity: 'conv-a' };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 200);
});

test('a tokens rewind keeps the cost that the same sample added', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = { tokens: 100, costUSD: 1, identity: 'conv-a' };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 900, costUSD: 3, identity: 'conv-a' };
  assert.equal(wiring.scorecards().alpha.unopened.meanTokens, 800);
  vendorTotals = { tokens: 40, costUSD: 3.5, identity: 'conv-a' };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 800);
  assert.equal(Math.round((closedAt(store, 0).costUSD ?? 0) * 100) / 100, 2.5);
});

test('a resumed card reports its own run, not the whole conversation', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = { tokens: 900, costUSD: 2, identity: 'conv-a' };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 1100, costUSD: 2.5, identity: 'conv-a' };
  assert.equal(wiring.scorecards().alpha.unopened.meanTokens, 200);
});

function laneFedByUsage(
  store: FakeStore,
  sessions: Map<string, { resumeSessionId: string | null }>,
  readTotals: () => VendorTotals | null,
) {
  return createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: (sessionId) => tokensFromUsage({ sessionTotals: readTotals }, sessions, sessionId),
  });
}

test('a resumed card whose usage is unscanned at delivery is never billed the prior conversation', () => {
  const store = fakeStore();
  const sessions = new Map([['s1', { resumeSessionId: 'conv-a' }]]);
  let vendorTotals: VendorTotals | null = null;
  const wiring = laneFedByUsage(store, sessions, () => vendorTotals);
  wiring.port.onPacksDelivered('s1', delivered());
  assert.equal(wiring.scorecards().alpha.unopened.meanTokens, null);
  vendorTotals = { tokens: 500000, costUSD: 12.5 };
  assert.equal(wiring.scorecards().alpha.unopened.meanTokens, 0);
  vendorTotals = { tokens: 500300, costUSD: 12.6 };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 300);
  assert.equal(closedAt(store, 0).resumeSessionId, 'conv-a');
});

test('a fresh session whose vendor identity arrives mid-run is billed the whole conversation', () => {
  const store = fakeStore();
  const sessions = new Map<string, { resumeSessionId: string | null }>([['s1', { resumeSessionId: null }]]);
  let vendorTotals: VendorTotals | null = null;
  const wiring = laneFedByUsage(store, sessions, () => vendorTotals);
  wiring.port.onPacksDelivered('s1', delivered());
  sessions.set('s1', { resumeSessionId: 'conv-new' });
  vendorTotals = { tokens: 300, costUSD: 0.75 };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 300);
  assert.equal(closedAt(store, 0).costUSD, 0.75);
});

test('a store replaced while holding unpersisted closes hands them to its replacement', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-mill-metrics-swap-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const recordsPath = path.join(root, 'mill-metrics.json');
  const eventsDir = path.join(root, 'mill-metrics');
  let readable = false;
  let millMetricsConfig = { retainDays: 90 };
  const lane = createMillMetricsLane({
    resolveConfig: () => millMetricsConfig,
    nowFn: () => NOW,
    createStore: ({ retainDays }) => createMillMetricsStore({
      recordsPath,
      eventsDir,
      retainDays,
      nowFn: () => NOW,
      fsPromises: {
        ...fsp,
        readFile: async (target: string, encoding: 'utf8') => {
          if (target === recordsPath && !readable) {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          }
          return fsp.readFile(target, encoding);
        },
      },
    }),
  });
  lane.port.onPacksDelivered('s1', delivered());
  lane.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  await lane.whenIdle();
  assert.equal(fs.existsSync(recordsPath), false);

  readable = true;
  millMetricsConfig = { retainDays: 30 };
  await lane.restartIfConfigChanged();
  await lane.whenIdle();
  const persisted = JSON.parse(await fsp.readFile(recordsPath, 'utf8')) as { sessions: { sessionId: string }[] };
  assert.deepEqual(persisted.sessions.map((entry) => entry.sessionId), ['s1']);
});
