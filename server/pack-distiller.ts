// The distiller lane: an LLM pass that REGENERATES derived summary files inside the pack source area
// when the sources they distill have drifted. Opt-in and off by default (config.packDistiller.enabled),
// plus `glissa pack distill` as the manual trigger, which is always allowed.
//
// The mill's deterministic assembly is untouched by design. This lane produces SOURCES: reviewable
// files that land under packs/ and show up in a plain `git diff`, and the mill still builds packs from
// files on disk with no model in the content path. The pack service's watcher sees the written file
// and rebuilds the pack on its own, so the two loops compose without knowing about each other.
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import type { HookRouter } from '../detection/hook-source.ts';
import type { Session, SessionOptions } from '../session/sessions.ts';
import { validatePackSpec } from './core/pack-core.ts';
import { needsDistill } from './core/distill-core.ts';
import { buildLanePermissions } from './core/lane-permissions-core.ts';
import {
  MAX_DISTILL_RESULT_BYTES,
  buildPackDistillPrompt,
  decidePackDistillPromptSize,
  failedResult,
  renderDistilledOutput,
  validateDistillResult,
} from './core/pack-distiller-core.ts';
import type { DistillResultVerdict } from './core/pack-distiller-core.ts';
import {
  awaitSessionExit, createJobResultFile, drainPending, firstLine, raceWithAbort, readResultFile,
  registerEphemeralSession,
} from './ephemeral-session.ts';
import type { JobResultFile, RecordLane, SpawnGate } from './ephemeral-session.ts';
import {
  distillOutputPath, distillSourceHashes, listPackSpecs, loadPackSpec,
} from './pack-builder.ts';
import type { DistillSourceHash, SpecListing } from './pack-builder.ts';
import { createSerialQueue } from './spawn-gate.ts';

const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_TIMEOUT_SECONDS = 900;
const PACK_DISTILL_PROMPT_FILE = 'pack-distill-prompt.txt';
const PACK_DISTILL_BOOTSTRAP_PROMPT = 'Read pack-distill-prompt.txt and follow all instructions in that file';
const UNSAFE_OUTPUT_REASON = 'output path escapes the packs directory or cannot be safely inspected';
const PACK_DISTILL_DENY_TOOLS = Object.freeze([
  'Bash', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task',
]);

type DistillSpawn = (options: { id: string; name: string; cwd: string; signal?: AbortSignal | null }) => Promise<void>;

interface DistillEntry {
  output?: unknown;
  instructions?: unknown;
  sources?: unknown;
}

interface DistillReport {
  pack: string;
  output: unknown;
  status: string;
  verdict: string | null;
  reason: string | null;
  summary: string;
}

interface DistillSpawnOptions {
  sessions?: Map<string, unknown>;
  closeSessionDataClients?: (id: string) => void;
  hookRouter?: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort?: (() => number | null) | null;
  spawnGate?: SpawnGate | null;
  replayBufferKB?: number;
  recordLane?: RecordLane | null;
  makeSession?: ((options: SessionOptions) => Session) | null;
}

interface PackDistillerDependencies {
  enabled?: boolean;
  listSpecs?: () => Promise<SpecListing[]> | SpecListing[];
  loadSpec?: (specPath: string) => Promise<unknown>;
  sourceHashes?: (entry: DistillEntry) => Promise<DistillSourceHash[]>;
  resolveOutput?: (output: unknown) => Promise<string | null>;
  readOutput?: (fullPath: string) => Promise<string | null>;
  writeOutput?: (fullPath: string, content: string) => Promise<void>;
  writePrompt?: (promptPath: string, content: string) => Promise<void>;
  spawnDistill?: DistillSpawn;
  createResultFile?: (packName: string, index: number) => Promise<JobResultFile> | JobResultFile;
  readResult?: (resultPath: string) => DistillResultVerdict | Promise<DistillResultVerdict>;
  intervalHours?: number;
  timeoutSeconds?: number;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  // The narrow call shapes rather than the globals' types, so a test can drive this lane's deadline by
  // hand (`typeof setTimeout` carries a `__promisify__` member no stand-in can implement).
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  log?: Pick<Console, 'log' | 'warn'>;
}

