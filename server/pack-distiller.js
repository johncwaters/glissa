'use strict';

// The distiller lane: an LLM pass that REGENERATES derived summary files inside the pack source area
// when the sources they distill have drifted. Opt-in and off by default (config.packDistiller.enabled),
// plus `glissa pack distill` as the manual trigger, which is always allowed.
//
// The mill's deterministic assembly is untouched by design. This lane produces SOURCES: reviewable
// files that land under packs/ and show up in a plain `git diff`, and the mill still builds packs from
// files on disk with no model in the content path. The pack service's watcher sees the written file
// and rebuilds the pack on its own, so the two loops compose without knowing about each other.
//
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const {
  awaitSessionExit, createJobResultFile, drainPending, firstLine, raceWithAbort, readResultFile,
  registerEphemeralSession,
} = require('./ephemeral-session');
const { createSerialQueue } = require('./spawn-gate');
const { needsDistill } = require('./core/distill-core');
const { buildLanePermissions } = require('./core/lane-permissions-core');
const {
  MAX_DISTILL_RESULT_BYTES,
  buildPackDistillPrompt,
  failedResult,
  decidePackDistillPromptSize,
  renderDistilledOutput,
  validateDistillResult,
} = require('./core/pack-distiller-core');
const { validatePackSpec } = require('./core/pack-core');
const {
  distillOutputPath, distillSourceHashes, listPackSpecs, loadPackSpec,
} = require('./pack-builder');

const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_TIMEOUT_SECONDS = 900;
const PACK_DISTILL_PROMPT_FILE = 'pack-distill-prompt.txt';
const PACK_DISTILL_BOOTSTRAP_PROMPT = 'Read pack-distill-prompt.txt and follow all instructions in that file';
const UNSAFE_OUTPUT_REASON = 'output path escapes the packs directory or cannot be safely inspected';
const PACK_DISTILL_DENY_TOOLS = Object.freeze([
  'Bash', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task',
]);

function packDistillerPermissions() {
  return buildLanePermissions({ denyTools: PACK_DISTILL_DENY_TOOLS });
}

function readDistillResult(resultPath) {
  const result = readResultFile(resultPath, null, null, {
    maxBytes: MAX_DISTILL_RESULT_BYTES,
    validate: validateDistillResult,
  });
  if (result.ok) return result;
  return failedResult(result.kind === 'missing' ? undefined : result.reason);
}

