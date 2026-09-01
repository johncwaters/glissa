/*
 * The git ingest source, IO shell (docs/plan-ingestion.md, M8), in two halves.
 *
 * REAL repos, initialized in temp directories, carry the event content: a commit arriving with its branch
 * and subject, a branch switch, working-tree dedupe, a fresh repo with no commits, a detached HEAD, and a
 * linked worktree read as a checkout of its own rather than folded into the repo it came from.
 *
 * INJECTED git carries the cost rules, which no repo can demonstrate: that a trigger storm costs ONE
 * status read, that the poll pokes the same debounce rather than reading in parallel, that the second
 * spawn happens only when HEAD moved, and that stop() mid-debounce and mid-read leaks neither a timer nor
 * an event. Those are the rules that decide whether this source is cheap on a busy machine, and a real
 * repo would only prove them by accident.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGitIngest } from '../server/ingest-git.ts';
import type { GitIngestOptions } from '../server/ingest-git.ts';
import { createIngestLane } from '../server/ingest-wiring.ts';
import { resolveIngestConfig } from '../server/core/ingest-core.ts';
import { LOG_FIELD_SEPARATOR } from '../server/core/ingest-git-core.ts';
import type { GitIngestEvent } from '../server/core/ingest-git-core.ts';
import type { WatchDebounce } from '../detection/watch-debounce.ts';
import { hasGit, git } from './helpers/git-fixture.ts';

const GIT = hasGit();
const SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const OTHER_SHA = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';

type GitExec = NonNullable<GitIngestOptions['execFileFn']>;

interface FakeTimers {
  delays: { intervals: number[]; timeouts: number[] };
  setIntervalFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn: (handle: NodeJS.Timeout) => void;
  setTimeoutFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn: (handle: NodeJS.Timeout) => void;
  runTimeouts: () => void;
  readonly timeoutCount: number;
  readonly intervalCount: number;
}

interface RepoLayout {
  toplevel: string;
  gitDir: string;
  commonDir: string;
}

interface FakeGit {
  calls: { args: readonly string[]; cwd: string | undefined }[];
  hold: () => () => void;
  readonly statusCalls: number;
  readonly logCalls: number;
  readonly revParseCalls: number;
  revParseCwds: () => (string | undefined)[];
  runner: GitExec;
}

interface FakeWatchers {
  watched: string[];
  readonly stopCount: number;
  factory: () => WatchDebounce;
}

// --- Harness --------------------------------------------------------------

// A real unref'd timer that never runs a callback of its own: the seams are typed against NodeJS.Timeout.
function parkedTimer(): NodeJS.Timeout {
  const handle = setTimeout(() => {}, 2 ** 30);
  handle.unref();
  return handle;
}

function fakeTimers(): FakeTimers {
  const intervals = new Map<NodeJS.Timeout, () => void>();
  const timeouts = new Map<NodeJS.Timeout, () => void>();
  const delays: { intervals: number[]; timeouts: number[] } = { intervals: [], timeouts: [] };
  return {
    delays,
    setIntervalFn: (fn, ms) => {
      const handle = parkedTimer();
      intervals.set(handle, fn);
      delays.intervals.push(ms);
      return handle;
    },
    clearIntervalFn: (handle) => { clearTimeout(handle); intervals.delete(handle); },
    setTimeoutFn: (fn, ms) => {
      const handle = parkedTimer();
      timeouts.set(handle, fn);
      delays.timeouts.push(ms);
      return handle;
    },
    clearTimeoutFn: (handle) => { clearTimeout(handle); timeouts.delete(handle); },
    runTimeouts: () => {
      const jobs = [...timeouts.values()];
      timeouts.clear();
      for (const fn of jobs) fn();
    },
    get timeoutCount() { return timeouts.size; },
    get intervalCount() { return intervals.size; },
  };
}

// A watcher that installs and never fires: the tests drive triggers directly, because an fs.watch event
// on a temp directory is a race, not a fixture. The real watch path is covered by watchCount below.
function fakeWatchers(): FakeWatchers {
  const watched: string[] = [];
  const stopped = { count: 0 };
  return {
    watched,
    get stopCount() { return stopped.count; },
    factory: () => {
      let active = false;
      return {
        watch(dir: string) {
          active = true;
          watched.push(dir);
          return true;
        },
        stop() {
          if (active) stopped.count += 1;
          active = false;
        },
        fire() {},
        get active() { return active; },
        get stopped() { return !active; },
      };
    },
  };
}

function refusingWatchers(): FakeWatchers {
  return {
    watched: [],
    stopCount: 0,
    factory: () => ({
      watch: () => false, stop: () => {}, fire: () => {}, active: false, stopped: false,
    }),
  };
}

// lane.git is null when the source is off; every case reading it has it on.
function gitOf(lane: ReturnType<typeof createIngestLane>) {
  if (!lane.git) throw new Error('the git source is off on this lane');
  return lane.git;
}

function porcelain({ branch = 'main', oid = SHA, entries = [] }: { branch?: string; oid?: string; entries?: string[] } = {}): string {
  const lines = [`# branch.oid ${oid}`, `# branch.head ${branch}`, ...entries];
  return `${lines.join('\n')}\n`;
}

function logLine(sha: string, subject: string): string {
  return `${[sha, 'Glissa Test', '1699999999', subject].join(LOG_FIELD_SEPARATOR)}\n`;
}

/**
 * A recording git. `hold()` parks every subsequent call on a promise the test releases, which is the only
 * way to observe a stop() that lands while a read is in flight.
 */
