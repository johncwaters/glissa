
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERACTIVE_LANE,
  OTHER_LANE,
  laneMapFromLedger,
  laneRollup,
  normalizeLedger,
  pruneLedger,
} from '../server/core/usage-lane-core.ts';
import type { LaneRollupRow } from '../server/core/usage-lane-core.ts';
import { createLaneLedger } from '../server/usage-lane-ledger.ts';
import { registerEphemeralSession } from '../server/ephemeral-session.ts';

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

interface LaneEntry {
  vendor?: string;
  sessionId: string | null;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  costUSD: number;
}

function entry({ sessionId, tokens = 100, costUSD = 1, vendor }: {
  sessionId: string | null;
  tokens?: number;
  costUSD?: number;
  vendor?: string;
}): LaneEntry {
  const row: LaneEntry = { sessionId, input: tokens, output: 0, cacheCreate: 0, cacheRead: 0, costUSD };
  if (vendor) row.vendor = vendor;
  return row;
}

function laneRowOf(rows: LaneRollupRow[], lane: string): LaneRollupRow {
  const row = rows.find((candidate) => candidate.lane === lane);
  if (!row) throw new Error(`no rollup row for lane ${lane}`);
  return row;
}

interface StoredLedgerEntry {
  vendor?: string;
  sessionId?: string;
  claudeSessionId?: string;
  lane?: string;
  ts?: number;
}

async function readStoredLedger(ledgerPath: string): Promise<{ version?: number; entries: StoredLedgerEntry[] }> {
  const parsed: unknown = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('the ledger file is not a JSON object');
  const { version, entries } = parsed as { version?: number; entries?: unknown };
  if (!Array.isArray(entries)) throw new Error('the ledger file carries no entries array');
  return { version, entries };
}

function fakeSession(): EventEmitter & { destroy: () => void } {
  return Object.assign(new EventEmitter(), { destroy: () => {} });
}

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'glissa-usage-lanes-'));
}


test('laneRollup joins entries to lanes and counts distinct sessions', () => {
  const lanes = laneMapFromLedger([
    { claudeSessionId: 'a', lane: 'pr-review', ts: 1 },
    { claudeSessionId: 'b', lane: 'pr-review', ts: 2 },
    { claudeSessionId: 'c', lane: INTERACTIVE_LANE, ts: 3 },
  ]);
  const rows = laneRollup([
    entry({ sessionId: 'a', tokens: 100, costUSD: 3 }),
    entry({ sessionId: 'a', tokens: 50, costUSD: 1.2 }),
    entry({ sessionId: 'b', tokens: 10, costUSD: 0.5 }),
    entry({ sessionId: 'c', tokens: 20, costUSD: 0.9 }),
  ], lanes);
  assert.equal(laneRowOf(rows, 'pr-review').costUSD, 4.7);
  assert.equal(laneRowOf(rows, 'pr-review').tokens, 160);
  assert.equal(laneRowOf(rows, 'pr-review').sessions, 2);
  assert.equal(laneRowOf(rows, INTERACTIVE_LANE).sessions, 1);
  assert.equal(rows[0].lane, 'pr-review');
});

test('an unknown session id is other, never inferred', () => {
  const lanes = laneMapFromLedger([{ claudeSessionId: 'known', lane: 'posthog', ts: 1 }]);
  const rows = laneRollup([
    entry({ sessionId: 'known', costUSD: 1 }),
    entry({ sessionId: 'a-terminal-session', costUSD: 2 }),
    entry({ sessionId: null, costUSD: 3 }),
  ], lanes);
  assert.equal(laneRowOf(rows, 'posthog').costUSD, 1);
  assert.equal(laneRowOf(rows, OTHER_LANE).costUSD, 5, 'both the unknown id and the id-less entry');
  assert.equal(laneRowOf(rows, OTHER_LANE).sessions, 1);
});

test('vendor entries attribute by their own composite key, unrecorded ones are other', () => {
  const lanes = laneMapFromLedger([
    { vendor: 'claude', sessionId: 'a', lane: 'pr-review', ts: 1 },
    { vendor: 'codex', sessionId: 'a', lane: INTERACTIVE_LANE, ts: 2 },
  ]);
  const rows = laneRollup([
    entry({ sessionId: 'a', costUSD: 1 }),
    entry({ sessionId: 'a', costUSD: 4, vendor: 'codex' }),
    entry({ sessionId: 'g', costUSD: 9, vendor: 'grok' }),
  ], lanes);
  assert.equal(laneRowOf(rows, 'pr-review').costUSD, 1);
  assert.equal(laneRowOf(rows, INTERACTIVE_LANE).costUSD, 4, 'the recorded codex session, not the claude one');
  assert.equal(laneRowOf(rows, OTHER_LANE).costUSD, 9);
  const withExplicit = laneRollup([entry({ sessionId: 'a', costUSD: 2, vendor: 'claude' })], lanes);
  assert.equal(withExplicit[0].costUSD, 2);
});

