/*
 * The fs ingest source, IO shell (docs/plan-ingestion.md, M9), in two halves.
 *
 * An INJECTED watcher carries every rule that decides whether this source is cheap and safe: the batch
 * window, the ref-counted roots and their subscribe/unsubscribe edges, the nesting collapse, a stop()
 * landing mid-batch and mid-subscribe, and the two grades of degradation. A real watcher would prove none
 * of those, because it would prove them by timing.
 *
 * ONE REAL @parcel/watcher subscription carries the thing no fake can: that the dependency actually loads
 * on this platform, that a write in a real directory arrives, and that a storm inside an ignored tree is
 * refused before it ever reaches this process. It is skipped, not failed, where the native module cannot
 * load, matching how the suite treats git.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createFsIngest } from '../server/ingest-fs.ts';
import type { FsIngestOptions, WatcherModule } from '../server/ingest-fs.ts';
import { createIngestLane } from '../server/ingest-wiring.ts';
import { MAX_FILES_PER_BATCH } from '../server/core/ingest-fs-core.ts';
import type { FsIngestEvent } from '../server/core/ingest-fs-core.ts';
import { resolveIngestConfig } from '../server/core/ingest-core.ts';

const PROJECT = path.resolve('/work/project');

const requireFromHere = createRequire(import.meta.url);

function hasParcelWatcher(): boolean {
  try {
    requireFromHere('@parcel/watcher');
    return true;
  } catch {
    return false;
  }
}

const PARCEL = hasParcelWatcher();

type SubscribeCallback = Parameters<WatcherModule['subscribe']>[1];
type WatchEvent = Parameters<SubscribeCallback>[1][number];
type ChangeKind = WatchEvent['type'];

// --- Harness --------------------------------------------------------------

interface FakeTimers {
  delays: number[];
  setTimeoutFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn: (handle: NodeJS.Timeout) => void;
  runTimeouts: () => void;
  readonly timeoutCount: number;
}

// A real unref'd timer that never runs a callback of its own: the seams are typed against NodeJS.Timeout.
function parkedTimer(): NodeJS.Timeout {
  const handle = setTimeout(() => {}, 2 ** 30);
  handle.unref();
  return handle;
}

// Timers the suite fires by hand. Each handle is a REAL unref'd timer that never runs a callback of its
// own, because the source's seams are typed against NodeJS.Timeout.
function fakeTimers(): FakeTimers {
  const timeouts = new Map<NodeJS.Timeout, () => void>();
  const delays: number[] = [];
  return {
    delays,
    setTimeoutFn: (fn, ms) => {
      const handle = parkedTimer();
      timeouts.set(handle, fn);
      delays.push(ms);
      return handle;
    },
    clearTimeoutFn: (handle) => { clearTimeout(handle); timeouts.delete(handle); },
    runTimeouts: () => {
      const jobs = [...timeouts.values()];
      timeouts.clear();
      for (const fn of jobs) fn();
    },
    get timeoutCount() { return timeouts.size; },
  };
}

interface FakeWatcher {
  subscribed: { root: string; options: unknown }[];
  unsubscribed: string[];
  readonly liveCount: number;
  hold: () => () => void;
  emit: (root: string, events: WatchEvent[]) => void;
  emitError: (root: string, error: Error) => void;
  module: WatcherModule;
}

/**
 * A recording @parcel/watcher. `emit(root, events)` drives the callback the way the native module would,
 * and `hold()` parks every subsequent subscribe on a promise, which is the only way to observe a stop()
 * that lands while a subscription is still being established.
 */
