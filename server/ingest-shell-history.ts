
import fsNode from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

import { canonicalizePath } from '../shared/paths.ts';
import {
  HEAD_SAMPLE_BYTES, MAX_CATCH_UP_BYTES, applyRead, createTailState, headChanged, headSample,
  pickStaleByMtime, planRead,
} from './core/ingest-tail-core.ts';
import type { TailState } from './core/ingest-tail-core.ts';
import {
  createParseState, decideCommandEvent, historyLocations, matchesLocation, normalizeShells,
  parseHistoryLines,
} from './core/ingest-shell-core.ts';
import type { HistoryLocation, HistoryParseState, ShellIngestEvent } from './core/ingest-shell-core.ts';
import { positiveInt } from './core/ingest-number-core.ts';
import { createLaneLog } from './lane-log.ts';
import type { LaneLogger } from './lane-log.ts';

const DEFAULT_POLL_MS = 2000;
const DEFAULT_DISCOVER_MS = 30000;
const DEFAULT_MAX_TRACKED = 8;
const DEFAULT_MAX_COMMANDS_PER_DRAIN = 50;
const WATCH_POLL_DEBOUNCE_MS = 100;
const WATCH_SWEEP_DEBOUNCE_MS = 500;

interface ShellHistoryContext {
  shell: string;
  parseState: HistoryParseState;
  previous: string | null;
}

interface DirectoryWatcher {
  close: () => void;
  on?: (event: string, listener: () => void) => unknown;
}

