import test from 'node:test';
import assert from 'node:assert/strict';

import { createPackService } from '../server/pack-service.ts';
import type { PackService, PackServiceDependencies } from '../server/pack-service.ts';
import type { BuildReport, SpecListing } from '../server/pack-builder.ts';
import type { PackWatcher } from '../server/pack-watch.ts';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const settle = async (): Promise<void> => { await flush(); await flush(); };

const SPECS: SpecListing[] = [
  { name: 'alpha', specPath: '/specs/alpha.pack.json' },
  { name: 'beta', specPath: '/specs/beta.pack.json' },
];

const ROOTS: Record<string, string[]> = {
  '/specs/alpha.pack.json': ['/packs/sources/alpha', '/packs/skills/alpha-skill'],
  '/specs/beta.pack.json': ['/packs/sources/beta'],
};

type ProjectRecord = Record<string, unknown>;
type ReportFor = (name: string) => BuildReport | Promise<BuildReport>;

interface RecordingWatcher extends PackWatcher {
  dir: string | null;
  onChange: () => void;
  stopped: boolean;
}

interface PackUpdate {
  name: string;
  version: string | null;
}

interface HarnessOptions {
  specs?: SpecListing[];
  reportFor?: ReportFor;
  consumedPackNames?: (() => unknown) | null;
  variantProjects?: () => { id?: unknown; path?: unknown; packs?: unknown }[];
  rootsForSpec?: (spec: SpecListing) => string[];
}

interface Harness {
  service: PackService;
  watchers: RecordingWatcher[];
  builds: string[];
  buildCalls: { name: string | undefined; projects: ProjectRecord[] | null | undefined }[];
  updates: PackUpdate[];
  fireWatch: (dir: string) => void;
  tickInterval: () => void;
  readonly intervalMs: number | null;
  readonly intervalCleared: number;
  hasInterval: () => boolean;
}

function okReport(name: string, overrides: Partial<BuildReport> = {}): BuildReport {
  return {
    ok: true, name, specPath: `/specs/${name}.pack.json`, errors: [], warnings: [], variants: [],
    version: `v-${name}-1`, fileCount: 3, tokenEstimate: 100, budgetTokens: 4000,
    currentDir: `/built/${name}/current`, unchanged: false, ...overrides,
  };
}

function harness({
  specs = SPECS,
  reportFor = (name) => okReport(name),
  consumedPackNames = null,
  variantProjects,
  rootsForSpec = (spec) => ROOTS[spec.specPath] || [],
}: HarnessOptions = {}): Harness {
  const watchers: RecordingWatcher[] = [];
  const builds: string[] = [];
  const buildCalls: { name: string | undefined; projects: ProjectRecord[] | null | undefined }[] = [];

  const interval: { callback: (() => void) | null; ms: number | null; cleared: number } = {
    callback: null, ms: null, cleared: 0,
  };

  const dependencies: PackServiceDependencies = {
    consumedPackNames,
    ...(variantProjects ? { variantProjects } : {}),
    listSpecs: async () => specs,
    loadSpec: async (specPath: string) => ({ name: specPath, sources: [], skills: [], specPath }),
    watchRootsForSpec: async (spec) => rootsForSpec(spec as SpecListing),
    build: async ({ name, projects }) => {
      builds.push(String(name));
      buildCalls.push({ name, projects });
      return reportFor(String(name));
    },
    createWatcher: ({ onChange }) => {
      const watcher: RecordingWatcher = {
        dir: null,
        onChange,
        stopped: false,
        active: true,
        watch(dir: string) { watcher.dir = dir; watchers.push(watcher); return true; },
        stop() { watcher.stopped = true; },
      };
      return watcher;
    },
    setIntervalFn: (fn, ms) => {
      interval.callback = fn;
      interval.ms = ms;
      const handle = setInterval(() => {}, 2 ** 30);
      handle.unref();
      return handle;
    },
    clearIntervalFn: (handle) => { clearInterval(handle); interval.cleared += 1; },
    log: { log() {}, warn() {} },
  };

  const service = createPackService(dependencies);

  const updates: PackUpdate[] = [];
  service.on('pack-updated', (payload: PackUpdate) => updates.push(payload));

  return {
    service, watchers, builds, buildCalls, updates,
    fireWatch: (dir: string) => {
      const watcher = watchers.find((candidate) => candidate.dir === dir);
      if (!watcher) throw new Error(`no watcher claimed ${dir}`);
      watcher.onChange();
    },
    tickInterval: () => {
      if (!interval.callback) throw new Error('no sweep interval was installed');
      interval.callback();
    },
    get intervalMs() { return interval.ms; },
    get intervalCleared() { return interval.cleared; },
    hasInterval: () => interval.callback !== null,
  };
}