interface PackDistiller {
  start(): Promise<void>;
  stop(): Promise<void>;
  runOnce(options?: { name?: string | null; dryRun?: boolean }): Promise<DistillReport[]>;
  isEnabled(): boolean;
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function packDistillerPermissions() {
  return buildLanePermissions({ denyTools: PACK_DISTILL_DENY_TOOLS });
}

function readDistillResult(resultPath: string): DistillResultVerdict {
  const result = readResultFile(resultPath, null, null, {
    maxBytes: MAX_DISTILL_RESULT_BYTES,
    validate: validateDistillResult,
  });
  if ('kind' in result) return failedResult(result.kind === 'missing' ? undefined : result.reason);
  return {
    ok: result.ok === true,
    verdict: result.verdict,
    summary: result.summary,
    content: typeof result.content === 'string' ? result.content : null,
  };
}

async function writeOutputNoFollow(fullPath: string, content: string): Promise<void> {
  const parentDir = path.dirname(fullPath);
  await fs.promises.mkdir(parentDir, { recursive: true });
  const tempPath = path.join(parentDir, `.${path.basename(fullPath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | fs.constants.O_NOFOLLOW;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tempPath, flags, 0o666);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    let outputStats: fs.Stats | null = null;
    try {
      outputStats = await fs.promises.lstat(fullPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
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

function writeStandaloneLaneSettings(permissions: unknown): { args: string[]; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-distill-'));
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions }, null, 2), 'utf8');
  return {
    args: ['--settings', settingsPath],
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
  };
}

// Lazy loading keeps dry runs from resolving Claude on PATH, which a static import would do at load.
const requireFromHere = createRequire(import.meta.url);
function loadSessionConstructor(): new (options: SessionOptions) => Session {
  return (requireFromHere('../session/sessions.ts') as typeof import('../session/sessions.ts')).Session;
}

function createDistillSpawn({
  sessions = new Map(), closeSessionDataClients = () => {}, hookRouter = null, getHookPort = null,
  spawnGate = null, replayBufferKB = undefined,
  // Lane attribution: names this lane on the ledger when its headless session reports a Claude session id.
  recordLane = null,
  // Session constructor seam: a test records the posture this lane builds without spawning anything.
  makeSession = null,
}: DistillSpawnOptions = {}): DistillSpawn {
  return async function spawnDistill({ id, name, cwd, signal = null }) {
    const buildSession = makeSession || ((options: SessionOptions) => new (loadSessionConstructor())(options));
    const posture = packDistillerPermissions();
    const standalone = hookRouter ? null : writeStandaloneLaneSettings(posture.permissions);
    const sess = buildSession({
      id,
      name,
      path: cwd,
      dangerouslySkipPermissions: false,
      extraClaudeArgs: ['-p', ...posture.args, ...(standalone ? standalone.args : [])],
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

function makePackDistillResultFile(packName: string, index: number): Promise<JobResultFile> {
  return createJobResultFile(`glissa-distill-${packName}-${index}`);
}

/**
 * Every side effect is injected. The defaults point at the real builder, the real spawn and the real
 * timers, so `createPackDistiller({ enabled })` is the production wiring.
 */
function createPackDistiller(deps: PackDistillerDependencies = {}): PackDistiller {
  const {
    enabled = false,
    listSpecs = () => listPackSpecs(),
    loadSpec = (specPath: string) => loadPackSpec(specPath),
    sourceHashes = (entry: DistillEntry) => distillSourceHashes(entry),
    resolveOutput = (output: unknown) => distillOutputPath(output),
    readOutput = async (fullPath: string) => {
      try { return await fs.promises.readFile(fullPath, 'utf8'); } catch { return null; }
    },
    writeOutput = writeOutputNoFollow,
    writePrompt = (promptPath: string, content: string) => fs.promises.writeFile(promptPath, content, 'utf8'),
    spawnDistill = createDistillSpawn(),
    // Each distill gets a private result directory rather than a predictable name in shared temp (see
    // createJobResultFile). ONE dep, returning { path, cleanup }, because the cleanup closure is what
    // owns the directory: a separate remove-by-path dep would have to guess from the string whether the
    // parent is ours to delete, and an injected path would then take its directory down with it.
    createResultFile = makePackDistillResultFile,
    readResult = readDistillResult,
    intervalHours = DEFAULT_INTERVAL_HOURS,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    setIntervalFn = (fn: () => void, ms: number) => setInterval(fn, ms),
    clearIntervalFn = clearInterval,
    setTimeoutFn = (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeoutFn = clearTimeout,
    log = console,
  } = deps;

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let tickRunning = false;
  // One queue, so an interval tick and a manual runOnce can never have two distill sessions writing
  // under packs/ at the same time. Distills are serialized by construction, never raced.
  const distillQueue = createSerialQueue();
  let idle: Promise<unknown> = Promise.resolve();

  function queue<T>(task: () => Promise<T>): Promise<T> {
    const run = distillQueue.run(task);
    idle = run.catch(() => {});
    return run;
  }

  function report(pack: string, output: unknown, overrides: Partial<DistillReport>): DistillReport {
    return { pack, output, status: 'error', verdict: null, reason: null, summary: '', ...overrides };
  }

  async function safeResolveOutput(output: unknown): Promise<string | null> {
    try {
      return await resolveOutput(output);
    } catch {
      return null;
    }
  }

  function spawnWithTimeout(
    spawnArgs: { id: string; name: string; cwd: string },
    resultPath: string,
    { onPending = null }: { onPending?: ((promise: Promise<unknown>) => void) | null } = {},
  ): Promise<DistillResultVerdict> {
    return raceWithAbort<DistillResultVerdict>({
      timeoutMs: timeoutSeconds * 1000,
      setTimeoutFn,
      clearTimeoutFn,
      onTimeout: () => failedResult('distill timed out'),
      onEmpty: () => failedResult('no verdict'),
      start: (signal) => {
        const pending = Promise.resolve(spawnDistill({ ...spawnArgs, signal }))
          .then(() => readResult(resultPath))
          .catch((err: unknown) => failedResult(firstLine(errorMessage(err))));
        if (typeof onPending === 'function') onPending(pending);
        return pending;
      },
    });
  }

  async function distillEntry(
    spec: { name: string },
    entry: DistillEntry,
    index: number,
    { dryRun }: { dryRun: boolean },
  ): Promise<DistillReport> {
    const base = (overrides: Partial<DistillReport>) => report(spec.name, entry.output, overrides);

    const outputPath = await safeResolveOutput(entry.output);
    if (!outputPath) return base({ reason: UNSAFE_OUTPUT_REASON });

    let hashes: DistillSourceHash[];
    try {
      hashes = await sourceHashes(entry);
    } catch (err) {
      return base({ reason: `could not read sources: ${firstLine(errorMessage(err))}` });
    }
    if (hashes.length === 0) return base({ reason: 'distill sources matched no files' });

    const drift = needsDistill(hashes, await readOutput(outputPath));
    if (!drift.stale) return base({ status: 'current' });
    if (dryRun) return base({ status: 'stale', reason: drift.reason });

    let result: DistillResultVerdict;
    // The prompt builder runs inside the try too, so a throw there cannot strand the directory.
    let resultFile: JobResultFile | null = null;
    let pendingSpawn: Promise<unknown> | null = null;
    try {
      resultFile = await createResultFile(spec.name, index);
      const prompt = buildPackDistillPrompt({
        outputPath,
        sources: hashes,
        instructions: String(entry.instructions ?? ''),
        resultPath: resultFile.path,
      });
      const promptSize = decidePackDistillPromptSize(prompt);
      if (!promptSize.dispatch) return base({ verdict: 'ERROR', reason: promptSize.gate });
      await writePrompt(path.join(path.dirname(resultFile.path), PACK_DISTILL_PROMPT_FILE), prompt);
      result = await spawnWithTimeout({
        id: `pack-distill:${spec.name}#${index}`,
        name: `distill ${spec.name} ${String(entry.output)}`,
        cwd: path.dirname(resultFile.path),
      }, resultFile.path, { onPending: (promise) => { pendingSpawn = promise; } });
    } finally {
      // Cleanup waits until an aborted session releases its private cwd.
      await drainPending(pendingSpawn);
      if (resultFile) await resultFile.cleanup();
    }
    if (result.verdict === 'ERROR') return base({ verdict: 'ERROR', reason: result.summary || 'distill failed' });

    try {
      await writeOutput(outputPath, renderDistilledOutput({ sources: hashes, content: result.content ?? '' }));
    } catch (err) {
      if (errorCode(err) === 'ELOOP') return base({ verdict: 'ERROR', reason: 'output path became a symbolic link' });
      return base({ verdict: 'ERROR', reason: `could not write output: ${firstLine(errorMessage(err))}` });
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

  async function runAll({ name = null, dryRun = false }: { name?: string | null; dryRun?: boolean } = {}): Promise<DistillReport[]> {
    const reports: DistillReport[] = [];
    for (const spec of await listSpecs()) {
      if (stopped) break;
      if (name && spec.name !== name) continue;

      let loaded: { name?: unknown; distill?: unknown };
      try {
        loaded = (await loadSpec(spec.specPath)) as { name?: unknown; distill?: unknown };
      } catch (err) {
        reports.push(report(spec.name, null, { reason: `could not read spec: ${firstLine(errorMessage(err))}` }));
        continue;
      }
      const entries: DistillEntry[] = Array.isArray(loaded.distill) ? loaded.distill : [];
      if (entries.length === 0) continue;

      let hasEscapingOutput = false;
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        if (await safeResolveOutput(entry.output)) continue;
        hasEscapingOutput = true;
        reports.push(report(typeof loaded.name === 'string' && loaded.name ? loaded.name : spec.name, entry.output, { reason: UNSAFE_OUTPUT_REASON }));
      }
      if (hasEscapingOutput) continue;

      const check = validatePackSpec(loaded);
      if (!check.ok) {
        reports.push(report(spec.name, null, { reason: `invalid spec: ${check.errors.join('; ')}` }));
        continue;
      }
      for (const [index, entry] of entries.entries()) {
        if (stopped) break;
        const entryReport = await distillEntry(
          { name: typeof loaded.name === 'string' && loaded.name ? loaded.name : spec.name },
          entry,
          index,
          { dryRun },
        );
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
  async function runOnce(options: { name?: string | null; dryRun?: boolean } = {}): Promise<DistillReport[]> {
    return queue(() => runAll(options));
  }

  async function tick(): Promise<void> {
    if (tickRunning || stopped) return;
    tickRunning = true;
    try {
      await runOnce();
    } catch (err) {
      log.warn(`[distill] pass failed: ${firstLine(errorMessage(err))}`);
    } finally {
      tickRunning = false;
    }
  }

  async function start(): Promise<void> {
    if (!enabled) return;
    stopped = false;
    timer = setIntervalFn(() => { void tick(); }, intervalHours * 3600000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    await tick();
  }

  // Shutdown waits for an output render already in flight.
  async function stop(): Promise<void> {
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    await idle;
  }

  return { start, stop, runOnce, isEnabled: () => enabled === true };
}

export {
  DEFAULT_INTERVAL_HOURS,
  DEFAULT_TIMEOUT_SECONDS,
  PACK_DISTILL_BOOTSTRAP_PROMPT,
  PACK_DISTILL_DENY_TOOLS,
  PACK_DISTILL_PROMPT_FILE,
  createDistillSpawn,
  createPackDistiller,
  makePackDistillResultFile,
  packDistillerPermissions,
  readDistillResult,
  writeOutputNoFollow,
};
export type { DistillReport, DistillSpawn, PackDistiller, PackDistillerDependencies };
