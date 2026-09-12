import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMillMetricsStore } from '../server/mill-metrics-store.ts';
import type { MillMetricSession } from '../shared/contracts/mill-metrics.ts';

const NOW = Date.parse('2026-08-30T12:00:00Z');

function record(overrides: Partial<MillMetricSession> = {}): MillMetricSession {
  return {
    sessionId: 's1',
    day: '2026-08-30',
    startedAt: NOW - 1000,
    endedAt: NOW,
    agent: 'claude-code',
    disposition: 'natural',
    finalState: 'DONE',
    tokens: 100,
    costUSD: 1,
    resumeSessionId: null,
    prompts: { interruption: 0, answer: 0, followup: 0, ambiguous: 0 },
    packs: [{
      name: 'alpha',
      version: 'v1',
      tokenEstimate: 100,
    }],
    ...overrides,
  };
}

async function fixture(t: TestContext) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-mill-metrics-store-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return {
    root,
    recordsPath: path.join(root, 'mill-metrics.json'),
    eventsDir: path.join(root, 'mill-metrics'),
  };
}

test('closed records round-trip through the durable store', async (t) => {
  const paths = await fixture(t);
  const store = createMillMetricsStore({ ...paths, retainDays: 90, nowFn: () => NOW });
  await store.load();
  store.closeSession(record());
  await store.whenIdle();

  const reloaded = createMillMetricsStore({ ...paths, retainDays: 90, nowFn: () => NOW });
  await reloaded.load();
  assert.deepEqual(reloaded.records(), [record()]);
});

test('legacy record keys are stripped while loading', async (t) => {
  const paths = await fixture(t);
  const legacyRecord = {
    ...record(),
    readDetection: 'available',
    packs: record().packs.map((pack) => ({
      ...pack,
      filesRead: 1,
      files: ['rules.md'],
      filesDropped: 2,
      opened: true,
      measurable: true,
    })),
  };
  await fsp.writeFile(paths.recordsPath, JSON.stringify({
    version: 1,
    updatedAt: new Date(NOW).toISOString(),
    sessions: [legacyRecord],
  }), 'utf8');
  const store = createMillMetricsStore({ ...paths, retainDays: 90, nowFn: () => NOW });
  await store.load();
  const loaded = store.records()[0];
  assert.ok(loaded);
  assert.deepEqual(loaded, record());
  assert.equal(Object.hasOwn(loaded, 'readDetection'), false);
  for (const key of ['filesRead', 'files', 'filesDropped', 'opened', 'measurable']) {
    assert.equal(Object.hasOwn(loaded.packs[0], key), false);
  }
});

test('an unreadable records file starts empty and warns', async (t) => {
  const paths = await fixture(t);
  await fsp.writeFile(paths.recordsPath, '{ broken', 'utf8');
  const warnings: string[] = [];
  const store = createMillMetricsStore({
    ...paths,
    retainDays: 90,
    nowFn: () => NOW,
    logger: { warn: (message) => warnings.push(message) },
  });
  await store.load();
  assert.deepEqual(store.records(), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /starting empty/);
});

