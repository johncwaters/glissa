
import { createRequire } from 'node:module';
import { canonicalizePath } from '../shared/paths.ts';
import {
  DEFAULT_BATCH_MS, buildIgnorePatterns, createBatch, daemonWriteRules, decideFsEvents, dedupeRoots,
  isIgnoredChange, normalizeRoots, recordChange, relativeWithin,
} from './core/ingest-fs-core.ts';
import type { FsBatch, FsIngestEvent } from './core/ingest-fs-core.ts';
import { positiveInt } from './core/ingest-number-core.ts';
import { createLaneLog } from './lane-log.ts';
import type { LaneLogger } from './lane-log.ts';

const DEFAULT_MAX_ROOTS = 8;
const CONFIG_HOLDER = 'config:fs.roots';

type ParcelWatcherModule = typeof import('@parcel/watcher');
type WatcherModule = Pick<ParcelWatcherModule, 'subscribe'>;
type WatcherSubscription = Awaited<ReturnType<ParcelWatcherModule['subscribe']>>;
type WatchEvent = { path?: string; type?: string };

interface RootSubscription {
  subscription: WatcherSubscription | null;
  batch: FsBatch;
  timer: NodeJS.Timeout | null;
  warnedError: boolean;
}

interface FsIngestOptions {
  publish?: (event: FsIngestEvent) => unknown;
  sourceConfig?: { batchMs?: number; roots?: string[] };
  configPath?: string | null;
  logger?: LaneLogger | null;
  loadWatcher?: () => unknown;
  canonicalize?: (path: string) => string;
  nowFn?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  maxRoots?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unrefTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

const requireFromHere = createRequire(import.meta.url);
function defaultLoadWatcher(): unknown {
  return requireFromHere('@parcel/watcher');
}

function isWatcherModule(value: unknown): value is WatcherModule {
  if (typeof value !== 'object' || value === null) return false;
  return 'subscribe' in value && typeof value.subscribe === 'function';
}

function createFsIngest({
  publish,
  sourceConfig = {},
  configPath = null,
  logger = console,
  loadWatcher = defaultLoadWatcher,
  canonicalize = canonicalizePath,
  nowFn = Date.now,
  setTimeoutFn = (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeoutFn = clearTimeout,
  maxRoots = DEFAULT_MAX_ROOTS,
}: FsIngestOptions = {}) {
  if (typeof publish !== 'function') throw new Error('createFsIngest requires publish');
  const publishEvent = publish;
  const batchMs = positiveInt(sourceConfig.batchMs, DEFAULT_BATCH_MS);
  const rootLimit = Math.max(1, positiveInt(maxRoots, DEFAULT_MAX_ROOTS));
  const ignorePatterns = buildIgnorePatterns();
  const daemonRules = daemonWriteRules(configPath);
  const configuredRoots = normalizeRoots(sourceConfig.roots);

  const wanted = new Map<string, Set<string>>();
  const holderSpellings = new Map<string, string[]>();
  const canonicalCache = new Map<string, string>();
  const subscriptions = new Map<string, RootSubscription>();
  const failedRoots = new Set<string>();
  const warnedOverflow = new Set<string>();

  let watcherModule: WatcherModule | null = null;
  let running = false;
  let disabled = false;
  let stopped = false;
  let warnedRestart = false;
  let chain: Promise<void> = Promise.resolve();
  let startPromise: Promise<void> | null = null;

  function alive(): boolean {
    return running && !disabled;
  }

  const { note, warn } = createLaneLog({ prefix: '[ingest]', logger });

  function disable(reason: string): void {
    if (disabled) return;
    disabled = true;
    running = false;
    warn(`fs source disabled: ${reason}`);
  }

  function loadWatcherModule(): WatcherModule | null {
    if (watcherModule) return watcherModule;
    try {
      const loaded = loadWatcher();
      if (!isWatcherModule(loaded)) throw new Error('no subscribe export');
      watcherModule = loaded;
      return watcherModule;
    } catch (error) {
      disable(`@parcel/watcher could not be loaded (${errorMessage(error)})`);
      return null;
    }
  }


  function flushRoot(root: string): void {
    const entry = subscriptions.get(root);
    if (!entry) return;
    entry.timer = null;
    const events = decideFsEvents(entry.batch, { root, now: nowFn() });
    entry.batch = createBatch();
    if (!alive()) return;
    for (const event of events) publishEvent(event);
  }

  function armFlush(entry: RootSubscription, root: string): void {
    if (entry.timer) return;
    entry.timer = unrefTimer(setTimeoutFn(() => flushRoot(root), batchMs));
  }

  function onWatchEvents(root: string, error: Error | null, events: WatchEvent[]): void {
    const entry = subscriptions.get(root);
    if (!entry || !alive()) return;
    if (error) {
      if (entry.warnedError) return;
      entry.warnedError = true;
      warn(`the watcher for ${root} reported an error (${errorMessage(error)}); it keeps running`);
      return;
    }
    if (!Array.isArray(events) || events.length === 0) return;
    let recorded = false;
    for (const event of events) {
      const relPath = relativeWithin(root, event?.path);
      if (!relPath || isIgnoredChange({ relPath, absolutePath: event?.path, daemonRules })) continue;
      if (recordChange(entry.batch, relPath, event?.type)) recorded = true;
    }
    if (!recorded) return;
    armFlush(entry, root);
  }


  async function subscribeRoot(root: string): Promise<void> {
    const watcher = loadWatcherModule();
    if (!watcher || !alive()) return;
    const entry: RootSubscription = { subscription: null, batch: createBatch(), timer: null, warnedError: false };
    subscriptions.set(root, entry);
    try {
      entry.subscription = await watcher.subscribe(
        root,
        (error, events) => onWatchEvents(root, error, events),
        { ignore: ignorePatterns },
      );
    } catch (error) {
      subscriptions.delete(root);
      if (!failedRoots.has(root)) {
        failedRoots.add(root);
        warn(`fs source: watching ${root} failed (${errorMessage(error)}); that root reports nothing until a restart`);
      }
      return;
    }
    if (subscriptions.get(root) === entry && alive()) {
      note(`fs source: subscribed ${root} (${subscriptions.size} roots watched)`);
      return;
    }
    subscriptions.delete(root);
    await closeSubscription(entry, root);
  }

  async function closeSubscription(entry: RootSubscription, root: string): Promise<void> {
    if (entry.timer) clearTimeoutFn(entry.timer);
    entry.timer = null;
    if (!entry.subscription) return;
    const handle = entry.subscription;
    entry.subscription = null;
    try {
      await handle.unsubscribe();
    } catch (error) {
      warn(`fs source: unsubscribing ${root} failed: ${errorMessage(error)}`);
    }
  }

  async function unsubscribeRoot(root: string): Promise<void> {
    const entry = subscriptions.get(root);
    if (!entry) return;
    subscriptions.delete(root);
    await closeSubscription(entry, root);
    note(`fs source: unsubscribed ${root} (${subscriptions.size} roots watched)`);
  }

  function warnOverflow(dropped: string[]): void {
    const current = new Set(dropped);
    for (const root of [...warnedOverflow]) {
      if (current.has(root)) continue;
      warnedOverflow.delete(root);
    }
    for (const root of dropped) {
      if (warnedOverflow.has(root)) continue;
      warnedOverflow.add(root);
      warn(`fs watch set is full at ${rootLimit} roots, so ${root} is not watched`);
    }
  }

  async function reconcileOnce(): Promise<void> {
    if (!alive()) return;
    const effective = dedupeRoots([...wanted.keys()]);
    warnOverflow(effective.slice(rootLimit));
    const kept = new Set(effective.slice(0, rootLimit));
    for (const root of [...subscriptions.keys()]) {
      if (kept.has(root)) continue;
      await unsubscribeRoot(root);
    }
    for (const root of [...failedRoots]) {
      if (kept.has(root)) continue;
      failedRoots.delete(root);
    }
    for (const root of kept) {
      if (subscriptions.has(root) || failedRoots.has(root)) continue;
      await subscribeRoot(root);
      if (!alive()) return;
    }
  }

  function reconcile(): Promise<void> {
    chain = chain.then(() => reconcileOnce()).catch((error: unknown) => {
      warn(`reconciling the fs watch set failed: ${errorMessage(error)}`);
    });
    return chain;
  }


  function canonicalRootFor(spelling: string): string {
    const cached = canonicalCache.get(spelling);
    if (cached) return cached;
    const resolved = canonicalize(spelling);
    canonicalCache.set(spelling, resolved);
    return resolved;
  }

  function pruneCanonicalCache(): void {
    const stillNamed = new Set<string>();
    for (const spellings of holderSpellings.values()) {
      for (const spelling of spellings) stillNamed.add(spelling);
    }
    for (const spelling of [...canonicalCache.keys()]) {
      if (stillNamed.has(spelling)) continue;
      canonicalCache.delete(spelling);
    }
  }

  function dropHolder(holder: string): boolean {
    const previous = holderSpellings.get(holder);
    if (!previous) return false;
    holderSpellings.delete(holder);
    for (const [root, holders] of wanted) {
      if (!holders.delete(holder)) continue;
      if (holders.size === 0) wanted.delete(root);
    }
    return true;
  }

  function sameSpellings(holder: string, spellings: string[]): boolean {
    const previous = holderSpellings.get(holder);
    if (!previous || previous.length !== spellings.length) return false;
    return previous.every((value, index) => value === spellings[index]);
  }

  function addRoots(holder: unknown, dirs: unknown): boolean {
    const key = typeof holder === 'string' && holder.trim() ? holder.trim() : null;
    if (!key || disabled || stopped) return false;
    const spellings = normalizeRoots(dirs);
    if (spellings.length === 0) return releaseHolder(key);
    if (sameSpellings(key, spellings)) return false;
    dropHolder(key);
    holderSpellings.set(key, spellings);
    for (const spelling of spellings) {
      const root = canonicalRootFor(spelling);
      const holders = wanted.get(root) || new Set<string>();
      holders.add(key);
      wanted.set(root, holders);
    }
    pruneCanonicalCache();
    void reconcile();
    return true;
  }

  function releaseHolder(holder: unknown): boolean {
    const key = typeof holder === 'string' && holder.trim() ? holder.trim() : null;
    if (!key || !dropHolder(key)) return false;
    pruneCanonicalCache();
    void reconcile();
    return true;
  }


  function start(): Promise<void> {
    if (stopped) {
      if (!warnedRestart) {
        warnedRestart = true;
        warn('fs source start() after stop() is a no-op; restart the daemon to re-arm it');
      }
      return Promise.resolve();
    }
    if (startPromise) return startPromise;
    if (disabled) return Promise.resolve();
    running = true;
    if (configuredRoots.length > 0) addRoots(CONFIG_HOLDER, configuredRoots);
    startPromise = reconcile();
    return startPromise;
  }

  function stop(): Promise<void> {
    running = false;
    stopped = true;
    startPromise = null;
    const pending = [...subscriptions.entries()];
    for (const [, entry] of pending) {
      if (entry.timer) clearTimeoutFn(entry.timer);
      entry.timer = null;
    }
    subscriptions.clear();
    wanted.clear();
    holderSpellings.clear();
    canonicalCache.clear();
    failedRoots.clear();
    warnedOverflow.clear();
    chain = chain.then(async () => {
      for (const [root, entry] of pending) await closeSubscription(entry, root);
    }).catch(() => {  });
    return chain;
  }

  return {
    name: 'fs',
    start,
    stop,
    addRoots,
    releaseHolder,
    reconcile: () => reconcile(),
    settle: () => chain,
    get isDisabled() { return disabled; },
    get rootCount() { return subscriptions.size; },
    get roots() { return [...subscriptions.keys()]; },
    get wantedRoots() { return [...wanted.keys()]; },
    get failedRootCount() { return failedRoots.size; },
    get pendingTimerCount() {
      let total = 0;
      for (const entry of subscriptions.values()) total += entry.timer ? 1 : 0;
      return total;
    },
    get pendingFileCount() {
      let total = 0;
      for (const entry of subscriptions.values()) total += entry.batch.files.size;
      return total;
    },
  };
}

export {
  CONFIG_HOLDER,
  DEFAULT_MAX_ROOTS,
  createFsIngest,
};
export type { FsIngestOptions, RootSubscription, WatcherModule };
