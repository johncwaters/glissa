'use strict';

// M15 of docs/plan-visions-3.md: the memory-distill lane's IO half. Every decision is in the pure core.

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  awaitSessionExit, drainPending, firstLine, raceWithAbort, registerEphemeralSession,
} = require('./ephemeral-session');
const { buildLanePermissions } = require('./core/lane-permissions-core');
const { createLaneLog } = require('./lane-log');
const { isBusyError } = require('./glissa-db');
const { needsDistill } = require('./core/distill-core');
const { createTickLoop } = require('./lane-runner');
const core = require('./core/memory-core');
const distillCore = require('./core/memory-distill-core');

const LANE_NAME = 'memory-distill';
const RESULT_FILE = 'memory-distill-result.json';
// A stable prefix, not decoration: it is what ingest-agent-core recognizes as this lane's throwaway cwd.
const WORK_DIR_PREFIX = 'glissa-memory-distill-';
// The delta never renders to nothing, however much of the budget the standing claims already took.
const MIN_DELTA_CHARS = 4000;

/*
 * The prompt embeds remembered text, so this session gets the least capability that still lets it write
 * its result file: no --dangerously-skip-permissions, no allow list at all, every dangerous verb denied,
 * and `defaultMode: acceptEdits` over a throwaway cwd, which is what actually confines the writes (see
 * server/core/lane-permissions-core.js for the probes behind every clause of that).
 *
 * `Read` is deliberately NOT denied here, though a lane wants it to be: a bare Read deny refuses the
 * Write tool as well, so it and the result-file contract cannot both exist. Reads go nowhere instead,
 * because there is no shell, no network tool, and the only writable directory is the throwaway one.
 */
const MEMORY_DISTILL_DENY_TOOLS = Object.freeze([
  'Bash', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Bash(git push:*)', 'Bash(gh:*)',
]);

