
import { EventEmitter } from 'node:events';

import { buildPack, listPackSpecs, loadPackSpec, packWatchRoots } from './pack-builder.ts';
import type { BuildReport, SpecListing } from './pack-builder.ts';
import { createPackWatcher } from './pack-watch.ts';
import type { PackWatcher } from './pack-watch.ts';
import { shortVersion } from './text-format.ts';

const DEFAULT_SWEEP_MINUTES = 15;
const DEFAULT_DEBOUNCE_MS = 500;

type ProjectRecord = Record<string, unknown>;

type VariantProject = {
  id?: unknown;
  path?: unknown;
};

interface PackServiceDependencies {
  listSpecs?: () => Promise<SpecListing[]> | SpecListing[];
  loadSpec?: (specPath: string) => Promise<unknown>;
  watchRootsForSpec?: (spec: unknown) => Promise<string[]> | string[];
  build?: (input: {
    specPath: string;
    name?: string;
    projects?: ProjectRecord[] | null;
  }) => Promise<BuildReport | null>;
  createWatcher?: typeof createPackWatcher;
  variantProjects?: () => VariantProject[];
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  sweepMinutes?: number;
  debounceMs?: number;
  log?: Pick<Console, 'log' | 'warn'>;
}

interface PackServiceApi {
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  restartIfConsumersChanged(): Promise<void>;
  sweep(): Promise<void>;
  getVersions(): Record<string, string | null>;
  _watcherCount(): number;
}

type PackService = EventEmitter & PackServiceApi;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createPackService(deps: PackServiceDependencies = {}): PackService {
  const {
    listSpecs = () => listPackSpecs(),
    loadSpec = (specPath: string) => loadPackSpec(specPath),
    watchRootsForSpec = (spec: unknown) => packWatchRoots(spec),
    build = ({ specPath, projects }: { specPath: string; projects?: ProjectRecord[] | null }) => buildPack({ specPath, projects: projects ?? [] }),
    createWatcher = createPackWatcher,
    variantProjects = () => [],
    setIntervalFn = (fn: () => void, ms: number) => setInterval(fn, ms),
    clearIntervalFn = clearInterval,
    sweepMinutes = DEFAULT_SWEEP_MINUTES,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    log = console,
  } = deps;

  const service = new EventEmitter();
  const watchers: PackWatcher[] = [];
  const versionsByName = new Map<string, string | null>();
  let sweepTimer: NodeJS.Timeout | null = null;
  let sweepRunning = false;
  let stopped = true;
  let torndown = false;
  let buildChain: Promise<BuildReport | null> = Promise.resolve(null);
  let restartChain: Promise<void> = Promise.resolve();
  let lastConsumerKey = '';

  function consumerKeyFor(specs: SpecListing[]): string {
    return JSON.stringify([
      specs.map((spec) => spec.name),
      variantProjects().map((project) => [project?.id ?? null, project?.path ?? null]),
    ]);
  }

  function notePublished(report: BuildReport | null | undefined): void {
    if (!report) return;
    if (!report.ok) {
      log.warn(`[packs] ${report.name} rebuild failed: ${report.errors?.join('; ') || 'no report'}`);
      return;
    }
    versionsByName.set(report.name, report.version);
    if (report.unchanged) return;
    log.log(`[packs] ${report.name} rebuilt: version ${shortVersion(report.version)}`);
    service.emit('pack-updated', { name: report.name, version: report.version });
  }

  async function runBuild(name: string, specPath: string): Promise<BuildReport | null> {
    if (stopped) return null;
    const report = await build({ specPath, name, projects: variantProjects() });
    if (!report) {
      log.warn(`[packs] ${name} rebuild failed: no report`);
      return null;
    }
    for (const warning of Array.isArray(report.warnings) ? report.warnings : []) log.warn(`[packs] ${name}: ${warning}`);
    notePublished(report);
    for (const variant of Array.isArray(report.variants) ? report.variants : []) notePublished(variant);
    return report;
  }

  function queueBuild(name: string, specPath: string): Promise<BuildReport | null> {
    buildChain = buildChain.then(() => runBuild(name, specPath)).catch((err: unknown) => {
      log.warn(`[packs] ${name} rebuild crashed: ${errorMessage(err)}`);
      return null;
    });
    return buildChain;
  }

  async function installWatchers({ name, specPath }: SpecListing): Promise<void> {
    let roots: string[];
    try {
      const spec = await loadSpec(specPath);
      roots = await watchRootsForSpec(spec);
    } catch (err) {
      log.warn(`[packs] ${name} has no watchable roots: ${errorMessage(err)}`);
      return;
    }
    if (stopped || torndown) return;
    for (const root of roots) {
      if (stopped || torndown) return;
      const watcher = createWatcher({ onChange: () => { void queueBuild(name, specPath); }, debounceMs });
      if (!watcher.watch(root)) continue;
      watchers.push(watcher);
    }
  }

  function armSweepTimer(): void {
    if (sweepTimer) clearIntervalFn(sweepTimer);
    sweepTimer = setIntervalFn(() => { void sweep(); }, sweepMinutes * 60000);
    if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }

  async function sweep(): Promise<void> {
    if (sweepRunning || stopped) return;
    sweepRunning = true;
    try {
      for (const spec of await listSpecs()) {
        if (stopped) return;
        await queueBuild(spec.name, spec.specPath);
      }
    } finally {
      sweepRunning = false;
    }
  }

  async function startNow(): Promise<void> {
    if (torndown) return;
    stopped = false;
    const specs = await listSpecs();
    lastConsumerKey = consumerKeyFor(specs);
    if (stopped || torndown) return;
    armSweepTimer();
    for (const spec of specs) await installWatchers(spec);
    await sweep();
  }

  function runOnChain(task: () => Promise<void>): Promise<void> {
    restartChain = restartChain.then(task).catch((err: unknown) => {
      log.warn(`[packs] ${errorMessage(err)}`);
    });
    return restartChain;
  }

  function start(): Promise<void> {
    return runOnChain(startNow);
  }

  async function teardown(): Promise<void> {
    stopped = true;
    if (sweepTimer) clearIntervalFn(sweepTimer);
    sweepTimer = null;
    for (const watcher of watchers) watcher.stop();
    watchers.length = 0;
    await buildChain.catch(() => {});
  }

  function pause(): Promise<void> {
    return runOnChain(async () => {
      if (torndown) return;
      await teardown();
    });
  }

  function resume(): Promise<void> {
    return runOnChain(async () => {
      if (torndown || !stopped) return;
      await startNow();
    });
  }

  async function stop(): Promise<void> {
    torndown = true;
    stopped = true;
    await restartChain.catch(() => {});
    await teardown();
  }

  function restartIfConsumersChanged(): Promise<void> {
    return runOnChain(async () => {
      if (torndown) return;
      const key = consumerKeyFor(await listSpecs());
      if (key === lastConsumerKey) return;
      await teardown();
      await startNow();
    });
  }

  return Object.assign(service, {
    start,
    pause,
    resume,
    stop,
    restartIfConsumersChanged,
    sweep,
    getVersions: () => Object.fromEntries(versionsByName),
    _watcherCount: () => watchers.length,
  });
}

export { DEFAULT_DEBOUNCE_MS, DEFAULT_SWEEP_MINUTES, createPackService };
export type { PackService, PackServiceDependencies };