test('start installs one watcher per source root and builds every spec once', async () => {
  const h = harness();
  await h.service.start();

  assert.deepEqual(h.watchers.map((w) => w.dir), ['/packs/sources/alpha', '/packs/skills/alpha-skill', '/packs/sources/beta']);
  assert.deepEqual(h.builds, ['alpha', 'beta'], 'the boot sweep covers a source edited while Glissa was down');
  assert.equal(h.intervalMs, 15 * 60000);
});

test('a throwing watch root provider leaves the sweep timer armed and later specs active', async () => {
  const h = harness({
    rootsForSpec: (spec) => {
      if (spec.specPath === '/specs/alpha.pack.json') throw new Error('root provider failed');
      return ROOTS[spec.specPath] || [];
    },
  });

  await assert.doesNotReject(h.service.start());

  assert.equal(h.hasInterval(), true);
  assert.deepEqual(h.watchers.map((watcher) => watcher.dir), ['/packs/sources/beta']);
  assert.deepEqual(h.builds, ['alpha', 'beta']);
  h.builds.length = 0;
  h.tickInterval();
  await settle();
  assert.deepEqual(h.builds, ['alpha', 'beta']);
  await h.service.stop();
});

test('a watch fire rebuilds only its own pack', async () => {
  const h = harness();
  await h.service.start();
  h.builds.length = 0;

  h.fireWatch('/packs/sources/beta');
  await settle();

  assert.deepEqual(h.builds, ['beta']);
  await h.service.stop();
});

test('the interval sweep rebuilds every spec', async () => {
  const h = harness();
  await h.service.start();
  h.builds.length = 0;

  h.tickInterval();
  await settle();

  assert.deepEqual(h.builds, ['alpha', 'beta']);
  await h.service.stop();
});

test('a published rebuild emits pack-updated; an unchanged one is silent', async () => {
  const versions: Record<string, string> = { alpha: 'v1', beta: 'v1' };
  const unchanged: Record<string, boolean> = { alpha: true, beta: true };
  const h = harness({ reportFor: (name) => okReport(name, { version: versions[name], unchanged: unchanged[name] }) });

  await h.service.start();
  assert.deepEqual(h.updates, [], 'a sweep that found nothing new must not broadcast a heartbeat');
  assert.deepEqual(h.service.getVersions(), { alpha: 'v1', beta: 'v1' }, 'an unchanged build still reports the live version');

  versions.alpha = 'v2';
  unchanged.alpha = false;
  h.fireWatch('/packs/sources/alpha');
  await settle();

  assert.deepEqual(h.updates, [{ name: 'alpha', version: 'v2' }]);
  assert.deepEqual(h.service.getVersions(), { alpha: 'v2', beta: 'v1' });
  await h.service.stop();
});

test('a failed build emits nothing and leaves the loop running', async () => {
  const h = harness({
    reportFor: (name) => (name === 'alpha'
      ? okReport(name, { ok: false, errors: ['over its 4000 token budget'], version: null })
      : okReport(name)),
  });

  await h.service.start();

  assert.deepEqual(h.updates.map((u) => u.name), ['beta'], 'beta still built after alpha failed');
  assert.equal(h.service.getVersions().alpha, undefined, 'a failed build never becomes the staleness baseline');
  await h.service.stop();
});

test('a build that throws is caught, so one bad pack cannot kill the loop', async () => {
  const h = harness({ reportFor: (name) => { if (name === 'alpha') throw new Error('disk gone'); return okReport(name); } });
  await assert.doesNotReject(h.service.start());
  assert.deepEqual(h.updates.map((u) => u.name), ['beta']);
  await h.service.stop();
});