function fakeWatcher({ failOn = (_root: string) => false }: { failOn?: (root: string) => boolean } = {}): FakeWatcher {
  const subscribed: { root: string; options: unknown }[] = [];
  const unsubscribed: string[] = [];
  const callbacks = new Map<string, SubscribeCallback>();
  const held: { gate: Promise<void> | null } = { gate: null };
  return {
    subscribed,
    unsubscribed,
    get liveCount() { return callbacks.size; },
    hold() {
      const release: { resolve: (() => void) | null } = { resolve: null };
      held.gate = new Promise<void>((resolve) => { release.resolve = () => resolve(); });
      return () => {
        held.gate = null;
        if (release.resolve) release.resolve();
      };
    },
    emit(root: string, events: WatchEvent[]) {
      const callback = callbacks.get(root);
      if (!callback) throw new Error(`nothing is watching ${root}`);
      callback(null, events);
    },
    emitError(root: string, error: Error) {
      const callback = callbacks.get(root);
      if (!callback) throw new Error(`nothing is watching ${root}`);
      callback(error, []);
    },
    module: {
      subscribe: async (root, callback, options) => {
        subscribed.push({ root, options });
        if (held.gate) await held.gate;
        if (failOn(root)) throw new Error('EACCES: permission denied');
        callbacks.set(root, callback);
        return {
          unsubscribe: async () => {
            unsubscribed.push(root);
            callbacks.delete(root);
          },
        };
      },
    },
  };
}