function fakeGit({ status, log = () => logLine(SHA, 'init'), layoutFor = null }: {
  status: () => string;
  log?: () => string;
  layoutFor?: ((cwd: string | undefined) => RepoLayout) | null;
}): FakeGit {
  const calls: { args: readonly string[]; cwd: string | undefined }[] = [];
  const held: { gate: Promise<void> | null } = { gate: null };
  // One repo per candidate directory by default; `layoutFor` overrides for the multi-repo cases.
  const layout = layoutFor || ((cwd: string | undefined) => ({
    toplevel: String(cwd), gitDir: `${String(cwd)}/.git`, commonDir: `${String(cwd)}/.git`,
  }));
  return {
    calls,
    hold() {
      const release: { resolve: (() => void) | null } = { resolve: null };
      held.gate = new Promise<void>((resolve) => { release.resolve = () => resolve(); });
      return () => {
        held.gate = null;
        if (release.resolve) release.resolve();
      };
    },
    get statusCalls() { return calls.filter((call) => call.args.includes('status')).length; },
    get logCalls() { return calls.filter((call) => call.args[0] === 'log').length; },
    get revParseCalls() { return calls.filter((call) => call.args[0] === 'rev-parse').length; },
    revParseCwds: () => calls.filter((call) => call.args[0] === 'rev-parse').map((call) => call.cwd),
    runner: async (_file, args, options) => {
      calls.push({ args, cwd: options?.cwd });
      if (held.gate) await held.gate;
      if (args[0] === 'rev-parse') {
        const resolved = layout(options?.cwd);
        return { stdout: `${resolved.toplevel}\n${resolved.gitDir}\n${resolved.commonDir}\n` };
      }
      if (args.includes('status')) return { stdout: status() };
      return { stdout: log() };
    },
  };
}

// Timing is CONFIG, never a constructor argument (docs/plan-ingestion.md resolves it in the pure config
// resolver), so the injected half sets it exactly where the lane would.
const INJECTED_TIMING = { debounceMs: 1000, pollMs: 60000 };

interface InjectedSourceOptions {
  fake: FakeGit;
  watchers: FakeWatchers;
  timers: FakeTimers;
  published: GitIngestEvent[];
  overrides?: Partial<GitIngestOptions>;
}

