'use strict';

const core = require('./core/pr-review-core');

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
  } = deps;

  const intervalMinutes = deps.intervalMinutes || 15;
  const mergeMethod = deps.mergeMethod || 'rebase';
  const maxConcurrentReviews = deps.maxConcurrentReviews || 3;
  const reviewTimeoutSeconds = deps.reviewTimeoutSeconds || 900;

  let state = {};
  let timer = null;
  let tickRunning = false;
  let stopped = false;
  let persistChain = Promise.resolve();

  function persist() {
    persistChain = persistChain.then(() => writeState(state)).catch((e) => {
      log.warn(`[pr-poller] state write failed: ${e.message}`);
    });
    return persistChain;
  }

  function inFlightCount() {
    return Object.values(state).filter((e) => e?.inFlight).length;
  }

  function ping(kind, ctx) {
    const msg = core.pingFor(kind, ctx);
    if (msg) telegram(msg);
  }

  function firstLine(s) {
    return String(s || '').split(/\r?\n/)[0].trim();
  }

  function finishReview(key, verdict, ctx, pr, wasConflicting) {
    const entry = state[key] || {};
    entry.phase = core.nextState(verdict);
    entry.inFlight = false;
    entry.wasConflicting = wasConflicting;
    entry.pingedError = verdict === 'ERROR';
    entry.reviewedHead = ctx.head || pr.headRefOid;
    state[key] = entry;
    const kindByVerdict = { CLEAN: 'clean', RESOLVED: 'resolved', CHANGES: 'changes', ERROR: 'error' };
    ping(kindByVerdict[verdict] || 'error', { key, summary: ctx.summary, reason: ctx.reason });
    return persist();
  }

  // Race the injected spawnReview against a hard timeout so a hung `claude -p` session can never pin
  // a PR in-flight forever (critic finding #1). On timeout the review is aborted (backend destroys the
  // session on the signal) and resolved to ERROR, freeing the concurrency slot.
  async function spawnWithTimeout(args) {
    const controller = new AbortController();
    let timeoutHandle = null;
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeoutFn(() => {
        controller.abort();
        resolve({ verdict: 'ERROR', summary: 'review timed out' });
      }, args.timeoutMs);
      if (timeoutHandle && typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
    });
    const run = Promise.resolve(spawnReview({ ...args, signal: controller.signal }))
      .catch((e) => ({ verdict: 'ERROR', summary: firstLine(e.message) }));
    const res = await Promise.race([run, timeout]);
    if (timeoutHandle) clearTimeoutFn(timeoutHandle);
    return res || { verdict: 'ERROR', summary: 'no verdict' };
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
        projectPath, teamId: 'pr-review', label: `pr-${pr.number}`, worktreeBase: getWorktreeBase(projectPath),
      });
      if (!ws || !ws.isGit) {
        await finishReview(key, 'ERROR', { reason: (ws?.reason) || 'cannot isolate worktree' }, pr, true);
        return;
      }
      workspace = ws;
      cwd = ws.cwd;
    }

    try {
      const res = await spawnWithTimeout({
        projectPath, cwd, pr, slug, conflicting, timeoutMs: reviewTimeoutSeconds * 1000,
      });
      let head = pr.headRefOid;
      if (res.verdict === 'RESOLVED') head = await requeryHead(gh, pr.number, pr.headRefOid);
      await finishReview(key, res.verdict, { summary: res.summary, head }, pr, conflicting);
    } catch (e) {
      await finishReview(key, 'ERROR', { reason: firstLine(e.message) }, pr, conflicting);
    } finally {
      if (workspace) {
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
        if (!entry.pingedError) {
          ping('error', { key, reason: 'touches workflow files, merge manually' });
          entry.pingedError = true;
        }
        return true;
      }
      const m = await gh.merge(pr.number, mergeMethod);
      if (m.ok) {
        entry.phase = 'merged';
        ping('merged', { key, summary: mergeMethod });
        return true;
      }
      if (/already merged|not open|closed|no open/i.test(m.err)) {
        delete state[key];
        return true;
      }
      if (!entry.pingedError) {
        ping('error', { key, reason: `merge failed: ${firstLine(m.err)}` });
        entry.pingedError = true;
        return true;
      }
      return false;
    }

    if (entry.pingedError) return false;
    entry.phase = 'error';
    ping('error', { key, reason: status === 'none' ? 'no CI checks; merge manually' : 'checks failing' });
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

  async function tickProject(projectId) {
    const projectPath = getProjectPathById(projectId);
    if (!projectPath) return false;
    const gh = makePrGh(projectPath);
    const slug = await gh.repoSlug();
    if (!slug) return false;
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
      if (stopped) break;
      const entry = state[pr.key] || {};
      entry.inFlight = true;
      state[pr.key] = entry;
      dirty = true;
      slots -= 1;
      void runReview(gh, projectPath, slug, pr);
    }
    return dirty;
  }

  async function tick() {
    if (tickRunning || stopped) return;
    tickRunning = true;
    try {
      let dirty = false;
      for (const projectId of projects) {
        const changed = await tickProject(projectId).catch((e) => {
          log.warn(`[pr-poller] tick failed for ${projectId}: ${e.message}`);
          return false;
        });
        if (changed) dirty = true;
      }
      if (dirty) await persist();
    } finally {
      tickRunning = false;
    }
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
    stopped = false;
    state = (await readState()) || {};
    for (const k of Object.keys(state)) {
      if (state[k]) state[k].inFlight = false;
    }
    await pruneOrphanWorktrees().catch(() => {});
    await probeAuth().catch(() => {});
    await tick();
    timer = setIntervalFn(() => { void tick(); }, intervalMinutes * 60000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
  }

  return { start, stop, tick, _state: () => state };
}

module.exports = { createPrPoller };
