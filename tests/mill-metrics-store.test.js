'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createMillMetricsStore } = require('../server/mill-metrics-store.ts');
const { MAX_PACK_FILES_PER_SESSION } = require('../shared/contracts/mill-metrics.ts');

const NOW = Date.parse('2026-08-30T12:00:00Z');

function record(overrides = {}) {
  return {
    sessionId: 's1',
    day: '2026-08-30',
    startedAt: NOW - 1000,
    endedAt: NOW,
    agent: 'claude-code',
    readDetection: 'available',
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
      filesRead: 1,
      files: ['rules.md'],
      filesDropped: 0,
      opened: true,
    }],
    ...overrides,
  };
}

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-mill-metrics-store-'));
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

test('two capped runs of one session fold into a record the next boot can still read', async (t) => {
  const paths = await fixture(t);
  const filesFor = (prefix) => Array.from(
    { length: MAX_PACK_FILES_PER_SESSION },
    (_, index) => `${prefix}-${String(index).padStart(4, '0')}.md`,
  );
  const runWithFiles = (prefix) => record({
    packs: [{
      name: 'alpha',
      version: 'v1',
      tokenEstimate: 100,
      filesRead: MAX_PACK_FILES_PER_SESSION,
      files: filesFor(prefix),
      filesDropped: 0,
      opened: true,
    }],
  });
  const store = createMillMetricsStore({ ...paths, retainDays: 90, nowFn: () => NOW });
  await store.load();
  store.closeSession(runWithFiles('first'));
  store.closeSession(runWithFiles('second'));
  await store.whenIdle();

  const reloaded = createMillMetricsStore({ ...paths, retainDays: 90, nowFn: () => NOW });
  await reloaded.load();
  assert.equal(reloaded.records().length, 1);
  assert.equal(reloaded.records()[0].packs[0].files.length, MAX_PACK_FILES_PER_SESSION);
  assert.equal(reloaded.records()[0].packs[0].filesDropped, MAX_PACK_FILES_PER_SESSION);
});

test('an unreadable records file starts empty and warns', async (t) => {
  const paths = await fixture(t);
  await fsp.writeFile(paths.recordsPath, '{ broken', 'utf8');
  const warnings = [];
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
    tokenEstimate: 100, agent: 'claude-code', readDetection: 'available',
  };
  const read = { v: 1, kind: 'pack-read', ts: NOW, sessionId: 's1', pack: 'alpha', relPath: 'rules.md' };
  store.appendEvent(delivered);
  store.appendEvent(read);
  await store.whenIdle();
  const eventPath = path.join(paths.eventsDir, 'events-2026-08-30.jsonl');
  const lines = (await fsp.readFile(eventPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines, [delivered, read]);
});

test('invalid event shapes are dropped without throwing and warn once per kind', async (t) => {
  const paths = await fixture(t);
  const warnings = [];
  const store = createMillMetricsStore({
    ...paths,
    retainDays: 90,
    nowFn: () => NOW,
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.doesNotThrow(() => store.appendEvent({ kind: 'pack-read' }));
  assert.doesNotThrow(() => store.appendEvent({ kind: 'pack-read' }));
  await store.whenIdle();
  assert.equal(warnings.length, 1);
  assert.equal(fs.existsSync(paths.eventsDir), false);
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

test('a record too large for the shape is refused rather than persisted', async (t) => {
  const paths = await fixture(t);
  const warnings = [];
  const store = createMillMetricsStore({
    ...paths,
    retainDays: 90,
    nowFn: () => NOW,
    logger: { warn: (message) => warnings.push(message) },
  });
  await store.load();
  store.closeSession(record({
    packs: [{
      name: 'alpha',
      version: 'v1',
      tokenEstimate: 100,
      filesRead: 1,
      files: ['x'.repeat(513)],
      filesDropped: 0,
      opened: true,
    }],
  }));
  await store.whenIdle();
  assert.deepEqual(store.records(), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dropped invalid session record/);
});

function storeWithBlockedReads(paths, warnings, isReadable) {
  return createMillMetricsStore({
    ...paths,
    retainDays: 90,
    nowFn: () => NOW,
    logger: { warn: (message) => warnings.push(message) },
    fsPromises: {
      ...fsp,
      readFile: async (target, encoding) => {
        if (target === paths.recordsPath && !isReadable()) {
          const error = new Error('permission denied');
          error.code = 'EACCES';
          throw error;
        }
        return fsp.readFile(target, encoding);
      },
    },
  });
}

async function persistedSessionIds(recordsPath) {
  const parsed = JSON.parse(await fsp.readFile(recordsPath, 'utf8'));
  return parsed.sessions.map((entry) => entry.sessionId).sort();
}

test('a records file that cannot be read is never persisted over', async (t) => {
  const paths = await fixture(t);
  await fsp.writeFile(paths.recordsPath, JSON.stringify({
    version: 1,
    updatedAt: new Date(NOW).toISOString(),
    sessions: [record({ sessionId: 'kept' })],
  }), 'utf8');
  const warnings = [];
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
  const warnings = [];
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
