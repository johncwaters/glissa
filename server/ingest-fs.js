/*
 * Filesystem ingest source, IO shell (docs/plan-ingestion.md, M9). One @parcel/watcher subscription per
 * watched root, batched into per-file coalesced change events. Nothing here decides what a change MEANS,
 * which files are noise, or how many events a window owes; that is server/core/ingest-fs-core.js.
 *
 * ROOTS are ref counted, following detection/integration-watcher-pool.js. With `fs.roots` empty (the
 * default) the watched set is the checkouts of projects whose sessions are ALIVE: a root is subscribed
 * when its first session starts and unsubscribed when its last one exits, so a machine with nothing
 * running watches nothing. Explicit `fs.roots` entries are held by a permanent holder on top of that.
 * Overlapping roots collapse before subscribing (the core's nesting rule), because a project root and a
 * session subdirectory of it are one watch and two subscriptions would report every change twice.
 *
 * DEGRADATION is graded, and this is the one source with a native dependency, so both grades are real. A
 * root that cannot be subscribed (deleted under us, a permission the daemon lacks) costs THAT root one
 * warning; the other roots keep reporting. A @parcel/watcher that cannot load at all (no prebuild for
 * this platform, a broken install) disables the whole source with one warning, and the lane plus every
 * other source runs untouched, exactly as the plan's watcher decision record says.
 */

'use strict';

const { canonicalizePath } = require('../shared/paths');
const {
  DEFAULT_BATCH_MS, buildIgnorePatterns, createBatch, daemonWriteRules, decideFsEvents, dedupeRoots,
  isIgnoredChange, normalizeRoots, recordChange, relativeWithin,
} = require('./core/ingest-fs-core');
const { positiveInt } = require('./core/ingest-number-core');

const DEFAULT_MAX_ROOTS = 8;
// The holder every `fs.roots` entry is registered under. A string no session id can collide with, since
// session ids are UUIDs.
const CONFIG_HOLDER = 'config:fs.roots';

function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

// Required lazily and behind a try, because a missing prebuild is a load-time throw and this source's
// whole contract is that such a throw costs the source rather than the daemon.
function defaultLoadWatcher() {
  return require('@parcel/watcher');
}

