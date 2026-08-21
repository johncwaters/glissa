/*
 * Git ingest source, IO shell (docs/plan-ingestion.md, M8). It watches the small git metadata
 * directories of the checkouts glissa's own sessions are working in and publishes one summarized event
 * per settled change: a commit, a branch switch, or a working-tree status move. Nothing here decides what
 * a change MEANS; that is server/core/ingest-git-core.js.
 *
 * Watchers are lossy WAKEUPS, never truth (the repo's standing invariant, and VS Code's git extension is
 * the same prior art the plan names). Packed refs make a ref watch silently miss a branch move, a nested
 * branch name lives in a subdirectory a non-recursive watch never sees, and Windows coalesces write
 * events, so the 60s poll is the correctness floor and the watchers only buy latency. Both paths funnel
 * into the SAME per-repo debounce, so a poll can never become a second parallel reader.
 *
 * COST is what shapes the rest. A `git commit` writes half a dozen files in the gitdir, so a per-event
 * spawn would mean six `git status` runs for one commit: every trigger arms one 1s debounce per repo, the
 * settled read runs on that repo's own promise chain so two triggers can never interleave spawns, and the
 * second spawn (`git log -1`) happens only when HEAD actually moved. A read that finds nothing new
 * publishes nothing at all, which matters more since M7.5 made every published event the navigator's
 * movement signal.
 *
 * This module never shells `git worktree` (tests/no-direct-git-worktree.test.js pins that
 * server/git-workspace.js is the only module that may). A linked worktree's own gitdir comes from the
 * `rev-parse` that resolves the checkout in the first place.
 */

'use strict';

const { promisify } = require('node:util');

const { execFile } = require('./child-process-safe');
const { createWatchDebounce } = require('../detection/watch-debounce');
const { canonicalizePath } = require('../shared/paths');
const {
  DEFAULT_DEBOUNCE_MS, DEFAULT_POLL_MS, LOG_ARGS, REV_PARSE_ARGS, STATUS_ARGS, createRepoState,
  decideGitEvents, deriveWatchDirs, isNoiseGitFile, parseCommitLine, parsePorcelainStatus, parseRevParse,
  shouldReadCommit,
} = require('./core/ingest-git-core');

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_REPOS = 16;
const DEFAULT_GIT_TIMEOUT_MS = 15000;
// A status listing this large means an unignored dependency tree; the read is abandoned rather than
// pulled into the event loop, and the repo simply reports nothing until its tree is sane again.
const MAX_GIT_BUFFER_BYTES = 8 * 1024 * 1024;

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

