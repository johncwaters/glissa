'use strict';

/*
 * Memory ingest IO shell (docs/plan-visions-3.md, M14): the one consumer that turns agent-log events into
 * durable records. It owns its tail-state file, its per-tick write batching and its cold-start backfill;
 * every decision it makes comes from server/core/memory-ingest-core.js.
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
const { isDispatchWorkdir, mapAgentLine } = require('./core/ingest-agent-core');
const { isUsageFile } = require('./core/usage-scan-core');
const { createJsonStateWriter } = require('./json-file');
const { createLaneLog } = require('./lane-log');
const core = require('./core/memory-ingest-core');

const TAIL_STATE_FILE = 'tail-state.json';
// The usage scanner's budget shape: one pass reads at most this, and what it did not reach is resumable.
const DEFAULT_BACKFILL_BYTE_BUDGET = 8 * 1024 * 1024;
const DEFAULT_BACKFILL_CHUNK_BYTES = 512 * 1024;
const DEFAULT_MAX_BACKFILL_DIRS = 4000;
const DEFAULT_MAX_BACKFILL_FILES = 2000;

function yieldTick() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function createMemoryIngest({
  store,
  stateDir = store?.dir || null,
  logger = console,
  debug = false,
  env = process.env,
  fsPromises = nodeFs.promises,
  laneMap = null,
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
} = {}) {
  if (!store || typeof store.append !== 'function') throw new Error('createMemoryIngest requires a memory store');
  const log = createLaneLog({ prefix: '[memory-ingest]', logger, debugFlag: debug });
  const statePath = stateDir ? path.join(stateDir, TAIL_STATE_FILE) : null;
  const writer = statePath
    ? createJsonStateWriter({
      filePath: statePath, fsPromises, warn: (error) => log.warn(`tail state write failed: ${error.message}`),
    })
    : null;

  const counts = {
    seen: 0, queued: 0, written: 0, rejected: 0, dropped: 0,
  };
  let queued = [];
  // Offsets a queued batch has not written yet: committing early would lose those records on a crash.
  const pendingTails = new Map();
  let tailState = core.normalizeTailState(null);
  let loadPromise = null;
  let flushTimer = null;
  let flushChain = Promise.resolve();
  let ownSource = null;
  let stopped = false;

  function loadTailState() {
    if (!statePath) return Promise.resolve(tailState);
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      let text = null;
      try {
        text = await fsPromises.readFile(statePath, 'utf8');
      } catch {
        // No file yet is the ordinary first-run case, and an empty state means every tail starts at EOF.
        return tailState;
      }
      try {
        tailState = core.normalizeTailState(JSON.parse(text));
      } catch (error) {
        // Starting empty costs the gap, never a duplicate: every unknown file restarts at end of file.
        log.warn(`tail state unreadable, starting empty: ${error.message}`);
        tailState = core.normalizeTailState(null);
      }
      return tailState;
    })();
    return loadPromise;
  }

  function persistTailState() {
    if (!writer) return Promise.resolve();
    return writer.write(tailState, () => `${JSON.stringify(tailState, null, 2)}\n`);
  }

  function commitTail(tail) {
    tailState = core.recordTailOffset(tailState, { ...tail, ts: nowFn() }, { maxEntries: maxTailEntries });
    void persistTailState();
  }

  // --- The live consumer ----------------------------------------------------

  function enqueue(event, tailPath) {
    counts.seen += 1;
    const input = core.memoryInputFromEvent(event, { deliveredHashes: store.deliveredHashes?.() || null });
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
      for (const input of batch.take) {
        const written = await appendOne(input);
        if (written) counts.written += 1;
        if (!written) counts.rejected += 1;
      }
      settlePendingTails();
      await yieldTick();
    }
  }

  function settlePendingTails() {
    for (const [filePath, tail] of [...pendingTails]) {
      if (queued.some((input) => input.tailPath === filePath)) continue;
      pendingTails.delete(filePath);
      commitTail(tail);
    }
  }

  // A rejected write is a count, never a throw: this rides the source's drain and the CLI's pass alike.
  async function appendOne(input) {
    const { tailPath, ...record } = input;
    try {
      return Boolean(await store.append(record));
    } catch (error) {
      log.warn(`append failed: ${error.message}`);
      return false;
    }
  }

  // Chains a flush unconditionally: the backfill enqueues without arming the timer a conditional would wait on.
  async function whenIdle() {
    if (flushTimer) clearTimeoutFn(flushTimer);
    flushTimer = null;
    flushChain = flushChain.then(flushQueue).catch((error) => log.warn(`flush failed: ${error.message}`));
    await flushChain;
    if (writer) await writer.idle();
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
    let entries = null;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return budget - 1;
    }
    let left = budget - 1;
    for (const entry of entries) {
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
  async function backfillFile(entry, budgetBytes, lanes) {
    const stat = await statOrNull(entry.file);
    if (!stat || !stat.isFile()) return { bytesRead: 0, partial: false, missing: true };
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
    let context = { root: scope.root, sessionId: scope.sessionId, vendorState: null };
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

  // Refuses to run beside another process doing the same job over the same tail-state file.
  async function backfill({ budgetBytes = backfillByteBudget } = {}) {
    if (stopped) return { ok: false, reason: 'stopped', files: 0, bytesRead: 0, partial: false };
    if (typeof store.withCanonLock !== 'function') {
      return { ok: false, reason: 'unsupported', files: 0, bytesRead: 0, partial: false };
    }
    const held = await store.withCanonLock(() => runBackfill(budgetBytes));
    if (!held.locked) {
      log.warn('another process holds the memory store lock: no backfill ran');
      return { ok: false, reason: 'locked', files: 0, bytesRead: 0, partial: false };
    }
    return held.result;
  }

  async function runBackfill(budgetBytes) {
    await loadTailState();
    const lanes = typeof laneMap === 'function' ? laneMap() : null;
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
      const outcome = await backfillFile(entry, remaining, lanes);
      if (outcome.missing) gone.push(entry.file);
      bytesRead += outcome.bytesRead;
      files += 1;
      partial = partial || outcome.partial;
      await yieldTick();
    }
    if (gone.length > 0) tailState = core.tailStateForget(tailState, gone);
    await persistTailState();
    await whenIdle();
    log.note(
      `backfill read ${bytesRead} byte(s) across ${files} file(s): `
      + `${counts.written} written, ${counts.rejected} rejected${partial ? ', budget reached' : ''}`
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
    if (writer) await writer.idle();
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
  DEFAULT_BACKFILL_CHUNK_BYTES,
  TAIL_STATE_FILE,
  createMemoryIngest,
};
