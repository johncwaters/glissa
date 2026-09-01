/*
 * Shell-history ingest source, IO shell (docs/plan-ingestion.md, M10). It tails the history files the
 * operator's shells already write and publishes one `command` event per accepted command. Nothing here
 * decides where a shell writes, what a line means, or which commands are noise: that is
 * server/core/ingest-shell-core.js, and where the next read starts is server/core/ingest-tail-core.js.
 *
 * This is the ONE source reading data created outside glissa's own surfaces, which is why it is off by
 * default even with the lane on and why every event goes through the lane's publish-time scrub like any
 * other. It is also the one source that can never name a project: a history file records the command
 * text and nothing else, so every event is machine scope and the digest labels it so.
 *
 * Watchers are lossy WAKEUPS, never truth (the repo's standing invariant): the 2s stat poll over the
 * tracked files is the correctness floor under Windows write-event coalescing, and a watcher that cannot
 * be installed at all costs one warning and leaves the poll doing the whole job. A slower directory
 * sweep is what finds a history file that did not exist when the daemon started.
 *
 * Every tail starts at end of file, so a daemon restart replays nothing.
 */

'use strict';

const fsNode = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { canonicalizePath } = require('../shared/paths.ts');
const {
  HEAD_SAMPLE_BYTES, MAX_CATCH_UP_BYTES, applyRead, createTailState, headChanged, headSample,
  pickStaleByMtime, planRead,
} = require('./core/ingest-tail-core');
const {
  createParseState, decideCommandEvent, historyLocations, matchesLocation, normalizeShells,
  parseHistoryLines,
} = require('./core/ingest-shell-core');
const { positiveInt } = require('./core/ingest-number-core');
const { createLaneLog } = require('./lane-log');

const DEFAULT_POLL_MS = 2000;
const DEFAULT_DISCOVER_MS = 30000;
// PSReadLine writes one file per host, so a machine with a console window, a VS Code terminal and an
// editor extension holds a handful; nothing legitimate approaches this.
const DEFAULT_MAX_TRACKED = 8;
/*
 * Half the ring, deliberately. A genuine append is one command; this bound only ever bites on a 256KB
 * catch-up read, and publishing more commands than the ring holds would evict the newest ones with the
 * oldest ones on their way in while spending movement signal on every one of them.
 */
const DEFAULT_MAX_COMMANDS_PER_DRAIN = 50;
const WATCH_POLL_DEBOUNCE_MS = 100;
const WATCH_SWEEP_DEBOUNCE_MS = 500;

function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