test('builds are serialized, so a watch fire during a sweep never publishes concurrently', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const h = harness({
    reportFor: async (name) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return okReport(name);
    },
  });

  const started = h.service.start();
  await flush();
  h.fireWatch('/packs/sources/beta');
  h.fireWatch('/packs/sources/alpha');
  await started;
  await h.service.stop();

  assert.equal(maxInFlight, 1, 'two builds of the same pack dir must never overlap');
  assert.ok(h.builds.length >= 3, 'the queued watch fires still ran');
});

test('a sweep already running is not started again', async () => {
  const h = harness({ reportFor: async (name) => { await new Promise((resolve) => setTimeout(resolve, 10)); return okReport(name); } });

  const started = h.service.start();
  await flush();

  void h.service.sweep();
  void h.service.sweep();
  await started;
  await h.service.stop();

  assert.deepEqual(h.builds, ['alpha', 'beta'], 'the re-entrant sweeps were dropped');
});

test('stop closes every watcher, clears the timer and drains the in-flight rebuild', async () => {
  let hang = false;
  let settled = false;
  const pending: { release: (() => void) | null } = { release: null };
  const h = harness({
    reportFor: (name) => {
      if (!hang) return okReport(name);
      return new Promise<BuildReport>((resolve) => {
        pending.release = () => { settled = true; resolve(okReport(name)); };
      });
    },
  });

  await h.service.start();
  hang = true;
  h.fireWatch('/packs/sources/alpha');
  await flush();

  const stopping = h.service.stop();
  if (!pending.release) throw new Error('the hung build never registered its release');
  pending.release();
  await stopping;

  assert.equal(settled, true, 'stop() waited for the build that was mid-publish');
  assert.equal(h.watchers.every((w) => w.stopped), true);
  assert.equal(h.intervalCleared, 1);
});

test('a rebuild queued after stop() does not run', async () => {
  const h = harness();
  await h.service.start();
  h.builds.length = 0;
  h.updates.length = 0;

  await h.service.stop();
  h.fireWatch('/packs/sources/alpha');
  await settle();

  assert.deepEqual(h.builds, []);
  assert.deepEqual(h.updates, []);
});

test('an install with no specs is fully inert: no watcher, no timer, no build', async () => {
  const h = harness({ specs: [] });
  await h.service.start();

  assert.deepEqual(h.watchers, []);
  assert.deepEqual(h.builds, []);
  assert.equal(h.hasInterval(), false);
  await h.service.stop();
});

test('a spec with no consumers gets no watcher and is skipped by the sweep', async () => {
  const h = harness({ consumedPackNames: () => ['beta'] });
  await h.service.start();

  assert.deepEqual(h.watchers.map((w) => w.dir), ['/packs/sources/beta'], 'alpha is not watched');
  assert.deepEqual(h.builds, ['beta'], 'the boot sweep built only the consumed pack');

  h.builds.length = 0;
  h.tickInterval();
  await settle();
  assert.deepEqual(h.builds, ['beta'], 'the interval sweep skips it too');
  await h.service.stop();
});

test('with nothing consumed at all the service is as inert as an install with no specs', async () => {
  const h = harness({ consumedPackNames: () => [] });
  await h.service.start();

  assert.deepEqual(h.watchers, []);
  assert.deepEqual(h.builds, []);
  assert.equal(h.hasInterval(), false, 'no timer either: there is nothing for a sweep to do');
  await h.service.stop();
});

test('the first consumer of a pack starts watching it and builds it, with no server restart', async () => {
  let consumed: string[] = [];
  const h = harness({ consumedPackNames: () => consumed });
  await h.service.start();
  assert.deepEqual(h.builds, []);

  consumed = ['alpha'];
  await h.service.restartIfConsumersChanged();

  assert.deepEqual(h.builds, ['alpha'], 'the next spawn finds a current build');
  assert.deepEqual(h.watchers.filter((w) => !w.stopped).map((w) => w.dir),
    ['/packs/sources/alpha', '/packs/skills/alpha-skill']);
  assert.equal(h.hasInterval(), true, 'the fallback sweep is installed now that there is something to sweep');

  h.builds.length = 0;
  h.fireWatch('/packs/sources/alpha');
  await settle();
  assert.deepEqual(h.builds, ['alpha'], 'the fresh watcher rebuilds its own pack');
  await h.service.stop();
});

