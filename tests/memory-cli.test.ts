import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { resolveMemoryConfig } from '../server/core/memory-core.ts';
import { runMemoryCli } from '../server/memory-cli.ts';
import type { DistillReport } from '../server/memory-distill.ts';
import type { createMemoryIngest } from '../server/memory-ingest-wiring.ts';
import { createMemoryStore } from '../server/memory-store.ts';

type MemoryStore = NonNullable<ReturnType<typeof createMemoryStore>>;
type MemoryIngest = ReturnType<typeof createMemoryIngest>;
type CliIngest = Pick<MemoryIngest, 'backfill' | 'statePath' | 'stats' | 'stop'>;
type ForgetResult = Awaited<ReturnType<MemoryStore['forget']>>;
type BackfillResult = Awaited<ReturnType<MemoryIngest['backfill']>>;
type IngestStats = ReturnType<MemoryIngest['stats']>;

const NO_COUNTS: IngestStats = {
  seen: 0, written: 0, rejected: 0, dropped: 0, offsetsSkipped: 0, laneSkipped: 0, refused: 0,
  queued: 0, tracked: 0,
};

interface StopCounter {
  stopped: number;
}

const QUIET = { log() {}, warn() {} };

function storeWithForget(t: TestContext, result: ForgetResult): MemoryStore & StopCounter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createMemoryStore({
    dir,
    dbPath: path.join(dir, 'glissa.db'),
    config: { ...resolveMemoryConfig(null), enabled: true },
    logger: QUIET,
  });
  if (!store) throw new Error('this node build has no node:sqlite');
  const counted = Object.assign(store, { stopped: 0 });
  const realStop = store.stop;
  counted.forget = async () => result;
  counted.stop = async () => { counted.stopped += 1; await realStop(); };
  return counted;
}

function fakeIngest(result: BackfillResult): CliIngest & StopCounter {
  const ingest = {
    statePath: '/tmp/glissa-memory/tail-state.json',
    stopped: 0,
    backfill: async () => result,
    stats: () => ({ ...NO_COUNTS, written: 3, rejected: 1 }),
    stop: async () => { ingest.stopped += 1; },
  };
  return ingest;
}

interface FakeDistiller extends StopCounter {
  calls: { dryRun?: boolean; force?: boolean }[];
  runOnce(options?: { dryRun?: boolean; force?: boolean }): Promise<DistillReport>;
  stop(): Promise<void>;
}

function fakeDistiller(result: DistillReport): FakeDistiller {
  const distiller: FakeDistiller = {
    stopped: 0,
    calls: [],
    runOnce: async (options = {}) => { distiller.calls.push(options); return result; },
    stop: async () => { distiller.stopped += 1; },
  };
  return distiller;
}

interface CliOutcome {
  code: number;
  logged: string[];
  errored: string[];
}