/**
 * @param {{ publish?: (event: Record<string, unknown>) => unknown,
 *   sourceConfig?: { pollMs?: number, shells?: string[] }, logger?: Console,
 *   env?: NodeJS.ProcessEnv, homeDir?: string, platform?: NodeJS.Platform,
 *   fsPromises?: typeof fsNode.promises, watchFn?: typeof fsNode.watch, nowFn?: () => number,
 *   setIntervalFn?: typeof setInterval, clearIntervalFn?: typeof clearInterval,
 *   setTimeoutFn?: typeof setTimeout, clearTimeoutFn?: typeof clearTimeout,
 *   discoverIntervalMs?: number, maxTrackedFiles?: number, maxCommandsPerDrain?: number,
 *   maxCatchUpBytes?: number }} [options]
 */
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
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  discoverIntervalMs = DEFAULT_DISCOVER_MS,
  maxTrackedFiles = DEFAULT_MAX_TRACKED,
  maxCommandsPerDrain = DEFAULT_MAX_COMMANDS_PER_DRAIN,
  maxCatchUpBytes = MAX_CATCH_UP_BYTES,
} = {}) {
  if (typeof publish !== 'function') throw new Error('createShellHistoryIngest requires publish');
  /** @type {(event: Record<string, unknown>) => unknown} */
  const publishEvent = publish;
  // Timing comes from the RESOLVED source config and nowhere else, the M8 rule: a constructor override
  // would be a second place to set it and, since the resolver materializes the key from its defaults, a
  // silently dead one.
  const pollMs = positiveInt(sourceConfig.pollMs, DEFAULT_POLL_MS);
  // Ahead of the rejected-shell check below, which warns during construction.
  const { note, warn } = createLaneLog({ prefix: '[ingest]', logger });
  const locations = historyLocations({ shells: sourceConfig.shells, env, platform, homeDir });
  /*
   * A configured name that matches no known shell is a typo in the one source that must be asked for
   * explicitly, so it is reported rather than absorbed. Said once, at construction: it is a fact about
   * the config, not about the lifecycle, and a source that never starts still has the bad key.
   */
  const rejectedShells = normalizeShells(sourceConfig.shells).rejected;
  if (rejectedShells.length > 0) {
    const nothing = locations.length === 0 ? '; no history file is tailed' : '';
    warn(`shell-history source: unknown shell(s) in sources.shellHistory.shells: ${rejectedShells.join(', ')}${nothing}`);
  }

  const tails = new Map();
  const contexts = new Map();
  const watchers = new Map();
  // The location directories that actually existed on the last sweep, which is exactly the set worth
  // watching: watching a directory fish never created would fail on every reconcile.
  let reachableDirs = [];
  /** @type {NodeJS.Timeout | null} */
  let pollTimer = null;
  /** @type {NodeJS.Timeout | null} */
  let discoverTimer = null;
  /** @type {NodeJS.Timeout | null} */
  let pokeTimer = null;
  /** @type {NodeJS.Timeout | null} */
  let sweepTimer = null;
  let running = false;
  let disabled = false;
  let warnedWatchFailure = false;
  // In-flight guards that HAND BACK the running pass rather than dropping the call, so a watcher wakeup
  // arriving mid-sweep still resolves after the work it asked for is done.
  /** @type {Promise<void> | null} */
  let drainInFlight = null;
  /** @type {Promise<void> | null} */
  let sweepInFlight = null;
  /** @type {Promise<void> | null} */
  let startPromise = null;

  // Every pass re-reads this after each await: stop() must not be undone by work already in flight.
  function alive() {
    return running && !disabled;
  }

  function closeWatcher(watcher) {
    try {
      watcher.close();
    } catch {
      // A watcher whose directory already vanished is closed enough.
    }
  }

  function teardown() {
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

  function clearState() {
    tails.clear();
    contexts.clear();
    reachableDirs = [];
  }

  // One logged warning and the source goes quiet; the lane and every other source keep running, and a
  // restart re-arms everything (docs/plan-ingestion.md, "Adapter failure").
  function disable(reason) {
    if (disabled) return;
    disabled = true;
    running = false;
    teardown();
    warn(`shell-history source disabled: ${reason}`);
  }

  async function runGuarded(fn) {
    if (!alive()) return;
    try {
      await fn();
    } catch (error) {
      disable(error.message);
    }
  }

  async function statOrNull(target) {
    try {
      return await fsPromises.stat(target);
    } catch {
      return null;
    }
  }

  // --- Discovery -----------------------------------------------------------

  async function trackFile(location, filePath, stat) {
    if (tails.has(filePath)) return;
    const head = await readHead(filePath);
    if (!alive() || tails.has(filePath)) return;
    tails.set(filePath, createTailState(stat, { path: filePath, head }));
    contexts.set(filePath, { shell: location.shell, parseState: createParseState(), previous: null });
    note(`shell-history source: tracking ${filePath} (${location.shell}, ${tails.size} files)`);
  }

  async function trackNamedFile(location, seen) {
    const filePath = path.join(location.dir, location.name);
    const stat = await statOrNull(filePath);
    if (!alive() || !stat || !stat.isFile()) return;
    seen.add(filePath);
    await trackFile(location, filePath, stat);
  }

  async function trackMatchingFiles(location, seen) {
    let entries;
    try {
      entries = await fsPromises.readdir(location.dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (!alive()) return;
    for (const entry of entries) {
      if (!entry.isFile() || !matchesLocation(location, entry.name)) continue;
      const filePath = path.join(location.dir, entry.name);
      // Recorded from the listing rather than from a stat, so an already-tracked file costs nothing.
      seen.add(filePath);
      if (tails.has(filePath)) continue;
      const stat = await statOrNull(filePath);
      if (!alive()) return;
      if (!stat || !stat.isFile()) continue;
      await trackFile(location, filePath, stat);
    }
  }

  function forgetFile(filePath) {
    if (!tails.delete(filePath)) return;
    contexts.delete(filePath);
    note(`shell-history source: dropped ${filePath} (${tails.size} files)`);
  }

  function pruneTracked() {
    for (const filePath of pickStaleByMtime(tails, { maxTracked: maxTrackedFiles })) forgetFile(filePath);
  }

  /**
   * A tracked file its own directory no longer holds is gone for good, and keeping its tail would cost
   * a failed stat on every poll forever. A directory that vanished proves nothing about the files that
   * were in it, so only files under a directory THIS sweep could actually read are forgotten.
   */
  function forgetVanished(reachable, seen) {
    for (const filePath of [...tails.keys()]) {
      if (!reachable.includes(path.dirname(filePath)) || seen.has(filePath)) continue;
      forgetFile(filePath);
    }
  }

  async function sweepOnce() {
    const reachable = [];
    const seen = new Set();
    for (const location of locations) {
      if (!alive()) return;
      // One stat per location answers both questions at once: whether there is anything to watch here,
      // and whether to spend a readdir on it. A shell the operator does not have costs exactly this.
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

  function discover() {
    if (sweepInFlight) return sweepInFlight;
    sweepInFlight = sweepOnce().finally(() => { sweepInFlight = null; });
    return sweepInFlight;
  }

  // --- Watching ------------------------------------------------------------

  function installWatch(dir) {
    try {
      // Watched spelling only: an 8.3 short path aborts node in native code (shared/paths.js); `dir` keeps keying reachableDirs and tails.
      const watcher = watchFn(canonicalizePath(dir), { persistent: false }, (eventType) => {
        onWatchEvent(eventType);
      });
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', () => closeWatcher(watcher));
      }
      return watcher;
    } catch (error) {
      /*
       * Graded degradation, and this grade is the mild one: a history file is polled every 2s anyway, so
       * a platform that refuses the watch costs latency and nothing else. Disabling the source over it
       * would throw away working ingestion to avoid a wakeup optimization.
       */
      if (warnedWatchFailure) return null;
      warnedWatchFailure = true;
      warn(`shell-history source: watching ${dir} failed (${error.message}); the ${pollMs}ms stat poll covers it`);
      return null;
    }
  }

  function reconcileWatchers() {
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

  /**
   * A watch event is a wakeup, and its TYPE decides how expensive a wakeup. Only `rename` can mean a
   * history file appeared or was rotated, so only `rename` schedules a sweep; a plain append fires
   * `change` on Windows, and letting that drive a sweep would put a readdir behind every command typed.
   */
  function onWatchEvent(eventType) {
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

  // --- Tailing -------------------------------------------------------------

  async function readAt(handle, position, length) {
    if (length <= 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  }

  // The head is sampled AFTER the range, so a rewrite landing between the two reads is caught by the head rather than published as the range.
  async function readWindow(filePath, { start = 0, length = 0, sampleHead = false } = {}) {
    /** @type {import('node:fs/promises').FileHandle | null} */
    let handle = null;
    try {
      handle = await fsPromises.open(filePath, 'r');
      const bytes = await readAt(handle, start, length);
      const head = sampleHead ? headSample(await readAt(handle, 0, HEAD_SAMPLE_BYTES)) : null;
      return { text: bytes.toString('utf8'), end: start + bytes.length, head };
    } catch {
      // A history file the shell holds locked mid-write leaves the offset where it was, so the next poll
      // retries the same bytes rather than skipping them.
      return null;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function readHead(filePath) {
    const read = await readWindow(filePath, { sampleHead: true });
    if (!read) return null;
    return read.head;
  }

  function publishCommands(filePath, lines) {
    const context = contexts.get(filePath);
    if (!context) return;
    const parsed = parseHistoryLines({ shell: context.shell, lines, state: context.parseState });
    context.parseState = parsed.state;
    /*
     * EVERY parsed command goes through the noise pipeline, and the drain bound is applied to what
     * survived it. Slicing first left `context.previous` describing a command the drain had dropped, so
     * a survivor identical to the one just above it published as new and a real change was judged
     * against the wrong predecessor.
     */
    const events = [];
    for (const command of parsed.commands) {
      const decided = decideCommandEvent({
        shell: context.shell, command, previous: context.previous, now: nowFn(),
      });
      context.previous = decided.previous;
      if (decided.event) events.push(decided.event);
    }
    const bound = positiveInt(maxCommandsPerDrain, DEFAULT_MAX_COMMANDS_PER_DRAIN);
    const recent = events.slice(-bound);
    // The offset already moved past them, so a silent drop would be an invisible hole; the note rides
    // the first surviving event exactly as the agent-log source's dropped-lines note rides its drain.
    const dropped = events.length - recent.length;
    if (dropped > 0) {
      recent[0].summary = `${recent[0].summary} [${dropped} earlier commands dropped]`;
      recent[0].detail = { ...recent[0].detail, droppedCommands: dropped };
    }
    for (const event of recent) publishEvent(event);
  }

  async function reseed(filePath, stat) {
    const context = contexts.get(filePath);
    if (!context) return;
    const head = await readHead(filePath);
    if (!alive() || !contexts.has(filePath)) return;
    tails.set(filePath, createTailState(stat, { path: filePath, head }));
    contexts.set(filePath, { shell: context.shell, parseState: createParseState(), previous: null });
  }

  async function drainFile(filePath) {
    const state = tails.get(filePath);
    if (!state || !contexts.has(filePath)) return;
    const stat = await statOrNull(filePath);
    if (!alive() || !stat) return;
    const plan = planRead(state, stat, { maxCatchUpBytes });
    if (plan.action === 'skip') return;
    /*
     * A truncation or a file recreated at this path RE-BASELINES and publishes nothing. PSReadLine
     * rewrites the whole file when it trims to MaximumHistoryCount (4096 by default), and a rewrite's
     * content is history this tail already had its chance at, so reading it back would flood the ring
     * with thousands of commands the operator ran weeks ago and spend movement signal on every one.
     * The cost is at most the one command that landed in the same rewrite, once per 4096.
     */
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
      // PSReadLine finishes a command that ends in a newline on an EMPTY physical line; dropping it
      // would glue that command to the next one. Rationale in full at splitKeepingEmpty.
      keepEmptyLines: true,
    });
    if (lines.length === 0) return;
    publishCommands(filePath, lines);
  }

  async function drainOnce() {
    for (const filePath of [...tails.keys()]) {
      if (!alive()) return;
      await drainFile(filePath);
    }
  }

  function poll() {
    if (drainInFlight) return drainInFlight;
    drainInFlight = drainOnce().finally(() => { drainInFlight = null; });
    return drainInFlight;
  }

  // --- Lifecycle -----------------------------------------------------------

  // Hands back the FIRST sweep on a repeat call rather than a resolved promise, so a caller that only
  // holds the lane can still wait for discovery to have happened.
  function start() {
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

  // Returns a promise so a caller that wants a settled teardown can await it; the guards above are what
  // actually stop an in-flight pass from repopulating anything, and this clears again once both land.
  function stop() {
    running = false;
    startPromise = null;
    teardown();
    clearState();
    const pending = [sweepInFlight, drainInFlight].filter(Boolean);
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
    // Driven directly by the tests, which need a deterministic sweep and drain rather than a timer race.
    discover: () => runGuarded(discover),
    poll: () => runGuarded(poll),
    get isDisabled() { return disabled; },
    get locations() { return locations.map((location) => ({ ...location })); },
    get trackedCount() { return tails.size; },
    get trackedFiles() { return [...tails.keys()]; },
    get watchCount() { return watchers.size; },
  };
}

module.exports = {
  DEFAULT_DISCOVER_MS,
  DEFAULT_MAX_COMMANDS_PER_DRAIN,
  DEFAULT_MAX_TRACKED,
  DEFAULT_POLL_MS,
  createShellHistoryIngest,
};
