
import fsNode from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

import { canonicalizePath } from '../shared/paths.ts';
import { claudeProjectsDir } from '../session/core/conversation-history.ts';
import {
  codexHomes, codexRootCandidates, codexSessionIdFromPath, grokHomes, grokRootCandidates, isUsageFile,
} from './core/usage-scan-core.ts';
import { INTERACTIVE_LANE, laneKey } from './core/usage-lane-core.ts';
import {
  MAX_CATCH_UP_BYTES, applyRead, canTrustCachedListing, createTailState, isActiveMtime, pickStaleByMtime,
  planRead,
} from './core/ingest-tail-core.ts';
import type { TailState } from './core/ingest-tail-core.ts';
import { PROMPT_KIND, isDispatchWorkdir, mapAgentLine } from './core/ingest-agent-core.ts';
import type { AgentIngestEvent } from './core/ingest-agent-core.ts';
import { positiveInt } from './core/ingest-number-core.ts';
import { createLaneLog } from './lane-log.ts';
import type { LaneLogger } from './lane-log.ts';

const DEFAULT_POLL_MS = 2000;
const DEFAULT_DISCOVER_MS = 30000;
const DEFAULT_ACTIVE_WITHIN_MS = 10 * 60 * 1000;
const WATCH_POLL_DEBOUNCE_MS = 100;
const WATCH_SWEEP_DEBOUNCE_MS = 500;
const CODEX_HEAD_BYTES = 128 * 1024;

interface TranscriptRoot {
  vendor: string;
  dir: string;
  home?: string;
  maxDepth: number;
}

interface DirListing {
  dirs: string[];
  files: string[];
}

interface CachedDir {
  mtimeMs: number;
  listedAtMs: number;
  root: TranscriptRoot;
  dirs: string[];
  files: string[];
  pending: string[];
}

interface FoundDir {
  root: TranscriptRoot;
  dir: string;
  mtimeMs: number;
  cached: CachedDir;
}

interface TranscriptContext {
  vendor: string;
  dir: string;
  root: string | null;
  sessionId: string | null;
}

interface TailSnapshot {
  path: string;
  vendor: string;
  root: string | null;
  sessionId: string | null;
  size: number;
  mtimeMs: number;
  offset: number;
}

interface AgentLogConsumer {
  name?: string;
  publish: (event: AgentIngestEvent, tail: TailSnapshot | null) => unknown;
  noteTail?: (entry: TailSnapshot) => void;
  userPrompts?: boolean;
}

interface AgentLogTarget {
  name: string;
  publish: (event: AgentIngestEvent, tail: TailSnapshot) => unknown;
  noteTail?: ((entry: TailSnapshot) => void) | null;
  userPrompts: boolean;
}

interface TranscriptFileSystem {
  open(filePath: string, flags: 'r'): Promise<fsNode.promises.FileHandle>;
  stat(target: string): Promise<fsNode.Stats>;
  readdir(dir: string, options: { withFileTypes: true }): Promise<fsNode.Dirent[]>;
}

interface DirectoryWatcher {
  close: () => void;
  on?: (event: string, listener: () => void) => unknown;
}