function injectedSource({ fake, watchers, timers, published, overrides = {} }: InjectedSourceOptions) {
  return createGitIngest({
    publish: (event) => published.push(event),
    sourceConfig: INJECTED_TIMING,
    reposProvider: () => ['/repo'],
    execFileFn: fake.runner,
    createWatch: watchers.factory,
    // The temp-path realpath collapse is shared/paths.ts's contract, not this source's; skipping it here
    // keeps the injected half free of any filesystem at all.
    canonicalize: (dir) => dir,
    logger: { warn: () => {} },
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    ...overrides,
  });
}

function initRepo(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  try {
    git(['init', '-b', 'main'], dir);
  } catch {
    git(['init'], dir);
  }
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Glissa Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

function initRepoWithCommit(prefix: string): string {
  const dir = initRepo(prefix);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A Windows git process can still hold the directory; a leaked temp dir is not a failed test.
  }
}

// Real repos still run on injected timers: the point is the event a settled read produces, not whether a
// 1000ms setTimeout elapsed.
async function realSource({ dirs, published, timers, overrides = {} }: {
  dirs: string[];
  published: GitIngestEvent[];
  timers: FakeTimers;
  overrides?: Partial<GitIngestOptions>;
}) {
  const source = createGitIngest({
    publish: (event) => published.push(event),
    sourceConfig: { debounceMs: 1, pollMs: 600000 },
    reposProvider: () => dirs,
    logger: { warn: () => {} },
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    ...overrides,
  });
  await source.start();
  return source;
}

// Lets the promise chain advance one turn, which is how a test observes the difference between a read
// that is QUEUED and one that is already running inside git.
function tick(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

// One settled read driven the way a watcher would drive it: through the debounce, then the chain.
async function settleThroughDebounce(source: ReturnType<typeof createGitIngest>, timers: FakeTimers): Promise<void> {
  for (const key of source.repoKeys) source.trigger(key);
  timers.runTimeouts();
  await source.settle();
}

// --- Real repos -----------------------------------------------------------

test('a commit publishes one commit event with its branch and subject', { skip: !GIT }, async (t) => {
  const dir = initRepoWithCommit('glissa-ingest-git-commit-');
  t.after(() => cleanup(dir));
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const source = await realSource({ dirs: [dir], published, timers });
  t.after(() => source.stop());

  assert.equal(source.repoCount, 1, 'the project checkout is the watch set');
  assert.equal(published.length, 0, 'the first read of a repo is a baseline');
  assert.ok(source.watchCount >= 1, 'a real gitdir watch is installed');

  fs.writeFileSync(path.join(dir, 'feature.txt'), 'work\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'add the feature flag'], dir);

  await settleThroughDebounce(source, timers);

  assert.equal(published.length, 1, `expected exactly one event, got ${JSON.stringify(published)}`);
  const [event] = published;
  assert.equal(event.source, 'git');
  assert.equal(event.kind, 'commit');
  assert.equal(event.scope.root, dir);
  assert.match(event.summary, /^commit [0-9a-f]{7} on main: add the feature flag$/);
  assert.equal(event.detail.branch, 'main');
});

test('touching gitdir files without changing anything publishes nothing', { skip: !GIT }, async (t) => {
  const dir = initRepoWithCommit('glissa-ingest-git-noop-');
  t.after(() => cleanup(dir));
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const source = await realSource({ dirs: [dir], published, timers });
  t.after(() => source.stop());

  const gitDir = path.join(dir, '.git');
  const stamp = new Date();
  for (let burst = 0; burst < 5; burst += 1) {
    for (const name of ['HEAD', 'index', 'COMMIT_EDITMSG']) {
      const target = path.join(gitDir, name);
      if (fs.existsSync(target)) fs.utimesSync(target, stamp, stamp);
    }
    for (const key of source.repoKeys) source.trigger(key);
  }
  // Twenty-five triggers, one armed debounce: the storm collapses before any git runs at all.
  assert.equal(source.pendingTimerCount, 1);
  timers.runTimeouts();
  await source.settle();

  assert.deepEqual(published, [], 'a no-op trigger storm must publish nothing');
});

test('a working-tree change publishes one status-change, and repeating it publishes nothing', { skip: !GIT }, async (t) => {
  const dir = initRepoWithCommit('glissa-ingest-git-status-');
  t.after(() => cleanup(dir));
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const source = await realSource({ dirs: [dir], published, timers });
  t.after(() => source.stop());

  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello\n', 'utf8');
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, 'status-change');
  assert.equal(published[0].summary, 'working tree on main: 1 untracked');

  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 1, 'an unchanged signature dedupes the second read away');

  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello again\n', 'utf8');
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 1, 'the content changed but the signature did not');

  git(['add', '-A'], dir);
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 2, 'staging moves the signature');
  assert.equal(published[1].summary, 'working tree on main: 1 staged');
});