async function writeOutputNoFollow(fullPath, content) {
  const parentDir = path.dirname(fullPath);
  await fs.promises.mkdir(parentDir, { recursive: true });
  const tempPath = path.join(parentDir, `.${path.basename(fullPath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | fs.constants.O_NOFOLLOW;
  let handle = null;
  try {
    handle = await fs.promises.open(tempPath, flags, 0o666);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    let outputStats = null;
    try {
      outputStats = await fs.promises.lstat(fullPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (outputStats?.isSymbolicLink()) {
      const error = Object.assign(new Error('output path became a symbolic link'), { code: 'ELOOP' });
      throw error;
    }
    await fs.promises.rename(tempPath, fullPath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
  }
}

function writeStandaloneLaneSettings(permissions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-distill-'));
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions }, null, 2), 'utf8');
  return {
    args: ['--settings', settingsPath],
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
  };
}

/**
 * @param {{ sessions?: Map<string, unknown>, closeSessionDataClients?: (id: string) => void,
 *   hookRouter?: unknown, getHookPort?: (() => number | null) | null, spawnGate?: unknown,
 *   replayBufferKB?: number, recordLane?: ((...args: unknown[]) => unknown) | null }} [options]
 */
function createDistillSpawn({
  sessions = new Map(), closeSessionDataClients = () => {}, hookRouter = null, getHookPort = null,
  spawnGate = null, replayBufferKB = undefined,
  // Lane attribution: names this lane on the ledger when its headless session reports a Claude session id.
  recordLane = null,
} = {}) {
  return async function spawnDistill({ id, name, cwd, signal }) {
    // Lazy loading keeps dry runs from resolving Claude on PATH.
    const { Session } = require('../session/sessions');
    const posture = packDistillerPermissions();
    const standalone = hookRouter ? null : writeStandaloneLaneSettings(posture.permissions);
    const sess = new Session({
      id,
      name,
      path: cwd,
      dangerouslySkipPermissions: false,
      extraClaudeArgs: standalone ? ['-p', ...standalone.args] : ['-p'],
      initialPrompt: PACK_DISTILL_BOOTSTRAP_PROMPT,
      ephemeral: true,
      settingsPermissions: posture.permissions,
      replayBufferKB,
      hookRouter,
      getHookPort,
    });
    registerEphemeralSession({ map: sessions, id, sess, closeSessionDataClients, logPrefix: 'pack-distill', name, recordLane });

    try {
      await awaitSessionExit(sess, { signal, spawnGate });
    } finally {
      if (standalone) standalone.cleanup();
    }
  };
}

/**
 * @param {{ enabled?: boolean, listSpecs?: typeof listPackSpecs, loadSpec?: typeof loadPackSpec,
 *   sourceHashes?: typeof distillSourceHashes, resolveOutput?: typeof distillOutputPath,
 *   readOutput?: (path: string) => Promise<string | null>,
 *   writeOutput?: (path: string, content: string) => Promise<void>,
 *   writePrompt?: (path: string, content: string) => Promise<void>,
 *   spawnDistill?: (options: { id: string, name: string, cwd: string, signal?: AbortSignal | null }) => Promise<void>,
 *   createResultFile?: (packName: string, index: number) => { path: string, cleanup: () => Promise<void> | void },
 *   readResult?: (path: string) => Record<string, unknown>, intervalHours?: number,
 *   timeoutSeconds?: number, setIntervalFn?: typeof setInterval,
 *   clearIntervalFn?: typeof clearInterval, setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout, log?: Console }} [deps] every side effect, injected. Defaults point at the real builder, the real
 *   spawn and the real timers, so `createPackDistiller({ enabled })` is the production wiring.
 */
function createPackDistiller(deps = {}) {
  const {
    enabled = false,
    listSpecs = () => listPackSpecs(),
    loadSpec = (specPath) => loadPackSpec(specPath),
    sourceHashes = (entry) => distillSourceHashes(entry),
    resolveOutput = (output) => distillOutputPath(output),
    readOutput = async (fullPath) => {
      try { return await fs.promises.readFile(fullPath, 'utf8'); } catch { return null; }
    },
    writeOutput = writeOutputNoFollow,
    writePrompt = (promptPath, content) => fs.promises.writeFile(promptPath, content, 'utf8'),
    spawnDistill = createDistillSpawn(),
    // Each distill gets a private result directory rather than a predictable name in shared temp (see
    // createJobResultFile). ONE dep, returning { path, cleanup }, because the cleanup closure is what
    // owns the directory: a separate remove-by-path dep would have to guess from the string whether the
    // parent is ours to delete, and an injected path would then take its directory down with it.
    createResultFile = (packName, index) => createJobResultFile(`glissa-distill-${packName}-${index}`),
    readResult = readDistillResult,
    intervalHours = DEFAULT_INTERVAL_HOURS,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    log = console,
  } = deps;

  let timer = null;
  let stopped = false;
  let tickRunning = false;
  // One queue, so an interval tick and a manual runOnce can never have two distill sessions writing
  // under packs/ at the same time. Distills are serialized by construction, never raced.
  const distillQueue = createSerialQueue();
  let idle = Promise.resolve();

  function queue(task) {
    const run = distillQueue.run(task);
    idle = run.catch(() => {});
    return run;
  }

  function report(pack, output, overrides) {
    return { pack, output, status: 'error', verdict: null, reason: null, summary: '', ...overrides };
  }

  async function safeResolveOutput(output) {
    try {
      return await resolveOutput(output);
    } catch {
      return null;
    }
  }

  function spawnWithTimeout(spawnArgs, resultPath, { onPending = null } = {}) {
    return raceWithAbort({
      timeoutMs: timeoutSeconds * 1000,
      setTimeoutFn,
      clearTimeoutFn,
      onPending,
      onTimeout: () => ({ verdict: 'ERROR', summary: 'distill timed out' }),
      onEmpty: () => ({ verdict: 'ERROR', summary: 'no verdict' }),
      start: (signal) => Promise.resolve(spawnDistill({ ...spawnArgs, signal }))
        .then(() => readResult(resultPath))
        .catch((err) => ({ verdict: 'ERROR', summary: firstLine(err.message) })),
    });
  }

  async function distillEntry(spec, entry, index, { dryRun }) {
    const base = (overrides) => report(spec.name, entry.output, overrides);

    const outputPath = await safeResolveOutput(entry.output);
    if (!outputPath) return base({ reason: UNSAFE_OUTPUT_REASON });

    let hashes;
    try {
      hashes = await sourceHashes(entry);
    } catch (err) {
      return base({ reason: `could not read sources: ${firstLine(err.message)}` });
    }
    if (hashes.length === 0) return base({ reason: 'distill sources matched no files' });

    const drift = needsDistill(hashes, await readOutput(outputPath));
    if (!drift.stale) return base({ status: 'current' });
    if (dryRun) return base({ status: 'stale', reason: drift.reason });

    let result;
    // The prompt builder runs inside the try too, so a throw there cannot strand the directory.
    let resultFile = null;
    let pendingSpawn = null;
    try {
      resultFile = await createResultFile(spec.name, index);
      const prompt = buildPackDistillPrompt({
        outputPath,
        sources: hashes,
        instructions: entry.instructions,
        resultPath: resultFile.path,
      });
      const promptSize = decidePackDistillPromptSize(prompt);
      if (!promptSize.dispatch) return base({ verdict: 'ERROR', reason: promptSize.gate });
      await writePrompt(path.join(path.dirname(resultFile.path), PACK_DISTILL_PROMPT_FILE), prompt);
      result = await spawnWithTimeout({
        id: `pack-distill:${spec.name}#${index}`,
        name: `distill ${spec.name} ${entry.output}`,
        cwd: path.dirname(resultFile.path),
      }, resultFile.path, { onPending: (promise) => { pendingSpawn = promise; } });
    } finally {
      // Cleanup waits until an aborted session releases its private cwd.
      await drainPending(pendingSpawn);
      if (resultFile) await resultFile.cleanup();
    }
    if (result.verdict === 'ERROR') return base({ verdict: 'ERROR', reason: result.summary || 'distill failed' });

    try {
      await writeOutput(outputPath, renderDistilledOutput({ sources: hashes, content: result.content }));
    } catch (err) {
      if (err.code === 'ELOOP') return base({ verdict: 'ERROR', reason: 'output path became a symbolic link' });
      return base({ verdict: 'ERROR', reason: `could not write output: ${firstLine(err.message)}` });
    }

    // A verdict is a claim; the file on disk is the evidence. Re-running the same drift check against
    // what was actually written is what makes a lying or half-finished session an ERROR rather than a
    // silently accepted rewrite.
    const verify = needsDistill(hashes, await readOutput(outputPath));
    if (verify.stale) {
      return base({ verdict: result.verdict, reason: `verdict ${result.verdict} but ${verify.reason}` });
    }
    return base({ status: 'distilled', verdict: result.verdict, summary: result.summary });
  }

  async function runAll({ name = null, dryRun = false } = {}) {
    const reports = [];
    for (const spec of await listSpecs()) {
      if (stopped) break;
      if (name && spec.name !== name) continue;

      let loaded;
      try {
        loaded = await loadSpec(spec.specPath);
      } catch (err) {
        reports.push(report(spec.name, null, { reason: `could not read spec: ${firstLine(err.message)}` }));
        continue;
      }
      const entries = Array.isArray(loaded.distill) ? loaded.distill : [];
      if (entries.length === 0) continue;

      let hasEscapingOutput = false;
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        if (await safeResolveOutput(entry.output)) continue;
        hasEscapingOutput = true;
        reports.push(report(loaded.name || spec.name, entry.output, { reason: UNSAFE_OUTPUT_REASON }));
      }
      if (hasEscapingOutput) continue;

      const check = validatePackSpec(loaded);
      if (!check.ok) {
        reports.push(report(spec.name, null, { reason: `invalid spec: ${check.errors.join('; ')}` }));
        continue;
      }
      for (const [index, entry] of entries.entries()) {
        if (stopped) break;
        const entryReport = await distillEntry(loaded, entry, index, { dryRun });
        if (entryReport.status === 'error') {
          log.warn(`[distill] ${entryReport.pack} ${entryReport.output || ''}: ${entryReport.reason}`);
        }
        if (entryReport.status === 'distilled') {
          log.log(`[distill] ${entryReport.pack} rewrote ${entryReport.output}`);
        }
        reports.push(entryReport);
      }
    }
    return reports;
  }

  /** One full pass: drift-check every distill entry and regenerate the stale ones. Never throws. */
  async function runOnce(options = {}) {
    return queue(() => runAll(options));
  }

  async function tick() {
    if (tickRunning || stopped) return;
    tickRunning = true;
    try {
      await runOnce();
    } catch (err) {
      log.warn(`[distill] pass failed: ${firstLine(err.message)}`);
    } finally {
      tickRunning = false;
    }
  }

  async function start() {
    if (!enabled) return;
    stopped = false;
    timer = setIntervalFn(() => { void tick(); }, intervalHours * 3600000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    await tick();
  }

  // Shutdown waits for an output render already in flight.
  async function stop() {
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    await idle;
  }

  return { start, stop, runOnce, isEnabled: () => enabled === true };
}

module.exports = {
  DEFAULT_INTERVAL_HOURS,
  DEFAULT_TIMEOUT_SECONDS,
  PACK_DISTILL_BOOTSTRAP_PROMPT,
  PACK_DISTILL_DENY_TOOLS,
  PACK_DISTILL_PROMPT_FILE,
  createDistillSpawn,
  createPackDistiller,
  packDistillerPermissions,
  readDistillResult,
  writeOutputNoFollow,
};