interface AgentLogIngestOptions {
  publish?: ((event: AgentIngestEvent, tail: TailSnapshot) => unknown) | null;
  consumers?: AgentLogConsumer[];
  sourceConfig?: { pollMs?: number };
  laneMap?: (() => Map<string, string>) | null;
  logger?: LaneLogger | null;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fsPromises?: TranscriptFileSystem;
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
  pollIntervalMs?: number;
  discoverIntervalMs?: number;
  activeWithinMs?: number;
  maxActiveFiles?: number;
  maxTrackedFiles?: number;
  maxCachedDirs?: number;
  maxWatchedDirs?: number;
  maxScanDirs?: number;
  maxStatsPerSweep?: number;
  maxLinesPerDrain?: number;
  maxCatchUpBytes?: number;
  vendors?: Record<string, boolean> | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unrefTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

function decodeGrokRoot(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function sessionIdFromPath(vendor: string, dir: string, filePath: string): string | null {
  if (vendor === 'claude') return path.basename(filePath, '.jsonl');
  if (vendor === 'grok') return path.basename(dir);
  return codexSessionIdFromPath(filePath);
}

function rootFromPath(vendor: string, dir: string): string | null {
  if (vendor === 'grok') return decodeGrokRoot(path.basename(path.dirname(dir)));
  if (vendor === 'claude') return dir;
  return null;
}

async function readCodexRoot(filePath: string, fsPromises: TranscriptFileSystem = fsNode.promises): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await fsPromises.open(filePath, 'r');
    const buffer = Buffer.alloc(CODEX_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CODEX_HEAD_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = text.split(/\r?\n/);
    if (bytesRead === CODEX_HEAD_BYTES) lines.pop();
    for (const line of lines) {
      if (!line) continue;
      let parsed: { payload?: { cwd?: unknown } } | null = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const cwd = parsed?.payload?.cwd;
      if (typeof cwd === 'string' && cwd.trim()) return cwd.trim();
    }
    return null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function transcriptRootCandidates(
  env: NodeJS.ProcessEnv = process.env,
  wanted: Record<string, boolean> = {},
  homeDir: string = os.homedir(),
): TranscriptRoot[] {
  const candidates: TranscriptRoot[] = [];
  if (wanted.claude !== false) {
    candidates.push({ vendor: 'claude', dir: claudeProjectsDir(env, homeDir), maxDepth: 1 });
  }
  if (wanted.codex !== false) {
    for (const candidate of codexRootCandidates(codexHomes(env, homeDir))) {
      if (candidate.kind !== 'active') continue;
      candidates.push({ vendor: 'codex', dir: candidate.dir, home: candidate.home, maxDepth: 3 });
    }
  }
  if (wanted.grok !== false) {
    for (const candidate of grokRootCandidates(grokHomes(env, homeDir))) {
      candidates.push({ vendor: 'grok', dir: candidate.dir, maxDepth: 2 });
    }
  }
  return candidates;
}

function createAgentLogIngest({
  publish = null,
  consumers = [],
  sourceConfig = {},
  laneMap = null,
  logger = console,
  env = process.env,
  homeDir = os.homedir(),
  fsPromises = fsNode.promises,
  watchFn = fsNode.watch,
  nowFn = Date.now,
  setIntervalFn = (fn: () => void, ms: number) => setInterval(fn, ms),
  clearIntervalFn = clearInterval,
  setTimeoutFn = (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeoutFn = clearTimeout,
  pollIntervalMs = DEFAULT_POLL_MS,
  discoverIntervalMs = DEFAULT_DISCOVER_MS,
  activeWithinMs = DEFAULT_ACTIVE_WITHIN_MS,
  maxActiveFiles = 32,
  maxTrackedFiles = 256,
  maxCachedDirs = 4096,
  maxWatchedDirs = 48,
  maxScanDirs = 2000,
  maxStatsPerSweep = 400,
  maxLinesPerDrain = 200,
  maxCatchUpBytes = MAX_CATCH_UP_BYTES,
  vendors = null,
}: AgentLogIngestOptions = {}) {
  const targets: AgentLogTarget[] = [];
  if (typeof publish === 'function') targets.push({ name: 'ring', publish, userPrompts: false });
  for (const consumer of Array.isArray(consumers) ? consumers : []) {
    if (typeof consumer?.publish !== 'function') continue;
    targets.push({
      name: consumer.name || 'consumer',
      publish: consumer.publish,
      noteTail: typeof consumer.noteTail === 'function' ? consumer.noteTail : null,
      userPrompts: consumer.userPrompts === true,
    });
  }
  if (targets.length === 0) throw new Error('createAgentLogIngest requires a publish target');
  const wantsUserPrompts = targets.some((target) => target.userPrompts);
  const pollMs = positiveInt(sourceConfig.pollMs, positiveInt(pollIntervalMs, DEFAULT_POLL_MS));
  const wanted = vendors && typeof vendors === 'object' ? vendors : {};

  const tails = new Map<string, TailState>();
  const contexts = new Map<string, TranscriptContext>();
  const active = new Set<string>();
  const probes = new Set<string>();
  const dirCache = new Map<string, CachedDir>();
  const watchers = new Map<string, DirectoryWatcher>();
  let pollTimer: NodeJS.Timeout | null = null;
  let discoverTimer: NodeJS.Timeout | null = null;
  let pokeTimer: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let running = false;
  let disabled = false;
  let drainInFlight: Promise<void> | null = null;
  let sweepInFlight: Promise<void> | null = null;
  let startPromise: Promise<void> | null = null;
  let watchSupportChecked = false;

  function alive(): boolean {
    return running && !disabled;
  }

  const { warn } = createLaneLog({ prefix: '[ingest]', logger });

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
    active.clear();
    probes.clear();
    dirCache.clear();
  }

  function disable(reason: string): void {
    if (disabled) return;
    disabled = true;
    running = false;
    teardown();
    warn(`agent-log source disabled: ${reason}`);
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

  async function resolveRoots(): Promise<TranscriptRoot[]> {
    const roots: TranscriptRoot[] = [];
    const codexHomesCovered = new Set<string>();
    for (const candidate of transcriptRootCandidates(env, wanted, homeDir)) {
      const stat = await statOrNull(candidate.dir);
      if (!alive()) return roots;
      if (!stat || !stat.isDirectory()) continue;
      if (candidate.home) codexHomesCovered.add(candidate.home);
      roots.push(candidate);
    }
    if (wanted.codex === false) return roots;
    for (const home of codexHomes(env, homeDir)) {
      if (codexHomesCovered.has(home)) continue;
      const stat = await statOrNull(home);
      if (!alive()) return roots;
      if (!stat || !stat.isDirectory()) continue;
      roots.push({ vendor: 'codex', dir: home, maxDepth: 0 });
    }
    return roots;
  }


  function forgetFile(filePath: string): void {
    tails.delete(filePath);
    contexts.delete(filePath);
    active.delete(filePath);
    probes.delete(filePath);
  }

  function forgetDir(dir: string): void {
    const cached = dirCache.get(dir);
    dirCache.delete(dir);
    if (!cached) return;
    for (const name of cached.files) forgetFile(path.join(dir, name));
  }


  async function listDir(dir: string, vendor: string): Promise<DirListing | null> {
    let entries: fsNode.Dirent[];
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const dirs: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(entry.name);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isUsageFile(vendor, entry.name)) continue;
      files.push(entry.name);
    }
    return { dirs, files };
  }

  function cacheListing(
    dir: string,
    root: TranscriptRoot,
    previous: CachedDir | undefined,
    listed: DirListing,
    mtimeMs: number,
  ): CachedDir {
    const previousFiles = new Set(previous ? previous.files : []);
    const previousPending = new Set(previous ? previous.pending : []);
    const currentFiles = new Set(listed.files);
    const pending = listed.files.filter(
      (name) => !previousFiles.has(name) || previousPending.has(name),
    );
    for (const name of previousFiles) {
      if (currentFiles.has(name)) continue;
      forgetFile(path.join(dir, name));
    }
    const entry: CachedDir = {
      mtimeMs, listedAtMs: nowFn(), root, dirs: listed.dirs, files: listed.files, pending,
    };
    dirCache.set(dir, entry);
    return entry;
  }

  async function walk(root: TranscriptRoot, dir: string, depth: number, found: FoundDir[], budget: number): Promise<number> {
    if (budget <= 0 || !alive()) return budget;
    const remaining = budget - 1;
    const stat = await statOrNull(dir);
    if (!alive()) return remaining;
    if (!stat || !stat.isDirectory()) {
      forgetDir(dir);
      return remaining;
    }
    let cached = dirCache.get(dir);
    if (!cached || cached.mtimeMs !== stat.mtimeMs || !canTrustCachedListing(cached)) {
      const listed = await listDir(dir, root.vendor);
      if (!alive() || !listed) return remaining;
      cached = cacheListing(dir, root, cached, listed, stat.mtimeMs);
    }
    found.push({ root, dir, mtimeMs: stat.mtimeMs, cached });
    if (depth >= root.maxDepth) return remaining;
    let left = remaining;
    for (const name of cached.dirs) {
      if (isDispatchWorkdir(name)) continue;
      left = await walk(root, path.join(dir, name), depth + 1, found, left);
      if (!alive()) return left;
    }
    return left;
  }


  function isEphemeralLane(lanes: Map<string, string> | null, vendor: string, sessionId: string | null): boolean {
    if (!lanes || !sessionId) return false;
    const lane = lanes.get(laneKey(vendor, sessionId));
    if (!lane) return false;
    return lane !== INTERACTIVE_LANE;
  }

  function currentLanes(): Map<string, string> | null {
    if (typeof laneMap !== 'function') return null;
    return laneMap();
  }

  async function trackFile(
    root: TranscriptRoot,
    dir: string,
    filePath: string,
    stat: fsNode.Stats,
    lanes: Map<string, string> | null,
  ): Promise<void> {
    const sessionId = sessionIdFromPath(root.vendor, dir, filePath);
    if (isEphemeralLane(lanes, root.vendor, sessionId)) return;
    let scopeRoot = rootFromPath(root.vendor, dir);
    if (root.vendor === 'codex') scopeRoot = await readCodexRoot(filePath, fsPromises);
    if (!alive()) return;
    if (isDispatchWorkdir(scopeRoot)) return;
    tails.set(filePath, createTailState(stat, { path: filePath }));
    contexts.set(filePath, {
      vendor: root.vendor, dir, root: scopeRoot, sessionId,
    });
    active.add(filePath);
  }

  async function promoteDir(entry: FoundDir, statBudget: number, lanes: Map<string, string> | null): Promise<number> {
    const { cached } = entry;
    let budget = statBudget;
    const now = nowFn();
    while (cached.pending.length > 0 && budget > 0 && alive()) {
      const name = cached.pending.shift();
      if (name === undefined) break;
      budget -= 1;
      const filePath = path.join(entry.dir, name);
      if (tails.has(filePath)) continue;
      const stat = await statOrNull(filePath);
      if (!alive()) return budget;
      if (!stat || !stat.isFile()) continue;
      if (!isActiveMtime(stat.mtimeMs, { now, withinMs: activeWithinMs })) continue;
      await trackFile(entry.root, entry.dir, filePath, stat, lanes);
    }
    return budget;
  }

  function installWatch(dir: string): DirectoryWatcher | null {
    try {
      const watcher = watchFn(canonicalizePath(dir), { persistent: false }, (eventType, filename) => {
        onWatchEvent(dir, eventType, filename);
      });
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', () => closeWatcher(watcher));
      }
      return watcher;
    } catch {
      return null;
    }
  }

  function reconcileWatchers(roots: TranscriptRoot[], found: FoundDir[]): void {
    if (!alive()) return;
    const keep = new Set(roots.map((root) => root.dir));
    for (const entry of found.slice(0, Math.max(0, maxWatchedDirs))) keep.add(entry.dir);
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
    if (watchSupportChecked || keep.size === 0) return;
    watchSupportChecked = true;
    if (watchers.size === 0) throw new Error('no transcript directory could be watched');
  }

  function capDirCache(): void {
    for (const dir of pickStaleByMtime(dirCache, { maxTracked: maxCachedDirs })) dirCache.delete(dir);
  }

  async function refreshQuietTails(statBudget: number): Promise<number> {
    let budget = statBudget;
    const now = nowFn();
    const quiet = [...tails.keys()].filter((filePath) => !active.has(filePath));
    quiet.sort((left, right) => (tails.get(right)?.mtimeMs || 0) - (tails.get(left)?.mtimeMs || 0));
    for (const filePath of quiet) {
      if (budget <= 0 || !alive()) return budget;
      budget -= 1;
      const stat = await statOrNull(filePath);
      if (!alive()) return budget;
      if (!stat) continue;
      if (!isActiveMtime(stat.mtimeMs, { now, withinMs: activeWithinMs })) continue;
      const reactivated = tails.get(filePath);
      if (reactivated) reactivated.mtimeMs = stat.mtimeMs;
      active.add(filePath);
    }
    return budget;
  }

  async function sweepOnce(): Promise<void> {
    const roots = await resolveRoots();
    if (!alive()) return;
    const found: FoundDir[] = [];
    let budget = positiveInt(maxScanDirs, 2000);
    for (const root of roots) {
      budget = await walk(root, root.dir, 0, found, budget);
      if (!alive()) return;
    }
    found.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const lanes = currentLanes();
    let stats = positiveInt(maxStatsPerSweep, 400);
    for (const entry of found) {
      if (stats <= 0) break;
      stats = await promoteDir(entry, stats, lanes);
      if (!alive()) return;
    }
    stats = await refreshQuietTails(stats);
    if (!alive()) return;
    evictStale();
    capDirCache();
    reconcileWatchers(roots, found);
  }

  function discover(): Promise<void> {
    if (sweepInFlight) return sweepInFlight;
    sweepInFlight = sweepOnce().finally(() => { sweepInFlight = null; });
    return sweepInFlight;
  }


  async function readRange(filePath: string, start: number, length: number): Promise<{ text: string; end: number } | null> {
    let handle: FileHandle | null = null;
    try {
      handle = await fsPromises.open(filePath, 'r');
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return { text: buffer.subarray(0, bytesRead).toString('utf8'), end: start + bytesRead };
    } catch {
      return null;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  function deliver(event: AgentIngestEvent, tail: TailSnapshot): void {
    for (const target of targets) {
      if (event.kind === PROMPT_KIND && !target.userPrompts) continue;
      try {
        target.publish(event, tail);
      } catch (error) {
        warn(`the ${target.name} target failed: ${errorMessage(error)}`);
      }
    }
  }

  function noteTail(tail: TailSnapshot): void {
    for (const target of targets) {
      if (!target.noteTail) continue;
      try {
        target.noteTail(tail);
      } catch (error) {
        warn(`the ${target.name} target failed: ${errorMessage(error)}`);
      }
    }
  }

  function tailSnapshot(filePath: string, context: TranscriptContext, state: TailState): TailSnapshot {
    return {
      path: filePath,
      vendor: context.vendor,
      root: context.root,
      sessionId: context.sessionId,
      size: state.size,
      mtimeMs: state.mtimeMs,
      offset: state.offset,
    };
  }

  function publishLines(filePath: string, lines: string[], lanes: Map<string, string> | null): void {
    const context = contexts.get(filePath);
    const state = tails.get(filePath);
    if (!context || !state) return;
    const bound = positiveInt(maxLinesPerDrain, 200);
    const recent = lines.slice(-bound);
    let droppedLines = lines.length - recent.length;
    for (const rawLine of recent) {
      const mapped = mapAgentLine({
        vendor: context.vendor,
        rawLine,
        ctx: { root: context.root, sessionId: context.sessionId, now: nowFn() },
        vendorState: state.vendorState,
        includeUserPrompts: wantsUserPrompts,
      });
      state.vendorState = mapped.vendorState;
      context.root = mapped.root;
      context.sessionId = mapped.sessionId;
      if (mapped.events.length === 0) continue;
      if (isEphemeralLane(lanes, context.vendor, context.sessionId)) continue;
      if (isDispatchWorkdir(context.root)) continue;
      for (const event of mapped.events) {
        if (!event.scope.root) continue;
        if (droppedLines > 0) {
          event.summary = `${event.summary} [${droppedLines} earlier lines dropped]`;
          event.detail = { ...event.detail, droppedLines };
          droppedLines = 0;
        }
        deliver(event, tailSnapshot(filePath, context, state));
      }
    }
  }

  function forgetIfDeleted(filePath: string): void {
    const cached = dirCache.get(path.dirname(filePath));
    if (!cached) return;
    if (cached.files.includes(path.basename(filePath))) return;
    forgetFile(filePath);
  }

  function resetContext(filePath: string): void {
    const context = contexts.get(filePath);
    if (!context) return;
    context.root = rootFromPath(context.vendor, context.dir);
    context.sessionId = sessionIdFromPath(context.vendor, context.dir, filePath);
  }

  async function drainFile(filePath: string, lanes: Map<string, string> | null): Promise<void> {
    const state = tails.get(filePath);
    if (!state) {
      active.delete(filePath);
      return;
    }
    const stat = await statOrNull(filePath);
    if (!alive()) return;
    if (!stat) {
      forgetIfDeleted(filePath);
      return;
    }
    const plan = planRead(state, stat, { maxCatchUpBytes });
    if (plan.action === 'skip') return;
    let text = '';
    let end = plan.end;
    if (plan.action === 'read') {
      const read = await readRange(filePath, plan.start, plan.end - plan.start);
      if (!alive()) return;
      if (!read) return;
      text = read.text;
      end = read.end;
    }
    if (plan.reset) resetContext(filePath);
    const lines = applyRead(state, { text, end, stat, reset: plan.reset, dropPartial: plan.dropPartial });
    if (lines.length === 0) return;
    publishLines(filePath, lines, lanes);
    const context = contexts.get(filePath);
    if (context) noteTail(tailSnapshot(filePath, context, state));
  }

  function evictStale(): void {
    for (const filePath of pickStaleByMtime(tails, { maxTracked: maxTrackedFiles })) forgetFile(filePath);
    const bound = Math.max(1, Math.floor(maxActiveFiles));
    if (active.size <= bound) return;
    const ordered = [...active].sort(
      (left, right) => (tails.get(right)?.mtimeMs || 0) - (tails.get(left)?.mtimeMs || 0),
    );
    for (const filePath of ordered.slice(bound)) active.delete(filePath);
  }

  async function drainProbes(lanes: Map<string, string> | null): Promise<void> {
    const now = nowFn();
    for (const filePath of [...probes]) {
      probes.delete(filePath);
      if (!alive()) return;
      if (tails.has(filePath)) continue;
      const cached = dirCache.get(path.dirname(filePath));
      if (!cached || !cached.root) continue;
      const stat = await statOrNull(filePath);
      if (!alive()) return;
      if (!stat || !stat.isFile()) continue;
      if (!isActiveMtime(stat.mtimeMs, { now, withinMs: activeWithinMs })) continue;
      await trackFile(cached.root, path.dirname(filePath), filePath, stat, lanes);
    }
  }

  async function drainOnce(): Promise<void> {
    const lanes = currentLanes();
    await drainProbes(lanes);
    for (const filePath of [...active]) {
      if (!alive()) return;
      await drainFile(filePath, lanes);
    }
  }

  function poll(): Promise<void> {
    if (drainInFlight) return drainInFlight;
    drainInFlight = drainOnce().finally(() => { drainInFlight = null; });
    return drainInFlight;
  }


  function noteProbe(dir: string, filename: unknown): void {
    if (typeof filename !== 'string' || !filename) return;
    const cached = dirCache.get(dir);
    if (!cached || !cached.root) return;
    if (!isUsageFile(cached.root.vendor, filename)) return;
    const filePath = path.join(dir, filename);
    if (tails.has(filePath) || probes.size >= Math.max(1, Math.floor(maxActiveFiles))) return;
    probes.add(filePath);
  }

  function onWatchEvent(dir: string, eventType: string, filename: string | Buffer | null): void {
    if (!alive()) return;
    if (eventType !== 'rename') noteProbe(dir, filename);
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
    name: 'agentLogs',
    start,
    stop,
    discover: () => runGuarded(discover),
    poll: () => runGuarded(poll),
    get isDisabled() { return disabled; },
    get trackedCount() { return tails.size; },
    get activeCount() { return active.size; },
    get cachedDirCount() { return dirCache.size; },
    get watchCount() { return watchers.size; },
  };
}

export {
  CODEX_HEAD_BYTES,
  DEFAULT_ACTIVE_WITHIN_MS,
  DEFAULT_DISCOVER_MS,
  DEFAULT_POLL_MS,
  createAgentLogIngest,
  readCodexRoot,
  rootFromPath,
  sessionIdFromPath,
  transcriptRootCandidates,
};
export type {
  AgentLogConsumer,
  AgentLogIngestOptions,
  TranscriptFileSystem,
  CachedDir,
  TailSnapshot,
  TranscriptContext,
  TranscriptRoot,
};
