
import { execFileAsync } from './child-process-safe.ts';
import { createWatchDebounce } from '../detection/watch-debounce.ts';
import type { WatchDebounce } from '../detection/watch-debounce.ts';
import { canonicalizePath } from '../shared/paths.ts';
import {
  DEFAULT_DEBOUNCE_MS, DEFAULT_POLL_MS, LOG_ARGS, REV_PARSE_ARGS, STATUS_ARGS, createRepoState,
  decideGitEvents, deriveWatchDirs, isNoiseGitFile, parseCommitLine, parsePorcelainStatus, parseRevParse,
  shouldReadCommit,
} from './core/ingest-git-core.ts';
import type { GitCommit, GitIngestEvent, GitLayout, GitRepoState } from './core/ingest-git-core.ts';
import { positiveInt } from './core/ingest-number-core.ts';
import { createLaneLog } from './lane-log.ts';
import type { LaneLogger } from './lane-log.ts';

const DEFAULT_MAX_REPOS = 16;
const DEFAULT_GIT_TIMEOUT_MS = 15000;
const MAX_GIT_BUFFER_BYTES = 8 * 1024 * 1024;

interface WatchedRepo {
  key: string;
  dir: string;
  root: string;
  gitDir: string;
  commonDir: string;
  state: GitRepoState;
  watchers: Map<string, WatchDebounce>;
  chain: Promise<void>;
  queued: boolean;
  timer: NodeJS.Timeout | null;
  warnedNoWatch: boolean;
  warnedRead: boolean;
}

