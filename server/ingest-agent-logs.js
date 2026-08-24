/*
 * Agent-log ingest source, IO shell (docs/plan-ingestion.md, M7). It tails the local AI agent CLIs'
 * own transcripts (Claude Code, Codex, Grok) and publishes one summarized event per completed turn or
 * tool call. Nothing here decides what a line means: that is ingest-agent-core.js, and where the next
 * read starts is ingest-tail-core.js.
 *
 * Watchers are lossy WAKEUPS, never truth (the repo's standing invariant): a 2s stat poll over the
 * active files is the correctness floor under Windows write-event coalescing, and a slower directory
 * sweep is what finds a transcript nobody was watching for yet.
 *
 * Every tail starts at end of file, so a daemon restart replays nothing: the rings carry recent
 * activity, and a project directory here can hold hundreds of megabytes of finished conversations.
 *
 * SCALE is the constraint that shapes the sweep. A real projects root holds hundreds of directories and
 * thousands of finished transcripts, so no pass here may cost one stat per transcript: a directory is
 * listed only when its mtime moved or has yet to settle, and a FILE is promotion-checked only once,
 * because an append moves neither. Anything that walks the whole tree every sweep starves the live
 * session it exists to find.
 */

'use strict';

const fsNode = require('node:fs');
const path = require('node:path');

const { canonicalizePath } = require('../shared/paths');
const { claudeProjectsDir } = require('../session/core/conversation-history');
const {
  codexHomes, codexRootCandidates, codexSessionIdFromPath, grokHomes, grokRootCandidates, isUsageFile,
} = require('./core/usage-scan-core');
const { INTERACTIVE_LANE, laneKey } = require('./core/usage-lane-core');
const {
  MAX_CATCH_UP_BYTES, applyRead, canTrustCachedListing, createTailState, isActiveMtime, pickStaleByMtime,
  planRead,
} = require('./core/ingest-tail-core');
const { PROMPT_KIND, isDispatchWorkdir, mapAgentLine } = require('./core/ingest-agent-core');
const { positiveInt } = require('./core/ingest-number-core');
const { createLaneLog } = require('./lane-log');

const DEFAULT_POLL_MS = 2000;
const DEFAULT_DISCOVER_MS = 30000;
const DEFAULT_ACTIVE_WITHIN_MS = 10 * 60 * 1000;
const WATCH_POLL_DEBOUNCE_MS = 100;
const WATCH_SWEEP_DEBOUNCE_MS = 500;
// A Codex rollout names its cwd only in the session_meta and turn_context lines at its head, and the
// first of those carries the whole system prompt, so the bounded head read has to clear that.
const CODEX_HEAD_BYTES = 128 * 1024;

function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