function writeStandaloneDenySettings(permissions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${WORK_DIR_PREFIX}settings-`));
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions }, null, 2), 'utf8');
  return {
    args: ['--settings', settingsPath],
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
  };
}

/**
 * The real spawn: one ephemeral headless session registered under this lane's name, which both excludes
 * its own transcript from ingestion and puts a `memory-distill` row on the usage ledger.
 */
function createMemoryDistillSpawn({
  sessions = new Map(), closeSessionDataClients = () => {}, hookRouter = null, getHookPort = null,
  spawnGate = null, replayBufferKB = undefined, recordLane = null,
} = {}) {
  return async function spawnMemoryDistill({ id, name, prompt, cwd, model = null, signal = null }) {
    const { Session } = require('../session/sessions');
    const posture = buildLanePermissions({ denyTools: MEMORY_DISTILL_DENY_TOOLS });
    const standalone = hookRouter ? null : writeStandaloneDenySettings(posture.permissions);
    const extraClaudeArgs = ['-p', ...(standalone ? standalone.args : [])];
    if (model) extraClaudeArgs.push('--model', model);
    const sess = new Session({
      id,
      name,
      path: cwd,
      dangerouslySkipPermissions: false,
      extraClaudeArgs,
      initialPrompt: prompt,
      ephemeral: true,
      settingsPermissions: posture.permissions,
      replayBufferKB,
      hookRouter,
      getHookPort,
    });
    registerEphemeralSession({
      map: sessions, id, sess, closeSessionDataClients, logPrefix: LANE_NAME, name, recordLane,
    });
    try {
      await awaitSessionExit(sess, { signal, spawnGate });
    } finally {
      if (standalone) standalone.cleanup();
    }
  };
}

async function readDistillResultFile(resultPath) {
  try {
    return JSON.parse(await fsPromises.readFile(resultPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {object} deps `store` is the memory store; every other side effect (the spawn, the work dir,
 *   the clock, the timers) is injected so the lane is testable with no Claude on PATH.
 */
function createMemoryDistiller(deps = {}) {
  const {
    store = null,
    config = distillCore.resolveDistillConfig(null, { memoryEnabled: false }),
    spawnDistill = createMemoryDistillSpawn(),
    readResult = readDistillResultFile,
    makeWorkDir = () => fsPromises.mkdtemp(path.join(os.tmpdir(), `${WORK_DIR_PREFIX}work-`)),
    removeWorkDir = async (dir) => { try { await fsPromises.rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
    now = () => Date.now(),
    logger = console,
    debug = false,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    checkIntervalMs = distillCore.CHECK_INTERVAL_MS,
    idFor = () => `${LANE_NAME}:${Date.now()}`,
  } = deps;

  const log = createLaneLog({ prefix: `[${LANE_NAME}]`, logger, debugFlag: debug });
  const intervalMs = config.intervalMinutes * 60000;
  let running = false;

  function report(overrides) {
    return {
      status: 'skipped', reason: null, verdict: null, published: false, version: null, newClaims: 0,
      records: 0, pending: false, mode: null, cursor: 0, delta: 0, remaining: 0, claims: 0, ...overrides,
    };
  }

  function spawnWithTimeout({ prompt, cwd, resultPath, onPending }) {
    return raceWithAbort({
      timeoutMs: config.timeoutSeconds * 1000,
      setTimeoutFn,
      clearTimeoutFn,
      onPending,
      onTimeout: () => ({ timedOut: true, parsed: null }),
      onEmpty: () => ({ timedOut: false, parsed: null }),
      start: (signal) => Promise.resolve(spawnDistill({
        id: idFor(), name: 'memory distill', prompt, cwd, signal,
      }))
        .then(async () => {
          if (signal.aborted) return undefined;
          return { timedOut: false, parsed: await readResult(resultPath) };
        })
        .catch((error) => ({ timedOut: false, parsed: null, error: firstLine(error.message) })),
    });
  }

  function filesFor(claims, valid) {
    const files = [{
      relPath: core.GLOBAL_PROJECTION_FILE,
      content: distillCore.renderDistilledProjection(claims, { project: null }),
    }];
    for (const tag of distillCore.claimProjectTags(claims)) {
      files.push({
        relPath: `${core.PROJECTS_DIR_NAME}/${core.projectFileSlug(tag)}.md`,
        content: distillCore.renderDistilledProjection(claims, { project: tag }),
      });
    }
    return { files, recordCount: valid.length, claimCount: claims.length };
  }

  // Fallback bullets are raw records, not standing claims the incremental prompt may reuse.
  async function readPublished() {
    const manifest = await store.readPublishedManifest();
    const documents = await store.readPublishedDocuments(manifest);
    const distilled = manifest?.source === 'distill';
    return {
      manifest,
      distilled,
      claims: distilled ? distillCore.readPublishedClaims(documents) : [],
      previousTexts: distillCore.publishedClaimTexts(documents),
    };
  }

  // The cursor advances only after published bytes are re-read, leaving failed deltas available again.
  async function noteOutcome({ advanced, cursor, failures }) {
    if (!advanced) {
      await store.setDistillFailures(failures + 1);
      return;
    }
    await store.setDistillCursorSeq(cursor);
    if (failures > 0) await store.setDistillFailures(0);
  }

  // A verdict is a claim; the published bytes are the evidence, so the stamp is re-read off what landed.
  async function verifyPublished(watermark) {
    const manifest = await store.readPublishedManifest();
    if (!manifest) return { ok: false, reason: 'nothing was published' };
    const expected = core.projectionStampSources(watermark);
    for (const document of await store.readPublishedDocuments(manifest)) {
      const drift = needsDistill(expected, document);
      if (drift.stale) return { ok: false, reason: drift.reason };
    }
    return { ok: true, reason: null };
  }

  async function spawnForResult({ prompt }) {
    let workDir = null;
    try {
      workDir = await makeWorkDir();
    } catch (error) {
      return { error: `no work dir: ${firstLine(error.message)}`, parsed: null };
    }
    const resultPath = path.join(workDir, RESULT_FILE);
    let pendingSpawn = null;
    let outcome = null;
    try {
      outcome = await spawnWithTimeout({
        prompt: prompt(resultPath), cwd: workDir, resultPath, onPending: (promise) => { pendingSpawn = promise; },
      });
    } finally {
      await drainPending(pendingSpawn);
      await removeWorkDir(workDir);
    }
    if (outcome.timedOut) return { error: 'the distill run timed out', parsed: null };
    if (outcome.error) return { error: outcome.error, parsed: null };
    return { error: null, parsed: outcome.parsed };
  }

  async function publishMerged({
    merged, valid, watermark, verdict, mode, cursor, failures, advances, proposed = null,
  }) {
    const built = filesFor(merged.claims, valid);
    if (merged.lockedTouched.length > 0) {
      // The held build renders what the run PROPOSED, which is the only place an operator can see it.
      const pending = await store.publishPending({ ...filesFor(proposed || merged.claims, valid), watermark });
      await noteOutcome({ advanced: false, cursor, failures });
      log.warn(`a distilled projection changed ${merged.lockedTouched.length} locked record(s): it was queued for review, not published`);
      return report({
        status: 'pending', verdict, pending: true, newClaims: merged.newClaims, mode, cursor,
        claims: built.claimCount,
        version: pending ? pending.version : null, reason: 'a locked record would be re-rendered',
      });
    }
    const published = await store.publishProjection({
      ...built, source: 'distill', verdict, distilledAt: now(), watermark,
    });
    if (!published) return report({ status: 'error', reason: 'the store is stopping', mode });
    const verified = await verifyPublished(watermark);
    if (!verified.ok) {
      await noteOutcome({ advanced: false, cursor, failures });
      return report({
        status: 'error', reason: `published but ${verified.reason}`, version: published.version, mode,
      });
    }
    await noteOutcome({ advanced: advances, cursor, failures });
    log.note(`distilled ${built.claimCount} claim(s) from ${built.recordCount} record(s) in ${mode} mode: ${published.published ? 'published' : 'unchanged'} ${published.version.slice(0, 12)}`);
    return report({
      status: 'published',
      verdict,
      published: published.published,
      version: published.version,
      newClaims: merged.newClaims,
      claims: built.claimCount,
      mode,
      cursor: advances ? cursor : store.distillCursorSeq(),
    });
  }

  // A full project re-distill is the only operation that can shrink that project's claim set.
  async function compact({
    valid, watermark, published, project, failures,
  }) {
    const own = valid.filter((record) => (record.project || null) === project);
    const selection = distillCore.selectCanonForPrompt(own, {
      maxRecords: config.maxPromptRecords, maxChars: config.maxPromptChars,
    });
    if (!selection.ok) return report({ status: 'error', reason: selection.reason, mode: 'full' });
    const spawned = await spawnForResult({
      prompt: (resultPath) => distillCore.buildMemoryDistillPrompt({
        records: selection.records, resultPath, maxNewClaims: config.maxNewClaims,
      }),
    });
    if (spawned.error) {
      await noteOutcome({ advanced: false, cursor: 0, failures });
      return report({ status: 'error', reason: spawned.error, mode: 'full' });
    }
    const checked = distillCore.validateDistillResult(spawned.parsed, {
      records: valid, previousTexts: published.previousTexts, maxNewClaims: distillCore.MAX_CLAIMS,
    });
    if (!checked.ok) {
      await noteOutcome({ advanced: false, cursor: 0, failures });
      return report({ status: 'error', reason: `${checked.reason}: ${checked.detail}`, mode: 'full' });
    }
    if (checked.verdict !== 'DISTILLED') return report({ status: 'current', verdict: checked.verdict, mode: 'full' });
    const stray = checked.claims.filter((claim) => (claim.project || null) !== project);
    if (stray.length > 0) {
      await noteOutcome({ advanced: false, cursor: 0, failures });
      return report({ status: 'error', reason: `${stray.length} compaction claim(s) fell outside ${project || 'global'}`, mode: 'full' });
    }
    const before = distillCore.claimsByProject(published.claims).get(project) || 0;
    if (checked.claims.length >= before) {
      await noteOutcome({ advanced: false, cursor: 0, failures });
      return report({ status: 'error', reason: `compaction returned ${checked.claims.length} claim(s), no fewer than the ${before} it replaced`, mode: 'full' });
    }
    // Full re-distills rewrite standing ground, so their shrink gate replaces the net-new cap.
    const replaced = distillCore.replaceProjectClaims(published.claims, checked.claims, project);
    const merged = distillCore.finalizeMergedClaims(replaced, {
      records: valid,
      previousTexts: published.previousTexts,
      maxNewClaims: distillCore.MAX_CLAIMS,
      lockedTouched: checked.lockedTouched,
    });
    if (!merged.ok) {
      await noteOutcome({ advanced: false, cursor: 0, failures });
      return report({ status: 'error', reason: `${merged.reason}: ${merged.detail}`, mode: 'full' });
    }
    // A compaction read every record of one project, not the delta, so the cursor is not its to move.
    return publishMerged({
      merged,
      valid,
      watermark,
      verdict: checked.verdict,
      mode: 'full',
      cursor: 0,
      failures,
      advances: false,
      proposed: replaced,
    });
  }

  // A supersession or forget can prune claims mechanically without a model run.
  async function reconcile({
    valid, watermark, published, cursor, failures,
  }) {
    if (published.claims.length === 0) return report({ status: 'current', verdict: 'NO_CHANGE', mode: 'incremental', cursor });
    const merged = distillCore.finalizeMergedClaims(published.claims, {
      records: valid, previousTexts: published.previousTexts, maxNewClaims: config.maxNewClaims,
    });
    if (!merged.ok) {
      await noteOutcome({ advanced: false, cursor, failures });
      return report({ status: 'error', reason: `${merged.reason}: ${merged.detail}`, mode: 'incremental' });
    }
    return publishMerged({
      merged, valid, watermark, verdict: 'NO_CHANGE', mode: 'incremental', cursor, failures, advances: true,
    });
  }

  async function distillDelta({
    valid, watermark, published, delta, failures,
  }) {
    const cursor = delta.nextCursor;
    const spawned = await spawnForResult({
      prompt: (resultPath) => distillCore.buildIncrementalDistillPrompt({
        published: published.claims,
        records: delta.records,
        resultPath,
        maxNewClaims: config.maxNewClaims,
      }),
    });
    if (spawned.error) {
      await noteOutcome({ advanced: false, cursor, failures });
      return report({ status: 'error', reason: spawned.error, mode: 'incremental', delta: delta.records.length });
    }
    const checked = distillCore.validateDistillOps(spawned.parsed, {
      records: valid, published: published.claims,
    });
    if (!checked.ok) {
      await noteOutcome({ advanced: false, cursor, failures });
      return report({ status: 'error', reason: `${checked.reason}: ${checked.detail}`, mode: 'incremental', delta: delta.records.length });
    }
    if (checked.verdict !== 'DISTILLED') {
      // The delta was read and said nothing new, so re-reading it could only say nothing new twice.
      await noteOutcome({ advanced: true, cursor, failures });
      return report({
        status: 'current', verdict: checked.verdict, mode: 'incremental', cursor, delta: delta.records.length,
      });
    }
    const proposed = distillCore.applyDistillOps(published.claims, checked.ops);
    const merged = distillCore.finalizeMergedClaims(proposed, {
      records: valid,
      previousTexts: published.previousTexts,
      maxNewClaims: config.maxNewClaims,
      lockedTouched: checked.lockedTouched,
    });
    if (!merged.ok) {
      await noteOutcome({ advanced: false, cursor, failures });
      return report({ status: 'error', reason: `${merged.reason}: ${merged.detail}`, mode: 'incremental', delta: delta.records.length });
    }
    const outcome = await publishMerged({
      merged,
      valid,
      watermark,
      verdict: checked.verdict,
      mode: 'incremental',
      cursor,
      failures,
      advances: true,
      proposed,
    });
    return { ...outcome, delta: delta.records.length, remaining: delta.remaining };
  }

  /** One pass. Never throws: the lane reports a reason and leaves the published build untouched. */
  async function runOnce({ dryRun = false, force = false } = {}) {
    if (!store) return report({ status: 'disabled', reason: 'no memory store' });
    if (running) return report({ status: 'skipped', reason: 'a run is already in flight' });
    running = true;
    try {
      const valid = store.validRecords();
      const watermark = store.watermark();
      const failures = store.distillFailures();
      const published = await readPublished();
      // A fallback publish drops standing claims, so the cursor resets to avoid resuming mid-canon.
      const cursor = published.distilled ? store.distillCursorSeq() : 0;
      const standing = distillCore.renderPublishedForPrompt(published.claims).length;
      const delta = distillCore.selectDeltaForPrompt(valid, {
        sinceSeq: cursor,
        limit: distillCore.deltaWindowFor(config.maxPromptRecords, failures),
        maxChars: Math.max(MIN_DELTA_CHARS, config.maxPromptChars - standing),
      });
      const mode = distillCore.decideDistillMode(published.claims, {
        maxProjectClaims: config.maxProjectClaims,
        maxChars: config.maxPromptChars,
      });
      const verdict = distillCore.decideDistillRun({
        now: now(),
        watermark,
        manifest: published.manifest,
        lastAppendAt: store.lastAppendAt(),
        intervalMs,
        quietMs: config.quietMs,
        workPending: delta.pending > 0 || mode.mode === 'full',
      });
      if (!verdict.run && !force) return report({ status: verdict.reason, cursor, delta: delta.records.length });
      if (dryRun) {
        return report({
          status: 'stale',
          mode: mode.mode,
          cursor,
          delta: delta.records.length,
          remaining: delta.remaining,
          records: delta.records.length,
          claims: published.claims.length,
        });
      }
      if (mode.mode === 'full') {
        return await compact({
          valid, watermark, published, project: mode.project, failures,
        });
      }
      if (delta.records.length === 0) {
        return await reconcile({
          valid, watermark, published, cursor, failures,
        });
      }
      return await distillDelta({
        valid, watermark, published, delta, failures,
      });
    } catch (error) {
      // Reported as `locked` because that is what the operator is being told: another writer holds it.
      if (isBusyError(error)) return report({ status: 'locked', reason: 'the memory database is busy' });
      return report({ status: 'error', reason: firstLine(error.message) });
    } finally {
      running = false;
    }
  }

  const loop = createTickLoop({
    tag: LANE_NAME,
    intervalMs: Math.min(checkIntervalMs, intervalMs),
    tick: async () => {
      const result = await loop.track(runOnce());
      if (result.status === 'error') log.warn(`run failed: ${result.reason}`);
    },
    setIntervalFn,
    clearIntervalFn,
    log: logger,
  });

  async function start() {
    if (!config.enabled || !store) return;
    await loop.start();
  }

  return {
    isEnabled: () => config.enabled === true && Boolean(store),
    runOnce,
    start,
    stop: () => loop.stop(),
  };
}

module.exports = {
  LANE_NAME,
  MEMORY_DISTILL_DENY_TOOLS,
  RESULT_FILE,
  WORK_DIR_PREFIX,
  createMemoryDistillSpawn,
  createMemoryDistiller,
  readDistillResultFile,
};