interface GitIngestOptions {
  publish?: (event: GitIngestEvent) => unknown;
  sourceConfig?: { debounceMs?: number; pollMs?: number };
  reposProvider?: (() => string[]) | null;
  logger?: LaneLogger | null;
  execFileFn?: (
    file: string,
    args: readonly string[],
    options: { cwd: string; encoding: 'utf8'; timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string | Buffer }>;
  createWatch?: typeof createWatchDebounce;
  canonicalize?: (path: string) => string;
  nowFn?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  maxRepos?: number;
  gitTimeoutMs?: number;
  gitPath?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unrefTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

function createGitIngest({
  publish,
  sourceConfig = {},
  reposProvider = null,
  logger = console,
  execFileFn = execFileAsync,
  createWatch = createWatchDebounce,
  canonicalize = canonicalizePath,
  nowFn = Date.now,
  setIntervalFn = (fn: () => void, ms: number) => setInterval(fn, ms),
  clearIntervalFn = clearInterval,
  setTimeoutFn = (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeoutFn = clearTimeout,
  maxRepos = DEFAULT_MAX_REPOS,
  gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  gitPath = 'git',
}: GitIngestOptions = {}) {
  if (typeof publish !== 'function') throw new Error('createGitIngest requires publish');
  const publishEvent = publish;
  const settleMs = positiveInt(sourceConfig.debounceMs, DEFAULT_DEBOUNCE_MS);
  const pollIntervalMs = positiveInt(sourceConfig.pollMs, DEFAULT_POLL_MS);
  const repoLimit = Math.max(1, positiveInt(maxRepos, DEFAULT_MAX_REPOS));
  const candidateLimit = repoLimit * 4;

  const repos = new Map<string, WatchedRepo>();
  const canonicalCache = new Map<string, string>();
  const layoutCache = new Map<string, GitLayout>();
  const warnedOverflow = new Set<string>();
  let pollTimer: NodeJS.Timeout | null = null;
  let running = false;
  let disabled = false;
  let reconcileInFlight: Promise<void> | null = null;
  let reconcileDirty = false;
  let startPromise: Promise<void> | null = null;

  function alive(): boolean {
    return running && !disabled;
  }

  const { note, warn } = createLaneLog({ prefix: '[ingest]', logger });

  function teardown(): void {
    if (pollTimer) clearIntervalFn(pollTimer);
    pollTimer = null;
    for (const repo of repos.values()) {
      if (repo.timer) clearTimeoutFn(repo.timer);
      repo.timer = null;
      for (const handle of repo.watchers.values()) handle.stop();
      repo.watchers.clear();
    }
  }

  function clearState(): void {
    repos.clear();
    canonicalCache.clear();
    layoutCache.clear();
    warnedOverflow.clear();
    reconcileDirty = false;
  }

  function disable(reason: string): void {
    if (disabled) return;
    disabled = true;
    running = false;
    teardown();
    warn(`git source disabled: ${reason}`);
  }

  async function runGuarded(fn: () => Promise<unknown>): Promise<void> {
    if (!alive()) return;
    try {
      await fn();
    } catch (error) {
      disable(errorMessage(error));
    }
  }


  async function runGit(cwd: string, args: readonly string[]): Promise<string | null> {
    try {
      const { stdout } = await execFileFn(gitPath, args, {
        cwd, encoding: 'utf8', timeout: gitTimeoutMs, maxBuffer: MAX_GIT_BUFFER_BYTES,
      });
      return typeof stdout === 'string' ? stdout : String(stdout || '');
    } catch {
      return null;
    }
  }


  function readProvider(): string[] {
    if (typeof reposProvider !== 'function') return [];
    let raw: unknown = null;
    try {
      raw = reposProvider();
    } catch (error) {
      warn(`git source: the repo provider failed: ${errorMessage(error)}`);
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const named: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string' || !entry.trim()) continue;
      const dir = entry.trim();
      if (named.includes(dir)) continue;
      named.push(dir);
      if (named.length >= candidateLimit) break;
    }
    return named;
  }

  function candidateDirs(): string[] {
    const named = readProvider();
    const stillNamed = new Set(named);
    for (const spelling of [...canonicalCache.keys()]) {
      if (stillNamed.has(spelling)) continue;
      canonicalCache.delete(spelling);
    }
    const dirs: string[] = [];
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

  async function resolveLayout(dir: string): Promise<GitLayout | null> {
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

  function dropRepo(key: string): void {
    const repo = repos.get(key);
    if (!repo) return;
    repos.delete(key);
    if (repo.timer) clearTimeoutFn(repo.timer);
    repo.timer = null;
    for (const handle of repo.watchers.values()) handle.stop();
    repo.watchers.clear();
    note(`git source: dropped ${repo.root} (${repos.size} repos watched)`);
  }

  function installWatchers(repo: WatchedRepo): void {
    for (const [dir, handle] of [...repo.watchers]) {
      if (handle.active) continue;
      handle.stop();
      repo.watchers.delete(dir);
    }
    for (const dir of deriveWatchDirs(repo)) {
      if (repo.watchers.has(dir)) continue;
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
    repo.warnedNoWatch = true;
    warn(`git source: no git directory could be watched for ${repo.root}; the ${pollIntervalMs}ms poll is its only trigger`);
  }

  async function addRepo(dir: string, layout: GitLayout): Promise<void> {
    const repo: WatchedRepo = {
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
    note(`git source: added ${repo.root} (${repos.size} repos watched, ${repo.watchers.size} directories)`);
    await scheduleRead(repo);
  }

  function warnOverflow(dropped: string[]): void {
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

  async function reconcileOnce(): Promise<void> {
    const dirs = candidateDirs();
    const wanted = new Map<string, { dir: string; layout: GitLayout }>();
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
      if (repos.has(key)) continue;
      const entry = wanted.get(key);
      if (!entry) continue;
      await addRepo(entry.dir, entry.layout);
      if (!alive()) return;
    }
    for (const repo of repos.values()) installWatchers(repo);
  }

  function reconcile(): Promise<void> {
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


  async function readRepo(repo: WatchedRepo): Promise<void> {
    const statusOut = await runGit(repo.dir, STATUS_ARGS);
    if (!alive() || !repos.has(repo.key)) return;
    if (statusOut === null) {
      if (repo.warnedRead) return;
      repo.warnedRead = true;
      warn(`git source: git status failed for ${repo.root}; retrying on the next trigger`);
      return;
    }
    repo.warnedRead = false;
    const status = parsePorcelainStatus(statusOut);
    let commit: GitCommit | null = null;
    if (shouldReadCommit(repo.state, status)) {
      const logOut = await runGit(repo.dir, LOG_ARGS);
      if (!alive() || !repos.has(repo.key)) return;
      commit = parseCommitLine(logOut || '');
    }
    const decided = decideGitEvents({
      previous: repo.state, status, commit, root: repo.root, now: nowFn(),
    });
    repo.state = decided.next;
    for (const event of decided.events) publishEvent(event);
  }

  function scheduleRead(repo: WatchedRepo): Promise<void> {
    if (repo.queued) return repo.chain;
    repo.queued = true;
    repo.chain = repo.chain.then(async () => {
      repo.queued = false;
      if (!alive() || !repos.has(repo.key)) return;
      await readRepo(repo);
    }).catch((error: unknown) => {
      warn(`git source: reading ${repo.root} failed: ${errorMessage(error)}`);
    });
    return repo.chain;
  }

  function trigger(repo: WatchedRepo): void {
    if (!alive() || repo.timer || !repos.has(repo.key)) return;
    repo.timer = unrefTimer(setTimeoutFn(() => {
      repo.timer = null;
      void scheduleRead(repo);
    }, settleMs));
  }

  async function pollOnce(): Promise<void> {
    await reconcile();
    if (!alive()) return;
    for (const repo of repos.values()) trigger(repo);
  }


  function start(): Promise<void> {
    if (startPromise) return startPromise;
    if (disabled) return Promise.resolve();
    running = true;
    pollTimer = unrefTimer(setIntervalFn(() => { void runGuarded(pollOnce); }, pollIntervalMs));
    startPromise = runGuarded(reconcile);
    return startPromise;
  }

  function stop(): Promise<void> {
    running = false;
    startPromise = null;
    teardown();
    const pending: Promise<void>[] = [reconcileInFlight, ...[...repos.values()].map((repo) => repo.chain)]
      .filter((entry): entry is Promise<void> => Boolean(entry));
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
    reconcile: () => runGuarded(reconcile),
    poll: () => runGuarded(pollOnce),
    readAll: async () => {
      for (const repo of [...repos.values()]) await scheduleRead(repo);
    },
    settle: () => Promise.allSettled([...repos.values()].map((repo) => repo.chain)),
    trigger: (key: string) => {
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

export {
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_MAX_REPOS,
  MAX_GIT_BUFFER_BYTES,
  createGitIngest,
};
export type { GitIngestOptions, WatchedRepo };
