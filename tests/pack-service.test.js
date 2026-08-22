'use strict';

// The context mill's automation loop with every side effect faked: which pack a watch fire rebuilds,
// what the fallback sweep covers, which rebuilds actually published, and that stop() closes the
// watchers, kills the timer and drains an in-flight rebuild. No fs, no timers, no real builds.

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
function harness({ specs = SPECS, reportFor = (name) => okReport(name) } = {}) {
  const watchers = [];
  const builds = [];
  const published = [];
  let intervalCallback = null;
  let intervalMs = null;
  let intervalCleared = 0;

  const service = createPackService({
    listSpecs: async () => specs,
    loadSpec: async (specPath) => ({ name: specPath, sources: [], skills: [] , specPath }),
    watchRootsForSpec: async (spec) => ROOTS[spec.specPath] || [],
    build: async ({ name, specPath }) => {
      builds.push(name);
      return reportFor(name, specPath);
    },
    createWatcher: ({ onChange }) => {
      const watcher = { dir: null, onChange, stopped: false };
      watcher.watch = (dir) => { watcher.dir = dir; watchers.push(watcher); return true; };
      watcher.stop = () => { watcher.stopped = true; };
      return watcher;
    },
    setIntervalFn: (fn, ms) => { intervalCallback = fn; intervalMs = ms; return { unref() {} }; },
    clearIntervalFn: () => { intervalCleared += 1; },
    // A published rebuild is observable only through its log line; an unchanged one says nothing.
    log: { log: (line) => published.push(line), warn() {} },
  });

  return {
    service, watchers, builds, published,
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

test('a rebuild that published says so; an unchanged one is silent', async () => {
  const versions = { alpha: 'v1', beta: 'v1' };
  const unchanged = { alpha: true, beta: true };
  const h = harness({ reportFor: (name) => okReport(name, { version: versions[name], unchanged: unchanged[name] }) });

  await h.service.start();
  assert.deepEqual(h.published, [], 'a sweep that found nothing new must not announce a heartbeat');

  versions.alpha = 'v2';
  unchanged.alpha = false;
  h.fireWatch('/packs/sources/alpha');
  await settle();

  assert.equal(h.published.length, 1);
  assert.match(h.published[0], /alpha rebuilt/);
  await h.service.stop();
});

test('a failed build emits nothing and leaves the loop running', async () => {
  const h = harness({
    reportFor: (name) => (name === 'alpha'
      ? { ok: false, name, errors: ['over its 4000 token budget'], unchanged: false }
      : okReport(name)),
  });

  await h.service.start();

  assert.equal(h.published.length, 1, 'beta still published after alpha failed');
  assert.match(h.published[0], /beta rebuilt/);
  await h.service.stop();
});

test('a build that throws is caught, so one bad pack cannot kill the loop', async () => {
  const h = harness({ reportFor: (name) => { if (name === 'alpha') throw new Error('disk gone'); return okReport(name); } });
  await assert.doesNotReject(h.service.start());
  assert.equal(h.published.length, 1);
  assert.match(h.published[0], /beta rebuilt/);
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
  h.published.length = 0;

  await h.service.stop();
  h.fireWatch('/packs/sources/alpha');
  await settle();

  assert.deepEqual(h.builds, []);
  assert.deepEqual(h.published, []);
});

test('an install with no specs is fully inert: no watcher, no timer, no build', async () => {
  const h = harness({ specs: [] });
  await h.service.start();

  assert.deepEqual(h.watchers, []);
  assert.deepEqual(h.builds, []);
  assert.equal(h.hasInterval(), false);
  await h.service.stop();
});