test('losing the last consumer stops that pack watchers', async () => {
  let consumed = ['alpha', 'beta'];
  const h = harness({ consumedPackNames: () => consumed });
  await h.service.start();
  assert.equal(h.watchers.length, 3);

  consumed = ['beta'];
  await h.service.restartIfConsumersChanged();

  assert.deepEqual(h.watchers.filter((w) => !w.stopped).map((w) => w.dir), ['/packs/sources/beta']);
  await h.service.stop();
});

test('an unchanged consumer set never restarts the loops', async () => {
  const h = harness({ consumedPackNames: () => ['alpha'] });
  await h.service.start();
  const watcherCount = h.watchers.length;
  h.builds.length = 0;

  await h.service.restartIfConsumersChanged();
  await h.service.restartIfConsumersChanged();

  assert.deepEqual(h.builds, [], 'an unrelated settings save must not rebuild anything');
  assert.equal(h.watchers.length, watcherCount, 'nor churn the watchers');
  await h.service.stop();
});

test('a consumer change queued after stop() cannot bring the loops back', async () => {
  let consumed: string[] = [];
  const h = harness({ consumedPackNames: () => consumed });
  await h.service.start();
  await h.service.stop();

  consumed = ['alpha'];
  await h.service.restartIfConsumersChanged();

  assert.deepEqual(h.builds, []);
  assert.deepEqual(h.watchers, []);
});

test('an unfiltered service is unaffected by the consumer gate', async () => {
  const h = harness();
  await h.service.start();
  h.builds.length = 0;

  await h.service.restartIfConsumersChanged();

  assert.deepEqual(h.builds, [], 'no consumer source means nothing to compare, so nothing restarts');
  assert.equal(h.watchers.length, 3, 'and every spec is still watched');
  await h.service.stop();
});

test('ensureBuilt builds a pack the consumer filter would still skip', async () => {
  const h = harness({ consumedPackNames: () => [] });
  await h.service.start();
  assert.deepEqual(h.builds, []);

  await h.service.ensureBuilt(['alpha']);

  assert.deepEqual(h.builds, ['alpha']);
  assert.equal(h.service.getVersions().alpha, 'v-alpha-1', 'the next spawn resolves a built pack');
  await h.service.stop();
});

test('ensureBuilt ignores a name no spec defines, and an empty request costs nothing', async () => {
  const h = harness({ consumedPackNames: () => [] });
  await h.service.start();

  await h.service.ensureBuilt(['ghost']);
  await h.service.ensureBuilt([]);
  await h.service.ensureBuilt([]);

  assert.deepEqual(h.builds, []);
  await h.service.stop();
});

test('ensureBuilt after stop() builds nothing', async () => {
  const h = harness({ consumedPackNames: () => ['alpha'] });
  await h.service.start();
  await h.service.stop();
  h.builds.length = 0;

  await h.service.ensureBuilt(['alpha']);

  assert.deepEqual(h.builds, []);
});

test('a consumer change racing the boot sweep queues behind it rather than orphaning its timer', async () => {
  let consumed = ['alpha'];
  const h = harness({
    consumedPackNames: () => consumed,
    reportFor: async (name) => { await new Promise((resolve) => setTimeout(resolve, 5)); return okReport(name); },
  });

  const started = h.service.start();
  await flush();
  consumed = ['alpha', 'beta'];
  const restarted = h.service.restartIfConsumersChanged();
  await started;
  await restarted;

  assert.equal(h.intervalCleared, 1, 'the boot interval was cleared by the restart, not leaked');
  assert.equal(h.watchers.filter((w) => !w.stopped).length, 3, 'the restart reinstalled every watcher exactly once');
  await h.service.stop();
  assert.equal(h.intervalCleared, 2);
});

