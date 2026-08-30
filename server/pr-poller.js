'use strict';

const core = require('./core/pr-review-core');
const { drainPending, firstLine, raceWithAbort } = require('./ephemeral-session');
const { createTickLoop } = require('./lane-runner');

// The GitHub PR auto-review poller. IO-FREE by construction: every side effect (gh/git calls,
// worktree ops, session spawn, telegram, state persistence, timers) is injected, so the tick logic
// is unit-testable with fakes (mirrors server/scheduler.js). Backend wires the real dependencies.
//
// Per-PR lifecycle (state persisted across ticks, keyed by `owner/repo#N`):
//   new / new-head  -> spawn a review session (clean lane in the repo dir, conflict lane in a
//                      throwaway worktree) -> CLEAN/RESOLVED -> awaiting-checks, CHANGES -> done,
//                      ERROR -> error.
//   awaiting-checks -> merged once gh checks are green and no workflow file is touched.
// A PR that vanishes from the open list (merged/closed elsewhere) is pruned.

function createPrPoller(deps) {
  const {
    projects = [],
    getProjectPathById,
    makePrGh,
    gitWorkspace,
    getWorktreeBase = () => undefined,
    spawnReview,
    telegram = () => {},
    readState = async () => ({}),
    writeState = async () => {},
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = console,
    getProjectNameById = () => null,
    onTickComplete = () => {},
    now = () => Date.now(),
  } = deps;

  const intervalMinutes = deps.intervalMinutes || 15;
  const mergeMethod = deps.mergeMethod || 'rebase';
  const maxConcurrentReviews = deps.maxConcurrentReviews || 3;
  const reviewTimeoutSeconds = deps.reviewTimeoutSeconds || 900;

  let state = {};

  const loop = createTickLoop({
    tag: 'pr-poller',
    intervalMs: intervalMinutes * 60000,
    tick: () => runTick(),
    writeState: () => writeState(state),
    setIntervalFn,
    clearIntervalFn,
    log,
  });
  const persist = () => loop.persist();

  function inFlightCount() {
    return Object.values(state).filter((e) => e?.inFlight).length;
  }

  function ping(kind, ctx) {
    const msg = core.pingFor(kind, ctx);
    if (msg) telegram(msg);
  }

  function finishReview(key, verdict, ctx, pr, wasConflicting) {
    const entry = state[key] || {};
    entry.phase = core.nextState(verdict);
    entry.inFlight = false;
    entry.wasConflicting = wasConflicting;
    entry.pingedError = verdict === 'ERROR';
    entry.reviewedHead = ctx.head || pr.headRefOid;
    if (verdict === 'ERROR') entry.reason = firstLine(ctx.reason || ctx.summary || '');
    if (verdict !== 'ERROR') delete entry.reason;
    state[key] = entry;
    const kindByVerdict = { CLEAN: 'clean', RESOLVED: 'resolved', CHANGES: 'changes', ERROR: 'error' };
    ping(kindByVerdict[verdict] || 'error', { key, summary: ctx.summary, reason: ctx.reason });
    return persist();
  }

  function spawnWithTimeout(args, {
    onPending = /** @type {((promise: Promise<unknown>) => void)|null} */ (null),
  } = {}) {
    return raceWithAbort({
      timeoutMs: args.timeoutMs,
      setTimeoutFn,
      clearTimeoutFn,
      onTimeout: () => ({ verdict: 'ERROR', summary: 'review timed out' }),
      onEmpty: () => ({ verdict: 'ERROR', summary: 'no verdict' }),
      start: (signal) => {
        const pending = Promise.resolve(spawnReview({ ...args, signal }))
          .catch((e) => ({ verdict: 'ERROR', summary: firstLine(e.message) }));
        if (typeof onPending === 'function') onPending(pending);
        return pending;
      },
    });
  }

  async function requeryHead(gh, number, oldHead) {
    let last = oldHead;
    for (let i = 0; i < 3; i += 1) {
      const h = await gh.viewHead(number);
      if (h && h !== oldHead) return h;
      last = h || last;
      await sleep(1500);
    }
    return last;
  }

  async function runReview(gh, projectPath, slug, pr) {
    const key = pr.key;
    const conflicting = pr.mergeable === 'CONFLICTING';
    let workspace = null;
    let cwd = projectPath;

    if (conflicting) {
      const branches = await gitWorkspace.listWorktreeBranches({ projectPath });
      if (branches.some((w) => w.branch === pr.headRefName)) {
        await finishReview(key, 'ERROR', { reason: 'branch checked out locally, resolve manually' }, pr, true);
        return;
      }
      const ws = await gitWorkspace.create({
        projectPath,
        teamId: 'pr-review',
        label: `pr-${pr.number}`,
        forkFromHead: true,
        worktreeBase: getWorktreeBase(projectPath),
      });
      if (!ws || !ws.isGit) {
        await finishReview(key, 'ERROR', { reason: (ws?.reason) || 'cannot isolate worktree' }, pr, true);
        return;
      }
      workspace = ws;
      cwd = ws.cwd;
    }

    /** @type {Promise<unknown>|null} */
    let pendingSpawn = null;
    try {
      const res = await spawnWithTimeout({
        projectPath, cwd, pr, slug, conflicting, timeoutMs: reviewTimeoutSeconds * 1000,
      }, { onPending: (promise) => { pendingSpawn = promise; } });
      let head = pr.headRefOid;
      if (res.verdict === 'RESOLVED') head = await requeryHead(gh, pr.number, pr.headRefOid);
      await finishReview(key, res.verdict, { summary: res.summary, head }, pr, conflicting);
    } catch (e) {
      await finishReview(key, 'ERROR', { reason: firstLine(e.message) }, pr, conflicting);
    } finally {
      if (workspace) {
        // A timeout resolves the verdict while the aborted session is still being killed, and a
        // surviving process holding a handle inside the worktree makes the discard fail (leaking the
        // checkout and the branch). Bounded, so a session that resists kill costs a delay, not a leak.
        await drainPending(pendingSpawn);
        await gitWorkspace.discard({ projectPath, workspace });
        await gh.deleteBranch(pr.headRefName);
      }
    }
  }

  async function tryMerge(gh, pr) {
    const key = pr.key;
    const entry = state[key];
    if (!entry) return false;
    // Only ever merge the exact head that was reviewed. A commit pushed after the CLEAN/RESOLVED
    // verdict must be re-reviewed (planReviews picks it up because reviewedHead != headRefOid) before
    // it can merge - a green check on an unreviewed head must never auto-merge.
    if (entry.reviewedHead !== pr.headRefOid) return false;
    const status = await gh.checksStatus(pr.number);
    if (status === 'pending') return false;

    if (status === 'green') {
      const wf = await gh.touchesWorkflows(pr.number);
      if (wf === null) return false; // gh files query failed: fail closed, defer to next tick, never merge blind
      if (wf) {
        entry.phase = 'done';
        entry.reason = 'touches workflow files, merge manually';
        if (!entry.pingedError) {
          ping('error', { key, reason: entry.reason });
          entry.pingedError = true;
        }
        return true;
      }
      const m = await gh.merge(pr.number, mergeMethod);
      if (m.ok) {
        entry.phase = 'merged';
        delete entry.reason;
        ping('merged', { key, summary: mergeMethod });
        return true;
      }
      if (/already merged|not open|closed|no open/i.test(m.err)) {
        delete state[key];
        return true;
      }
      entry.reason = `merge failed: ${firstLine(m.err)}`;
      if (!entry.pingedError) {
        ping('error', { key, reason: entry.reason });
        entry.pingedError = true;
        return true;
      }
      return false;
    }

    // phase/reason land before the pingedError gate so the dashboard row keeps the current reason
    entry.phase = 'error';
    entry.reason = status === 'none' ? 'no CI checks; merge manually' : 'checks failing';
    if (entry.pingedError) return false;
    ping('error', { key, reason: entry.reason });
    entry.pingedError = true;
    return true;
  }

  function pruneVanished(slug, liveKeys) {
    let dirty = false;
    for (const key of Object.keys(state)) {
      if (!key.startsWith(`${slug}#`)) continue;
      if (liveKeys.has(key)) continue;
      delete state[key];
      dirty = true;
    }
    return dirty;
  }

  // One dashboard row per live PR: the gh data this tick already fetched (title, url, head) merged
  // with the lane's own state entry. A key that is in state but no longer live was pruned above, so
  // iterating the live list is what omits it.
  function summarizePrs(prs, slug) {
    return prs.map((pr) => {
      const entry = state[pr.key] || {};
      return {
        key: pr.key,
        number: pr.number,
        title: pr.title || '',
        url: pr.url || `https://github.com/${slug}/pull/${pr.number}`,
        headSha: pr.headRefOid || null,
        phase: entry.phase || null,
        inFlight: entry.inFlight === true,
        wasConflicting: entry.wasConflicting === true,
        pingedError: entry.pingedError === true,
        reason: entry.reason || null,
      };
    });
  }

  async function tickProject(projectId) {
    const projectPath = getProjectPathById(projectId);
    if (!projectPath) return null;
    const gh = makePrGh(projectPath);
    const slug = await gh.repoSlug();
    if (!slug) return null;
    const owner = slug.split('/')[0];

    const raw = await gh.listPrs();
    for (const pr of raw) pr.key = core.prKey(slug, pr.number);
    const actionable = core.filterActionablePrs(raw, { repoOwner: owner });

    let dirty = pruneVanished(slug, new Set(raw.map((p) => p.key)));

    for (const pr of core.planMerges(actionable, state)) {
      if (await tryMerge(gh, pr)) dirty = true;
    }

    let slots = maxConcurrentReviews - inFlightCount();
    for (const pr of core.planReviews(actionable, state)) {
      if (slots <= 0) break;
      if (loop.isStopped()) break;
      const entry = state[pr.key] || {};
      entry.inFlight = true;
      delete entry.reason;
      state[pr.key] = entry;
      dirty = true;
      slots -= 1;
      // runReview's finally block awaits gitWorkspace.discard, which can reject; the .catch here keeps
      // this a never-rejecting tracking promise so stop()'s Promise.allSettled always resolves promptly.
      loop.track(runReview(gh, projectPath, slug, pr).catch((e) => {
        log.warn(`[pr-poller] review crashed for ${pr.key}: ${e.message}`);
      }));
    }

    return {
      dirty,
      summary: {
        projectId,
        name: getProjectNameById(projectId) || slug,
        repoSlug: slug,
        lastTickAt: now(),
        prs: summarizePrs(actionable, slug),
      },
    };
  }

  async function runTick() {
    let dirty = false;
    let failures = 0;
    const summaries = [];
    for (const projectId of projects) {
      const res = await tickProject(projectId).catch((e) => {
        log.warn(`[pr-poller] tick failed for ${projectId}: ${e.message}`);
        failures += 1;
        return null;
      });
      if (!res) continue;
      if (res.dirty) dirty = true;
      summaries.push(res.summary);
    }
    if (dirty) await persist();
    onTickComplete({ type: 'pr-status', ts: now(), projects: summaries });
    // EVERY project failing is a gh or network outage, not one bad repo, and re-polling it at full
    // cadence for the length of the outage is what the backoff exists to stop. One project failing
    // among several is that repo's problem and must not slow the others down.
    if (projects.length > 0 && failures === projects.length) return { failed: true };
    return undefined;
  }

  async function pruneOrphanWorktrees() {
    for (const projectId of projects) {
      const projectPath = getProjectPathById(projectId);
      if (!projectPath) continue;
      const branches = await gitWorkspace.listWorktreeBranches({ projectPath }).catch(() => []);
      for (const w of branches) {
        if (!w.branch.startsWith('glissa/pr-review/')) continue;
        await gitWorkspace.removeWorktreeByPath({ projectPath, cwd: w.cwd, branch: w.branch }).catch(() => {});
      }
    }
  }

  async function probeAuth() {
    for (const projectId of projects) {
      const projectPath = getProjectPathById(projectId);
      if (!projectPath) continue;
      const ok = await makePrGh(projectPath).authOk().catch(() => false);
      if (!ok) {
        log.warn('[pr-poller] gh is not authenticated; PR auto-review will no-op until `gh auth login`');
        return;
      }
    }
  }

  async function start() {
    await loop.start(async () => {
      state = (await readState()) || {};
      for (const k of Object.keys(state)) {
        if (state[k]) state[k].inFlight = false;
      }
      await pruneOrphanWorktrees().catch(() => {});
      await probeAuth().catch(() => {});
    });
  }

  return { start, stop: loop.stop, tick: loop.tick, _state: () => state };
}

module.exports = { createPrPoller };
