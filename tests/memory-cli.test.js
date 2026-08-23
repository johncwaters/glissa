'use strict';

// `glissa memory` reporting. Two rules, both about not lying to the operator: a held canon lock must not
// read as an empty search, and a backfill refused because a live server holds that lock must say so
// rather than report a clean pass that never ran.

const test = require('node:test');
const assert = require('node:assert/strict');

const { runMemoryCli } = require('../server/memory-cli');

function fakeStore(result) {
  return {
    distDir: '/tmp/glissa-memory-dist',
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

async function captureCli(args, store, ingest = null) {
  const logged = [];
  const errored = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...parts) => logged.push(parts.join(' '));
  console.error = (...parts) => errored.push(parts.join(' '));
  try {
    const code = await runMemoryCli(args, { makeStore: () => store, makeIngest: async () => ingest });
    return { code, logged, errored };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

test('a forget blocked by the canon lock says so instead of reporting no match', async () => {
  const store = fakeStore({
    ok: false, reason: 'locked', removed: 0, redacted: 0, segments: 0, tombstoneId: null,
  });
  const { code, logged, errored } = await captureCli(['forget', 'm-0123456789abcdef'], store);
  assert.equal(code, 1);
  assert.equal(logged.length, 0);
  assert.equal(errored.length, 1);
  assert.match(errored[0], /lock/i);
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

test('a backfill blocked by the canon lock names the lock instead of reporting a clean pass', async () => {
  const ingest = fakeIngest({ ok: false, reason: 'locked', files: 0, bytesRead: 0, partial: false });
  const { code, logged, errored } = await captureCli(['backfill'], fakeStore(null), ingest);
  assert.equal(code, 1);
  assert.equal(logged.length, 0);
  assert.equal(errored.length, 1);
  assert.match(errored[0], /lock/i);
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
