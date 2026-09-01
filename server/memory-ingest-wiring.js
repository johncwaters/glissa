'use strict';

/*
 * Memory ingest IO shell (docs/plan-visions-3.md, M14): the one consumer that turns agent-log events into
 * durable records. Its per-tick write batching and its cold-start backfill live here; every decision it
 * makes comes from server/core/memory-ingest-core.js, and its durable offsets live in the store's
 * database beside the canon, so an offset and the records read at it agree by transaction (M12b).
 *
 * It is a TARGET of the agent-log source, never a second copy of it. With the ingest lane running, that
 * lane's source fans out to this consumer; with the ingest lane off, this shell constructs the same source
 * for itself, because `memory.enabled` implies the SOURCE and nothing else: no ring, no broadcast, no
 * digest. Which one happened is stated in the lane log.
 *
 * PRIVACY: remembered text never reaches a log line here. Counts, paths, reasons and verdicts do.
 */

const nodeFs = require('node:fs');
const path = require('node:path');

const {
  createAgentLogIngest, readCodexRoot, rootFromPath, sessionIdFromPath, transcriptRootCandidates,
} = require('./ingest-agent-logs');
const { INTERACTIVE_LANE } = require('./core/usage-lane-core');
const { isBusyError } = require('./glissa-db');
const { isDispatchWorkdir, mapAgentLine } = require('./core/ingest-agent-core.ts');
const { isUsageFile } = require('./core/usage-scan-core');
const { createLaneLog } = require('./lane-log');
const { readKnownProjects } = require('./core/memory-core.ts');
const core = require('./core/memory-ingest-core.ts');

// The usage scanner's budget shape: one pass reads at most this, and what it did not reach is resumable.
const DEFAULT_BACKFILL_BYTE_BUDGET = 8 * 1024 * 1024;
const DEFAULT_BACKFILL_CHUNK_BYTES = 512 * 1024;
const DEFAULT_MAX_BACKFILL_DIRS = 4000;
const DEFAULT_MAX_BACKFILL_FILES = 2000;

function yieldTick() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

// The oldest moment the lane ledger can speak for, or null when it holds nothing to speak with.
function earliestLaneEntryMs(ledger) {
  if (!ledger || typeof ledger.snapshot !== 'function') return null;
  /** @type {number|null} */
  let earliest = null;
  for (const entry of ledger.snapshot()) {
    const ts = Number(entry?.ts);
    if (!Number.isFinite(ts)) continue;
    if (earliest === null || ts < earliest) earliest = ts;
  }
  return earliest;
}

/**
 * @param {{ store?: NonNullable<ReturnType<typeof import('./memory-store').createMemoryStore>>,
 *   logger?: Console, debug?: boolean | (() => boolean), env?: NodeJS.ProcessEnv, fsPromises?: typeof nodeFs.promises,
 *   laneMap?: (() => Map<string, string>) | null, laneFloorMs?: (() => number | null) | null,
 *   nowFn?: () => number, setTimeoutFn?: typeof setTimeout, clearTimeoutFn?: typeof clearTimeout,
 *   maxRecordsPerTick?: number, maxQueued?: number, maxTailEntries?: number,
 *   backfillByteBudget?: number, backfillChunkBytes?: number, maxBackfillDirs?: number,
 *   maxBackfillFiles?: number, vendors?: Record<string, boolean> | null,
 *   knownProjects?: Array<Record<string, unknown>> | (() => Array<Record<string, unknown>>) }} [options]
 */