test('a restart racing stop() installs no watcher into the emptied array', async () => {
  let consumed = ['alpha'];
  const h = harness({ consumedPackNames: () => consumed });
  await h.service.start();

  consumed = ['alpha', 'beta'];
  const restarted = h.service.restartIfConsumersChanged();
  const stopping = h.service.stop();
  await Promise.all([restarted, stopping]);

  assert.equal(h.watchers.every((w) => w.stopped), true, `${h.watchers.filter((w) => !w.stopped).length} watchers left open`);
});

function groupReport(name: string, overrides: Partial<BuildReport> = {}): BuildReport {
  return okReport(name, {
    variants: [
      okReport(`${name}-glissa-12345678`, { version: `v-${name}-a` }),
      okReport(`${name}-other-87654321`, { version: `v-${name}-b`, unchanged: true }),
    ],
    ...overrides,
  });
}

test('a derived pack gets its own version and its own pack-updated, like any other pack', async () => {
  const h = harness({ consumedPackNames: () => ['alpha'], reportFor: (name) => groupReport(name) });
  await h.service.start();

  assert.deepEqual(h.service.getVersions(), {
    alpha: 'v-alpha-1',
    'alpha-glissa-12345678': 'v-alpha-a',
    'alpha-other-87654321': 'v-alpha-b',
  });

  assert.deepEqual(h.updates.map((update) => update.name), ['alpha', 'alpha-glissa-12345678']);
  await h.service.stop();
});

test('a failed variant is warned about and leaves its group build reported as ok', async () => {
  const warnings: string[] = [];
  const h = harness({
    consumedPackNames: () => ['alpha'],
    reportFor: (name) => groupReport(name, {
      variants: [{ ...okReport(`${name}-glissa-12345678`), ok: false, errors: ['budget'] }],
    }),
  });
  h.service.on('pack-updated', (update: PackUpdate) => warnings.push(update.name));
  await h.service.start();

  assert.deepEqual(h.service.getVersions(), { alpha: 'v-alpha-1' });
  assert.deepEqual(warnings, ['alpha']);
  await h.service.stop();
});

test('the projects a build derives variants from are read live, per build', async () => {
  let projects: ProjectRecord[] = [{ id: 'p1', name: 'glissa', path: '/repos/a/glissa', packs: ['alpha'] }];
  const h = harness({ consumedPackNames: () => ['alpha'], variantProjects: () => projects });
  await h.service.start();
  assert.deepEqual(h.buildCalls[0].projects, projects);

  projects = [];
  h.fireWatch('/packs/sources/alpha');
  await settle();
  assert.deepEqual(h.buildCalls[h.buildCalls.length - 1].projects, []);
  await h.service.stop();
});

test('a project moving path restarts the loops: the derived pack set moved even though the names did not', async () => {
  let projects: ProjectRecord[] = [{ id: 'p1', name: 'glissa', path: '/repos/a/glissa', packs: ['alpha'] }];
  const h = harness({ consumedPackNames: () => ['alpha'], variantProjects: () => projects });
  await h.service.start();
  h.builds.length = 0;

  await h.service.restartIfConsumersChanged();
  assert.deepEqual(h.builds, [], 'nothing moved, so nothing was rebuilt');

  projects = [{ id: 'p1', name: 'glissa', path: '/repos/moved/glissa', packs: ['alpha'] }];
  await h.service.restartIfConsumersChanged();
  assert.deepEqual(h.builds, ['alpha'], 'the variant for the new path is built without a server restart');
  await h.service.stop();
});

test('ensureBuilt derives variants from the SAVED config, which the in-memory one does not know yet', async () => {
  const saved: ProjectRecord[] = [{ id: 'p1', name: 'glissa', path: '/repos/a/glissa', packs: ['alpha'] }];
  const h = harness({ consumedPackNames: () => [], variantProjects: () => [] });
  await h.service.start();

  await h.service.ensureBuilt(['alpha'], { projects: saved });

  assert.deepEqual(h.buildCalls.map((call) => call.name), ['alpha']);
  assert.deepEqual(h.buildCalls[0].projects, saved);
  await h.service.stop();
});
