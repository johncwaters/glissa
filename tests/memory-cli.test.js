'use strict';

// `glissa memory` reporting. Two rules, both about not lying to the operator: a write the database
// refused must not read as an empty search, and a backfill that never ran must say so rather than report
// a clean pass. The refusal is a busy database now (M12b), not the file-era canon lock.

const test = require('node:test');
const assert = require('node:assert/strict');

const { runMemoryCli } = require('../server/memory-cli');

function fakeStore(result) {
  return {
    distDir: '/tmp/glissa-memory-dist',
    pendingDir: '/tmp/glissa-memory/dist-pending',
    projectionPath: '/tmp/glissa-memory/dist/current/MEMORY.md',
    stopped: 0,
    forget: async () => result,
    stop: async function stop() { this.stopped += 1; },
  };
}

function fakeIngest(result) {
  return {
    statePath: '/tmp/glissa-memory/tail-state.json',
    stopped: 0,
    backfill: async () => result,
    stats: () => ({ written: 3, rejected: 1 }),
    stop: async function stop() { this.stopped += 1; },
  };
}

function fakeDistiller(result) {
  return {
    stopped: 0,
    calls: [],
    runOnce: async function runOnce(options) { this.calls.push(options); return result; },
    stop: async function stop() { this.stopped += 1; },
  };
}

async function captureCli(args, store, ingest = null, distiller = null) {
  const logged = [];
  const errored = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...parts) => logged.push(parts.join(' '));
  console.error = (...parts) => errored.push(parts.join(' '));
  try {
    const code = await runMemoryCli(args, {
      makeStore: () => store, makeIngest: async () => ingest, makeDistiller: () => distiller,
    });
    return { code, logged, errored };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

test('a forget blocked by a busy database says so instead of reporting no match', async () => {
  const store = fakeStore({
    ok: false, reason: 'locked', removed: 0, redacted: 0, segments: 0, tombstoneId: null,
  });
  const { code, logged, errored } = await captureCli(['forget', 'm-0123456789abcdef'], store);
  assert.equal(code, 1);
  assert.equal(logged.length, 0);
  assert.equal(errored.length, 1);
  assert.match(errored[0], /busy/i);
  assert.equal(errored[0].includes('No remembered record matched'), false);
  assert.equal(store.stopped, 1);
});

test('a forget that genuinely matched nothing still reports no match', async () => {
  const store = fakeStore({
    ok: false, reason: 'no-match', removed: 0, redacted: 0, segments: 0, tombstoneId: null,
  });
  const { code, logged, errored } = await captureCli(['forget', 'nothing-like-this'], store);
  assert.equal(code, 1);
  assert.equal(errored.length, 0);
  assert.deepEqual(logged, ['No remembered record matched. Nothing was written.']);
  assert.equal(store.stopped, 1);
});

test('a successful forget reports its counts and exits zero', async () => {
  const store = fakeStore({
    ok: true, reason: null, removed: 2, redacted: 1, segments: 1, tombstoneId: 'm-fedcba9876543210',
  });
  const { code, logged } = await captureCli(['forget', 'hunter2'], store);
  assert.equal(code, 0);
  assert.match(logged[0], /Removed 2 record\(s\), redacted 1, across 1 segment\(s\)\./);
  assert.match(logged[1], /m-fedcba9876543210/);
  assert.equal(store.stopped, 1);
});

test('a backfill blocked by a busy database says so instead of reporting a clean pass', async () => {
  const ingest = fakeIngest({ ok: false, reason: 'locked', files: 0, bytesRead: 0, partial: false });
  const { code, logged, errored } = await captureCli(['backfill'], fakeStore(null), ingest);
  assert.equal(code, 1);
  assert.equal(logged.length, 0);
  assert.equal(errored.length, 1);
  assert.match(errored[0], /busy/i);
  assert.equal(ingest.stopped, 1);
});

test('a completed backfill reports its counts and exits zero', async () => {
  const ingest = fakeIngest({ ok: true, reason: null, files: 4, bytesRead: 2048, partial: false });
  const { code, logged, errored } = await captureCli(['backfill'], fakeStore(null), ingest);
  assert.equal(code, 0);
  assert.deepEqual(errored, []);
  assert.match(logged[0], /2048 byte\(s\) across 4 transcript\(s\)/);
  assert.match(logged[1], /3 record\(s\); 1 were refused/);
  assert.equal(logged.some((line) => /budget/.test(line)), false);
});

test('a backfill that hit its byte budget says it can be run again', async () => {
  const ingest = fakeIngest({ ok: true, reason: null, files: 9, bytesRead: 8192, partial: true });
  const { code, logged } = await captureCli(['backfill'], fakeStore(null), ingest);
  assert.equal(code, 0);
  assert.ok(logged.some((line) => /run it again/.test(line)));
});

// --- distill -------------------------------------------------------------

function distillReport(overrides) {
  return {
    status: 'published', reason: null, verdict: 'DISTILLED', published: true, version: 'abc123',
    newClaims: 2, records: 7, pending: false, ...overrides,
  };
}

test('a dry run reports what would be distilled and spawns nothing', async () => {
  const distiller = fakeDistiller(distillReport({ status: 'stale', verdict: null, published: false, version: null }));
  const { code, logged } = await captureCli(['distill', '--dry-run'], fakeStore(null), null, distiller);
  assert.equal(code, 0);
  assert.deepEqual(distiller.calls, [{ dryRun: true, force: true }]);
  assert.match(logged[0], /7 record\(s\) would be distilled/);
  assert.match(logged[0], /Nothing was spawned/);
  assert.equal(distiller.stopped, 1);
});

test('a distill blocked by a busy database says so instead of reporting a clean pass', async () => {
  const distiller = fakeDistiller(distillReport({ status: 'locked', reason: 'the memory database is busy' }));
  const { code, logged, errored } = await captureCli(['distill'], fakeStore(null), null, distiller);
  assert.equal(code, 1);
  assert.equal(logged.length, 0);
  assert.match(errored[0], /busy/i);
});

test('a build held for locked review names the pending directory and fails the command', async () => {
  const distiller = fakeDistiller(distillReport({
    status: 'pending', pending: true, published: false, reason: 'a locked record would be re-rendered',
  }));
  const { code, logged } = await captureCli(['distill'], fakeStore(null), null, distiller);
  assert.equal(code, 1);
  assert.match(logged[0], /dist-pending/);
});

test('a published build names its version and the projection path', async () => {
  const distiller = fakeDistiller(distillReport({}));
  const { code, logged } = await captureCli(['distill'], fakeStore(null), null, distiller);
  assert.equal(code, 0);
  assert.match(logged[0], /abc123/);
  assert.match(logged[1], /MEMORY\.md/);
});