test('a branch switch publishes branch-change, and an unborn repo lives through its first commit', { skip: !GIT }, async (t) => {
  const dir = initRepoWithCommit('glissa-ingest-git-branch-');
  t.after(() => cleanup(dir));
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const source = await realSource({ dirs: [dir], published, timers });
  t.after(() => source.stop());

  git(['checkout', '-b', 'feature/nested-name'], dir);
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, 'branch-change');
  assert.match(published[0].summary, /^switched to feature\/nested-name at [0-9a-f]{7}: init$/);

  const head = git(['rev-parse', 'HEAD'], dir).trim();
  git(['checkout', '--detach', head], dir);
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 2);
  assert.equal(published[1].kind, 'branch-change');
  assert.match(published[1].summary, /^switched to detached HEAD at [0-9a-f]{7}: init$/);
});

test('a repo with no commits baselines, reports its tree, and publishes its first commit', { skip: !GIT }, async (t) => {
  const dir = initRepo('glissa-ingest-git-unborn-');
  t.after(() => cleanup(dir));
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const source = await realSource({ dirs: [dir], published, timers });
  t.after(() => source.stop());

  assert.equal(source.repoCount, 1, 'an unborn repo is still a repo');
  assert.equal(published.length, 0);

  fs.writeFileSync(path.join(dir, 'first.txt'), 'one\n', 'utf8');
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, 'status-change');
  assert.match(published[0].summary, /no commits yet\): 1 untracked$/);

  git(['add', '-A'], dir);
  git(['commit', '-m', 'the first commit'], dir);
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 2);
  assert.equal(published[1].kind, 'commit');
  assert.match(published[1].summary, /^commit [0-9a-f]{7} on main: the first commit$/);
});

test('two candidate directories inside one checkout are one repo, and a subdirectory resolves to it', { skip: !GIT }, async (t) => {
  const dir = initRepoWithCommit('glissa-ingest-git-dedupe-');
  t.after(() => cleanup(dir));
  const nested = path.join(dir, 'src');
  fs.mkdirSync(nested, { recursive: true });
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const source = await realSource({ dirs: [dir, nested, dir], published, timers });
  t.after(() => source.stop());

  assert.equal(source.repoCount, 1, 'one gitdir is one repo no matter how many sessions name it');
  // The scope is the checkout's toplevel, never whichever subdirectory a session happened to sit in.
  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello\n', 'utf8');
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 1);
  assert.equal(published[0].scope.root, dir);
});

/*
 * The watch-set rule, and the answer to what a pr-review worktree does to it. A linked worktree keeps its
 * own HEAD and index under `<common>/worktrees/<name>`, so a commit made in one moves nothing the repo it
 * forked from can see. That cuts both ways: a worktree the provider NAMES is a checkout of its own and
 * publishes its own commits, and a worktree the provider does not name (every ephemeral lane's, since
 * those sessions never enter the map backend.js derives the set from) is invisible, and cannot even leak
 * in sideways as a spurious event on the repo whose refs it shares.
 */