function createMemoryIngest({
  store,
  logger = console,
  debug = false,
  env = process.env,
  fsPromises = nodeFs.promises,
  laneMap = null,
  /*
   * The oldest moment the lane ledger can speak for. A transcript last written BEFORE it is one the
   * ledger has no entry for and never will, so the live tail's primary feedback-loop exclusion cannot
   * judge it; a pr-review or Radar session from before the ledger existed would otherwise be remembered
   * as the operator's own work. Absent (no ledger, or an empty one) skips nothing, which is the
   * behavior of a machine that has never run one of those lanes.
   */
  laneFloorMs = null,
  nowFn = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  maxRecordsPerTick = core.DEFAULT_MAX_RECORDS_PER_TICK,
  maxQueued = core.DEFAULT_MAX_QUEUED,
  maxTailEntries = core.DEFAULT_MAX_TAIL_ENTRIES,
  backfillByteBudget = DEFAULT_BACKFILL_BYTE_BUDGET,
  backfillChunkBytes = DEFAULT_BACKFILL_CHUNK_BYTES,
  maxBackfillDirs = DEFAULT_MAX_BACKFILL_DIRS,
  maxBackfillFiles = DEFAULT_MAX_BACKFILL_FILES,
  vendors = null,
  knownProjects = [],
} = {}) {
  if (!store || typeof store.append !== 'function') throw new Error('createMemoryIngest requires a memory store');
  const memoryStore = store;
  const log = createLaneLog({ prefix: '[memory-ingest]', logger, debugFlag: debug });
  const statePath = store.dbPath || null;

  const counts = {
    seen: 0, queued: 0, written: 0, rejected: 0, dropped: 0, offsetsSkipped: 0, laneSkipped: 0, refused: 0,
  };
  let queued = [];
  // Offsets a queued batch has not written yet: committing early would lose those records on a crash.
  const pendingTails = new Map();
  /*
   * Transcripts whose records the SUBSTRATE refused, as opposed to records the write gates refused. Their
   * offsets are frozen for the rest of this process: the durable offset stays at or before the lost range,
   * so a later pass re-reads it, and committing any further offset for that file would step over the hole
   * instead. A re-read is free, since a record's id is derived from its own bytes.
   */
  const holedPaths = new Set();
  let tailState = core.normalizeTailState(null);
  /** @type {Promise<{ version: number, files: Record<string, unknown> }>|null} */
  let loadPromise = null;
  /** @type {NodeJS.Timeout|null} */
  let flushTimer = null;
  let flushChain = Promise.resolve();
  /** @type {ReturnType<typeof createAgentLogIngest>|null} */
  let ownSource = null;
  let stopped = false;

  // Starting empty costs the gap, never a duplicate: every unknown file restarts at end of file.
  function loadTailState() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        tailState = core.normalizeTailState(memoryStore.tailState());
      } catch (error) {
        log.warn(`tail state unreadable, starting empty: ${error.message}`);
        tailState = core.normalizeTailState(null);
      }
      return tailState;
    })();
    return loadPromise;
  }

  /*
   * ONE row per transcript, in the same database the records land in, which is what retired the whole-file
   * last-writer-wins race the lockfile existed for: a live server's consumer and a `glissa memory backfill`
   * now write disjoint rows and SQLite arbitrates the rest. A refused write costs a re-read, never a range.
   */
  function commitTail(tail) {
    if (tail?.path && holedPaths.has(tail.path)) {
      log.debugNote(() => `offset held back for ${tail.path}: an earlier range was never remembered`);
      return;
    }
    const entry = { ...tail, ts: nowFn() };
    tailState = core.recordTailOffset(tailState, entry, { maxEntries: maxTailEntries });
    if (memoryStore.saveTailOffset(entry, { maxEntries: maxTailEntries })) return;
    counts.offsetsSkipped += 1;
    log.debugNote(() => `tail state write skipped for ${tail.path}`);
  }

  // --- The live consumer ----------------------------------------------------

  function enqueue(event, tailPath) {
    counts.seen += 1;
    const input = core.memoryInputFromEvent(event, {
      deliveredHashes: memoryStore.deliveredHashes?.() || null,
      knownProjects: readKnownProjects(knownProjects),
    });
    if (!input) return false;
    const outcome = core.enqueueIngestInput(queued, { ...input, tailPath }, { maxQueued });
    queued = outcome.queue;
    counts.queued += 1;
    counts.dropped += outcome.dropped;
    return true;
  }

  function publish(event, tail) {
    if (stopped) return;
    if (!enqueue(event, tail?.path || null)) return;
    scheduleFlush();
  }

  // Deferred while anything is queued for that path, so a crash replays those lines rather than skipping them.
  function noteTail(tail) {
    if (stopped || !tail?.path) return;
    if (queued.some((input) => input.tailPath === tail.path)) {
      pendingTails.set(tail.path, tail);
      return;
    }
    commitTail(tail);
  }

  function scheduleFlush() {
    if (flushTimer || queued.length === 0) return;
    flushTimer = setTimeoutFn(() => {
      flushTimer = null;
      flushChain = flushChain.then(flushQueue).catch((error) => log.warn(`flush failed: ${error.message}`));
    }, 0);
    if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  // A per-tick record cap with a yield between batches: every session on this machine shares one event loop.
  async function flushQueue() {
    while (queued.length > 0 && !stopped) {
      const batch = core.planIngestBatch(queued, { maxPerTick: maxRecordsPerTick });
      queued = batch.rest;
      const outcome = await appendBatch(batch.take);
      counts.written += outcome.written;
      counts.rejected += batch.take.length - outcome.written;
      if (outcome.refused) holdOffsets(batch.take);
      settlePendingTails();
      await yieldTick();
    }
  }

  // Named for what it protects: the range these records came from, which nothing remembered.
  function holdOffsets(inputs) {
    counts.refused += inputs.length;
    for (const input of inputs) {
      if (!input.tailPath || holedPaths.has(input.tailPath)) continue;
      holedPaths.add(input.tailPath);
      pendingTails.delete(input.tailPath);
      log.warn(`the store refused a batch: offsets for that transcript are frozen until the next start`);
    }
  }

  function settlePendingTails() {
    for (const [filePath, tail] of [...pendingTails]) {
      if (queued.some((input) => input.tailPath === filePath)) continue;
      pendingTails.delete(filePath);
      commitTail(tail);
    }
  }

  /*
   * One transaction per tick, and a refused write is a count rather than a throw: this rides the source's
   * drain and the CLI's pass alike. `refused` is the store saying its SUBSTRATE would not take these, which
   * is not the same answer as the write gates refusing every record, and a throw is read the same way.
   */
  async function appendBatch(inputs) {
    const records = inputs.map(({ tailPath, ...record }) => record);
    try {
      const outcome = await memoryStore.appendMany(records);
      const written = (Array.isArray(outcome?.records) ? outcome.records : []).filter(Boolean).length;
      return { written, refused: outcome?.refused === true };
    } catch (error) {
      log.warn(`append failed: ${error.message}`);
      return { written: 0, refused: true };
    }
  }

  // Chains a flush unconditionally: the backfill enqueues without arming the timer a conditional would wait on.
  async function whenIdle() {
    if (flushTimer) clearTimeoutFn(flushTimer);
    flushTimer = null;
    flushChain = flushChain.then(flushQueue).catch((error) => log.warn(`flush failed: ${error.message}`));
    await flushChain;
  }

  // --- The implied source ---------------------------------------------------

  const consumer = {
    name: 'memory',
    userPrompts: true,
    publish,
    noteTail,
  };

  // What `memory.enabled` implies with the ingest lane off: the source alone, no ring and no broadcast.
  function startOwnSource(overrides = {}) {
    if (ownSource || stopped) return ownSource;
    ownSource = createAgentLogIngest({
      consumers: [consumer],
      laneMap,
      logger,
      env,
      fsPromises,
      vendors,
      ...overrides,
    });
    log.note('the agent-log source was constructed for the memory lane alone');
    void ownSource.start();
    return ownSource;
  }

  // --- Cold-start backfill --------------------------------------------------

  function laneIsEphemeral(lanes, sessionId) {
    if (!lanes || !sessionId) return false;
    const lane = lanes.get(sessionId);
    if (!lane) return false;
    return lane !== INTERACTIVE_LANE;
  }

  async function statOrNull(target) {
    try {
      return await fsPromises.stat(target);
    } catch {
      return null;
    }
  }

  async function collectFiles(root, dir, depth, found, budget) {
    if (budget <= 0 || found.length >= maxBackfillFiles) return budget;
    /** @type {import('node:fs').Dirent[]|null} */
    let entries = null;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return budget - 1;
    }
    let left = budget - 1;
    for (const entry of entries) {
      // Inside the loop, not only on entry: one directory of ten thousand transcripts is the whole cap.
      if (found.length >= maxBackfillFiles) return left;
      if (entry.isFile() && isUsageFile(root.vendor, entry.name)) {
        found.push({ root, dir, file: path.join(dir, entry.name) });
        continue;
      }
      if (!entry.isDirectory() || depth >= root.maxDepth) continue;
      // The shape half of the feedback-loop exclusion, same rule the live source walks under.
      if (isDispatchWorkdir(entry.name)) continue;
      left = await collectFiles(root, path.join(dir, entry.name), depth + 1, found, left);
      if (left <= 0) return left;
    }
    return left;
  }

  async function backfillRoots() {
    const roots = [];
    for (const candidate of transcriptRootCandidates(env, vendors || {})) {
      const stat = await statOrNull(candidate.dir);
      if (!stat || !stat.isDirectory()) continue;
      roots.push(candidate);
    }
    return roots;
  }

  async function readRange(filePath, start, length) {
    /** @type {import('node:fs/promises').FileHandle|null} */
    let handle = null;
    try {
      handle = await fsPromises.open(filePath, 'r');
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead);
    } catch {
      return null;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function scopeFor(entry) {
    const sessionId = sessionIdFromPath(entry.root.vendor, entry.dir, entry.file);
    if (entry.root.vendor !== 'codex') return { sessionId, root: rootFromPath(entry.root.vendor, entry.dir) };
    return { sessionId, root: await readCodexRoot(entry.file, fsPromises) };
  }

  // Cut at the last newline IN BYTES, so a chunk boundary inside a multi-byte character corrupts nothing.
  function readLaneFloor() {
    if (typeof laneFloorMs !== 'function') return null;
    try {
      const floor = laneFloorMs();
      return Number.isFinite(floor) ? floor : null;
    } catch (error) {
      log.warn(`lane floor failed: ${error.message}`);
      return null;
    }
  }

  async function backfillFile(entry, budgetBytes, lanes, floorMs) {
    const stat = await statOrNull(entry.file);
    if (!stat || !stat.isFile()) return { bytesRead: 0, partial: false, missing: true };
    if (floorMs !== null && stat.mtimeMs < floorMs) {
      counts.laneSkipped += 1;
      return { bytesRead: 0, partial: false, missing: false };
    }
    const resume = core.decideResumeRead(tailState.files[entry.file], stat);
    if (resume.action !== 'resume' && resume.action !== 'cold') {
      commitTail({ path: entry.file, size: stat.size, mtimeMs: stat.mtimeMs, offset: resume.start });
      return { bytesRead: 0, partial: false, missing: false };
    }
    const plan = core.planBackfillRead({
      start: resume.start, size: stat.size, budgetBytes, maxChunkBytes: backfillChunkBytes,
    });
    if (plan.action !== 'read') return { bytesRead: 0, partial: plan.partial, missing: false };
    const bytes = await readRange(entry.file, plan.start, plan.end - plan.start);
    if (!bytes) return { bytesRead: 0, partial: false, missing: false };
    const lastBreak = bytes.lastIndexOf(0x0a);
    // A chunk with no line break at all is one line longer than the whole chunk: skip past it rather than stall.
    const consumed = lastBreak === -1 ? bytes.length : lastBreak + 1;
    const scope = await scopeFor(entry);
    if (lastBreak !== -1) {
      ingestLines(entry, bytes.subarray(0, consumed).toString('utf8').split(/\r?\n/), scope, lanes);
    }
    commitTail({
      path: entry.file, size: stat.size, mtimeMs: stat.mtimeMs, offset: plan.start + consumed,
    });
    return { bytesRead: bytes.length, partial: plan.partial, missing: false };
  }

  function ingestLines(entry, lines, scope, lanes) {
    let context = { root: scope.root, sessionId: scope.sessionId, vendorState: /** @type {Record<string, string> | null} */ (null) };
    for (const rawLine of lines) {
      if (!rawLine) continue;
      const mapped = mapAgentLine({
        vendor: entry.root.vendor,
        rawLine,
        ctx: { root: context.root, sessionId: context.sessionId, now: nowFn() },
        vendorState: context.vendorState,
        includeUserPrompts: true,
      });
      context = { root: mapped.root, sessionId: mapped.sessionId, vendorState: mapped.vendorState };
      if (mapped.events.length === 0) continue;
      if (laneIsEphemeral(lanes, context.sessionId)) continue;
      if (isDispatchWorkdir(context.root)) continue;
      for (const event of mapped.events) enqueue(event, entry.file);
    }
  }

  /*
   * Safe beside a live server's own pass now that the offsets are rows: both read the same durable
   * offsets and both write disjoint ones, so the pre-M12b refusal is gone. A database busy for the whole
   * timeout is still reported as `locked`, which is what the operator is being told.
   */
  async function backfill({ budgetBytes = backfillByteBudget } = {}) {
    if (stopped) return { ok: false, reason: 'stopped', files: 0, bytesRead: 0, partial: false };
    try {
      return await runBackfill(budgetBytes);
    } catch (error) {
      if (!isBusyError(error)) throw error;
      log.warn('the memory database is busy: no backfill ran');
      return { ok: false, reason: 'locked', files: 0, bytesRead: 0, partial: false };
    }
  }

  async function runBackfill(budgetBytes) {
    await loadTailState();
    const lanes = typeof laneMap === 'function' ? laneMap() : null;
    const floorMs = readLaneFloor();
    const found = [];
    let dirBudget = maxBackfillDirs;
    for (const root of await backfillRoots()) {
      dirBudget = await collectFiles(root, root.dir, 0, found, dirBudget);
    }
    const gone = [];
    let bytesRead = 0;
    let partial = false;
    let files = 0;
    for (const entry of found) {
      if (stopped) break;
      const remaining = budgetBytes - bytesRead;
      if (remaining <= 0) {
        partial = true;
        break;
      }
      const outcome = await backfillFile(entry, remaining, lanes, floorMs);
      if (outcome.missing) gone.push(entry.file);
      bytesRead += outcome.bytesRead;
      files += 1;
      partial = partial || outcome.partial;
      await yieldTick();
    }
    if (gone.length > 0) {
      tailState = core.tailStateForget(tailState, gone);
      memoryStore.forgetTails(gone);
    }
    await whenIdle();
    log.note(
      `backfill read ${bytesRead} byte(s) across ${files} file(s): `
      + `${counts.written} written, ${counts.rejected} rejected, `
      + `${counts.laneSkipped} predating the lane ledger${partial ? ', budget reached' : ''}`
    );
    return { ok: true, reason: null, files, bytesRead, partial };
  }

  // Drains before latching: a queued record is one the source already advanced its offset past.
  async function stop() {
    if (stopped) return;
    if (ownSource) await ownSource.stop();
    ownSource = null;
    await whenIdle();
    settlePendingTails();
    stopped = true;
  }

  return {
    backfill,
    consumer,
    startOwnSource,
    statePath,
    stats: () => ({ ...counts, queued: queued.length, tracked: Object.keys(tailState.files).length }),
    stop,
    tailState: () => core.normalizeTailState(tailState),
    whenIdle,
    get source() { return ownSource; },
  };
}

module.exports = {
  DEFAULT_BACKFILL_BYTE_BUDGET,
  earliestLaneEntryMs,
  DEFAULT_BACKFILL_CHUNK_BYTES,
  createMemoryIngest,
};
