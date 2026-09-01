// IO shell for the Mill tab (server/core/mill-core.ts): read every pack spec, its published manifest
// and its distill drift, gather which live sessions were spawned against which pack, and hand it all
// to the pure assembler. Nothing is cached on disk and no timer runs: the Mill is a pull surface, so
// the only state here is the last report, replayed to a client that connects between requests.
//
// Fully async fs, like pack-builder: a spec can distill a whole docs tree, and every session shares
// one event loop.

import fsp from 'node:fs/promises';
import path from 'node:path';

import { needsDistill } from './core/distill-core.ts';
import { buildMillReport } from './core/mill-core.ts';
import type { MillReport } from './core/mill-core.ts';
import { packConsumerGroups, packVariantProjects, planPackVariants } from './core/pack-core.ts';
import type { PackManifest } from './core/pack-core.ts';
import { isPlainObject } from './core/usage-number-core.ts';
import {
  DEFAULT_PACKS_DIR,
  defaultBuiltRoot,
  defaultSpecsDir,
  distillOutputPath,
  distillSourceHashes,
  listPackSpecs,
  loadPackSpec,
  packSourceRoots,
  readBuiltManifest,
  resolveBuiltPack,
} from './pack-builder.ts';
import type { SpecListing } from './pack-builder.ts';

interface MillConfig {
  projects?: unknown;
  prReview?: { packs?: unknown } | null;
  posthog?: { packs?: unknown } | null;
  packsAutoRebuild?: boolean;
  packDistiller?: { enabled?: boolean } | null;
}

interface MillSessionSnapshot {
  id?: string;
  name?: string;
  path?: string;
  state?: string;
  ephemeral?: boolean;
  packs?: unknown;
}

interface DistillStatus {
  output: string;
  stale: boolean | null;
  reason: string | null;
}

interface MillSpecEntry {
  name: string;
  spec: Record<string, unknown> | null;
  specError: string | null;
  manifest: PackManifest | null;
  builtReason: string | null;
  distill: DistillStatus[];
  group?: string;
  variantProject?: { id: string | null; label: string };
}

interface MillWiringDependencies {
  config?: MillConfig;
  baseDir?: string;
  specsDir?: string | null;
  builtRoot?: string | null;
  listSessions?: () => MillSessionSnapshot[];
  getWatcherCount?: () => number | null;
  measurement?: () => Record<string, unknown>;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}

// A pass that threw answers the requestId with its reason instead of a report, so the payload a caller
// receives is one of two shapes discriminated by `error`.
interface MillReportFailure {
  type: string;
  requestId: string | null;
  ts: number;
  error: string;
}

type MillReportPayload = MillReport | MillReportFailure;

