'use strict';

// The context mill's automation loop: keep every built pack current without anyone running
// `glissa pack build`. IO-FREE by construction in the pr-poller sense - spec discovery, spec loading,
// the build itself, the watchers and the timers are all injected (the defaults just point at the real
// pack-builder), so the loop is unit-testable with fakes.
//
// Two loops, belt and suspenders, the same shape as the pairings store's watch-plus-reload:
//   watchers  - one recursive debounced fs.watch per source root, rebuilding just that pack. Fast,
//               and lossy by nature (fs.watch drops events, and recursive watching is unavailable on
//               older Linux), so it is the latency optimization, never the guarantee.
//   sweep     - a `.unref()`ed interval that rebuilds every spec. Cheap, because a build whose plan
//               matches the published version writes nothing and reports `unchanged`.
//
// A rebuild that actually published emits `pack-updated`; an unchanged one is silent, which is what
// keeps the interval from broadcasting a heartbeat every 15 minutes.

const { EventEmitter } = require('node:events');

const { buildPack, listPackSpecs, loadPackSpec, packWatchRoots } = require('./pack-builder');
const { createPackWatcher } = require('./pack-watch');
const { shortVersion } = require('./text-format');

const DEFAULT_SWEEP_MINUTES = 15;
// Long enough to swallow an editor's save-plus-rename burst, short enough that a rebuilt pack's
// skills hot-reload into a live session while the operator is still looking at the edit.
const DEFAULT_DEBOUNCE_MS = 500;

function createPackService(deps = {}) {
  const {
    listSpecs = () => listPackSpecs(),
    loadSpec = (specPath) => loadPackSpec(specPath),
    watchRootsForSpec = (spec) => packWatchRoots(spec),
    build = ({ specPath }) => buildPack({ specPath }),
    createWatcher = createPackWatcher,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    sweepMinutes = DEFAULT_SWEEP_MINUTES,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    log = console,
  } = deps;

  const service = new EventEmitter();
  const watchers = [];
  // Latest known version per pack, including the ones a sweep found unchanged: this is what the
  // dashboard compares a session's DELIVERED version against.
  const versionsByName = new Map();
  let sweepTimer = null;
  let sweepRunning = false;
  let stopped = false;
  // Every rebuild runs through one chain, so a watch fire racing the sweep (or a second watch fire)
  // can never have two builds publishing the same pack dir at once.
  let buildChain = Promise.resolve();

  async function runBuild(name, specPath) {
    if (stopped) return null;
    const report = await build({ specPath, name });
    if (!report || !report.ok) {
      log.warn(`[packs] ${name} rebuild failed: ${report?.errors?.join('; ') || 'no report'}`);
      return report || null;
    }
    versionsByName.set(report.name, report.version);
    if (report.unchanged) return report;
    log.log(`[packs] ${name} rebuilt: version ${shortVersion(report.version)}`);
    service.emit('pack-updated', { name: report.name, version: report.version });
    return report;
  }

  function queueBuild(name, specPath) {
    buildChain = buildChain.then(() => runBuild(name, specPath)).catch((err) => {
      log.warn(`[packs] ${name} rebuild crashed: ${err.message}`);
      return null;
    });
    return buildChain;
  }

  async function installWatchers({ name, specPath }) {
    let spec;
    try {
      spec = await loadSpec(specPath);
    } catch (err) {
      log.warn(`[packs] ${name} has no watchable roots: ${err.message}`);
      return;
    }
    const roots = await watchRootsForSpec(spec);
    for (const root of roots) {
      const watcher = createWatcher({ onChange: () => { void queueBuild(name, specPath); }, debounceMs });
      if (!watcher.watch(root)) continue;
      watchers.push(watcher);
    }
  }

  // Rebuild every spec. Re-entrancy guarded like the pr-poller tick: a sweep that overruns its own
  // interval (a large docs tree on a slow disk) must not stack up behind itself.
  async function sweep() {
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

  async function start() {
    stopped = false;
    const specs = await listSpecs();
    // No specs means no watchers and no timer: an install that never wrote a pack spec pays nothing.
    if (specs.length === 0) return;
    for (const spec of specs) await installWatchers(spec);
    // One pass up front, so a source edited while Glissa was down is already rebuilt before the first
    // session spawns against it.
    await sweep();
    // stop() can land while that first sweep runs (a shutdown right after boot); installing the
    // interval afterwards would leave a timer nothing ever clears.
    if (stopped) return;
    sweepTimer = setIntervalFn(() => { void sweep(); }, sweepMinutes * 60000);
    if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }

  // Async so shutdown (and any caller that reuses the same built root) can await the in-flight
  // rebuild: a build interrupted mid-publish would leave a tmp dir for the next build to sweep.
  async function stop() {
    stopped = true;
    if (sweepTimer) clearIntervalFn(sweepTimer);
    sweepTimer = null;
    for (const watcher of watchers) watcher.stop();
    watchers.length = 0;
    await buildChain.catch(() => {});
  }

  service.start = start;
  service.stop = stop;
  service.sweep = sweep;
  /** Latest built version per pack name, the staleness baseline the dashboard compares against. */
  service.getVersions = () => Object.fromEntries(versionsByName);
  service._watcherCount = () => watchers.length;
  return service;
}

module.exports = { createPackService, DEFAULT_SWEEP_MINUTES, DEFAULT_DEBOUNCE_MS };