// Lets the promise chain advance one turn, which is how a test observes the difference between a
// subscription that is QUEUED and one that is already in flight inside the watcher.
function tick(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

// The ignore list the source registers with, which the native module receives as opaque options.
function subscribeIgnores(entry: { options: unknown } | undefined): string[] {
  const options = entry?.options;
  if (typeof options !== 'object' || options === null || !('ignore' in options)) return [];
  return Array.isArray(options.ignore) ? options.ignore.map(String) : [];
}

// lane.fs is null when the source is off; every case reading it has it on.
function fsOf(lane: ReturnType<typeof createIngestLane>) {
  if (!lane.fs) throw new Error('the fs source is off on this lane');
  return lane.fs;
}

function change(root: string, relPath: string, type: ChangeKind): WatchEvent {
  return { path: path.join(root, relPath), type };
}

interface InjectedSourceOptions {
  watcher: FakeWatcher;
  timers: FakeTimers;
  published: FsIngestEvent[];
  sourceConfig?: { batchMs?: number; roots?: string[] };
  overrides?: Partial<FsIngestOptions>;
}

function injectedSource({ watcher, timers, published, sourceConfig = {}, overrides = {} }: InjectedSourceOptions) {
  return createFsIngest({
    publish: (event) => published.push(event),
    sourceConfig: { batchMs: 500, ...sourceConfig },
    loadWatcher: () => watcher.module,
    // The spelling collapse is shared/paths.ts's contract, not this source's; skipping it keeps the
    // injected half free of any filesystem at all.
    canonicalize: (dir) => dir,
    logger: { warn: () => {} },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    ...overrides,
  });
}

// --- Batching -------------------------------------------------------------

test('a window of writes to one file publishes one event when the batch fires, and not before', async (t) => {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  const source = injectedSource({ watcher, timers, published, sourceConfig: { roots: [PROJECT] } });
  t.after(() => source.stop());
  await source.start();

  watcher.emit(PROJECT, [change(PROJECT, 'src/app.js', 'create')]);
  watcher.emit(PROJECT, [change(PROJECT, 'src/app.js', 'update')]);
  watcher.emit(PROJECT, [change(PROJECT, 'src/app.js', 'update')]);

  assert.equal(published.length, 0, 'nothing publishes before the window settles');
  assert.equal(timers.timeoutCount, 1, 'three bursts arm ONE window');
  assert.deepEqual(timers.delays, [500], 'the window comes from the resolved source config');

  timers.runTimeouts();
  assert.equal(published.length, 1);
  assert.equal(published[0].summary, 'created src/app.js');
  assert.equal(published[0].scope.root, PROJECT);
  assert.equal(timers.timeoutCount, 0, 'a fired window rearms nothing on its own');

  watcher.emit(PROJECT, [change(PROJECT, 'src/app.js', 'update')]);
  assert.equal(timers.timeoutCount, 1, 'the next change arms a fresh window');
  timers.runTimeouts();
  assert.equal(published.length, 2);
  assert.equal(published[1].summary, 'updated src/app.js');
});

test('an event storm inside an ignored directory arms no window at all', async (t) => {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  const source = injectedSource({ watcher, timers, published, sourceConfig: { roots: [PROJECT] } });
  t.after(() => source.stop());
  await source.start();

  // The native ignore already refuses these before this process sees them; the shell re-checks, which is
  // what covers a platform whose glob matching differs and the daemon's own files below.
  const storm: WatchEvent[] = [];
  for (let file = 0; file < 500; file += 1) storm.push(change(PROJECT, `node_modules/dep/file-${file}.js`, 'create'));
  watcher.emit(PROJECT, storm);

  assert.equal(timers.timeoutCount, 0, 'an ignored storm must not even reach the batcher');
  assert.equal(source.pendingFileCount, 0);
  assert.equal(published.length, 0);
});

test('the daemon\'s own state writes are refused, and the watcher is told to ignore the noisy trees', async (t) => {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  const configPath = path.join(PROJECT, 'config.json');
  const source = injectedSource({
    watcher, timers, published, sourceConfig: { roots: [PROJECT] }, overrides: { configPath },
  });
  t.after(() => source.stop());
  await source.start();

  const ignore = subscribeIgnores(watcher.subscribed[0]);
  assert.ok(ignore.includes('**/node_modules/**'));
  assert.ok(ignore.includes('**/.git/**'));
  assert.ok(ignore.includes('**/.glissa/**'), 'the daemon home is refused at registration time');

  // Every write one `wasActive` flip or `resumeSessionId` capture actually makes: the config file, the
  // backup written beside it, and the per-pid temp file the save stages through before its rename.
  watcher.emit(PROJECT, [
    change(PROJECT, 'config.json', 'update'),
    change(PROJECT, 'config.json.bak', 'update'),
    change(PROJECT, 'config.json.boot.bak', 'create'),
    change(PROJECT, `config.json.tmp.${process.pid}`, 'create'),
    change(PROJECT, `config.json.tmp.${process.pid}`, 'delete'),
    change(PROJECT, 'usage-lanes.json', 'update'),
    change(PROJECT, 'recordings/session.jsonl', 'create'),
  ]);
  assert.equal(timers.timeoutCount, 0, 'glissa writing its own bookkeeping is not project activity');

  // A repo file that merely begins the same way is a carbon unit's own file and still publishes.
  watcher.emit(PROJECT, [
    change(PROJECT, 'src/app.js', 'update'),
    change(PROJECT, 'configuration.json', 'update'),
  ]);
  timers.runTimeouts();
  assert.deepEqual(
    published.map((event) => event.summary).sort(),
    ['updated configuration.json', 'updated src/app.js'],
  );
});

test('a burst past the file threshold publishes one summarized event', async (t) => {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  const source = injectedSource({ watcher, timers, published, sourceConfig: { roots: [PROJECT] } });
  t.after(() => source.stop());
  await source.start();

  const burst: WatchEvent[] = [];
  for (let file = 0; file <= MAX_FILES_PER_BATCH; file += 1) burst.push(change(PROJECT, `gen/out-${file}.ts`, 'create'));
  watcher.emit(PROJECT, burst);
  timers.runTimeouts();

  assert.equal(published.length, 1);
  assert.equal(published[0].detail.files, MAX_FILES_PER_BATCH + 1);
});

// --- Ref-counted roots ----------------------------------------------------

test('a root is subscribed when its first holder arrives and unsubscribed when its last one leaves', async (t) => {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  const source = injectedSource({ watcher, timers, published });
  t.after(() => source.stop());
  await source.start();
  assert.equal(source.rootCount, 0, 'with no sessions and no config roots, nothing is watched');

  source.addRoots('session-a', [PROJECT]);
  await source.settle();
  assert.deepEqual(source.roots, [PROJECT]);
  assert.equal(watcher.subscribed.length, 1);

  source.addRoots('session-b', [PROJECT]);
  await source.settle();
  assert.equal(watcher.subscribed.length, 1, 'a second session in the same root joins the existing watch');

  source.releaseHolder('session-a');
  await source.settle();
  assert.deepEqual(source.roots, [PROJECT], 'one holder leaving does not close a watch another one holds');
  assert.deepEqual(watcher.unsubscribed, []);

  source.releaseHolder('session-b');
  await source.settle();
  assert.deepEqual(source.roots, []);
  assert.deepEqual(watcher.unsubscribed, [PROJECT]);
  assert.equal(watcher.liveCount, 0);
});

test('re-registering the same roots costs nothing, which is what makes a per-transition call safe', async (t) => {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  let canonicalizeCalls = 0;
  const source = injectedSource({
    watcher,
    timers,
    published,
    overrides: { canonicalize: (dir) => { canonicalizeCalls += 1; return dir; } },
  });
  t.after(() => source.stop());
  await source.start();

  source.addRoots('session-a', [PROJECT]);
  await source.settle();
  assert.equal(canonicalizeCalls, 1);

  // A session state-change fires on every transition of every session, so this path must not put a sync
  // realpath (or a resubscribe) on the shared event loop each time.
  for (let transition = 0; transition < 25; transition += 1) source.addRoots('session-a', [PROJECT]);
  await source.settle();
  assert.equal(canonicalizeCalls, 1, 'an unchanged holder never re-canonicalizes');
  assert.equal(watcher.subscribed.length, 1, 'and never resubscribes');
});

test('a worktree session widens its own hold to both halves of its checkout', async (t) => {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  const worktree = path.resolve('/work/.glissa-worktrees/project-abc');
  const source = injectedSource({ watcher, timers, published });
  t.after(() => source.stop());
  await source.start();

  source.addRoots('session-a', [PROJECT]);
  await source.settle();
  assert.deepEqual(source.roots, [PROJECT]);

  // Exactly what worktree-ready does: the directory the agent will edit in did not exist a moment ago.
  source.addRoots('session-a', [PROJECT, worktree]);
  await source.settle();
  assert.deepEqual(source.roots.sort(), [PROJECT, worktree].sort());

  source.releaseHolder('session-a');
  await source.settle();
  assert.deepEqual(source.roots, []);
  assert.equal(watcher.unsubscribed.length, 2);
});

test('a root inside another root is never watched twice, and the wider one wins whenever it arrives', async (t) => {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  const nested = path.join(PROJECT, 'packages', 'app');
  const parent = path.resolve('/work');
  const source = injectedSource({ watcher, timers, published });
  t.after(() => source.stop());
  await source.start();

  source.addRoots('session-a', [PROJECT]);
  source.addRoots('session-b', [nested]);
  await source.settle();
  assert.deepEqual(source.roots, [PROJECT], 'a session inside a watched project joins that watch');
  assert.equal(watcher.subscribed.length, 1);

  // An explicit fs.roots entry covering both replaces them rather than doubling every event under it.
  source.addRoots('config:fs.roots', [parent]);
  await source.settle();
  assert.deepEqual(source.roots, [parent]);
  assert.deepEqual(watcher.unsubscribed, [PROJECT]);

  watcher.emit(parent, [change(parent, 'project/src/app.js', 'update')]);
  timers.runTimeouts();
  assert.equal(published.length, 1, 'one change under overlapping roots is still one event');
});

test('the root cap drops the overflow and warns once, never once per reconcile', async (t) => {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  const warnings: string[] = [];
  const source = injectedSource({
    watcher, timers, published, overrides: { maxRoots: 2, logger: { warn: (message: string) => { warnings.push(message); } } },
  });
  t.after(() => source.stop());
  await source.start();

  for (const index of [1, 2, 3]) source.addRoots(`session-${index}`, [path.resolve(`/work/repo-${index}`)]);
  await source.settle();
  assert.equal(source.rootCount, 2);
  assert.equal(warnings.filter((line) => line.includes('watch set is full')).length, 1);

  await source.reconcile();
  await source.reconcile();
  assert.equal(warnings.filter((line) => line.includes('watch set is full')).length, 1, 'the warning is once per key');
});

// --- Lifecycle and degradation --------------------------------------------

test('stop() mid-batch leaks neither a timer nor an event', async (t) => {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  const source = injectedSource({ watcher, timers, published, sourceConfig: { roots: [PROJECT] } });
  t.after(() => source.stop());
  await source.start();

  watcher.emit(PROJECT, [change(PROJECT, 'src/app.js', 'update')]);
  assert.equal(timers.timeoutCount, 1);
  assert.equal(source.pendingFileCount, 1);

  await source.stop();
  assert.equal(timers.timeoutCount, 0, 'a pending window is cancelled, not flushed into a dead lane');
  assert.equal(source.rootCount, 0);
  assert.deepEqual(watcher.unsubscribed, [PROJECT]);
  assert.equal(watcher.liveCount, 0);

  timers.runTimeouts();
  assert.deepEqual(published, [], 'nothing a stopped source held may reach the rings');
});

test('stop() landing mid-subscribe closes the handle it was about to receive', async (t) => {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  const source = injectedSource({ watcher, timers, published, sourceConfig: { roots: [PROJECT] } });
  t.after(() => source.stop());

  const release = watcher.hold();
  const starting = source.start();
  await tick();
  assert.equal(watcher.subscribed.length, 1, 'the subscribe is genuinely in flight');

  const stopping = source.stop();
  release();
  await starting;
  await stopping;

  assert.deepEqual(watcher.unsubscribed, [PROJECT], 'the handle the subscribe returned must not be stranded');
  assert.equal(watcher.liveCount, 0);
  assert.equal(source.rootCount, 0);
});

/*
 * stop() is terminal, and the contract says so rather than half working. The lane never restarts an
 * adapter (a daemon restart re-arms everything), and stop() drops every session hold on the way down, so
 * a start() that came back would be watching only the config roots while every live session went
 * unreported: strictly worse than being inert, because it looks like it is working.
 */
test('start() after stop() stays inert and warns once', async (t) => {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  const warnings: string[] = [];
  const source = injectedSource({
    watcher,
    timers,
    published,
    sourceConfig: { roots: [PROJECT] },
    overrides: { logger: { warn: (message: string) => { warnings.push(message); } } },
  });
  t.after(() => source.stop());
  await source.start();
  source.addRoots('session-a', [path.resolve('/work/repo-a')]);
  await source.settle();
  assert.equal(source.rootCount, 2);

  await source.stop();
  assert.equal(source.rootCount, 0);

  await source.start();
  await source.settle();
  assert.equal(source.rootCount, 0, 'a restart must not come back holding only the config roots');
  assert.equal(watcher.subscribed.length, 2, 'nothing was resubscribed');
  assert.equal(warnings.filter((line) => line.includes('start() after stop()')).length, 1);

  await source.start();
  assert.equal(warnings.filter((line) => line.includes('start() after stop()')).length, 1, 'warned once');

  // And a session arriving after the teardown cannot quietly re-arm it either.
  assert.equal(source.addRoots('session-b', [PROJECT]), false);
  await source.settle();
  assert.equal(source.rootCount, 0);
});

test('a root that cannot be watched degrades that root alone, with one warning', async (t) => {
  const broken = path.resolve('/work/deleted');
  const watcher = fakeWatcher({ failOn: (root) => root === broken });
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  const warnings: string[] = [];
  const source = injectedSource({
    watcher, timers, published, overrides: { logger: { warn: (message: string) => { warnings.push(message); } } },
  });
  t.after(() => source.stop());
  await source.start();

  source.addRoots('session-a', [broken]);
  source.addRoots('session-b', [PROJECT]);
  await source.settle();

  assert.equal(source.isDisabled, false, 'one bad root may never take the source down');
  assert.deepEqual(source.roots, [PROJECT], 'every other root keeps reporting');
  assert.equal(source.failedRootCount, 1);
  assert.equal(warnings.filter((line) => line.includes(broken)).length, 1);

  await source.reconcile();
  assert.equal(warnings.filter((line) => line.includes(broken)).length, 1, 'a failed root is not retried per pass');

  watcher.emit(PROJECT, [change(PROJECT, 'src/app.js', 'update')]);
  timers.runTimeouts();
  assert.equal(published.length, 1);
});

test('a watcher error on a live root warns once and keeps the subscription', async (t) => {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  const warnings: string[] = [];
  const source = injectedSource({
    watcher,
    timers,
    published,
    sourceConfig: { roots: [PROJECT] },
    overrides: { logger: { warn: (message: string) => { warnings.push(message); } } },
  });
  t.after(() => source.stop());
  await source.start();

  watcher.emitError(PROJECT, new Error('EMFILE'));
  watcher.emitError(PROJECT, new Error('EMFILE'));
  assert.equal(warnings.filter((line) => line.includes('reported an error')).length, 1);
  assert.deepEqual(source.roots, [PROJECT]);

  watcher.emit(PROJECT, [change(PROJECT, 'src/app.js', 'update')]);
  timers.runTimeouts();
  assert.equal(published.length, 1, 'a transient error costs a warning, not the root');
});

/*
 * The failure mode the plan's watcher decision record exists for: this is the one source with a native
 * dependency, so a platform with no prebuild is a load-time throw. It must cost the SOURCE and nothing
 * else, which is why the require is lazy and injected.
 */
test('a @parcel/watcher that cannot load disables the source and nothing else', async (t) => {
  const timers = fakeTimers();
  const published: FsIngestEvent[] = [];
  const warnings: string[] = [];
  const source = createFsIngest({
    publish: (event) => published.push(event),
    sourceConfig: { batchMs: 500, roots: [PROJECT] },
    loadWatcher: () => { throw new Error('No prebuild found for this platform'); },
    canonicalize: (dir) => dir,
    logger: { warn: (message: string) => { warnings.push(message); } },
    ...timers,
  });
  t.after(() => source.stop());
  await source.start();

  assert.equal(source.isDisabled, true);
  assert.equal(source.rootCount, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fs source disabled/);
  assert.match(warnings[0], /No prebuild found/);

  // And it stays inert rather than retrying on every session that starts.
  source.addRoots('session-a', [PROJECT]);
  await source.settle();
  assert.equal(source.rootCount, 0);
  assert.equal(warnings.length, 1);
});

test('a module that loads but exports nothing usable is the same graded failure', async (t) => {
  const timers = fakeTimers();
  const warnings: string[] = [];
  const source = createFsIngest({
    publish: () => {},
    sourceConfig: { roots: [PROJECT] },
    loadWatcher: () => ({}),
    canonicalize: (dir) => dir,
    logger: { warn: (message: string) => { warnings.push(message); } },
    ...timers,
  });
  t.after(() => source.stop());
  await source.start();
  assert.equal(source.isDisabled, true);
  assert.match(warnings[0], /no subscribe export/);
});

// --- The lane -------------------------------------------------------------

test('the fs source off constructs nothing, and on it follows session state', async (t) => {
  const off = createIngestLane({
    config: resolveIngestConfig({ enabled: true, sources: { terminal: { enabled: true } } }),
    setIntervalFn: parkedTimer,
    clearIntervalFn: (handle) => { clearTimeout(handle); },
  });
  t.after(() => off.stop());
  assert.equal(off.fsEnabled, false);
  assert.equal(off.fs, null);
  assert.equal(off.noteSessionRoots({ id: 'p1', path: PROJECT, state: 'RUNNING' }), false);

  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const lane = createIngestLane({
    config: resolveIngestConfig({ enabled: true, sources: { fs: { enabled: true } } }),
    setIntervalFn: parkedTimer,
    clearIntervalFn: (handle) => { clearTimeout(handle); },
    fsOptions: { loadWatcher: () => watcher.module, canonicalize: (dir) => dir, logger: { warn: () => {} } },
    ...timers,
  });
  t.after(() => lane.stop());
  assert.equal(lane.fsEnabled, true);

  const sess = { id: 'p1', path: PROJECT, worktreeDir: null, state: 'DORMANT' };
  lane.noteSessionRoots(sess);
  await fsOf(lane).settle();
  assert.deepEqual(fsOf(lane).roots, [], 'a dormant session has started nothing to watch');

  sess.state = 'STARTING';
  lane.noteSessionRoots(sess);
  await fsOf(lane).settle();
  assert.deepEqual(fsOf(lane).roots, [PROJECT]);

  // A published event rides the lane's own publish path, so it is normalized, scrubbed and seq-stamped.
  watcher.emit(PROJECT, [change(PROJECT, 'src/app.js', 'update')]);
  timers.runTimeouts();
  const [event] = lane.recentEvents();
  assert.equal(event.source, 'fs');
  assert.equal(event.summary, 'updated src/app.js');
  assert.ok(event.seq > 0);

  sess.state = 'DONE';
  lane.noteSessionRoots(sess);
  await fsOf(lane).settle();
  assert.deepEqual(fsOf(lane).roots, [], 'an exited session releases its hold');
});

test('an fs event surfaces in the digest as one line', async (t) => {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  const lane = createIngestLane({
    config: resolveIngestConfig({ enabled: true, sources: { fs: { enabled: true } } }),
    setIntervalFn: parkedTimer,
    clearIntervalFn: (handle) => { clearTimeout(handle); },
    fsOptions: { loadWatcher: () => watcher.module, canonicalize: (dir) => dir, logger: { warn: () => {} } },
    nowFn: () => 5000,
    ...timers,
  });
  t.after(() => lane.stop());

  lane.noteSessionRoots({ id: 'p1', path: PROJECT, state: 'RUNNING' });
  await fsOf(lane).settle();
  watcher.emit(PROJECT, [change(PROJECT, 'docs/plan.md', 'update')]);
  timers.runTimeouts();

  assert.match(lane.buildDigest({}), /- files 0s ago: updated docs\/plan\.md/);
});

// --- The real watcher -----------------------------------------------------

/*
 * The one test that proves the dependency itself: a real subscription on a real temp directory, a real
 * write, and a real event. It also proves the registration-time ignore, which is the entire reason this
 * watcher was chosen over recursive fs.watch: 200 writes inside node_modules must never reach this
 * process, on any platform.
 */
test('a real @parcel/watcher subscription reports a real write and refuses an ignored tree', { skip: !PARCEL }, async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-ingest-fs-')));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A Windows watcher can still hold the directory; a leaked temp dir is not a failed test.
    }
  });
  const published: FsIngestEvent[] = [];
  const source = createFsIngest({
    publish: (event) => published.push(event),
    sourceConfig: { batchMs: 50, roots: [dir] },
    logger: { warn: () => {} },
  });
  t.after(() => source.stop());
  await source.start();
  assert.deepEqual(source.roots, [dir], 'the real subscription installed');

  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  for (let file = 0; file < 200; file += 1) {
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep', `file-${file}.js`), 'module.exports = 1;\n', 'utf8');
  }
  fs.writeFileSync(path.join(dir, 'notes.md'), '# notes\n', 'utf8');

  const deadline = Date.now() + 10000;
  while (published.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 50).unref(); });
  }

  /*
   * At least one event, deliberately not exactly one: a real create-plus-update pair can straddle the
   * batch window, and pinning the count here would make this test flake on timing rather than fail on
   * behavior. What it must prove is that the real subscription DELIVERS and that its registration-time
   * ignore HOLDS, so every event that arrived names the one file outside node_modules. The exact
   * coalescing and burst arithmetic live in the injected-watcher tests, where the clock is controlled.
   */
  assert.ok(published.length >= 1, 'the real subscription delivered nothing');
  for (const event of published) {
    assert.equal(event.detail.path, 'notes.md', `an ignored tree leaked through: ${event.summary}`);
    assert.equal(event.scope.root, dir);
  }
});