test('a linked worktree is its own checkout, and an unnamed one is invisible', { skip: !GIT }, async (t) => {
  const dir = initRepoWithCommit('glissa-ingest-git-worktree-');
  const worktreeDir = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
  t.after(() => cleanup(dir));
  t.after(() => cleanup(worktreeDir));
  git(['worktree', 'add', worktreeDir, '-b', 'glissa/session'], dir);

  const unnamed: GitIngestEvent[] = [];
  const unnamedTimers = fakeTimers();
  const repoOnly = await realSource({ dirs: [dir], published: unnamed, timers: unnamedTimers });
  const named: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const source = await realSource({ dirs: [dir, worktreeDir], published: named, timers });
  t.after(() => repoOnly.stop());
  t.after(() => source.stop());

  assert.equal(repoOnly.repoCount, 1, 'a worktree nobody named is not in the watch set');
  assert.equal(source.repoCount, 2, 'a named worktree is a checkout of its own, not a second view of one');

  fs.writeFileSync(path.join(worktreeDir, 'in-worktree.txt'), 'work\n', 'utf8');
  git(['add', '-A'], worktreeDir);
  git(['commit', '-m', 'commit inside the worktree'], worktreeDir);

  await settleThroughDebounce(repoOnly, unnamedTimers);
  assert.equal(unnamed.length, 0, 'a commit in an unwatched worktree publishes nothing at all');

  await settleThroughDebounce(source, timers);
  assert.equal(named.length, 1, `expected one event, got ${JSON.stringify(named)}`);
  assert.equal(named[0].kind, 'commit');
  assert.equal(named[0].scope.root, worktreeDir, 'the scope is the worktree, not the repo it forked from');
  assert.match(named[0].summary, /^commit [0-9a-f]{7} on glissa\/session: commit inside the worktree$/);
});

test('the lane publishes git events through the normalizer, and builds them into the digest', { skip: !GIT }, async (t) => {
  const dir = initRepoWithCommit('glissa-ingest-git-lane-');
  t.after(() => cleanup(dir));
  const timers = fakeTimers();
  const lane = createIngestLane({
    // Timing travels as CONFIG, the whole way down from the resolver: nothing else may set it.
    config: resolveIngestConfig({
      enabled: true, sources: { git: { enabled: true, debounceMs: 1, pollMs: 600000 } },
    }),
    logger: { warn: () => {} },
    repoRoots: () => [dir],
    ...timers,
  });
  t.after(() => lane.stop());
  assert.equal(lane.gitEnabled, true);
  await gitOf(lane).start();
  assert.equal(timers.delays.intervals.at(-1), 600000, 'the poll interval came from the resolved config');

  fs.writeFileSync(path.join(dir, 'shipped.txt'), 'done\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'ship the git source'], dir);
  await settleThroughDebounce(gitOf(lane), timers);

  const events = lane.recentEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'commit');
  assert.equal(events[0].seq, 1, 'the lane stamps the ordering key, not the adapter');
  assert.equal(lane.latestSeq(), 1);
  assert.match(lane.buildDigest({ scopes: [dir] }), /- git .*: commit [0-9a-f]{7} on main: ship the git source/);
});

// --- Injected git ---------------------------------------------------------

test('a trigger storm inside one debounce window costs exactly one status read', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  const fake = fakeGit({ status: () => porcelain({ entries: ['? a.txt'] }) });
  const source = injectedSource({ fake, watchers, timers, published });
  await source.start();

  const baselineStatusCalls = fake.statusCalls;
  assert.equal(baselineStatusCalls, 1, 'the baseline read is one status and no log');
  assert.equal(fake.logCalls, 0);

  for (let hit = 0; hit < 50; hit += 1) source.trigger(source.repoKeys[0]);
  assert.equal(source.pendingTimerCount, 1, 'fifty triggers arm one debounce');
  timers.runTimeouts();
  await source.settle();
  assert.equal(fake.statusCalls - baselineStatusCalls, 1);
  assert.deepEqual(published, [], 'the tree never moved, so the settle publishes nothing');
  await source.stop();
});