test('appendEvent writes one JSON line per accepted event and whenIdle drains them', async (t) => {
  const paths = await fixture(t);
  const store = createMillMetricsStore({ ...paths, retainDays: 90, nowFn: () => NOW });
  const delivered = {
    v: 1, kind: 'pack-delivered', ts: NOW, sessionId: 's1', pack: 'alpha', version: 'v1',
    tokenEstimate: 100, agent: 'claude-code',
  };
  const prompt = {
    v: 1, kind: 'prompt', ts: NOW, sessionId: 's1', promptClass: 'interruption', state: 'RUNNING',
  };
  store.appendEvent(delivered);
  store.appendEvent(prompt);
  await store.whenIdle();
  const eventPath = path.join(paths.eventsDir, 'events-2026-08-30.jsonl');
  const lines = (await fsp.readFile(eventPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as unknown);
  assert.deepEqual(lines, [delivered, prompt]);
});

test('invalid event shapes are dropped without throwing and warn once per kind', async (t) => {
  const paths = await fixture(t);
  const warnings: string[] = [];
  const store = createMillMetricsStore({
    ...paths,
    retainDays: 90,
    nowFn: () => NOW,
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.doesNotThrow(() => store.appendEvent({ kind: 'prompt' }));
  assert.doesNotThrow(() => store.appendEvent({ kind: 'prompt' }));
  await store.whenIdle();
  assert.equal(warnings.length, 1);
  assert.equal(fs.existsSync(paths.eventsDir), false);
});

test('a retired event kind is skipped while the events around it still persist', async (t) => {
  const paths = await fixture(t);
  const warnings: string[] = [];
  const store = createMillMetricsStore({
    ...paths,
    retainDays: 90,
    nowFn: () => NOW,
    logger: { warn: (message) => warnings.push(message) },
  });
  const delivered = {
    v: 1, kind: 'pack-delivered', ts: NOW, sessionId: 's1', pack: 'alpha', version: 'v1',
    tokenEstimate: 100, agent: 'claude-code',
  };
  const sessionEnd = {
    v: 1, kind: 'session-end', ts: NOW, sessionId: 's1', disposition: 'natural', finalState: 'DONE',
    transition: 'task_complete',
  };
  store.appendEvent(delivered);
  store.appendEvent({ v: 1, kind: 'pack-read', ts: NOW, sessionId: 's1', pack: 'alpha', relPath: 'data/notes.md' });
  store.appendEvent({ v: 1, kind: 'pack-read', ts: NOW, sessionId: 's1', pack: 'alpha', relPath: 'data/other.md' });
  store.appendEvent(sessionEnd);
  await store.whenIdle();

  const eventPath = path.join(paths.eventsDir, 'events-2026-08-30.jsonl');
  const lines = (await fsp.readFile(eventPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as unknown);
  assert.deepEqual(lines, [delivered, sessionEnd]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /pack-read/);
});

test('load prunes only dated event files older than the retention cutoff', async (t) => {
  const paths = await fixture(t);
  await fsp.mkdir(paths.eventsDir, { recursive: true });
  for (const name of [
    'events-2026-08-23.jsonl',
    'events-2026-08-24.jsonl',
    'events-2026-08-30.jsonl',
    'notes.jsonl',
  ]) {
    await fsp.writeFile(path.join(paths.eventsDir, name), '{}\n', 'utf8');
  }
  const store = createMillMetricsStore({ ...paths, retainDays: 7, nowFn: () => NOW });
  await store.load();
  assert.deepEqual((await fsp.readdir(paths.eventsDir)).sort(), [
    'events-2026-08-24.jsonl',
    'events-2026-08-30.jsonl',
    'notes.jsonl',
  ]);
});

test('an invalid record shape is refused rather than persisted', async (t) => {
  const paths = await fixture(t);
  const warnings: string[] = [];
  const store = createMillMetricsStore({
    ...paths,
    retainDays: 90,
    nowFn: () => NOW,
    logger: { warn: (message) => warnings.push(message) },
  });
  await store.load();
  store.closeSession(record({
    packs: [{
      name: '',
      version: 'v1',
      tokenEstimate: 100,
    }],
  }));
  await store.whenIdle();
  assert.deepEqual(store.records(), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dropped invalid session record/);
});

function storeWithBlockedReads(
  paths: { recordsPath: string; eventsDir: string },
  warnings: string[],
  isReadable: () => boolean,
) {
  return createMillMetricsStore({
    ...paths,
    retainDays: 90,
    nowFn: () => NOW,
    logger: { warn: (message) => warnings.push(message) },
    fsPromises: {
      ...fsp,
      readFile: async (target: string, encoding: 'utf8') => {
        if (target === paths.recordsPath && !isReadable()) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return fsp.readFile(target, encoding);
      },
    },
  });
}

async function persistedSessionIds(recordsPath: string): Promise<string[]> {
  const parsed = JSON.parse(await fsp.readFile(recordsPath, 'utf8')) as { sessions: { sessionId: string }[] };
  return parsed.sessions.map((entry) => entry.sessionId).sort();
}

test('a records file that cannot be read is never persisted over', async (t) => {
  const paths = await fixture(t);
  await fsp.writeFile(paths.recordsPath, JSON.stringify({
    version: 1,
    updatedAt: new Date(NOW).toISOString(),
    sessions: [record({ sessionId: 'kept' })],
  }), 'utf8');
  const warnings: string[] = [];
  const store = storeWithBlockedReads(paths, warnings, () => false);
  await store.load();
  store.closeSession(record({ sessionId: 'fresh' }));
  await store.whenIdle();
  assert.deepEqual(await persistedSessionIds(paths.recordsPath), ['kept']);
  assert.match(warnings[0], /will retry/);
});

test('a close held through an unreadable window persists once the retried load succeeds', async (t) => {
  const paths = await fixture(t);
  await fsp.writeFile(paths.recordsPath, JSON.stringify({
    version: 1,
    updatedAt: new Date(NOW).toISOString(),
    sessions: [record({ sessionId: 'kept' })],
  }), 'utf8');
  let readable = false;
  const store = storeWithBlockedReads(paths, [], () => readable);
  await store.load();
  store.closeSession(record({ sessionId: 'fresh' }));
  await store.whenIdle();
  readable = true;
  store.closeSession(record({ sessionId: 'later' }));
  await store.whenIdle();
  assert.deepEqual(await persistedSessionIds(paths.recordsPath), ['fresh', 'kept', 'later']);
});

test('a store going idle retries the load and persists the closes it was holding', async (t) => {
  const paths = await fixture(t);
  await fsp.writeFile(paths.recordsPath, JSON.stringify({
    version: 1,
    updatedAt: new Date(NOW).toISOString(),
    sessions: [record({ sessionId: 'kept' })],
  }), 'utf8');
  let readable = false;
  const warnings: string[] = [];
  const store = storeWithBlockedReads(paths, warnings, () => readable);
  await store.load();
  store.closeSession(record({ sessionId: 'fresh' }));
  await store.whenIdle();
  assert.deepEqual(await persistedSessionIds(paths.recordsPath), ['kept']);
  assert.ok(warnings.some((message) => /left unpersisted/.test(message)));

  readable = true;
  await store.whenIdle();
  assert.deepEqual(await persistedSessionIds(paths.recordsPath), ['fresh', 'kept']);
});

test('load prunes expired session records without rewriting the file', async (t) => {
  const paths = await fixture(t);
  const payload = {
    version: 1,
    updatedAt: new Date(NOW).toISOString(),
    sessions: [record({ sessionId: 'old', day: '2026-08-23' }), record()],
  };
  await fsp.writeFile(paths.recordsPath, JSON.stringify(payload), 'utf8');
  const store = createMillMetricsStore({ ...paths, retainDays: 7, nowFn: () => NOW });
  await store.load();
  assert.deepEqual(store.records().map((entry) => entry.sessionId), ['s1']);
  assert.equal(JSON.parse(await fsp.readFile(paths.recordsPath, 'utf8')).sessions.length, 2);
});