async function captureCli(
  args: string[],
  store: MemoryStore,
  ingest: CliIngest | null = null,
  distiller: FakeDistiller | null = null,
): Promise<CliOutcome> {
  const logged: string[] = [];
  const errored: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...parts: unknown[]) => logged.push(parts.join(' '));
  console.error = (...parts: unknown[]) => errored.push(parts.join(' '));
  try {
    const code = await runMemoryCli(args, {
      makeStore: () => store,
      makeIngest: async () => {
        if (!ingest) throw new Error('this command needs no ingest');
        return ingest;
      },
      makeDistiller: () => {
        if (!distiller) throw new Error('this command needs no distiller');
        return distiller;
      },
    });
    return { code, logged, errored };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

test('a forget blocked by a busy database says so instead of reporting no match', async (t) => {
  const store = storeWithForget(t, {
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

test('a forget that genuinely matched nothing still reports no match', async (t) => {
  const store = storeWithForget(t, {
    ok: false, reason: 'no-match', removed: 0, redacted: 0, segments: 0, tombstoneId: null,
  });
  const { code, logged, errored } = await captureCli(['forget', 'nothing-like-this'], store);
  assert.equal(code, 1);
  assert.equal(errored.length, 0);
  assert.deepEqual(logged, ['No remembered record matched. Nothing was written.']);
  assert.equal(store.stopped, 1);
});

test('a successful forget reports its counts and exits zero', async (t) => {
  const store = storeWithForget(t, {
    ok: true, reason: null, removed: 2, redacted: 1, segments: 1, tombstoneId: 'm-fedcba9876543210',
  });
  const { code, logged } = await captureCli(['forget', 'hunter2'], store);
  assert.equal(code, 0);
  assert.match(logged[0], /Removed 2 record\(s\), redacted 1, across 1 segment\(s\)\./);
  assert.match(logged[1], /m-fedcba9876543210/);
  assert.equal(store.stopped, 1);
});

test('a backfill blocked by a busy database says so instead of reporting a clean pass', async (t) => {
  const store = storeWithForget(t, { ok: false, reason: 'no-match', removed: 0, redacted: 0, segments: 0, tombstoneId: null });
  const ingest = fakeIngest({ ok: false, reason: 'locked', files: 0, bytesRead: 0, partial: false });
  const { code, logged, errored } = await captureCli(['backfill'], store, ingest);
  assert.equal(code, 1);
  assert.equal(logged.length, 0);
  assert.equal(errored.length, 1);
  assert.match(errored[0], /busy/i);
  assert.equal(ingest.stopped, 1);
});

test('a completed backfill reports its counts and exits zero', async (t) => {
  const store = storeWithForget(t, { ok: false, reason: 'no-match', removed: 0, redacted: 0, segments: 0, tombstoneId: null });
  const ingest = fakeIngest({ ok: true, reason: null, files: 4, bytesRead: 2048, partial: false });
  const { code, logged, errored } = await captureCli(['backfill'], store, ingest);
  assert.equal(code, 0);
  assert.deepEqual(errored, []);
  assert.match(logged[0], /2048 byte\(s\) across 4 transcript\(s\)/);
  assert.match(logged[1], /3 record\(s\); 1 were refused/);
  assert.equal(logged.some((line) => /budget/.test(line)), false);
});

test('a backfill that hit its byte budget says it can be run again', async (t) => {
  const store = storeWithForget(t, { ok: false, reason: 'no-match', removed: 0, redacted: 0, segments: 0, tombstoneId: null });
  const ingest = fakeIngest({ ok: true, reason: null, files: 9, bytesRead: 8192, partial: true });
  const { code, logged } = await captureCli(['backfill'], store, ingest);
  assert.equal(code, 0);
  assert.ok(logged.some((line) => /run it again/.test(line)));
});

function distillReport(overrides: Partial<DistillReport>): DistillReport {
  return {
    status: 'published', reason: null, verdict: 'DISTILLED', published: true, version: 'abc123',
    newClaims: 2, records: 7, pending: false, mode: 'incremental', cursor: 41, delta: 7, remaining: 3,
    claims: 12, ...overrides,
  };
}

test('a dry run reports what would be distilled and spawns nothing', async (t) => {
  const store = storeWithForget(t, { ok: false, reason: 'no-match', removed: 0, redacted: 0, segments: 0, tombstoneId: null });
  const distiller = fakeDistiller(distillReport({ status: 'stale', verdict: null, published: false, version: null }));
  const { code, logged } = await captureCli(['distill', '--dry-run'], store, null, distiller);
  assert.equal(code, 0);
  assert.deepEqual(distiller.calls, [{ dryRun: true, force: true }]);
  assert.match(logged[0], /7 record\(s\) would be distilled in incremental mode/);
  assert.match(logged[0], /3 left behind/);
  assert.match(logged[1], /Cursor: 41; 12 claim\(s\) already stand/);
  assert.match(logged[1], /Nothing was spawned/);
  assert.equal(distiller.stopped, 1);
});

test('a distill blocked by a busy database says so instead of reporting a clean pass', async (t) => {
  const store = storeWithForget(t, { ok: false, reason: 'no-match', removed: 0, redacted: 0, segments: 0, tombstoneId: null });
  const distiller = fakeDistiller(distillReport({ status: 'locked', reason: 'the memory database is busy' }));
  const { code, logged, errored } = await captureCli(['distill'], store, null, distiller);
  assert.equal(code, 1);
  assert.equal(logged.length, 0);
  assert.match(errored[0], /busy/i);
});

test('a build held for locked review names the pending directory and fails the command', async (t) => {
  const store = storeWithForget(t, { ok: false, reason: 'no-match', removed: 0, redacted: 0, segments: 0, tombstoneId: null });
  const distiller = fakeDistiller(distillReport({
    status: 'pending', pending: true, published: false, reason: 'a locked record would be re-rendered',
  }));
  const { code, logged } = await captureCli(['distill'], store, null, distiller);
  assert.equal(code, 1);
  assert.match(logged[0], /dist-pending/);
});

test('a published build names its version and the projection path', async (t) => {
  const store = storeWithForget(t, { ok: false, reason: 'no-match', removed: 0, redacted: 0, segments: 0, tombstoneId: null });
  const distiller = fakeDistiller(distillReport({}));
  const { code, logged } = await captureCli(['distill'], store, null, distiller);
  assert.equal(code, 0);
  assert.match(logged[0], /abc123/);
  assert.match(logged[1], /MEMORY\.md/);
});