test('the second spawn happens only when HEAD moved', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  let oid = SHA;
  const fake = fakeGit({
    status: () => porcelain({ oid }),
    log: () => logLine(oid, 'move the head'),
  });
  const source = injectedSource({ fake, watchers, timers, published });
  await source.start();

  await settleThroughDebounce(source, timers);
  assert.equal(fake.logCalls, 0, 'an unchanged HEAD never costs a log spawn');

  oid = OTHER_SHA;
  await settleThroughDebounce(source, timers);
  assert.equal(fake.logCalls, 1);
  assert.equal(published.length, 1);
  assert.equal(published[0].summary, 'commit 9f8e7d6 on main: move the head');
  await source.stop();
});

test('the poll pokes the same debounce rather than reading in parallel', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  const fake = fakeGit({ status: () => porcelain({}) });
  const source = injectedSource({ fake, watchers, timers, published });
  await source.start();
  const afterStart = fake.statusCalls;

  await source.poll();
  assert.equal(fake.statusCalls, afterStart, 'the poll arms the debounce and reads nothing itself');
  assert.equal(source.pendingTimerCount, 1);

  // A watcher hit landing inside the poll's own window must not become a second read.
  source.trigger(source.repoKeys[0]);
  assert.equal(source.pendingTimerCount, 1);
  timers.runTimeouts();
  await source.settle();
  assert.equal(fake.statusCalls - afterStart, 1);
  await source.stop();
});

test('a read still running when the next trigger lands queues exactly one more, never a third', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  const fake = fakeGit({ status: () => porcelain({}) });
  const source = injectedSource({ fake, watchers, timers, published });
  await source.start();
  const afterStart = fake.statusCalls;

  const release = fake.hold();
  source.trigger(source.repoKeys[0]);
  timers.runTimeouts();
  await tick();
  // The read is now parked inside git. Three more settles pile up behind it and collapse into one.
  for (let hit = 0; hit < 3; hit += 1) {
    source.trigger(source.repoKeys[0]);
    timers.runTimeouts();
    await tick();
  }
  release();
  await source.settle();
  assert.equal(fake.statusCalls - afterStart, 2, 'one running read plus one queued, whatever the storm');
  await source.stop();
});

test('stop() mid-debounce leaks neither a timer nor a read', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  const fake = fakeGit({ status: () => porcelain({ entries: ['? a.txt'] }) });
  const source = injectedSource({ fake, watchers, timers, published });
  await source.start();
  const afterStart = fake.statusCalls;
  const installed = watchers.watched.length;
  assert.ok(installed >= 2, 'the common dir and its refs/heads are both watched');

  source.trigger(source.repoKeys[0]);
  assert.equal(source.pendingTimerCount, 1);
  await source.stop();

  assert.equal(timers.timeoutCount, 0, 'the armed debounce is cancelled, not left to fire');
  assert.equal(timers.intervalCount, 0, 'the poll interval is cancelled');
  assert.equal(watchers.stopCount, installed, 'every watcher is closed');
  assert.equal(source.repoCount, 0);
  timers.runTimeouts();
  await source.settle();
  assert.equal(fake.statusCalls, afterStart, 'nothing reads after stop');
  assert.deepEqual(published, []);
});

test('stop() landing mid-read publishes nothing the read was about to say', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  let entries: string[] = [];
  const fake = fakeGit({ status: () => porcelain({ entries }) });
  const source = injectedSource({ fake, watchers, timers, published });
  await source.start();

  entries = ['? new.txt'];
  const release = fake.hold();
  source.trigger(source.repoKeys[0]);
  timers.runTimeouts();
  // The status that WOULD have published a change is in flight when the daemon shuts down.
  const stopped = source.stop();
  release();
  await stopped;

  assert.deepEqual(published, [], 'an in-flight read must not publish past stop()');
  assert.equal(source.repoCount, 0);
});