// Grok encodes the session's cwd into its directory name with percent-escapes, which decode exactly.
function decodeGrokRoot(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function sessionIdFromPath(vendor, dir, filePath) {
  if (vendor === 'claude') return path.basename(filePath, '.jsonl');
  if (vendor === 'grok') return path.basename(dir);
  return codexSessionIdFromPath(filePath);
}

function rootFromPath(vendor, dir) {
  if (vendor === 'grok') return decodeGrokRoot(path.basename(path.dirname(dir)));
  // A Claude line carries its own cwd; the raw transcript directory stands in until one arrives.
  if (vendor === 'claude') return dir;
  return null;
}

// Codex nests its rollouts under date directories that name no project, so the cwd is read once from
// the head of the file. Without it every event of a session joined mid-file would be machine scope.
async function readCodexRoot(filePath, fsPromises = fsNode.promises) {
  let handle = null;
  try {
    handle = await fsPromises.open(filePath, 'r');
    const buffer = Buffer.alloc(CODEX_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CODEX_HEAD_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = text.split(/\r?\n/);
    if (bytesRead === CODEX_HEAD_BYTES) lines.pop();
    for (const line of lines) {
      if (!line) continue;
      let parsed = null;
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

/**
 * Every transcript root the usage lane already knows how to resolve, reused rather than re-derived so the
 * two lanes can never disagree about where a vendor keeps its sessions. Pure: it names candidates, and
 * the caller decides which of them exist.
 */
function transcriptRootCandidates(env = process.env, wanted = {}) {
  const candidates = [];
  if (wanted.claude !== false) {
    candidates.push({ vendor: 'claude', dir: claudeProjectsDir(env), maxDepth: 1 });
  }
  if (wanted.codex !== false) {
    /*
     * The active sessions root only. An archived rollout is a session Codex already finished moving
     * away, so it can never append, and skipping it also removes the active-over-archived dedupe the
     * usage lane needs and this one does not.
     */
    for (const candidate of codexRootCandidates(codexHomes(env))) {
      if (candidate.kind !== 'active') continue;
      candidates.push({ vendor: 'codex', dir: candidate.dir, home: candidate.home, maxDepth: 3 });
    }
  }
  if (wanted.grok !== false) {
    for (const candidate of grokRootCandidates(grokHomes(env))) {
      candidates.push({ vendor: 'grok', dir: candidate.dir, maxDepth: 2 });
    }
  }
  return candidates;
}

function createAgentLogIngest({
  publish = null,
  // The M14 fan-out: every target sees the MAPPED event, and user prompts reach only the targets that asked.
  consumers = [],
  sourceConfig = {},
  laneMap = null,
  logger = console,
  env = process.env,
  fsPromises = fsNode.promises,
  watchFn = fsNode.watch,
  nowFn = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  pollIntervalMs = DEFAULT_POLL_MS,
  discoverIntervalMs = DEFAULT_DISCOVER_MS,
  activeWithinMs = DEFAULT_ACTIVE_WITHIN_MS,
  maxActiveFiles = 32,
  maxTrackedFiles = 256,
  // Generous on purpose: evicting a listing costs a re-stat of every file in it, so this is a guard
  // against pathological growth rather than a working set. A real projects root sits well inside it.
  maxCachedDirs = 4096,
  maxWatchedDirs = 48,
  maxScanDirs = 2000,
  maxStatsPerSweep = 400,
  maxLinesPerDrain = 200,
  maxCatchUpBytes = MAX_CATCH_UP_BYTES,
  vendors = null,
} = {}) {
  const targets = [];
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

  const tails = new Map();
  const contexts = new Map();
  const active = new Set();
  // Untracked files a watcher named by a `change` event: the one path back for a transcript that was
  // already quiet when its directory was last listed, since an append moves no directory mtime.
  const probes = new Set();
  const dirCache = new Map();
  const watchers = new Map();
  let pollTimer = null;
  let discoverTimer = null;
  let pokeTimer = null;
  let sweepTimer = null;
  let running = false;
  let disabled = false;
  // In-flight guards that HAND BACK the running pass rather than dropping the call, so a watcher wakeup
  // arriving mid-sweep still resolves after the work it asked for is done.
  let drainInFlight = null;
  let sweepInFlight = null;
  let startPromise = null;
  let watchSupportChecked = false;

  // Every pass re-reads this after each await: stop() must not be undone by work already in flight.
  function alive() {
    return running && !disabled;
  }

  const { warn } = createLaneLog({ prefix: '[ingest]', logger });

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
    active.clear();
    probes.clear();
    dirCache.clear();
  }

  // One logged warning and the source goes quiet; the lane and every other source keep running, and a
  // restart re-arms everything (docs/plan-ingestion.md, "Adapter failure").
  function disable(reason) {
    if (disabled) return;
    disabled = true;
    running = false;
    teardown();
    warn(`agent-log source disabled: ${reason}`);
  }

  async function runGuarded(fn) {
    if (!alive()) return;
    try {
      await fn();
    } catch (error) {
      disable(error.message);
    }
  }

  // --- Roots ---------------------------------------------------------------

  async function statOrNull(target) {
    try {
      return await fsPromises.stat(target);
    } catch {
      return null;
    }
  }

  async function resolveRoots() {
    const roots = [];
    const codexHomesCovered = new Set();
    for (const candidate of transcriptRootCandidates(env, wanted)) {
      const stat = await statOrNull(candidate.dir);
      if (!alive()) return roots;
      if (!stat || !stat.isDirectory()) continue;
      if (candidate.home) codexHomesCovered.add(candidate.home);
      roots.push(candidate);
    }
    if (wanted.codex === false) return roots;
    // ccusage's own fallback: a Codex home with no sessions/ directory keeps its rollouts flat.
    for (const home of codexHomes(env)) {
      if (codexHomesCovered.has(home)) continue;
      const stat = await statOrNull(home);
      if (!alive()) return roots;
      if (!stat || !stat.isDirectory()) continue;
      roots.push({ vendor: 'codex', dir: home, maxDepth: 0 });
    }
    return roots;
  }

  // --- Bookkeeping ---------------------------------------------------------

  function forgetFile(filePath) {
    tails.delete(filePath);
    contexts.delete(filePath);
    active.delete(filePath);
    probes.delete(filePath);
  }

  function forgetDir(dir) {
    const cached = dirCache.get(dir);
    dirCache.delete(dir);
    if (!cached) return;
    for (const name of cached.files) forgetFile(path.join(dir, name));
  }

  // --- Discovery -----------------------------------------------------------

  async function listDir(dir, vendor) {
    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const dirs = [];
    const files = [];
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

  /**
   * Fold a fresh listing into the cache. `pending` is the load-bearing field: only names never
   * promotion-checked before (or left over from an exhausted budget) go in it, so a directory of four
   * hundred finished transcripts is paid for ONCE rather than on every sweep, and a directory whose
   * pending list is empty is skipped entirely. Names that disappeared are forgotten here, which is also
   * how a deleted transcript stops costing a stat every poll.
   */
  function cacheListing(dir, root, previous, listed, mtimeMs) {
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
    const entry = {
      mtimeMs, listedAtMs: nowFn(), root, dirs: listed.dirs, files: listed.files, pending,
    };
    dirCache.set(dir, entry);
    return entry;
  }

  async function walk(root, dir, depth, found, budget) {
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
      // The shape half of the feedback-loop exclusion: a dispatch workdir's transcripts are never even
      // listed, so they cost no stat, no watcher and no tail even when the ledger has not heard of them.
      if (isDispatchWorkdir(name)) continue;
      left = await walk(root, path.join(dir, name), depth + 1, found, left);
      if (!alive()) return left;
    }
    return left;
  }


  /*
   * Feedback-loop exclusion, primary mechanism: the usage-lane ledger (server/usage-lane-ledger.js).
   * A Claude session id Glissa RECORDED spawning under one of its own ephemeral lanes never publishes,
   * or visions dispatch output would re-enter the next visions prompt. The ledger is primary rather
   * than the throwaway-workdir shape because it is the only one that separates the in-place PR-review
   * lane, which runs in the operator's real project directory, from the operator's own work in that
   * same directory; isDispatchWorkdir is the independent second layer for when the ledger has not heard.
   */
  // The ledger map is keyed by the vendor-namespaced composite (M5), so the lookup builds the same key
  // from this transcript's vendor and session id.
  function isEphemeralLane(lanes, vendor, sessionId) {
    if (!lanes || !sessionId) return false;
    const lane = lanes.get(laneKey(vendor, sessionId));
    if (!lane) return false;
    return lane !== INTERACTIVE_LANE;
  }

  function currentLanes() {
    if (typeof laneMap !== 'function') return null;
    return laneMap();
  }

  async function trackFile(root, dir, filePath, stat, lanes) {
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

  /**
   * One promotion check per file, ever. Each name is taken off `pending` as it is checked, so a
   * directory that exhausts the sweep's stat budget resumes where it stopped instead of restarting and
   * starving every directory below it.
   */
  async function promoteDir(entry, statBudget, lanes) {
    const { cached } = entry;
    let budget = statBudget;
    const now = nowFn();
    while (cached.pending.length > 0 && budget > 0 && alive()) {
      const name = cached.pending.shift();
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

  function installWatch(dir) {
    try {
      // Watched spelling only: an 8.3 short path aborts node in native code (shared/paths.js); `dir` keeps keying tails and listings.
      const watcher = watchFn(canonicalizePath(dir), { persistent: false }, (eventType, filename) => {
        onWatchEvent(dir, eventType, filename);
      });
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', () => closeWatcher(watcher));
      }
      return watcher;
    } catch {
      // A directory that vanished between the sweep and the watch is routine, and the poll still covers
      // every file already tracked inside it.
      return null;
    }
  }

  function reconcileWatchers(roots, found) {
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
    // Nothing to watch is not evidence about watching, so the support check waits for a real attempt.
    if (watchSupportChecked || keep.size === 0) return;
    watchSupportChecked = true;
    // Every directory refusing a watch is a platform-level watcher failure rather than a vanished path,
    // and the plan disables the source instead of degrading to a mode nobody asked for.
    if (watchers.size === 0) throw new Error('no transcript directory could be watched');
  }

  function capDirCache() {
    for (const dir of pickStaleByMtime(dirCache, { maxTracked: maxCachedDirs })) dirCache.delete(dir);
  }

  /**
   * The one path back for a tail evicted from the active set, or for a transcript already quiet when
   * its directory was last listed. Bounded by the tracked set, which is itself bounded, and cheap in
   * practice because a machine with a live session has almost nothing quiet and tracked.
   */
  async function refreshQuietTails(statBudget) {
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
      /*
       * Take the fresh mtime onto the state. Only applyRead advances it otherwise, so a re-activated
       * tail would still rank as the oldest thing tracked and the size cap would evict it again on the
       * same pass, which is re-activation that never actually reaches a drain.
       */
      tails.get(filePath).mtimeMs = stat.mtimeMs;
      active.add(filePath);
    }
    return budget;
  }

  async function sweepOnce() {
    const roots = await resolveRoots();
    if (!alive()) return;
    const found = [];
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

  function discover() {
    if (sweepInFlight) return sweepInFlight;
    sweepInFlight = sweepOnce().finally(() => { sweepInFlight = null; });
    return sweepInFlight;
  }

  // --- Tailing -------------------------------------------------------------

  async function readRange(filePath, start, length) {
    let handle = null;
    try {
      handle = await fsPromises.open(filePath, 'r');
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return { text: buffer.subarray(0, bytesRead).toString('utf8'), end: start + bytesRead };
    } catch {
      // A transcript deleted or momentarily locked mid-read leaves the offset where it was, so the next
      // poll retries the same bytes rather than skipping them.
      return null;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  // A throwing target must not reach the source's guard, which would read it as a platform failure.
  function deliver(event, tail) {
    for (const target of targets) {
      if (event.kind === PROMPT_KIND && !target.userPrompts) continue;
      try {
        target.publish(event, tail);
      } catch (error) {
        warn(`the ${target.name} target failed: ${error.message}`);
      }
    }
  }

  function noteTail(tail) {
    for (const target of targets) {
      if (!target.noteTail) continue;
      try {
        target.noteTail(tail);
      } catch (error) {
        warn(`the ${target.name} target failed: ${error.message}`);
      }
    }
  }

  // What a durable-offset consumer needs to resume this file: the identity keys plus where the read ended.
  function tailSnapshot(filePath, context, state) {
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

  function publishLines(filePath, lines, lanes) {
    const context = contexts.get(filePath);
    const state = tails.get(filePath);
    if (!context || !state) return;
    const bound = positiveInt(maxLinesPerDrain, 200);
    const recent = lines.slice(-bound);
    // The offset already moved past them, so a silent drop would be an invisible hole; the note rides
    // the first surviving event exactly as the terminal source's truncation note rides its flush.
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
        /*
         * agentLogs never publishes machine scope. A null root reads as "belongs to no project" in the
         * digest, which is the shellHistory contract, and a rootless agent event would be labelled wrong
         * AND admitted into every project's filtered digest.
         */
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

  // A transcript whose stat fails and whose directory listing no longer names it is gone for good; a
  // stat that merely failed against a live listing is a momentary lock and keeps its offset.
  function forgetIfDeleted(filePath) {
    const cached = dirCache.get(path.dirname(filePath));
    if (!cached) return;
    if (cached.files.includes(path.basename(filePath))) return;
    forgetFile(filePath);
  }

  function resetContext(filePath) {
    const context = contexts.get(filePath);
    if (!context) return;
    // The file at this path is a different file now, so the root and session it revealed go with it.
    context.root = rootFromPath(context.vendor, context.dir);
    context.sessionId = sessionIdFromPath(context.vendor, context.dir, filePath);
  }

  async function drainFile(filePath, lanes) {
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
    // After the events, so a consumer that defers its offset until its own writes land has already seen them.
    if (context) noteTail(tailSnapshot(filePath, context, state));
  }

  /*
   * A file leaves the active set only on the SIZE cap, never on going quiet. Dropping a quiet tail was
   * the idle-session-then-prompt bug: a session left alone past the window would never publish again,
   * which is the ordinary way a carbon unit works.
   */
  function evictStale() {
    for (const filePath of pickStaleByMtime(tails, { maxTracked: maxTrackedFiles })) forgetFile(filePath);
    const bound = Math.max(1, Math.floor(maxActiveFiles));
    if (active.size <= bound) return;
    const ordered = [...active].sort(
      (left, right) => (tails.get(right)?.mtimeMs || 0) - (tails.get(left)?.mtimeMs || 0),
    );
    for (const filePath of ordered.slice(bound)) active.delete(filePath);
  }

  async function drainProbes(lanes) {
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

  async function drainOnce() {
    // One ledger read per drain, never one per line: laneMap rebuilds its Map on every call.
    const lanes = currentLanes();
    await drainProbes(lanes);
    for (const filePath of [...active]) {
      if (!alive()) return;
      await drainFile(filePath, lanes);
    }
  }

  function poll() {
    if (drainInFlight) return drainInFlight;
    drainInFlight = drainOnce().finally(() => { drainInFlight = null; });
    return drainInFlight;
  }

  // --- Lifecycle -----------------------------------------------------------

  function noteProbe(dir, filename) {
    if (typeof filename !== 'string' || !filename) return;
    const cached = dirCache.get(dir);
    if (!cached || !cached.root) return;
    if (!isUsageFile(cached.root.vendor, filename)) return;
    const filePath = path.join(dir, filename);
    if (tails.has(filePath) || probes.size >= Math.max(1, Math.floor(maxActiveFiles))) return;
    probes.add(filePath);
  }

  /**
   * A watch event is a wakeup, and its TYPE decides how expensive a wakeup. Only `rename` can mean a
   * transcript appeared or vanished, so only `rename` schedules a sweep; a plain append fires `change`
   * on Windows, and letting that drive a full sweep put one live session on a tree walk every 500ms.
   */
  function onWatchEvent(dir, eventType, filename) {
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
    name: 'agentLogs',
    start,
    stop,
    // Driven directly by the tests, which need a deterministic sweep and drain rather than a timer race.
    discover: () => runGuarded(discover),
    poll: () => runGuarded(poll),
    get isDisabled() { return disabled; },
    get trackedCount() { return tails.size; },
    get activeCount() { return active.size; },
    get cachedDirCount() { return dirCache.size; },
    get watchCount() { return watchers.size; },
  };
}

module.exports = {
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