function createGitIngest({
  publish,
  sourceConfig = {},
  // () => string[] of working directories to consider. Which directories those are is the watch-set rule
  // and belongs to the caller (server/backend.js derives it from live sessions); this source only ever
  // watches what it is handed.
  reposProvider = null,
  logger = console,
  execFileFn = execFileAsync,
  createWatch = createWatchDebounce,
  canonicalize = canonicalizePath,
  nowFn = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  maxRepos = DEFAULT_MAX_REPOS,
  gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  gitPath = 'git',
} = {}) {
  if (typeof publish !== 'function') throw new Error('createGitIngest requires publish');
  /*
   * Timing comes from the RESOLVED source config and nowhere else. The plan puts every timing value in
   * the pure config resolver beside the ring caps, so a constructor override would be a second place to
   * set one and, since the resolver materializes both keys from its defaults, a silently dead one.
   */
  const settleMs = positiveInt(sourceConfig.debounceMs, DEFAULT_DEBOUNCE_MS);
  const pollIntervalMs = positiveInt(sourceConfig.pollMs, DEFAULT_POLL_MS);
  const repoLimit = Math.max(1, positiveInt(maxRepos, DEFAULT_MAX_REPOS));
  // A spawn guard, NOT the repo ceiling: the cap that matters is applied to distinct repos below, and a
  // worktree session names two directories that collapse to two repos, or one dir that collapses to one.
  const candidateLimit = repoLimit * 4;

  // Keyed by the checkout's OWN gitdir, so a project path and a subdirectory of it resolve to one repo,
  // while a linked worktree (whose gitdir sits under `worktrees/<name>`) stays a repo of its own.
  const repos = new Map();
  /*
   * Two caches over the same key space, both pruned to exactly what the provider currently names, which
   * is what keeps a recurring reconcile free: realpathSync is sync fs on the shared event loop and the
   * only spelling-collapsing call Node offers, and rev-parse is a spawn. Long uptime cannot grow either,
   * because a directory that stops being named leaves both in the same sweep.
   */
  const canonicalCache = new Map();
  const layoutCache = new Map();
  // Keys refused by the repo cap, remembered only so the warning fires once rather than every reconcile.
  const warnedOverflow = new Set();
  let pollTimer = null;
  let running = false;
  let disabled = false;
  let reconcileInFlight = null;
  let reconcileDirty = false;
  let startPromise = null;

  // Re-read after every await: stop() must not be undone by a pass already in flight.
  function alive() {
    return running && !disabled;
  }

  function warn(message) {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`[ingest] ${message}`);
  }

  function teardown() {
    if (pollTimer) clearIntervalFn(pollTimer);
    pollTimer = null;
    for (const repo of repos.values()) {
      if (repo.timer) clearTimeoutFn(repo.timer);
      repo.timer = null;
      for (const handle of repo.watchers.values()) handle.stop();
      repo.watchers.clear();
    }
  }

  function clearState() {
    repos.clear();
    canonicalCache.clear();
    layoutCache.clear();
    warnedOverflow.clear();
    reconcileDirty = false;
  }

  // One logged warning and the source goes quiet; the lane and every other source keep running, and a
  // restart re-arms everything (docs/plan-ingestion.md, "Adapter failure").
  function disable(reason) {
    if (disabled) return;
    disabled = true;
    running = false;
    teardown();
    warn(`git source disabled: ${reason}`);
  }

  async function runGuarded(fn) {
    if (!alive()) return;
    try {
      await fn();
    } catch (error) {
      disable(error.message);
    }
  }

  // --- Git -----------------------------------------------------------------

  /*
   * Null on ANY failure, never a throw: a repo deleted under us, a git that is not installed, an index
   * held by another process, a status that outgrew the buffer. The caller leaves its state untouched on
   * null, so the next trigger or the poll retries the same read rather than baselining onto a half answer.
   */
  async function runGit(cwd, args) {
    try {
      const { stdout } = await execFileFn(gitPath, args, {
        cwd, encoding: 'utf8', timeout: gitTimeoutMs, maxBuffer: MAX_GIT_BUFFER_BYTES,
      });
      return typeof stdout === 'string' ? stdout : String(stdout || '');
    } catch {
      return null;
    }
  }

  // --- Repos ---------------------------------------------------------------

  function readProvider() {
    if (typeof reposProvider !== 'function') return [];
    let raw = null;
    try {
      raw = reposProvider();
    } catch (error) {
      warn(`repo provider failed: ${error.message}`);
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const named = [];
    for (const entry of raw) {
      if (typeof entry !== 'string' || !entry.trim()) continue;
      const dir = entry.trim();
      if (named.includes(dir)) continue;
      named.push(dir);
      if (named.length >= candidateLimit) break;
    }
    return named;
  }

  /**
   * The provider's directories, canonicalized and deduped, with the canonical cache pruned to exactly the
   * spellings it just named. Pruning HERE is what bounds the cache without a size cap: a cap would
   * saturate under long-uptime churn and quietly put a sync realpath back on every reconcile, which is the
   * one thing this cache exists to keep off the shared event loop.
   */
  function candidateDirs() {
    const named = readProvider();
    const stillNamed = new Set(named);
    for (const spelling of [...canonicalCache.keys()]) {
      if (stillNamed.has(spelling)) continue;
      canonicalCache.delete(spelling);
    }
    const dirs = [];
    for (const spelling of named) {
      let dir = canonicalCache.get(spelling);
      if (!dir) {
        dir = canonicalize(spelling);
        canonicalCache.set(spelling, dir);
      }
      if (dirs.includes(dir)) continue;
      dirs.push(dir);
    }
    return dirs;
  }

  /**
   * One rev-parse per candidate directory, held for as long as the provider keeps naming it. A checkout's
   * layout only changes when the checkout does, so re-resolving on every 60s poll and every worktree-ready
   * poke would be a spawn per directory per poke for an answer that never moved. A FAILURE is deliberately
   * not cached: a directory that is not a repo yet becomes one the moment someone runs `git init` in it.
   */
  async function resolveLayout(dir) {
    const cached = layoutCache.get(dir);
    if (cached) return cached;
    const stdout = await runGit(dir, REV_PARSE_ARGS);
    if (!alive() || stdout === null) return null;
    const parsed = parseRevParse(stdout, dir);
    if (!parsed) return null;
    const layout = {
      toplevel: canonicalize(parsed.toplevel),
      gitDir: canonicalize(parsed.gitDir),
      commonDir: canonicalize(parsed.commonDir),
    };
    layoutCache.set(dir, layout);
    return layout;
  }

  function dropRepo(key) {
    const repo = repos.get(key);
    if (!repo) return;
    repos.delete(key);
    if (repo.timer) clearTimeoutFn(repo.timer);
    repo.timer = null;
    for (const handle of repo.watchers.values()) handle.stop();
    repo.watchers.clear();
  }

  /**
   * Watch DIRECTORIES, and re-check them every reconcile. `refs/heads` does not exist in a repo with no
   * commits and a gitdir can be pruned out from under a watcher, so a handle that self-stopped on error
   * is replaced here rather than left dead until a restart.
   */
  function installWatchers(repo) {
    for (const [dir, handle] of [...repo.watchers]) {
      if (handle.active) continue;
      handle.stop();
      repo.watchers.delete(dir);
    }
    for (const dir of deriveWatchDirs(repo)) {
      if (repo.watchers.has(dir)) continue;
      // The debounce half of this helper is deliberately unused: one timer per repo (below) coalesces
      // every watched directory of that repo into a single settled read, where one timer per directory
      // would let a commit's gitdir write and its refs write settle separately.
      const handle = createWatch({ onChange: () => {}, debounceMs: settleMs });
      const watching = handle.watch(dir, (_eventType, filename) => {
        if (isNoiseGitFile(filename)) return;
        trigger(repo);
      });
      if (!watching) {
        handle.stop();
        continue;
      }
      repo.watchers.set(dir, handle);
    }
    if (repo.watchers.size > 0 || repo.warnedNoWatch) return;
    // Graded and per repo: no watcher means latency, not blindness, because the poll still recomputes.
    repo.warnedNoWatch = true;
    warn(`no git directory could be watched for ${repo.root}; the ${pollIntervalMs}ms poll is its only trigger`);
  }

  async function addRepo(dir, layout) {
    const repo = {
      key: layout.gitDir,
      dir,
      root: layout.toplevel,
      gitDir: layout.gitDir,
      commonDir: layout.commonDir,
      state: createRepoState(),
      watchers: new Map(),
      chain: Promise.resolve(),
      queued: false,
      timer: null,
      warnedNoWatch: false,
      warnedRead: false,
    };
    repos.set(repo.key, repo);
    installWatchers(repo);
    // The first read is a baseline and publishes nothing, so a daemon start never announces history.
    await scheduleRead(repo);
  }

  // Once per key, not once per reconcile: the set stays full for as long as the sessions do, and a
  // per-poll warning would bury every other line in the log.
  function warnOverflow(dropped) {
    const current = new Set(dropped);
    for (const key of [...warnedOverflow]) {
      if (current.has(key)) continue;
      warnedOverflow.delete(key);
    }
    for (const key of dropped) {
      if (warnedOverflow.has(key)) continue;
      warnedOverflow.add(key);
      warn(`git watch set is full at ${repoLimit} repos, so ${key} is not watched`);
    }
  }

  /**
   * The cap is applied to DISTINCT resolved repos, not to candidate directories. A worktree session names
   * two directories, so capping the candidates would have halved the real ceiling, and it would have done
   * so silently.
   */
  async function reconcileOnce() {
    const dirs = candidateDirs();
    const wanted = new Map();
    for (const dir of dirs) {
      const layout = await resolveLayout(dir);
      if (!alive()) return;
      if (!layout || wanted.has(layout.gitDir)) continue;
      wanted.set(layout.gitDir, { dir, layout });
    }
    const keys = [...wanted.keys()];
    warnOverflow(keys.slice(repoLimit));
    const kept = new Set(keys.slice(0, repoLimit));
    for (const key of [...repos.keys()]) {
      if (kept.has(key)) continue;
      dropRepo(key);
    }
    const stillNamed = new Set(dirs);
    for (const dir of [...layoutCache.keys()]) {
      if (stillNamed.has(dir)) continue;
      layoutCache.delete(dir);
    }
    for (const key of kept) {
      // Two sessions in one checkout (a project path and a subdirectory of it) are one repo, not two.
      if (repos.has(key)) continue;
      const { dir, layout } = wanted.get(key);
      await addRepo(dir, layout);
      if (!alive()) return;
    }
    for (const repo of repos.values()) installWatchers(repo);
  }

  /**
   * A poke arriving mid-pass cannot be answered by the pass already running: its candidate snapshot was
   * taken before the worktree the poke exists to announce was there. So it sets a dirty flag and earns ONE
   * trailing re-run, not one per poke, which is what keeps a burst of pokes at boot (runAutoResume fires
   * several) from becoming a burst of reconciles.
   */
  function reconcile() {
    if (reconcileInFlight) {
      reconcileDirty = true;
      return reconcileInFlight;
    }
    reconcileDirty = false;
    reconcileInFlight = reconcileOnce()
      .finally(() => { reconcileInFlight = null; })
      .then(() => {
        if (!reconcileDirty || !alive()) return undefined;
        return reconcile();
      });
    return reconcileInFlight;
  }

  // --- Reading -------------------------------------------------------------

  async function readRepo(repo) {
    const statusOut = await runGit(repo.dir, STATUS_ARGS);
    if (!alive() || !repos.has(repo.key)) return;
    if (statusOut === null) {
      if (repo.warnedRead) return;
      repo.warnedRead = true;
      warn(`git status failed for ${repo.root}; retrying on the next trigger`);
      return;
    }
    repo.warnedRead = false;
    const status = parsePorcelainStatus(statusOut);
    let commit = null;
    if (shouldReadCommit(repo.state, status)) {
      const logOut = await runGit(repo.dir, LOG_ARGS);
      if (!alive() || !repos.has(repo.key)) return;
      commit = parseCommitLine(logOut || '');
    }
    const decided = decideGitEvents({
      previous: repo.state, status, commit, root: repo.root, now: nowFn(),
    });
    repo.state = decided.next;
    for (const event of decided.events) publish(event);
  }

  /**
   * The per-repo promise chain, with the re-entrancy guard the plan calls for: a `git status` on a large
   * repo outlives the 1s debounce, so at most one read runs and at most one waits behind it. `queued`
   * clears when the queued job STARTS, so a change arriving during a read still earns its own re-read
   * while a trigger storm arriving during one debounce window costs nothing extra.
   */
  function scheduleRead(repo) {
    if (repo.queued) return repo.chain;
    repo.queued = true;
    repo.chain = repo.chain.then(async () => {
      repo.queued = false;
      if (!alive() || !repos.has(repo.key)) return;
      await readRepo(repo);
    }).catch((error) => {
      warn(`reading ${repo.root} failed: ${error.message}`);
    });
    return repo.chain;
  }

  // Every trigger, from a watcher or from the poll, arrives HERE, so the poll can never become a second
  // parallel reader.
  function trigger(repo) {
    if (!alive() || repo.timer || !repos.has(repo.key)) return;
    repo.timer = unrefTimer(setTimeoutFn(() => {
      repo.timer = null;
      void scheduleRead(repo);
    }, settleMs));
  }

  async function pollOnce() {
    await reconcile();
    if (!alive()) return;
    for (const repo of repos.values()) trigger(repo);
  }

  // --- Lifecycle -----------------------------------------------------------

  function start() {
    if (startPromise) return startPromise;
    if (disabled) return Promise.resolve();
    running = true;
    pollTimer = unrefTimer(setIntervalFn(() => { void runGuarded(pollOnce); }, pollIntervalMs));
    startPromise = runGuarded(reconcile);
    return startPromise;
  }

  // Returns a promise so a caller wanting a settled teardown can await it. The state is torn down FIRST,
  // which is what stops an in-flight read from publishing or re-arming anything: every guarded pass
  // re-checks alive() and its own repo membership after each await.
  function stop() {
    running = false;
    startPromise = null;
    teardown();
    const pending = [reconcileInFlight, ...[...repos.values()].map((repo) => repo.chain)].filter(Boolean);
    clearState();
    if (pending.length === 0) return Promise.resolve();
    return Promise.allSettled(pending).then(() => {
      teardown();
      clearState();
    });
  }

  return {
    name: 'git',
    start,
    stop,
    // Driven directly by the tests, which need a deterministic reconcile and read rather than a timer race.
    reconcile: () => runGuarded(reconcile),
    poll: () => runGuarded(pollOnce),
    readAll: async () => {
      for (const repo of [...repos.values()]) await scheduleRead(repo);
    },
    // Awaits what is already queued WITHOUT queueing more, which is how a test observes the result of a
    // debounce it just let fire rather than a read of its own.
    settle: () => Promise.allSettled([...repos.values()].map((repo) => repo.chain)),
    trigger: (key) => {
      const repo = repos.get(key);
      if (repo) trigger(repo);
    },
    get isDisabled() { return disabled; },
    get repoCount() { return repos.size; },
    get repoKeys() { return [...repos.keys()]; },
    get watchCount() {
      let total = 0;
      for (const repo of repos.values()) total += repo.watchers.size;
      return total;
    },
    get pendingTimerCount() {
      let total = 0;
      for (const repo of repos.values()) total += repo.timer ? 1 : 0;
      return total;
    },
  };
}

module.exports = {
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_MAX_REPOS,
  MAX_GIT_BUFFER_BYTES,
  createGitIngest,
};