test('a source with nothing to watch keeps polling instead of disabling itself', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const warnings: string[] = [];
  let entries: string[] = [];
  const fake = fakeGit({ status: () => porcelain({ entries }) });
  const source = injectedSource({
    fake,
    watchers: refusingWatchers(),
    timers,
    published,
    overrides: { logger: { warn: (message) => warnings.push(message) } },
  });
  await source.start();
  entries = ['? a.txt'];

  assert.equal(source.isDisabled, false, 'a watcher that will not install degrades the repo, not the source');
  assert.equal(source.watchCount, 0);
  assert.equal(warnings.length, 1, 'one warning, not one per watch attempt');
  assert.match(warnings[0], /poll is its only trigger/);

  await source.poll();
  timers.runTimeouts();
  await source.settle();
  assert.equal(published.length, 1, 'the poll is the correctness floor when no watcher exists');
  await source.stop();
});

test('a directory that is not a repo is skipped without disabling the source', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  const source = createGitIngest({
    publish: (event) => published.push(event),
    reposProvider: () => ['/not/a/repo'],
    execFileFn: async () => { throw new Error('fatal: not a git repository'); },
    createWatch: watchers.factory,
    canonicalize: (dir) => dir,
    logger: { warn: () => {} },
    ...timers,
  });
  await source.start();
  assert.equal(source.repoCount, 0);
  assert.equal(source.isDisabled, false);
  assert.deepEqual(published, []);
  await source.stop();
});

test('a repo the provider stopped naming is dropped, watchers and all', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  const fake = fakeGit({ status: () => porcelain({}) });
  let dirs = ['/repo'];
  const source = injectedSource({
    fake, watchers, timers, published, overrides: { reposProvider: () => dirs },
  });
  await source.start();
  assert.equal(source.repoCount, 1);
  const installed = watchers.watched.length;

  dirs = [];
  await source.reconcile();
  assert.equal(source.repoCount, 0);
  assert.equal(watchers.stopCount, installed);
  await source.stop();
});

test('a candidate directory is resolved by rev-parse once, however often the set is re-derived', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  const fake = fakeGit({ status: () => porcelain({}) });
  const source = injectedSource({ fake, watchers, timers, published });
  await source.start();
  assert.equal(fake.revParseCalls, 1);

  // What the 60s poll and every worktree-ready poke do. A layout only changes when the checkout does, so
  // re-resolving here would be one spawn per directory per poke for an answer that never moved.
  await source.reconcile();
  await source.poll();
  await source.reconcile();
  assert.equal(fake.revParseCalls, 1, 'the layout is cached for as long as the provider keeps naming it');
  assert.equal(source.repoCount, 1);
  await source.stop();
});

test('a directory the provider drops leaves both caches, and is re-resolved if it comes back', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  const canonicalized: string[] = [];
  const fake = fakeGit({ status: () => porcelain({}) });
  let dirs = ['/repo'];
  const source = injectedSource({
    fake,
    watchers,
    timers,
    published,
    overrides: {
      reposProvider: () => dirs,
      canonicalize: (dir) => {
        canonicalized.push(dir);
        return dir;
      },
    },
  });
  await source.start();
  const afterStart = canonicalized.length;

  await source.reconcile();
  assert.equal(canonicalized.length, afterStart, 'a still-named directory costs no second realpath');

  dirs = [];
  await source.reconcile();
  assert.equal(source.repoCount, 0);

  // Both caches let go with the repo, so long-uptime churn cannot saturate them into uselessness.
  dirs = ['/repo'];
  await source.reconcile();
  assert.equal(source.repoCount, 1);
  assert.equal(fake.revParseCalls, 2, 'a directory that left and came back is resolved again');
  assert.ok(canonicalized.length > afterStart, 'and canonicalized again');
  await source.stop();
});