interface MillWiring {
  requestReport(msg: { requestId?: unknown } | null | undefined, send: (payload: MillReportPayload) => void): Promise<void>;
  listPackNames(): Promise<string[]>;
  resolvePackSourceRoots(name: string): Promise<string[]>;
  getCachedReport(): MillReport | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createMillWiring(deps: MillWiringDependencies = {}): MillWiring {
  const {
    config = {},
    baseDir = DEFAULT_PACKS_DIR,
    specsDir = null,
    builtRoot = null,
    listSessions = () => [],
    getWatcherCount = () => null,
    measurement = () => ({}),
    now = Date.now,
    log = console,
  } = deps;

  let lastReport: MillReport | null = null;
  let inFlight: Promise<MillReport> | null = null;
  // A request that lands mid-pass would otherwise be answered from bytes read before it arrived.
  let dirty = false;

  const resolvedSpecsDir = () => specsDir || defaultSpecsDir();
  const resolvedBuiltRoot = () => builtRoot || defaultBuiltRoot();

  async function readOutputFile(fullPath: string): Promise<string | null> {
    try {
      return await fsp.readFile(fullPath, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null;
      throw error;
    }
  }

  // A paired phone is a remote client on the far side of this report, so a failure names the code and
  // at most a basename. An fs error's own message carries the absolute path it failed on.
  function safeFailureReason(error: unknown): string {
    const failure = (error ?? {}) as { code?: unknown; path?: unknown; message?: unknown };
    const code = typeof failure.code === 'string' && failure.code ? failure.code : null;
    const file = typeof failure.path === 'string' && failure.path ? path.basename(failure.path) : null;
    if (code && file) return `${code} on ${file}`;
    if (code) return code;
    if (file) return `read failed on ${file}`;
    return String(failure.message || 'read failed');
  }

  // A check that could not run reports its reason with stale null, so the tab says "check failed"
  // rather than claiming a derived file is current or drifted on evidence it never had.
  async function distillStatus(entry: { output?: unknown; sources?: unknown } | null | undefined): Promise<DistillStatus> {
    const output = String(entry?.output ?? '');
    try {
      const fullPath = await distillOutputPath(output, { baseDir });
      if (!fullPath) return { output, stale: null, reason: 'output path resolves outside the packs directory' };
      const sources = await distillSourceHashes(entry ?? {}, { baseDir });
      const verdict = needsDistill(sources, await readOutputFile(fullPath));
      return { output, stale: verdict.stale, reason: verdict.reason };
    } catch (error) {
      return { output, stale: null, reason: safeFailureReason(error) };
    }
  }

  async function readSpecEntry({ name, specPath }: SpecListing): Promise<MillSpecEntry> {
    const entry: MillSpecEntry = { name, spec: null, specError: null, manifest: null, builtReason: null, distill: [] };
    let loaded: unknown;
    try {
      loaded = await loadPackSpec(specPath);
    } catch (error) {
      entry.specError = `could not read spec: ${safeFailureReason(error)}`;
      return entry;
    }
    // Valid JSON that is not an object (a bare null, an array, a number) parses without throwing, and
    // every read below dereferences it.
    if (!isPlainObject(loaded)) {
      entry.spec = null;
      entry.specError = 'spec file is not a JSON object';
      return entry;
    }
    entry.spec = loaded;
    entry.manifest = await readBuiltManifest(name, { builtRoot: resolvedBuiltRoot() });
    if (!entry.manifest) {
      const resolved = await resolveBuiltPack(name, { builtRoot: resolvedBuiltRoot() });
      entry.builtReason = resolved.reason;
    }
    const spec = entry.spec;
    if (!spec) return entry;
    for (const distill of Array.isArray(spec.distill) ? spec.distill : []) {
      entry.distill.push(await distillStatus(distill as { output?: unknown; sources?: unknown }));
    }
    return entry;
  }

  function sessionRows() {
    const rows: Record<string, unknown>[] = [];
    for (const snapshot of listSessions()) {
      rows.push({
        sessionId: snapshot.id,
        sessionName: snapshot.name,
        // The delivery rows are grouped by it and it never reaches the report: two cards on one
        // checkout are one delivery target, and the operator's directory layout is not the tab's.
        path: snapshot.path,
        state: snapshot.state,
        ephemeral: snapshot.ephemeral === true,
        packs: Array.isArray(snapshot?.packs) ? snapshot.packs : [],
      });
    }
    return rows;
  }

  /*
   * A per-project variant is its own top-level pack, so it gets its own row rather than a field on the
   * group's: same manifest read, same delivery join, plus the `group` and project it was derived for.
   * The drift check is the group's alone: a variant shares its spec, so re-running it per project would
   * multiply the one expensive thing this surface does.
   */
  async function variantEntries(entry: MillSpecEntry): Promise<MillSpecEntry[]> {
    const spec = entry.spec;
    if (!spec || spec.perProjectVariants !== true) return [];
    const projects = packVariantProjects(config);
    const labelById = new Map(projects.map((project) => [project.id, project.name]));
    const rows: MillSpecEntry[] = [];
    for (const build of planPackVariants(spec, projects).builds) {
      const variant = build.variant && typeof build.variant === 'object' ? build.variant : null;
      if (!variant) continue;
      const projectSlug = 'projectSlug' in variant ? variant.projectSlug : null;
      if (!projectSlug) continue;
      const variantProjectId = 'projectId' in variant ? variant.projectId : null;
      const manifest = await readBuiltManifest(build.name, { builtRoot: resolvedBuiltRoot() });
      const resolved = manifest ? null : await resolveBuiltPack(build.name, { builtRoot: resolvedBuiltRoot() });
      rows.push({
        name: build.name,
        spec: entry.spec,
        specError: entry.specError,
        group: entry.name,
        variantProject: {
          id: variantProjectId,
          label: labelById.get(variantProjectId) || 'project',
        },
        manifest,
        builtReason: resolved ? resolved.reason : null,
        distill: [],
      });
    }
    return rows;
  }

  async function buildReport(): Promise<MillReport> {
    const specs: MillSpecEntry[] = [];
    for (const spec of await listPackSpecs({ specsDir: resolvedSpecsDir() })) {
      const entry = await readSpecEntry(spec);
      specs.push(entry, ...(await variantEntries(entry)));
    }
    return buildMillReport({
      ts: now(),
      requestId: null,
      autoRebuild: config.packsAutoRebuild !== false,
      distillerEnabled: config.packDistiller?.enabled === true,
      watcherCount: getWatcherCount(),
      specs,
      sessionRows: sessionRows(),
      measurementByPack: measurement(),
      packsDir: baseDir,
      // The SAME enumeration the build gate reads, so the tab and the mill can never disagree about
      // what counts as a consumer, addressed per project rather than per card.
      consumerSources: packConsumerGroups(config),
    });
  }

  /*
   * A pass, plus at most one FOLLOW-UP pass when a request landed while the first was running. A
   * rebuild is exactly what a client asks about, so answering a mid-pass request from bytes read
   * before it arrived reports the state it was asking whether had changed. The bound is one: a chain
   * that re-ran for every late arrival would never settle under a polling client.
   */
  async function runPasses(): Promise<MillReport> {
    const first = await buildReport();
    if (!dirty) return first;
    dirty = false;
    return buildReport();
  }

  /*
   * The pulled half of the protocol. Clients asking at once share the pass: the walk touches every
   * spec's sources for the drift check, which is the one expensive thing this surface does.
   */
  async function requestReport(
    msg: { requestId?: unknown } | null | undefined,
    send: (payload: MillReportPayload) => void,
  ): Promise<void> {
    const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null;
    if (inFlight) dirty = true;
    if (!inFlight) {
      dirty = false;
      inFlight = runPasses().finally(() => { inFlight = null; });
    }
    try {
      const report = await inFlight;
      lastReport = { ...report, requestId: null };
      send({ ...report, requestId });
    } catch (error) {
      log.warn(`[mill] report failed: ${errorMessage(error)}`);
      send({ type: 'mill-report', requestId, ts: now(), error: errorMessage(error) });
    }
  }

  /*
   * The pack names a spec file actually defines. The control plane validates an assignment against
   * this rather than against the built packs: a spec that has never been built is exactly what a first
   * assignment is for, since assigning it is what makes the mill build it.
   */
  async function listPackNames(): Promise<string[]> {
    const specs = await listPackSpecs({ specsDir: resolvedSpecsDir() });
    return specs.map((spec) => spec.name);
  }

  // Read from the SPEC, not a manifest: a first assignment is exactly the case that has never been built.
  async function resolvePackSourceRoots(name: string): Promise<string[]> {
    const specs = await listPackSpecs({ specsDir: resolvedSpecsDir() });
    const found = specs.find((spec) => spec.name === name);
    if (!found) return [];
    try {
      return packSourceRoots(await loadPackSpec(found.specPath), { baseDir });
    } catch (error) {
      log.warn(`[mill] could not resolve source roots for "${name}": ${errorMessage(error)}`);
      return [];
    }
  }

  return {
    requestReport,
    listPackNames,
    resolvePackSourceRoots,
    getCachedReport: () => lastReport,
  };
}

export { createMillWiring };
export type { MillReportFailure, MillReportPayload, MillSpecEntry, MillWiring, MillWiringDependencies };
