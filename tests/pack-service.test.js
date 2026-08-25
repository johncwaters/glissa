'use strict';

// The context mill's automation loop with every side effect faked: which pack a watch fire rebuilds,
// what the fallback sweep covers, when `pack-updated` is (and is not) emitted, and that stop() closes
// the watchers, kills the timer and drains an in-flight rebuild. No fs, no timers, no real builds.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPackService } = require('../server/pack-service');

// Drain the microtask queue: the loop chains several awaits before a build starts, and a build
// queued by a watch fire runs off the shared promise chain rather than inline.
const flush = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { await flush(); await flush(); };

const SPECS = [
  { name: 'alpha', specPath: '/specs/alpha.pack.json' },
  { name: 'beta', specPath: '/specs/beta.pack.json' },
];

const ROOTS = {
  '/specs/alpha.pack.json': ['/packs/sources/alpha', '/packs/skills/alpha-skill'],
  '/specs/beta.pack.json': ['/packs/sources/beta'],
};

function okReport(name, overrides = {}) {
  return {
    ok: true, name, specPath: `/specs/${name}.pack.json`, errors: [],
    version: `v-${name}-1`, fileCount: 3, tokenEstimate: 100, budgetTokens: 4000,
    currentDir: `/built/${name}/current`, unchanged: false, ...overrides,
  };
}

// A fake service: fake watchers (recording the dir they claimed and their onChange), a fake interval,
// and a build that returns whatever the test queued for that pack name.
function harness({
  specs = SPECS,
  reportFor = (name) => okReport(name),
  consumedPackNames = null,
  variantProjects = null,
  rootsForSpec = (spec) => ROOTS[spec.specPath] || [],
} = {}) {
  const watchers = [];
  const builds = [];
  const buildCalls = [];
  let intervalCallback = null;
  let intervalMs = null;
  let intervalCleared = 0;

  const service = createPackService({
    consumedPackNames,
    ...(variantProjects ? { variantProjects } : {}),
    listSpecs: async () => specs,
    loadSpec: async (specPath) => ({ name: specPath, sources: [], skills: [] , specPath }),
    watchRootsForSpec: async (spec) => rootsForSpec(spec),
    build: async ({ name, specPath, projects }) => {
      builds.push(name);
      buildCalls.push({ name, projects });
      return reportFor(name, specPath, projects);
    },
    createWatcher: ({ onChange }) => {
      const watcher = { dir: null, onChange, stopped: false };
      watcher.watch = (dir) => { watcher.dir = dir; watchers.push(watcher); return true; };
      watcher.stop = () => { watcher.stopped = true; };
      return watcher;
    },
    setIntervalFn: (fn, ms) => { intervalCallback = fn; intervalMs = ms; return { unref() {} }; },
    clearIntervalFn: () => { intervalCleared += 1; },
    log: { log() {}, warn() {} },
  });

  const updates = [];
  service.on('pack-updated', (payload) => updates.push(payload));

  return {
    service, watchers, builds, buildCalls, updates,
    fireWatch: (dir) => watchers.find((w) => w.dir === dir).onChange(),
    tickInterval: () => intervalCallback(),
    get intervalMs() { return intervalMs; },
    get intervalCleared() { return intervalCleared; },
    hasInterval: () => intervalCallback !== null,
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
  const versions = { alpha: 'v1', beta: 'v1' };
  const unchanged = { alpha: true, beta: true };
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
      ? { ok: false, name, errors: ['over its 4000 token budget'], unchanged: false }
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
  // What the interval callback does, while the boot sweep is still running.
  void h.service.sweep();
  void h.service.sweep();
  await started;
  await h.service.stop();

  assert.deepEqual(h.builds, ['alpha', 'beta'], 'the re-entrant sweeps were dropped');
});

test('stop closes every watcher, clears the timer and drains the in-flight rebuild', async () => {
  let hang = false;
  let settled = false;
  let release = null;
  const h = harness({
    reportFor: (name) => {
      if (!hang) return okReport(name);
      return new Promise((resolve) => { release = () => { settled = true; resolve(okReport(name)); }; });
    },
  });

  await h.service.start();
  hang = true;
  h.fireWatch('/packs/sources/alpha');
  await flush();

  const stopping = h.service.stop();
  release();
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

// ── Consumer gating ──
// A pack nothing would be spawned against costs a source walk per sweep to publish bytes no session
// will ever be handed, so it is neither watched nor swept until something names it.

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
  let consumed = [];
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
  let consumed = [];
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
  // The assignment has been written to disk but not yet reloaded, so the in-memory consumer set does not
  // name it yet. This is the ONLY window in which the filter must be ignored.
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
  await h.service.ensureBuilt(null);

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

  // One timer is live, and the restart cleared the boot one rather than assigning over it.
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

  // Every watcher ever created is closed: an fs.watch handle installed after teardown emptied the array
  // is one nothing would ever close.
  assert.equal(h.watchers.every((w) => w.stopped), true, `${h.watchers.filter((w) => !w.stopped).length} watchers left open`);
});

// ---- Per-project variants: derived packs are recorded and announced in their own right ----

function groupReport(name, overrides = {}) {
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
  // The unchanged variant publishes nothing, exactly like an unchanged plain pack.
  assert.deepEqual(h.updates.map((update) => update.name), ['alpha', 'alpha-glissa-12345678']);
  await h.service.stop();
});

test('a failed variant is warned about and leaves its group build reported as ok', async () => {
  const warnings = [];
  const h = harness({
    consumedPackNames: () => ['alpha'],
    reportFor: (name) => groupReport(name, {
      variants: [{ ...okReport(`${name}-glissa-12345678`), ok: false, errors: ['budget'] }],
    }),
  });
  h.service.on('pack-updated', (update) => warnings.push(update.name));
  await h.service.start();

  assert.deepEqual(h.service.getVersions(), { alpha: 'v-alpha-1' });
  assert.deepEqual(warnings, ['alpha']);
  await h.service.stop();
});

test('the projects a build derives variants from are read live, per build', async () => {
  let projects = [{ id: 'p1', name: 'glissa', path: '/repos/a/glissa', packs: ['alpha'] }];
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
  let projects = [{ id: 'p1', name: 'glissa', path: '/repos/a/glissa', packs: ['alpha'] }];
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
  const saved = [{ id: 'p1', name: 'glissa', path: '/repos/a/glissa', packs: ['alpha'] }];
  const h = harness({ consumedPackNames: () => [], variantProjects: () => [] });
  await h.service.start();

  await h.service.ensureBuilt(['alpha'], { projects: saved });

  assert.deepEqual(h.buildCalls.map((call) => call.name), ['alpha']);
  assert.deepEqual(h.buildCalls[0].projects, saved);
  await h.service.stop();
});
