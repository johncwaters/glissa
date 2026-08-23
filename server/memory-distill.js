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
const { needsDistill } = require('./core/distill-core');
const { createTickLoop } = require('./lane-runner');
const core = require('./core/memory-core');
const distillCore = require('./core/memory-distill-core');

const LANE_NAME = 'memory-distill';
const RESULT_FILE = 'memory-distill-result.json';
// A stable prefix, not decoration: it is what ingest-agent-core recognizes as this lane's throwaway cwd.
const WORK_DIR_PREFIX = 'glissa-memory-distill-';

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
      records: 0, pending: false, ...overrides,
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

  async function distill({ valid, watermark }) {
    const selection = distillCore.selectCanonForPrompt(valid, {
      maxRecords: config.maxPromptRecords, maxChars: config.maxPromptChars,
    });
    if (!selection.ok) return report({ status: 'error', reason: selection.reason });

    const manifest = await store.readPublishedManifest();
    const previousTexts = distillCore.publishedClaimTexts(await store.readPublishedDocuments(manifest));

    let workDir = null;
    try {
      workDir = await makeWorkDir();
    } catch (error) {
      return report({ status: 'error', reason: `no work dir: ${firstLine(error.message)}` });
    }
    const resultPath = path.join(workDir, RESULT_FILE);
    let pendingSpawn = null;
    let outcome = null;
    try {
      outcome = await spawnWithTimeout({
        prompt: distillCore.buildMemoryDistillPrompt({
          records: selection.records, resultPath, maxNewClaims: config.maxNewClaims,
        }),
        cwd: workDir,
        resultPath,
        onPending: (promise) => { pendingSpawn = promise; },
      });
    } finally {
      await drainPending(pendingSpawn);
      await removeWorkDir(workDir);
    }
    if (outcome.timedOut) return report({ status: 'error', reason: 'the distill run timed out' });
    if (outcome.error) return report({ status: 'error', reason: outcome.error });

    const checked = distillCore.validateDistillResult(outcome.parsed, {
      records: valid, previousTexts, maxNewClaims: config.maxNewClaims,
    });
    if (!checked.ok) return report({ status: 'error', reason: `${checked.reason}: ${checked.detail}` });
    if (checked.verdict !== 'DISTILLED') {
      return report({ status: 'current', verdict: checked.verdict });
    }

    const built = filesFor(checked.claims, valid);
    if (checked.lockedTouched.length > 0) {
      const pending = await store.publishPending({ ...built, watermark });
      log.warn(`a distilled projection changed ${checked.lockedTouched.length} locked record(s): it was queued for review, not published`);
      return report({
        status: 'pending', verdict: checked.verdict, pending: true, newClaims: checked.newClaims,
        version: pending ? pending.version : null, reason: 'a locked record would be re-rendered',
      });
    }

    const published = await store.publishProjection({
      ...built,
      source: 'distill',
      verdict: checked.verdict,
      distilledAt: now(),
      watermark,
    });
    if (!published) return report({ status: 'error', reason: 'the store is stopping' });
    const verified = await verifyPublished(watermark);
    if (!verified.ok) return report({ status: 'error', reason: `published but ${verified.reason}`, version: published.version });
    log.note(`distilled ${built.claimCount} claim(s) from ${built.recordCount} record(s): ${published.published ? 'published' : 'unchanged'} ${published.version.slice(0, 12)}`);
    return report({
      status: 'published',
      verdict: checked.verdict,
      published: published.published,
      version: published.version,
      newClaims: checked.newClaims,
    });
  }

  /** One pass. Never throws: the lane reports a reason and leaves the published build untouched. */
  async function runOnce({ dryRun = false, force = false } = {}) {
    if (!store) return report({ status: 'disabled', reason: 'no memory store' });
    if (running) return report({ status: 'skipped', reason: 'a run is already in flight' });
    running = true;
    try {
      const valid = store.validRecords();
      const watermark = store.watermark();
      const manifest = await store.readPublishedManifest();
      const verdict = distillCore.decideDistillRun({
        now: now(),
        watermark,
        manifest,
        lastAppendAt: store.lastAppendAt(),
        intervalMs,
        quietMs: config.quietMs,
      });
      if (!verdict.run && !force) return report({ status: verdict.reason });
      if (dryRun) {
        const selection = distillCore.selectCanonForPrompt(valid, {
          maxRecords: config.maxPromptRecords, maxChars: config.maxPromptChars,
        });
        return report({
          status: selection.ok ? 'stale' : 'error',
          reason: selection.reason,
          records: selection.records.length,
        });
      }
      const held = await store.withCanonLock(() => distill({ valid, watermark }));
      if (!held.locked) return report({ status: 'locked', reason: 'another process holds the canon lock' });
      return held.result;
    } catch (error) {
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