interface ShellHistoryOptions {
  publish?: (event: ShellIngestEvent) => unknown;
  sourceConfig?: { pollMs?: number; shells?: string[] };
  logger?: LaneLogger | null;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  fsPromises?: typeof fsNode.promises;
  watchFn?: (
    dir: string,
    options: { persistent: boolean },
    handler: (eventType: string, fileName: string | null) => void,
  ) => DirectoryWatcher;
  nowFn?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  discoverIntervalMs?: number;
  maxTrackedFiles?: number;
  maxCommandsPerDrain?: number;
  maxCatchUpBytes?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unrefTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

function createShellHistoryIngest({
  publish,
  sourceConfig = {},
  logger = console,
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
  fsPromises = fsNode.promises,
  watchFn = fsNode.watch,
  nowFn = Date.now,
  setIntervalFn = (fn: () => void, ms: number) => setInterval(fn, ms),
  clearIntervalFn = clearInterval,
  setTimeoutFn = (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeoutFn = clearTimeout,
  discoverIntervalMs = DEFAULT_DISCOVER_MS,
  maxTrackedFiles = DEFAULT_MAX_TRACKED,
  maxCommandsPerDrain = DEFAULT_MAX_COMMANDS_PER_DRAIN,
  maxCatchUpBytes = MAX_CATCH_UP_BYTES,
}: ShellHistoryOptions = {}) {
  if (typeof publish !== 'function') throw new Error('createShellHistoryIngest requires publish');
  const publishEvent = publish;
  const pollMs = positiveInt(sourceConfig.pollMs, DEFAULT_POLL_MS);
  const { note, warn } = createLaneLog({ prefix: '[ingest]', logger });
  const locations = historyLocations({ shells: sourceConfig.shells, env, platform, homeDir });
  const rejectedShells = normalizeShells(sourceConfig.shells).rejected;
  if (rejectedShells.length > 0) {
    const nothing = locations.length === 0 ? '; no history file is tailed' : '';
    warn(`shell-history source: unknown shell(s) in sources.shellHistory.shells: ${rejectedShells.join(', ')}${nothing}`);
  }

  const tails = new Map<string, TailState>();
  const contexts = new Map<string, ShellHistoryContext>();
  const watchers = new Map<string, DirectoryWatcher>();
  let reachableDirs: string[] = [];
  let pollTimer: NodeJS.Timeout | null = null;
  let discoverTimer: NodeJS.Timeout | null = null;
  let pokeTimer: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let running = false;
  let disabled = false;
  let warnedWatchFailure = false;
  let drainInFlight: Promise<void> | null = null;
  let sweepInFlight: Promise<void> | null = null;
  let startPromise: Promise<void> | null = null;

  function alive(): boolean {
    return running && !disabled;
  }

  function closeWatcher(watcher: DirectoryWatcher): void {
    try {
      watcher.close();
    } catch {
    }
  }

  function teardown(): void {
    if (pollTimer) clearIntervalFn(pollTimer);
    if (discoverTimer) clearIntervalFn(discoverTimer);
    if (pokeTimer) clearTimeoutFn(pokeTimer);
    if (sweepTimer) clearTimeoutFn(sweepTimer);
    pollTimer = null;
    discoverTimer = null;
    pokeTimer = null;
    sweepTimer = null;
    for (const watcher of watchers.values()) closeWatcher(watcher);
    watchers.clear();
  }

  function clearState(): void {
    tails.clear();
    contexts.clear();
    reachableDirs = [];
  }

  function disable(reason: string): void {
    if (disabled) return;
    disabled = true;
    running = false;
    teardown();
    warn(`shell-history source disabled: ${reason}`);
  }

  async function runGuarded(fn: () => Promise<unknown>): Promise<void> {
    if (!alive()) return;
    try {
      await fn();
    } catch (error) {
      disable(errorMessage(error));
    }
  }

  async function statOrNull(target: string): Promise<fsNode.Stats | null> {
    try {
      return await fsPromises.stat(target);
    } catch {
      return null;
    }
  }


  async function trackFile(location: HistoryLocation, filePath: string, stat: fsNode.Stats): Promise<void> {
    if (tails.has(filePath)) return;
    const head = await readHead(filePath);
    if (!alive() || tails.has(filePath)) return;
    tails.set(filePath, createTailState(stat, { path: filePath, head }));
    contexts.set(filePath, { shell: location.shell, parseState: createParseState(), previous: null });
    note(`shell-history source: tracking ${filePath} (${location.shell}, ${tails.size} files)`);
  }

  async function trackNamedFile(location: HistoryLocation, seen: Set<string>): Promise<void> {
    const filePath = path.join(location.dir, location.name ?? '');
    const stat = await statOrNull(filePath);
    if (!alive() || !stat || !stat.isFile()) return;
    seen.add(filePath);
    await trackFile(location, filePath, stat);
  }

  async function trackMatchingFiles(location: HistoryLocation, seen: Set<string>): Promise<void> {
    let entries: fsNode.Dirent[];
    try {
      entries = await fsPromises.readdir(location.dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (!alive()) return;
    for (const entry of entries) {
      if (!entry.isFile() || !matchesLocation(location, entry.name)) continue;
      const filePath = path.join(location.dir, entry.name);
      seen.add(filePath);
      if (tails.has(filePath)) continue;
      const stat = await statOrNull(filePath);
      if (!alive()) return;
      if (!stat || !stat.isFile()) continue;
      await trackFile(location, filePath, stat);
    }
  }

  function forgetFile(filePath: string): void {
    if (!tails.delete(filePath)) return;
    contexts.delete(filePath);
    note(`shell-history source: dropped ${filePath} (${tails.size} files)`);
  }

  function pruneTracked(): void {
    for (const filePath of pickStaleByMtime(tails, { maxTracked: maxTrackedFiles })) forgetFile(filePath);
  }

  function forgetVanished(reachable: string[], seen: Set<string>): void {
    for (const filePath of [...tails.keys()]) {
      if (!reachable.includes(path.dirname(filePath)) || seen.has(filePath)) continue;
      forgetFile(filePath);
    }
  }

  async function sweepOnce(): Promise<void> {
    const reachable: string[] = [];
    const seen = new Set<string>();
    for (const location of locations) {
      if (!alive()) return;
      const dirStat = await statOrNull(location.dir);
      if (!alive()) return;
      if (!dirStat || !dirStat.isDirectory()) continue;
      if (!reachable.includes(location.dir)) reachable.push(location.dir);
      if (location.name) await trackNamedFile(location, seen);
      if (!location.name) await trackMatchingFiles(location, seen);
      if (!alive()) return;
    }
    reachableDirs = reachable;
    forgetVanished(reachable, seen);
    pruneTracked();
    reconcileWatchers();
  }

  function discover(): Promise<void> {
    if (sweepInFlight) return sweepInFlight;
    sweepInFlight = sweepOnce().finally(() => { sweepInFlight = null; });
    return sweepInFlight;
  }


  function installWatch(dir: string): DirectoryWatcher | null {
    try {
      const watcher = watchFn(canonicalizePath(dir), { persistent: false }, (eventType) => {
        onWatchEvent(eventType);
      });
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', () => closeWatcher(watcher));
      }
      return watcher;
    } catch (error) {
      if (warnedWatchFailure) return null;
      warnedWatchFailure = true;
      warn(`shell-history source: watching ${dir} failed (${errorMessage(error)}); the ${pollMs}ms stat poll covers it`);
      return null;
    }
  }

  function reconcileWatchers(): void {
    if (!alive()) return;
    const keep = new Set(reachableDirs);
    for (const [dir, watcher] of [...watchers]) {
      if (keep.has(dir)) continue;
      closeWatcher(watcher);
      watchers.delete(dir);
    }
    for (const dir of keep) {
      if (watchers.has(dir)) continue;
      const watcher = installWatch(dir);
      if (!watcher) continue;
      watchers.set(dir, watcher);
    }
  }

  function onWatchEvent(eventType: string): void {
    if (!alive()) return;
    if (!pokeTimer) {
      pokeTimer = unrefTimer(setTimeoutFn(() => {
        pokeTimer = null;
        void runGuarded(poll);
      }, WATCH_POLL_DEBOUNCE_MS));
    }
    if (eventType !== 'rename' || sweepTimer) return;
    sweepTimer = unrefTimer(setTimeoutFn(() => {
      sweepTimer = null;
      void runGuarded(discover);
    }, WATCH_SWEEP_DEBOUNCE_MS));
  }


  async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
    if (length <= 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  }

  async function readWindow(filePath: string, { start = 0, length = 0, sampleHead = false }: {
    start?: number;
    length?: number;
    sampleHead?: boolean;
  } = {}): Promise<{ text: string; end: number; head: string | null } | null> {
    let handle: FileHandle | null = null;
    try {
      handle = await fsPromises.open(filePath, 'r');
      const bytes = await readAt(handle, start, length);
      const head = sampleHead ? headSample(await readAt(handle, 0, HEAD_SAMPLE_BYTES)) : null;
      return { text: bytes.toString('utf8'), end: start + bytes.length, head };
    } catch {
      return null;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function readHead(filePath: string): Promise<string | null> {
    const read = await readWindow(filePath, { sampleHead: true });
    if (!read) return null;
    return read.head;
  }

  function publishCommands(filePath: string, lines: string[]): void {
    const context = contexts.get(filePath);
    if (!context) return;
    const parsed = parseHistoryLines({ shell: context.shell, lines, state: context.parseState });
    context.parseState = parsed.state;
    const events: ShellIngestEvent[] = [];
    for (const command of parsed.commands) {
      const decided = decideCommandEvent({
        shell: context.shell, command, previous: context.previous, now: nowFn(),
      });
      context.previous = decided.previous;
      if (decided.event) events.push(decided.event);
    }
    const bound = positiveInt(maxCommandsPerDrain, DEFAULT_MAX_COMMANDS_PER_DRAIN);
    const recent = events.slice(-bound);
    const dropped = events.length - recent.length;
    if (dropped > 0) {
      recent[0].summary = `${recent[0].summary} [${dropped} earlier commands dropped]`;
      recent[0].detail = { ...recent[0].detail, droppedCommands: dropped };
    }
    for (const event of recent) publishEvent(event);
  }

  async function reseed(filePath: string, stat: fsNode.Stats): Promise<void> {
    const context = contexts.get(filePath);
    if (!context) return;
    const head = await readHead(filePath);
    if (!alive() || !contexts.has(filePath)) return;
    tails.set(filePath, createTailState(stat, { path: filePath, head }));
    contexts.set(filePath, { shell: context.shell, parseState: createParseState(), previous: null });
  }

  async function drainFile(filePath: string): Promise<void> {
    const state = tails.get(filePath);
    if (!state || !contexts.has(filePath)) return;
    const stat = await statOrNull(filePath);
    if (!alive() || !stat) return;
    const plan = planRead(state, stat, { maxCatchUpBytes });
    if (plan.action === 'skip') return;
    if (plan.reset) {
      await reseed(filePath, stat);
      return;
    }
    const read = await readWindow(filePath, {
      start: plan.start, length: plan.end - plan.start, sampleHead: plan.sampleHead,
    });
    if (!alive() || !read) return;
    if (headChanged(state, read.head)) {
      await reseed(filePath, stat);
      return;
    }
    const lines = applyRead(state, {
      text: read.text,
      end: read.end,
      stat,
      head: read.head,
      dropPartial: plan.dropPartial,
      keepEmptyLines: true,
    });
    if (lines.length === 0) return;
    publishCommands(filePath, lines);
  }

  async function drainOnce(): Promise<void> {
    for (const filePath of [...tails.keys()]) {
      if (!alive()) return;
      await drainFile(filePath);
    }
  }

  function poll(): Promise<void> {
    if (drainInFlight) return drainInFlight;
    drainInFlight = drainOnce().finally(() => { drainInFlight = null; });
    return drainInFlight;
  }


  function start(): Promise<void> {
    if (startPromise) return startPromise;
    if (disabled) return Promise.resolve();
    running = true;
    pollTimer = unrefTimer(setIntervalFn(() => { void runGuarded(poll); }, pollMs));
    discoverTimer = unrefTimer(setIntervalFn(
      () => { void runGuarded(discover); },
      positiveInt(discoverIntervalMs, DEFAULT_DISCOVER_MS),
    ));
    startPromise = runGuarded(discover);
    return startPromise;
  }

  function stop(): Promise<void> {
    running = false;
    startPromise = null;
    teardown();
    clearState();
    const pending = [sweepInFlight, drainInFlight].filter((entry): entry is Promise<void> => Boolean(entry));
    if (pending.length === 0) return Promise.resolve();
    return Promise.allSettled(pending).then(() => {
      teardown();
      clearState();
    });
  }

  return {
    name: 'shellHistory',
    start,
    stop,
    discover: () => runGuarded(discover),
    poll: () => runGuarded(poll),
    get isDisabled() { return disabled; },
    get locations() { return locations.map((location) => ({ ...location })); },
    get trackedCount() { return tails.size; },
    get trackedFiles() { return [...tails.keys()]; },
    get watchCount() { return watchers.size; },
  };
}

export {
  DEFAULT_DISCOVER_MS,
  DEFAULT_MAX_COMMANDS_PER_DRAIN,
  DEFAULT_MAX_TRACKED,
  DEFAULT_POLL_MS,
  createShellHistoryIngest,
};
export type { ShellHistoryContext, ShellHistoryOptions };