test('a poke landing mid-reconcile earns one trailing re-run, not one per poke', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  const fake = fakeGit({ status: () => porcelain({}) });
  let dirs = ['/repo'];
  const source = injectedSource({
    fake, watchers, timers, published, overrides: { reposProvider: () => dirs },
  });
  await source.start();
  assert.equal(source.repoCount, 1);

  /*
   * The first pass must genuinely still be running when the worktree appears, and only an UNCACHED
   * directory in its snapshot can hold it there: /repo was resolved at start and costs no spawn, so a
   * pass over /repo alone drains before the poke lands and the poke's own snapshot would already contain
   * the worktree. /repo-b is what parks the first pass inside git, exactly as a real boot reconcile of
   * several projects is parked when a worktree-ready poke arrives.
   */
  dirs = ['/repo', '/repo-b'];
  const release = fake.hold();
  const inFlight = source.reconcile();
  await tick();
  dirs = ['/repo', '/repo-b', '/repo-wt'];
  const pokes = [source.reconcile(), source.reconcile(), source.reconcile()];
  release();
  await Promise.all([inFlight, ...pokes]);

  // Three with the trailing re-run, two without it: the held pass can only ever see the two it snapshotted.
  assert.equal(source.repoCount, 3, 'the late worktree is picked up without waiting for the poll');
  assert.deepEqual(
    source.repoKeys.sort(),
    [path.resolve('/repo/.git'), path.resolve('/repo-b/.git'), path.resolve('/repo-wt/.git')].sort(),
  );
  // Three pokes, ONE trailing pass: each directory is resolved once and never re-resolved.
  assert.deepEqual(fake.revParseCwds(), ['/repo', '/repo-b', '/repo-wt']);
  await source.stop();
});

test('the repo cap counts distinct repos, not candidate directories, and says what it dropped', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  const warnings: string[] = [];
  const fake = fakeGit({ status: () => porcelain({}) });
  // Two worktree sessions: four directories, three distinct checkouts, because both name the same project.
  let dirs = ['/repo', '/repo-wt-a', '/repo', '/repo-wt-b'];
  const source = injectedSource({
    fake,
    watchers,
    timers,
    published,
    overrides: {
      reposProvider: () => dirs,
      maxRepos: 3,
      logger: { warn: (message) => warnings.push(message) },
    },
  });
  await source.start();
  assert.equal(source.repoCount, 3, 'four directories that are three repos all fit a cap of three');
  assert.deepEqual(warnings, []);

  dirs = [...dirs, '/repo-wt-c'];
  await source.reconcile();
  assert.equal(source.repoCount, 3);
  assert.equal(warnings.length, 1, 'an overflow is never silent');
  assert.match(warnings[0], /watch set is full at 3 repos, so .*repo-wt-c/);

  // Once per dropped key: a set that stays full must not fill the log with the same line every poll.
  await source.reconcile();
  await source.poll();
  assert.equal(warnings.length, 1);
  await source.stop();
});

test('the lane builds no git adapter when the source is off', () => {
  const off = createIngestLane({
    config: resolveIngestConfig({ enabled: true, sources: { terminal: { enabled: true } } }),
    repoRoots: () => { throw new Error('the watch set must not even be asked for'); },
    ...fakeTimers(),
  });
  assert.equal(off.gitEnabled, false);
  assert.equal(off.git, null);
  assert.equal(off.sources.includes('git'), false);
  // noteRepos is safe to call unconditionally, so backend.js never has to ask whether the source exists.
  off.noteRepos();
  off.stop();

  const laneOff = createIngestLane({ config: resolveIngestConfig({ enabled: false }), ...fakeTimers() });
  assert.equal(laneOff.gitEnabled, false);
  assert.equal(laneOff.git, null);
  laneOff.stop();
});