test('laneRollup with no ledger puts everything in other', () => {
  const rows = laneRollup([entry({ sessionId: 'a', costUSD: 1 })], new Map());
  assert.deepEqual(rows.map((row) => row.lane), [OTHER_LANE]);
  assert.deepEqual(laneRollup([], new Map()), []);
  assert.deepEqual(laneRollup(null, null), []);
});

test('normalizeLedger: one lane per id, newest record wins, junk dropped', () => {
  const normalized = normalizeLedger([
    { claudeSessionId: 'a', lane: 'pr-review', ts: 10 },
    { claudeSessionId: 'a', lane: 'interactive', ts: 20 },
    { claudeSessionId: 'b', lane: 'posthog', ts: 5 },
    { claudeSessionId: '', lane: 'posthog', ts: 5 },
    { claudeSessionId: 'c', lane: '', ts: 5 },
    null,
  ]);
  assert.deepEqual(normalized.map((row) => [row.sessionId, row.lane]), [['b', 'posthog'], ['a', 'interactive']]);
  const reversed = normalizeLedger([
    { claudeSessionId: 'a', lane: 'interactive', ts: 20 },
    { claudeSessionId: 'a', lane: 'pr-review', ts: 10 },
  ]);
  assert.equal(reversed[0].lane, 'interactive');
  assert.ok(normalized.every((row) => row.vendor === 'claude'));
});

test('pruneLedger drops entries past retention but keeps unstamped ones', () => {
  const kept = pruneLedger([
    { claudeSessionId: 'fresh', lane: 'pr-review', ts: NOW - 3 * DAY_MS },
    { claudeSessionId: 'stale', lane: 'pr-review', ts: NOW - 400 * DAY_MS },
    { claudeSessionId: 'unstamped', lane: 'posthog' },
  ], { now: NOW, retainDays: 365 });
  const ids = kept.map((row) => row.sessionId).sort();
  assert.deepEqual(ids, ['fresh', 'unstamped'], 'losing an attribution is worse than keeping a stale one');
  assert.equal(pruneLedger([{ claudeSessionId: 'x', lane: 'y', ts: 1 }], {}).length, 1);
});


test('the ledger records a lane and persists it atomically', async () => {
  const root = await makeTempRoot();
  const ledgerPath = path.join(root, '.glissa', 'usage-lanes.json');
  const ledger = createLaneLedger({ ledgerPath, nowFn: () => NOW });
  ledger.record('claude-1', 'pr-review');
  ledger.record('claude-2', INTERACTIVE_LANE);
  await ledger.whenIdle();

  const stored = await readStoredLedger(ledgerPath);
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.entries.map((row) => [row.vendor, row.sessionId, row.lane]), [['claude', 'claude-1', 'pr-review'], ['claude', 'claude-2', INTERACTIVE_LANE]]);
  assert.equal(ledger.laneMap().get('claude:claude-1'), 'pr-review');
  assert.deepEqual(await fs.readdir(path.join(root, '.glissa')), ['usage-lanes.json']);
});

test('a fresh ledger reads what a previous process wrote', async () => {
  const root = await makeTempRoot();
  const ledgerPath = path.join(root, '.glissa', 'usage-lanes.json');
  const first = createLaneLedger({ ledgerPath, nowFn: () => NOW });
  first.record('claude-1', 'pack-distill');
  await first.whenIdle();

  const second = createLaneLedger({ ledgerPath, nowFn: () => NOW });
  await second.load();
  assert.equal(second.laneMap().get('claude:claude-1'), 'pack-distill');
});

test('re-recording the same id and lane does not rewrite the file', async () => {
  const root = await makeTempRoot();
  const ledgerPath = path.join(root, '.glissa', 'usage-lanes.json');
  const ledger = createLaneLedger({ ledgerPath, nowFn: () => NOW });
  ledger.record('claude-1', 'pr-review');
  await ledger.whenIdle();
  const before = await fs.readFile(ledgerPath, 'utf8');
  ledger.record('claude-1', 'pr-review');
  await ledger.whenIdle();
  assert.equal(await fs.readFile(ledgerPath, 'utf8'), before);
});

test('retention is applied on write, not just on read', async () => {
  const root = await makeTempRoot();
  const ledgerPath = path.join(root, '.glissa', 'usage-lanes.json');
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, JSON.stringify({
    version: 1,
    entries: [
      { claudeSessionId: 'ancient', lane: 'pr-review', ts: NOW - 400 * DAY_MS },
      { claudeSessionId: 'recent', lane: 'pr-review', ts: NOW - DAY_MS },
    ],
  }));
  const ledger = createLaneLedger({ ledgerPath, nowFn: () => NOW, retainDays: 365 });
  ledger.record('new-one', 'posthog');
  await ledger.whenIdle();
  const stored = await readStoredLedger(ledgerPath);
  assert.deepEqual(stored.entries.map((row) => row.sessionId).sort(), ['new-one', 'recent']);
});

