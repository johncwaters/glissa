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
//
// Both loops are CONSUMER-GATED: a spec no project and no lane names is never watched and never swept,
// because building it would cost a source walk per sweep to publish bytes no spawn will ever deliver.
// The consumer set is injected, so a project's pack list changing (from the Mill tab or a config.json
// hand edit) restarts the loops instead of waiting for a server restart.

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
    build = ({ specPath, projects }) => buildPack({ specPath, projects }),
    createWatcher = createPackWatcher,
    // Names something would actually be spawned against. null (the default) means "no filter", which
    // is what an existing caller injecting nothing gets; the backend always supplies it.
    consumedPackNames = null,
    // The project records a perProjectVariants spec derives its variants from. A variant's consumer is
    // exactly its project, so this set moving is a consumer change like any other.
    variantProjects = () => [],
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
  // Latched by stop() only, so a restart still queued when shutdown begins cannot bring the loops back.
  let torndown = false;
  // Every rebuild runs through one chain, so a watch fire racing the sweep (or a second watch fire)
  // can never have two builds publishing the same pack dir at once.
  let buildChain = Promise.resolve();
  // Restarts run through their own chain, so a second consumer change landing mid-drain queues behind
  // the first rather than racing it over the same watchers and timer.
  let restartChain = Promise.resolve();
  let lastConsumerKey = null;

  // null (no filter) is also the initial lastConsumerKey, so an unfiltered service never restarts.
  function consumerKey() {
    if (!consumedPackNames) return null;
    // The derived variant set is keyed too: a project's path or pack list moving changes which packs
    // exist, not just which specs are worth sweeping.
    const projects = variantProjects().map((project) => [project?.id ?? null, project?.path ?? null, project?.packs ?? null]);
    return JSON.stringify([consumedNames(), projects]);
  }

  function consumedNames() {
    const names = consumedPackNames();
    return Array.isArray(names) ? [...names].sort() : [];
  }

  // A Set of the names worth working on, or null when nothing is filtering.
  function consumedSet() {
    if (!consumedPackNames) return null;
    return new Set(consumedNames());
  }

  function consumedSpecs(specs, consumed) {
    if (!consumed) return specs;
    return specs.filter((spec) => consumed.has(spec.name));
  }

  // A group spec publishes its base AND one derived pack per consuming project, each a top-level pack
  // with its own version, so every one of them is recorded and announced in its own right.
  function notePublished(report) {
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

  async function runBuild(name, specPath, projects) {
    if (stopped) return null;
    const report = await build({ specPath, name, projects: projects || variantProjects() });
    if (!report) {
      log.warn(`[packs] ${name} rebuild failed: no report`);
      return null;
    }
    for (const warning of Array.isArray(report.warnings) ? report.warnings : []) log.warn(`[packs] ${name}: ${warning}`);
    notePublished(report);
    for (const variant of Array.isArray(report.variants) ? report.variants : []) notePublished(variant);
    return report;
  }

  function queueBuild(name, specPath, projects = null) {
    buildChain = buildChain.then(() => runBuild(name, specPath, projects)).catch((err) => {
      log.warn(`[packs] ${name} rebuild crashed: ${err.message}`);
      return null;
    });
    return buildChain;
  }

  // Every await here is a window a teardown can land in, and a watcher installed after one has emptied
  // the array is an fs.watch handle nothing will ever close.
  async function installWatchers({ name, specPath }) {
    let spec;
    try {
      spec = await loadSpec(specPath);
    } catch (err) {
      log.warn(`[packs] ${name} has no watchable roots: ${err.message}`);
      return;
    }
    if (stopped || torndown) return;
    const roots = await watchRootsForSpec(spec);
    for (const root of roots) {
      if (stopped || torndown) return;
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
      const consumed = consumedSet();
      for (const spec of consumedSpecs(await listSpecs(), consumed)) {
        if (stopped) return;
        await queueBuild(spec.name, spec.specPath);
      }
    } finally {
      sweepRunning = false;
    }
  }

  async function startNow() {
    if (torndown) return;
    stopped = false;
    lastConsumerKey = consumerKey();
    const specs = consumedSpecs(await listSpecs(), consumedSet());
    // Nothing to build means no watchers and no timer: an install that never wrote a pack spec, and one
    // whose specs nothing delivers, both pay nothing.
    if (stopped || torndown || specs.length === 0) return;
    for (const spec of specs) await installWatchers(spec);
    // One pass up front, so a source edited while Glissa was down is already rebuilt before the first
    // session spawns against it.
    await sweep();
    // A teardown can land while that first sweep runs (a shutdown right after boot, a settings save that
    // re-gated the loops); installing the interval afterwards leaves a timer nothing ever clears.
    if (stopped || torndown) return;
    // Never assign over a live handle: whatever put one here is the timer nothing else holds a ref to.
    if (sweepTimer) clearIntervalFn(sweepTimer);
    sweepTimer = setIntervalFn(() => { void sweep(); }, sweepMinutes * 60000);
    if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }

  // Everything that installs or tears down watchers and the timer runs on ONE chain, boot included, so a
  // settings save landing during the boot sweep queues behind it rather than racing it.
  function runOnChain(task) {
    restartChain = restartChain.then(task).catch((err) => {
      log.warn(`[packs] ${err.message}`);
    });
    return restartChain;
  }

  function start() {
    return runOnChain(startNow);
  }

  // Async so shutdown (and any caller that reuses the same built root) can await the in-flight
  // rebuild: a build interrupted mid-publish would leave a tmp dir for the next build to sweep.
  async function teardown() {
    stopped = true;
    if (sweepTimer) clearIntervalFn(sweepTimer);
    sweepTimer = null;
    for (const watcher of watchers) watcher.stop();
    watchers.length = 0;
    await buildChain.catch(() => {});
  }

  // The latches go up FIRST and the queued work drains BEFORE teardown, so a restart that raced the
  // shutdown cannot install watchers into an array teardown has already emptied and walked away from.
  async function stop() {
    torndown = true;
    stopped = true;
    await restartChain.catch(() => {});
    await teardown();
  }

  /*
   * The consumer set is what decides which specs are watched and swept, so a project gaining its first
   * pack (or losing its last one) is what starts and stops that work. Same shape as a lane runner's
   * restartIfConfigChanged: a no-op unless the set actually moved, and the drain-then-start is
   * serialized so a second change queues rather than overlapping the first.
   */
  function restartIfConsumersChanged() {
    const key = consumerKey();
    if (key === lastConsumerKey) return restartChain;
    lastConsumerKey = key;
    return runOnChain(async () => {
      if (torndown) return;
      await teardown();
      await startNow();
    });
  }

  /*
   * Build these packs NOW, ignoring the consumer filter. The one caller is an assignment that has been
   * persisted but not yet reloaded: consumer gating guarantees a newly assigned pack has never been
   * built, and a session resolves its packs at spawn, so a build that waits for the reload arrives after
   * the spawn that needed it. Runs on the build chain, so it cannot publish under a concurrent rebuild.
   */
  async function ensureBuilt(names, { projects = null } = {}) {
    if (torndown || stopped) return;
    const wanted = new Set(Array.isArray(names) ? names : []);
    if (wanted.size === 0) return;
    for (const spec of (await listSpecs()).filter((entry) => wanted.has(entry.name))) {
      // The projects come from the config that was just SAVED, not the one still in memory: the
      // assignment is what derives the project's variant, and it has not been reloaded yet.
      await queueBuild(spec.name, spec.specPath, projects);
    }
  }

  service.start = start;
  service.stop = stop;
  service.restartIfConsumersChanged = restartIfConsumersChanged;
  service.ensureBuilt = ensureBuilt;
  service.sweep = sweep;
  /** Latest built version per pack name, the staleness baseline the dashboard compares against. */
  service.getVersions = () => Object.fromEntries(versionsByName);
  service._watcherCount = () => watchers.length;
  return service;
}

module.exports = { createPackService, DEFAULT_SWEEP_MINUTES, DEFAULT_DEBOUNCE_MS };