function createFsIngest({
  publish,
  sourceConfig = {},
  // The daemon's own resolved config file. Its siblings (usage ledgers, the warehouse, recordings,
  // uploads) are the writes glissa makes into whatever directory that path resolved to, which in a dev
  // checkout is inside the repo a session is working in.
  configPath = null,
  logger = console,
  loadWatcher = defaultLoadWatcher,
  canonicalize = canonicalizePath,
  nowFn = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  maxRoots = DEFAULT_MAX_ROOTS,
} = {}) {
  if (typeof publish !== 'function') throw new Error('createFsIngest requires publish');
  // Timing comes from the RESOLVED source config and nowhere else, the M8 rule: a constructor override
  // would be a second place to set it and, since the resolver materializes the key from its defaults, a
  // silently dead one.
  const batchMs = positiveInt(sourceConfig.batchMs, DEFAULT_BATCH_MS);
  const rootLimit = Math.max(1, positiveInt(maxRoots, DEFAULT_MAX_ROOTS));
  const ignorePatterns = buildIgnorePatterns();
  const daemonRules = daemonWriteRules(configPath);
  const configuredRoots = normalizeRoots(sourceConfig.roots);

  // canonical root -> the holders keeping it alive. The ref count IS this set's size.
  const wanted = new Map();
  // holder -> the spellings it last named, so a repeated note costs a compare rather than a realpath.
  const holderSpellings = new Map();
  // Bounded by the holders, pruned in the same sweep: realpathSync.native is sync fs on the shared event
  // loop, and a session state-change fires on every transition of every session.
  const canonicalCache = new Map();
  // canonical root -> { subscription, batch, timer, warnedError }
  const subscriptions = new Map();
  const failedRoots = new Set();
  const warnedOverflow = new Set();

  let watcherModule = null;
  let running = false;
  let disabled = false;
  let stopped = false;
  let warnedRestart = false;
  let chain = Promise.resolve();
  let startPromise = null;

  function alive() {
    return running && !disabled;
  }

  function warn(message) {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`[ingest] ${message}`);
  }

  // One logged warning and the source goes quiet; the lane and every other source keep running, and a
  // restart re-arms everything (docs/plan-ingestion.md, "Adapter failure").
  function disable(reason) {
    if (disabled) return;
    disabled = true;
    running = false;
    warn(`fs source disabled: ${reason}`);
  }

  function loadWatcherModule() {
    if (watcherModule) return watcherModule;
    try {
      const loaded = loadWatcher();
      if (!loaded || typeof loaded.subscribe !== 'function') throw new Error('no subscribe export');
      watcherModule = loaded;
      return watcherModule;
    } catch (error) {
      disable(`@parcel/watcher could not be loaded (${error.message})`);
      return null;
    }
  }

  // --- Batching ------------------------------------------------------------

  function flushRoot(root) {
    const entry = subscriptions.get(root);
    if (!entry) return;
    entry.timer = null;
    const events = decideFsEvents(entry.batch, { root, now: nowFn() });
    entry.batch = createBatch();
    if (!alive()) return;
    for (const event of events) publish(event);
  }

  // Trailing, never leading: the window exists so the create-then-update pair a single save produces
  // arrives as one event, and a leading edge would publish the create before the update could join it.
  function armFlush(entry, root) {
    if (entry.timer) return;
    entry.timer = unrefTimer(setTimeoutFn(() => flushRoot(root), batchMs));
  }

  /**
   * The watcher callback. An error here is the root's problem, not the source's: the subscription stays
   * (parcel keeps delivering after a transient error) and the warning fires once, so a directory that
   * churns through a permission error cannot fill the log.
   */
  function onWatchEvents(root, error, events) {
    const entry = subscriptions.get(root);
    if (!entry || !alive()) return;
    if (error) {
      if (entry.warnedError) return;
      entry.warnedError = true;
      warn(`the watcher for ${root} reported an error (${error.message}); it keeps running`);
      return;
    }
    if (!Array.isArray(events) || events.length === 0) return;
    let recorded = false;
    for (const event of events) {
      const relPath = relativeWithin(root, event?.path);
      if (!relPath || isIgnoredChange({ relPath, absolutePath: event?.path, daemonRules })) continue;
      if (recordChange(entry.batch, relPath, event?.type)) recorded = true;
    }
    if (!recorded) return;
    armFlush(entry, root);
  }

  // --- Subscriptions -------------------------------------------------------

  async function subscribeRoot(root) {
    const watcher = loadWatcherModule();
    if (!watcher || !alive()) return;
    const entry = { subscription: null, batch: createBatch(), timer: null, warnedError: false };
    subscriptions.set(root, entry);
    try {
      entry.subscription = await watcher.subscribe(
        root,
        (error, events) => onWatchEvents(root, error, events),
        { ignore: ignorePatterns },
      );
    } catch (error) {
      // Graded per the plan: one root degrades, the lane and the other roots do not. Remembered so the
      // next reconcile does not retry a root that is simply not there.
      subscriptions.delete(root);
      if (!failedRoots.has(root)) {
        failedRoots.add(root);
        warn(`watching ${root} failed (${error.message}); that root reports nothing until a restart`);
      }
      return;
    }
    // stop() landing mid-subscribe: the entry is gone by now, so the handle it just returned is the one
    // thing nothing else would ever close.
    if (subscriptions.get(root) === entry && alive()) return;
    subscriptions.delete(root);
    await closeSubscription(entry, root);
  }

  async function closeSubscription(entry, root) {
    if (entry.timer) clearTimeoutFn(entry.timer);
    entry.timer = null;
    if (!entry.subscription) return;
    const handle = entry.subscription;
    entry.subscription = null;
    try {
      await handle.unsubscribe();
    } catch (error) {
      warn(`unsubscribing ${root} failed: ${error.message}`);
    }
  }

  async function unsubscribeRoot(root) {
    const entry = subscriptions.get(root);
    if (!entry) return;
    subscriptions.delete(root);
    await closeSubscription(entry, root);
  }

  // Once per key, not once per reconcile: the wanted set stays full for as long as the sessions do.
  function warnOverflow(dropped) {
    const current = new Set(dropped);
    for (const root of [...warnedOverflow]) {
      if (current.has(root)) continue;
      warnedOverflow.delete(root);
    }
    for (const root of dropped) {
      if (warnedOverflow.has(root)) continue;
      warnedOverflow.add(root);
      warn(`fs watch set is full at ${rootLimit} roots, so ${root} is not watched`);
    }
  }

  /**
   * Bring the subscriptions in line with what the holders currently want. Nesting collapses first, so a
   * newly wanted parent root REPLACES the children already subscribed under it rather than doubling
   * them, and the cap applies to what survives that collapse.
   */
  async function reconcileOnce() {
    if (!alive()) return;
    const effective = dedupeRoots([...wanted.keys()]);
    warnOverflow(effective.slice(rootLimit));
    const kept = new Set(effective.slice(0, rootLimit));
    for (const root of [...subscriptions.keys()]) {
      if (kept.has(root)) continue;
      await unsubscribeRoot(root);
    }
    for (const root of [...failedRoots]) {
      if (kept.has(root)) continue;
      failedRoots.delete(root);
    }
    for (const root of kept) {
      if (subscriptions.has(root) || failedRoots.has(root)) continue;
      await subscribeRoot(root);
      if (!alive()) return;
    }
  }

  // Every subscribe and unsubscribe is async, so they run on one chain: two holders arriving in the same
  // tick must not race each other into two subscriptions for one root.
  function reconcile() {
    chain = chain.then(() => reconcileOnce()).catch((error) => {
      warn(`reconciling the fs watch set failed: ${error.message}`);
    });
    return chain;
  }

  // --- Ref counting --------------------------------------------------------

  function canonicalRootFor(spelling) {
    const cached = canonicalCache.get(spelling);
    if (cached) return cached;
    const resolved = canonicalize(spelling);
    canonicalCache.set(spelling, resolved);
    return resolved;
  }

  function pruneCanonicalCache() {
    const stillNamed = new Set();
    for (const spellings of holderSpellings.values()) {
      for (const spelling of spellings) stillNamed.add(spelling);
    }
    for (const spelling of [...canonicalCache.keys()]) {
      if (stillNamed.has(spelling)) continue;
      canonicalCache.delete(spelling);
    }
  }

  function dropHolder(holder) {
    const previous = holderSpellings.get(holder);
    if (!previous) return false;
    holderSpellings.delete(holder);
    for (const [root, holders] of wanted) {
      if (!holders.delete(holder)) continue;
      if (holders.size === 0) wanted.delete(root);
    }
    return true;
  }

  function sameSpellings(holder, spellings) {
    const previous = holderSpellings.get(holder);
    if (!previous || previous.length !== spellings.length) return false;
    return previous.every((value, index) => value === spellings[index]);
  }

  /**
   * Register (or re-register) one holder's roots. A repeat naming the same spellings returns without
   * touching the filesystem at all, which is what keeps this callable from a session state-change: that
   * event fires on every transition of every session, and canonicalizing there would put a sync realpath
   * on the shared event loop many times per turn.
   */
  function addRoots(holder, dirs) {
    const key = typeof holder === 'string' && holder.trim() ? holder.trim() : null;
    if (!key || disabled || stopped) return false;
    const spellings = normalizeRoots(dirs);
    if (spellings.length === 0) return releaseHolder(key);
    if (sameSpellings(key, spellings)) return false;
    dropHolder(key);
    holderSpellings.set(key, spellings);
    for (const spelling of spellings) {
      const root = canonicalRootFor(spelling);
      const holders = wanted.get(root) || new Set();
      holders.add(key);
      wanted.set(root, holders);
    }
    pruneCanonicalCache();
    void reconcile();
    return true;
  }

  function releaseHolder(holder) {
    const key = typeof holder === 'string' && holder.trim() ? holder.trim() : null;
    if (!key || !dropHolder(key)) return false;
    pruneCanonicalCache();
    void reconcile();
    return true;
  }

  // --- Lifecycle -----------------------------------------------------------

  function start() {
    /*
     * stop() is TERMINAL, and saying so is the whole point. The lane never restarts an adapter (a daemon
     * restart re-arms everything, docs/plan-ingestion.md "Lifecycle"), and stop() drops every session hold
     * on the way down, so a restart here would come back watching only the config roots and silently miss
     * every live session. Inert and one warning beats half working.
     */
    if (stopped) {
      if (!warnedRestart) {
        warnedRestart = true;
        warn('fs source start() after stop() is a no-op; restart the daemon to re-arm it');
      }
      return Promise.resolve();
    }
    if (startPromise) return startPromise;
    if (disabled) return Promise.resolve();
    running = true;
    // Explicit roots are a permanent holder: they widen the set regardless of what is running, which is
    // the whole reason the config key exists.
    if (configuredRoots.length > 0) addRoots(CONFIG_HOLDER, configuredRoots);
    startPromise = reconcile();
    return startPromise;
  }

  /**
   * Cancels every pending batch WITHOUT flushing it (a stop mid-window has no consumer to publish to) and
   * unsubscribes every watcher. Returns a promise so a caller wanting a settled teardown can await it;
   * the flags go down first, so a subscribe already in flight closes the handle it is about to receive
   * rather than leaving it open.
   */
  function stop() {
    running = false;
    stopped = true;
    startPromise = null;
    const pending = [...subscriptions.entries()];
    // Synchronously, ahead of the async unsubscribes: a caller that stops and immediately asks whether
    // anything is still armed must see zero, not a timer waiting on a chain to drain.
    for (const [, entry] of pending) {
      if (entry.timer) clearTimeoutFn(entry.timer);
      entry.timer = null;
    }
    subscriptions.clear();
    wanted.clear();
    holderSpellings.clear();
    canonicalCache.clear();
    failedRoots.clear();
    warnedOverflow.clear();
    chain = chain.then(async () => {
      for (const [root, entry] of pending) await closeSubscription(entry, root);
    }).catch(() => { /* a teardown error costs nothing worth reporting at shutdown */ });
    return chain;
  }

  return {
    name: 'fs',
    start,
    stop,
    addRoots,
    releaseHolder,
    // Driven directly by the tests and by a caller that wants the set settled rather than eventual.
    reconcile: () => reconcile(),
    settle: () => chain,
    get isDisabled() { return disabled; },
    get rootCount() { return subscriptions.size; },
    get roots() { return [...subscriptions.keys()]; },
    get wantedRoots() { return [...wanted.keys()]; },
    get failedRootCount() { return failedRoots.size; },
    get pendingTimerCount() {
      let total = 0;
      for (const entry of subscriptions.values()) total += entry.timer ? 1 : 0;
      return total;
    },
    get pendingFileCount() {
      let total = 0;
      for (const entry of subscriptions.values()) total += entry.batch.files.size;
      return total;
    },
  };
}

module.exports = {
  CONFIG_HOLDER,
  DEFAULT_MAX_ROOTS,
  createFsIngest,
};