test('an old-format ledger file round-trips as vendor claude', async () => {
  const root = await makeTempRoot();
  const ledgerPath = path.join(root, '.glissa', 'usage-lanes.json');
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, JSON.stringify({
    version: 1,
    entries: [
      { claudeSessionId: 'old-1', lane: 'pr-review', ts: NOW - DAY_MS },
      { claudeSessionId: 'old-2', lane: INTERACTIVE_LANE, ts: NOW - DAY_MS },
    ],
  }));
  const ledger = createLaneLedger({ ledgerPath, nowFn: () => NOW, retainDays: 365 });
  await ledger.load();
  assert.equal(ledger.laneMap().get('claude:old-1'), 'pr-review');
  assert.equal(ledger.laneMap().get('claude:old-2'), INTERACTIVE_LANE);
  assert.ok(ledger.snapshot().every((row) => row.vendor === 'claude' && typeof row.sessionId === 'string'));

  ledger.record('new-codex', INTERACTIVE_LANE, 'codex');
  await ledger.whenIdle();
  const stored = await readStoredLedger(ledgerPath);
  const byId = new Map(stored.entries.map((row) => [row.sessionId, row]));
  assert.equal(byId.get('old-1')?.vendor, 'claude');
  assert.equal(byId.get('new-codex')?.vendor, 'codex');
  assert.ok(stored.entries.every((row) => row.claudeSessionId === undefined), 'no entry keeps the pre-M5 field');
  assert.equal(ledger.laneMap().get('codex:new-codex'), INTERACTIVE_LANE);
});

test('a corrupt ledger starts empty, warns, and still records', async () => {
  const root = await makeTempRoot();
  const ledgerPath = path.join(root, '.glissa', 'usage-lanes.json');
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, '{ not json');
  const warnings: string[] = [];
  const ledger = createLaneLedger({ ledgerPath, nowFn: () => NOW, logger: { warn: (message) => warnings.push(String(message)) } });
  await ledger.load();
  assert.deepEqual(ledger.snapshot(), []);
  assert.ok(warnings.some((message) => message.includes('unreadable')), `warned: ${warnings.join(' | ')}`);
  ledger.record('claude-1', 'pr-review');
  await ledger.whenIdle();
  assert.equal(ledger.laneMap().get('claude:claude-1'), 'pr-review');
});

test('an unwritable ledger degrades to a warning and keeps working in memory', async () => {
  const root = await makeTempRoot();
  const warnings: string[] = [];
  const ledger = createLaneLedger({
    ledgerPath: path.join(root, '.glissa', 'usage-lanes.json'),
    nowFn: () => NOW,
    logger: { warn: (message) => warnings.push(String(message)) },
    fsPromises: { ...fs, writeFile: async () => { throw new Error('EACCES simulated'); } },
  });
  ledger.record('claude-1', 'pr-review');
  await ledger.whenIdle();
  assert.ok(warnings.some((message) => message.includes('write failed')), `warned: ${warnings.join(' | ')}`);
  assert.equal(ledger.laneMap().get('claude:claude-1'), 'pr-review');
});

test('no ledgerPath makes the whole feature inert', async () => {
  const ledger = createLaneLedger({});
  await ledger.load();
  ledger.record('claude-1', 'pr-review');
  assert.equal(ledger.laneMap().size, 0);
  assert.deepEqual(ledger.snapshot(), []);
});


test('registerEphemeralSession records the lane from its own logPrefix', () => {
  const recorded: [string, string][] = [];
  const sess = fakeSession();
  registerEphemeralSession({
    map: new Map(),
    id: 'ephemeral-1',
    sess,
    closeSessionDataClients: () => {},
    logPrefix: 'pr-review',
    name: 'pr-42',
    recordLane: (claudeSessionId, lane) => { recorded.push([claudeSessionId, lane]); },
  });
  sess.emit('claude-session-id', { id: 'claude-abc' });
  assert.deepEqual(recorded, [['claude-abc', 'pr-review']]);
});

test('registerEphemeralSession without a recorder behaves exactly as before', () => {
  const map = new Map<string, unknown>();
  const sess = fakeSession();
  registerEphemeralSession({ map, id: 'e1', sess, closeSessionDataClients: () => {}, logPrefix: 'posthog', name: 'n' });
  sess.emit('claude-session-id', { id: 'claude-abc' });
  assert.equal(map.get('e1'), sess);
  sess.emit('exit', {});
  assert.equal(map.has('e1'), false, 'the exit cleanup still runs');
});
