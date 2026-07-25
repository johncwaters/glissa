'use strict';

// Session-level worktree isolation wiring. start() provisions/reuses a worktree off the integration
// branch; a missing integration branch BLOCKS (stays DORMANT, never spawns in the real tree); a non-git
// path runs in place; merge/discard/exit-settle drive mergeStatus and delegate to the injected git
// engine. The git engine itself is exercised in team-git-session.test.js; a FAKE engine here isolates
// Session wiring. Spawn-path asserts are win32-gated (mirroring spawn-integration.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { Session } = require('../session/sessions');
const { STATES } = require('../shared/states');
const WIN = process.platform === 'win32';

// The finish settled branch and the once("exit") handler now fire an ASYNC reset (merge/discard ->
// resetToDormant) and clear the teardown-mutex flag in a .finally(). Yield the microtask/timer queue so
// those settle before a synchronous state assertion. The injected fake engine resolves immediately, so a
// single setImmediate hop drains the awaited chain.
const drain = () => new Promise((r) => setImmediate(r));

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const GIT = hasGit();

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A real one-commit git repo to stand in for a session worktree, so getDiff runs against actual git
// (the reconcile path it drives is git-truth, not mockable).
function initOneCommitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-diff-'));
  try { git(['init', '-b', 'main'], dir); } catch { git(['init'], dir); }
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Glissa Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

// A repo with a `develop` integration branch and a `feat` branch one commit ahead of it, checked out as
// HEAD - the shape getDiff sees for a session worktree. Builds on initOneCommitRepo (init/config/commit),
// then branches develop and adds the feat commit. The caller can fast-forward develop to simulate an
// out-of-band merge (the CLI rebase-then-FF case) and assert the gate self-corrects.
function initRepoDevelopFeature() {
  const dir = initOneCommitRepo();
  git(['branch', 'develop'], dir);
  git(['checkout', 'develop'], dir);
  git(['checkout', '-b', 'feat'], dir);
  fs.writeFileSync(path.join(dir, 'feature.txt'), 'work\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'feat work'], dir);
  return dir; // HEAD = feat, one commit ahead of develop
}

function fakePty(pid = 2147483646) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

// A PTY that records what gets written to it, so the parked-merge handoff (pasteMergePrompt) can be asserted.
function capturingPty(writes, pid = 2147483646) {
  return { pid, onData() {}, onExit() {}, write(d) { writes.push(d); }, resize() {}, kill() {} };
}

// A real temp dir so the spawn_success guard (fs.existsSync on the worktree) passes.
function realWorktreeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-wt-fake-'));
}

function fakeGitWorkspace(opts = {}) {
  const calls = { create: [], mergeBack: [], mergeKeep: [], discard: [] };
  return {
    calls,
    create(args) {
      calls.create.push(args);
      if (opts.createResult) return opts.createResult;
      return { cwd: opts.worktreeDir, isGit: true, branch: `glissa/session/${args.label}`, base: args.baseBranch, baseSha: 'basesha' };
    },
    mergeBack(args) { calls.mergeBack.push(args); return opts.mergeResult || { merged: true, branch: null }; },
    mergeKeep(args) {
      calls.mergeKeep.push(args);
      return opts.mergeKeepResult
        || { merged: true, kept: true, branch: args.workspace.branch, base: args.targetBranch, baseSha: 'newbase' };
    },
    discard(args) { calls.discard.push(args); },
  };
}

function makeSession(extra = {}) {
  return new Session({
    id: 'wt-sess',
    name: 'wt-sess',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: extra.ptySpawn,
    gitWorkspace: extra.gitWorkspace,
    integrationBranch: extra.integrationBranch,
  });
}

test('start() provisions a worktree off the integration branch and spawns the PTY in it', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt });
  const spawned = [];
  const s = makeSession({
    gitWorkspace: gw, integrationBranch: 'develop',
    ptySpawn: (file, args, optsArg) => { spawned.push(optsArg); return fakePty(); },
  });
  try {
    await s.start();
    assert.equal(gw.calls.create.length, 1, 'worktree created once');
    assert.equal(gw.calls.create[0].teamId, 'session');
    assert.equal(gw.calls.create[0].label, 'wt-sess');
    assert.equal(gw.calls.create[0].baseBranch, 'develop');
    assert.equal(s.worktreeDir, wt);
    assert.equal(s.isWorktree, true);
    assert.equal(spawned.length, 1, 'spawned once');
    assert.equal(spawned[0].cwd, wt, 'PTY cwd is the worktree, not the repo root');
    assert.equal(s.state, STATES.STARTING);
    const snap = s.toSnapshot();
    assert.equal(snap.mergeStatus, 'none');
    assert.equal(snap.isWorktree, true);
  } finally {
    s.destroy();
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('concurrent start() calls are single-flight: one worktree, one PTY, no branch-in-use fallback', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const spawned = [];
  // Async create with a real event-loop gap, mirroring the serialized git engine: without the
  // single-flight guard the second start() enters during the first's provision await, sees its own
  // just-created branch as in-use, and respawns in place.
  const gw = {
    calls: { create: [] },
    async create(args) {
      gw.calls.create.push(args);
      await new Promise((r) => setImmediate(r));
      if (gw.calls.create.length > 1) {
        return { cwd: process.cwd(), isGit: false, reason: 'branch-in-use', conflictPath: wt };
      }
      return { cwd: wt, isGit: true, branch: `glissa/session/${args.label}`, base: args.baseBranch, baseSha: 'basesha' };
    },
    mergeBack() {}, mergeKeep() {}, discard() {},
  };
  const s = makeSession({
    gitWorkspace: gw, integrationBranch: 'develop',
    ptySpawn: (file, args, optsArg) => { spawned.push(optsArg); return fakePty(); },
  });
  try {
    await Promise.all([s.start(), s.start()]);
    assert.equal(gw.calls.create.length, 1, 'worktree provisioned once');
    assert.equal(spawned.length, 1, 'exactly one PTY spawned');
    assert.equal(spawned[0].cwd, wt, 'the PTY runs in the worktree, not in place');
    assert.equal(s.worktreeDir, wt, 'worktreeDir not clobbered by a losing racer');
    assert.equal(s.worktreeNotice, null, 'no branch-in-use notice against our own branch');
  } finally {
    s.destroy();
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('start() BLOCKS when the integration branch is missing - stays DORMANT, no spawn, notice set', async () => {
  const gw = fakeGitWorkspace({ createResult: { cwd: process.cwd(), isGit: false, reason: 'no-base-branch' } });
  const spawned = [];
  let blocked = null;
  const s = makeSession({
    gitWorkspace: gw, integrationBranch: 'develop',
    ptySpawn: (file, args, optsArg) => { spawned.push(optsArg); return fakePty(); },
  });
  s.on('worktree-blocked', (e) => { blocked = e; });
  try {
    await s.start();
    assert.equal(spawned.length, 0, 'PTY never spawned (never ran in the real tree)');
    assert.equal(s.state, STATES.DORMANT, 'stays DORMANT');
    assert.ok(s.worktreeNotice && /not found/i.test(s.worktreeNotice), 'actionable notice set');
    assert.ok(blocked && blocked.branch === 'develop', 'worktree-blocked event emitted');
    assert.equal(s.toSnapshot().worktreeNotice, s.worktreeNotice);
  } finally {
    s.destroy();
  }
});

test('start() runs in place with a notice when the session branch is already checked out elsewhere (branch-in-use)', { skip: !WIN }, async () => {
  const gw = fakeGitWorkspace({ createResult: { cwd: process.cwd(), isGit: false, reason: 'branch-in-use', conflictPath: 'C:\\other\\wt' } });
  const spawned = [];
  let blocked = null;
  const s = makeSession({
    gitWorkspace: gw, integrationBranch: 'develop',
    ptySpawn: (file, args, optsArg) => { spawned.push(optsArg); return fakePty(); },
  });
  s.on('worktree-blocked', (e) => { blocked = e; });
  try {
    await s.start();
    assert.equal(spawned.length, 1, 'still spawns, running in place (not blocked like no-base-branch)');
    assert.equal(s.worktreeDir, null);
    assert.equal(s.isWorktree, false);
    assert.ok(s.worktreeNotice && /already checked out/i.test(s.worktreeNotice), 'actionable notice set');
    assert.ok(s.worktreeNotice.includes('C:\\other\\wt'), 'notice names the conflicting worktree path');
    assert.ok(blocked && blocked.notice === s.worktreeNotice, 'worktree-blocked event carries the same notice');
  } finally {
    s.destroy();
  }
});

test('start() runs in place for a non-git path (the only in-place fallback)', { skip: !WIN }, async () => {
  const gw = fakeGitWorkspace({ createResult: { cwd: process.cwd(), isGit: false } });
  const spawned = [];
  const s = makeSession({
    gitWorkspace: gw, integrationBranch: 'develop',
    ptySpawn: (file, args, optsArg) => { spawned.push(optsArg); return fakePty(); },
  });
  try {
    await s.start();
    assert.equal(s.worktreeDir, null, 'no worktree');
    assert.equal(s.isWorktree, false);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].cwd, process.cwd(), 'spawned in place at the repo path');
    assert.equal(s.state, STATES.STARTING);
  } finally {
    s.destroy();
  }
});

test('restart REUSES the existing worktree (never silently recreates over in-progress work)', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    await s.start();
    await s.start(); // restart funnels through start()
    assert.equal(gw.calls.create.length, 1, 'worktree created once across two starts');
    assert.equal(s.worktreeDir, wt);
  } finally {
    s.destroy();
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('mergeWorktree delegates to the engine and clears the worktree on success', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt, mergeResult: { merged: true, branch: null } });
  const statuses = [];
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    await s.start();
    const r = await s.mergeWorktree();
    assert.equal(r.merged, true);
    assert.equal(gw.calls.mergeBack.length, 1);
    assert.equal(gw.calls.mergeBack[0].targetBranch, 'develop');
    assert.equal(s.mergeStatus, 'merged');
    assert.equal(s.worktreeDir, null, 'worktree cleared after merge');
    assert.deepEqual(statuses.slice(-2), ['merging', 'merged']);
  } finally {
    s.destroy();
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('mergeWorktree parks on a conflict (worktree preserved)', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt, mergeResult: { merged: false, parked: true, reason: 'rebase-conflict', branch: 'glissa/session/wt-sess' } });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    await s.start();
    const r = await s.mergeWorktree();
    assert.equal(r.merged, false);
    assert.equal(s.mergeStatus, 'parked');
    assert.equal(s.worktreeDir, wt, 'parked worktree preserved');
  } finally {
    s.destroy();
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('mergeAndContinue from COMPLETE merges into develop but KEEPS the worktree + session alive', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({
    worktreeDir: wt,
    mergeKeepResult: { merged: true, kept: true, branch: 'glissa/session/wt-sess', base: 'develop', baseSha: 'newbase' },
  });
  const statuses = [];
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    await s.start();
    s.state = STATES.COMPLETE; // a completed turn, PTY still alive in the worktree
    const r = await s.mergeAndContinue();
    assert.equal(r.merged, true);
    assert.equal(gw.calls.mergeKeep.length, 1, 'delegated to the keep-worktree merge');
    assert.equal(gw.calls.mergeKeep[0].targetBranch, 'develop');
    assert.equal(gw.calls.mergeBack.length, 0, 'did NOT use the finishing merge path');
    assert.equal(s.worktreeDir, wt, 'worktree kept alive so the session keeps working');
    assert.equal(s.isWorktree, true);
    assert.equal(s.baseSha, 'newbase', 'tracks the new integration tip it was rebased onto');
    assert.equal(s.state, STATES.COMPLETE, 'session is NOT ended');
    assert.equal(s.mergeStatus, 'none', 'clean worktree again after the merge');
    assert.deepEqual(statuses.slice(-2), ['merging', 'none']);
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('mergeAndContinue surfaces a stash-restore conflict as pending-review (not a silent clean none)', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({
    worktreeDir: wt,
    mergeKeepResult: { merged: true, kept: true, branch: 'glissa/session/wt-sess', base: 'develop', baseSha: 'newbase', restoreConflict: true },
  });
  const statuses = [];
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  s.on('merge-status', (e) => statuses.push(e));
  try {
    await s.start();
    s.state = STATES.COMPLETE;
    const r = await s.mergeAndContinue();
    assert.equal(r.merged, true);
    assert.equal(s.baseSha, 'newbase', 'still tracks the new integration tip it was rebased onto');
    assert.equal(s.mergeStatus, 'pending-review', 'the reapplied-with-conflicts worktree is surfaced');
    assert.equal(statuses.at(-1).reason, 'restore-conflict');
    assert.equal(s.worktreeDir, wt, 'worktree kept alive');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('mergeAndContinue refuses while actively RUNNING (mid-edit; no merge)', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    await s.start();
    s.state = STATES.RUNNING;
    const r = await s.mergeAndContinue();
    assert.equal(r.merged, false);
    assert.equal(r.refused, true, 'guard refusals are flagged so the control handler can surface them');
    assert.equal(r.reason, 'not-continuable');
    assert.equal(gw.calls.mergeKeep.length, 0, 'no merge attempted mid-work');
    assert.equal(s.worktreeDir, wt, 'worktree untouched');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('mergeAndContinue({ force: true }) overrides the RUNNING refusal (operator explicit "merge anyway")', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({
    worktreeDir: wt,
    mergeKeepResult: { merged: true, kept: true, branch: 'glissa/session/wt-sess', base: 'develop', baseSha: 'newbase' },
  });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    await s.start();
    s.state = STATES.RUNNING;
    const r = await s.mergeAndContinue({ force: true });
    assert.equal(r.merged, true, 'force overrides the RUNNING guard');
    assert.equal(gw.calls.mergeKeep.length, 1);
    assert.equal(s.worktreeDir, wt, 'worktree kept alive');
    assert.equal(s.state, STATES.RUNNING, 'session is NOT ended by the merge');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('mergeAndContinue({ force: true }) still refuses a non-live state (force only widens the RUNNING guard)', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    await s.start();
    s.state = STATES.DONE;
    const r = await s.mergeAndContinue({ force: true });
    assert.equal(r.merged, false);
    assert.equal(r.refused, true, 'guard refusals are flagged so the control handler can surface them');
    assert.equal(r.reason, 'not-continuable');
    assert.equal(gw.calls.mergeKeep.length, 0, 'force does not widen past RUNNING');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('mergeAndContinue from WAITING merges (paused awaiting the operator is quiescent, not working)', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({
    worktreeDir: wt,
    mergeKeepResult: { merged: true, kept: true, branch: 'glissa/session/wt-sess', base: 'develop', baseSha: 'newbase' },
  });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    await s.start();
    s.state = STATES.WAITING; // turn ended on a question; the agent is parked waiting for the operator, not editing
    const r = await s.mergeAndContinue();
    assert.equal(r.merged, true, 'a quiescent WAITING session is mergeable, same as IDLE/COMPLETE');
    assert.equal(gw.calls.mergeKeep.length, 1, 'delegated to the keep-worktree merge');
    assert.equal(s.worktreeDir, wt, 'worktree kept alive so the session keeps working');
    assert.equal(s.state, STATES.WAITING, 'session is NOT ended by the merge');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('mergeAndContinue parks on a rebase conflict (worktree preserved, session continues)', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({
    worktreeDir: wt,
    mergeKeepResult: { merged: false, parked: true, reason: 'rebase-conflict', branch: 'glissa/session/wt-sess' },
  });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    await s.start();
    s.state = STATES.IDLE;
    const r = await s.mergeAndContinue();
    assert.equal(r.merged, false);
    assert.equal(s.mergeStatus, 'parked');
    assert.equal(s.worktreeDir, wt, 'parked worktree preserved');
    assert.equal(s.state, STATES.IDLE, 'session not ended');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('pasteMergePrompt: a parked session pastes a context-rich merge prompt into its PTY (bracketed paste)', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({
    worktreeDir: wt,
    mergeKeepResult: { merged: false, parked: true, reason: 'rebase-conflict', branch: 'glissa/session/wt-sess', conflicts: ['src/a.js', 'src/b.js'] },
  });
  const writes = [];
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => capturingPty(writes) });
  try {
    await s.start();
    s.state = STATES.IDLE;
    await s.mergeAndContinue(); // -> parked; stores reason + conflicts for the handoff
    assert.equal(s.mergeStatus, 'parked');
    assert.deepEqual(s.mergeConflicts, ['src/a.js', 'src/b.js']);

    const r = s.pasteMergePrompt();
    assert.equal(r.ok, true);
    assert.equal(writes.length, 1, 'one paste into the PTY');
    const out = writes[0];
    assert.ok(out.startsWith('\x1b[200~') && out.endsWith('\x1b[201~'), 'wrapped in bracketed paste (multi-line, not auto-submitted)');
    assert.ok(out.includes('glissa/session/wt-sess'), 'names the session branch');
    assert.ok(out.includes('develop'), 'names the integration target');
    assert.ok(out.includes('src/a.js') && out.includes('src/b.js'), 'lists the conflicting files');
    assert.ok(out.includes('git rebase develop'), 'gives the rebase command');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('pasteMergePrompt: refused when not parked (no stray paste into a clean session)', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt });
  const writes = [];
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => capturingPty(writes) });
  try {
    await s.start();
    s.state = STATES.IDLE; // not parked
    assert.deepEqual(s.pasteMergePrompt(), { ok: false, reason: 'not-parked' });
    assert.equal(writes.length, 0, 'nothing written');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('adoptWorktree re-attaches an on-disk worktree as pending-review (restart re-adoption)', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt, mergeResult: { merged: true, branch: null } });
  const statuses = [];
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    s.adoptWorktree({ worktreeDir: wt, branch: 'glissa/session/wt-sess', base: 'develop' });
    assert.equal(s.worktreeDir, wt);
    assert.equal(s.isWorktree, true);
    assert.equal(s.mergeStatus, 'pending-review');
    assert.equal(s.toSnapshot().mergeStatus, 'pending-review');
    // An adopted worktree can still be merged: it delegates to the engine with the reconstructed workspace.
    await s.mergeWorktree();
    assert.equal(gw.calls.mergeBack.length, 1);
    assert.equal(gw.calls.mergeBack[0].targetBranch, 'develop');
  } finally {
    s.destroy();
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('getDiff self-heals a stranded pending-review gate to none when nothing is reviewable', { skip: !GIT }, async () => {
  const repo = initOneCommitRepo();
  const s = makeSession();
  const statuses = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    s.worktreeDir = repo;          // clean one-commit repo: no committed-vs-base diff, no working changes
    s.mergeStatus = 'pending-review'; // gate stranded after the operator merged/cleaned inside the live PTY
    const d = await s.getDiff();
    assert.equal(d.committed.diff.trim(), '', 'no committed diff');
    assert.equal(d.uncommitted.diff.trim(), '', 'clean working tree');
    assert.equal(s.mergeStatus, 'none', 'gate demoted to none');
    assert.deepEqual(statuses, ['none'], 'broadcast the demotion exactly once');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('getDiff keeps pending-review when the worktree still has real changes', { skip: !GIT }, async () => {
  const repo = initOneCommitRepo();
  const s = makeSession();
  const statuses = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    s.worktreeDir = repo;
    s.mergeStatus = 'pending-review';
    fs.writeFileSync(path.join(repo, 'work.txt'), 'new work\n', 'utf8'); // an untracked deliverable
    const d = await s.getDiff();
    assert.notEqual(d.uncommitted.diff.trim(), '', 'untracked change shows via intent-to-add');
    assert.equal(s.mergeStatus, 'pending-review', 'gate preserved while there is something to review');
    assert.deepEqual(statuses, [], 'no demotion broadcast');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('getDiff: committed range + gate come from the integration branch, not a stale baseSha', { skip: !GIT }, async () => {
  const repo = initRepoDevelopFeature();
  const s = makeSession({ integrationBranch: 'develop' });
  try {
    s.worktreeDir = repo;
    s.baseSha = git(['rev-parse', 'develop'], repo).trim(); // the (correct) fork point
    const d = await s.getDiff();
    assert.equal(d.hasCommits, true, 'a commit ahead of develop is mergeable');
    assert.ok(d.committed.diff.includes('feature.txt'), 'committed diff shows the ahead commit');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('getDiff: a branch already on develop shows nothing to merge despite a stale baseSha (out-of-band merge)', { skip: !GIT }, async () => {
  const repo = initRepoDevelopFeature();
  const s = makeSession({ integrationBranch: 'develop' });
  try {
    const staleBase = git(['rev-parse', 'develop'], repo).trim(); // the pre-merge fork point
    // Land the work on develop out-of-band (a CLI rebase-then-FF), leaving the session's baseSha stale.
    git(['checkout', 'develop'], repo);
    git(['merge', '--ff-only', 'feat'], repo);
    git(['checkout', 'feat'], repo);
    s.worktreeDir = repo;
    s.baseSha = staleBase; // STALE: still the old fork, not the new develop tip
    const d = await s.getDiff();
    assert.equal(d.hasCommits, false, 'develop already contains the work -> nothing to merge');
    assert.equal(d.committed.diff.trim(), '', 'no phantom committed diff from the stale baseSha');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

// --- checkWorktreeChange: the live change funnel (turn-end hook / gitdir watch / integration-ref watcher) ---

test('checkWorktreeChange emits worktree-changed on a real delta and dedups an unchanged worktree', { skip: !GIT }, async () => {
  const repo = initOneCommitRepo();
  const s = makeSession();
  const changes = [];
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    s.worktreeDir = repo;
    await s.checkWorktreeChange();                 // null -> baseline signature: one emit
    assert.equal(changes.length, 1, 'baseline emit');
    assert.ok(changes[0].sig, 'carries a signature token');
    await s.checkWorktreeChange();                 // identical state: no re-emit
    assert.equal(changes.length, 1, 'no emit when nothing changed (signature dedup)');
    fs.writeFileSync(path.join(repo, 'work.txt'), 'new\n', 'utf8'); // an untracked deliverable
    await s.checkWorktreeChange();
    assert.equal(changes.length, 2, 'a working-tree change re-emits');
    assert.notEqual(changes[1].sig, changes[0].sig, 'the signature actually moved');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange detects a COMMIT (no working-tree change) via the ahead-count/HEAD signature', { skip: !GIT }, async () => {
  const repo = initRepoDevelopFeature(); // HEAD = feat, one commit ahead of develop
  const s = makeSession({ integrationBranch: 'develop' });
  const changes = [];
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    s.worktreeDir = repo;
    await s.checkWorktreeChange();                 // baseline
    const baseline = changes.length;
    // Commit an already-saved file: the working tree is clean afterward, so only HEAD + ahead-count move.
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'more\n', 'utf8');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'second feat'], repo);
    await s.checkWorktreeChange();
    assert.equal(changes.length, baseline + 1, 'a commit moves the signature even with a clean tree');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange is suppressed while merging (index mid-rewrite)', { skip: !GIT }, async () => {
  const repo = initOneCommitRepo();
  const s = makeSession();
  const changes = [];
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    s.worktreeDir = repo;
    s.mergeStatus = 'merging';
    await s.checkWorktreeChange();
    assert.equal(changes.length, 0, 'no broadcast while a merge is in flight');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange live-self-heals a stranded pending-review to none over an empty worktree', { skip: !GIT }, async () => {
  const repo = initOneCommitRepo(); // clean: no working changes, no integration branch -> ahead 0
  const s = makeSession();
  const statuses = [];
  const changes = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    s.worktreeDir = repo;
    s.mergeStatus = 'pending-review'; // stranded after a merge/clean inside the live PTY
    await s.checkWorktreeChange();
    assert.equal(s.mergeStatus, 'none', 'gate demoted live, no manual getDiff needed');
    assert.deepEqual(statuses, ['none'], 'demotion broadcast exactly once');
    assert.equal(changes.length, 1, 'still emits a change so the selected diff refreshes to empty');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange keeps pending-review while the worktree still has real changes', { skip: !GIT }, async () => {
  const repo = initOneCommitRepo();
  const s = makeSession();
  const statuses = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    s.worktreeDir = repo;
    s.mergeStatus = 'pending-review';
    fs.writeFileSync(path.join(repo, 'work.txt'), 'real work\n', 'utf8'); // something to review
    await s.checkWorktreeChange();
    assert.equal(s.mergeStatus, 'pending-review', 'gate preserved while there is something to review');
    assert.deepEqual(statuses, [], 'no demotion broadcast');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange returns UNKNOWN (no broadcast, no demotion) when the worktree is unreadable', async () => {
  // A non-existent cwd makes every git call throw - the "momentarily unreadable" case (mid-rebase, lock
  // contention, pruned dir). The signature must report UNKNOWN, never a false-empty that demotes the gate.
  const s = makeSession();
  const statuses = [];
  const changes = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    s.worktreeDir = path.join(os.tmpdir(), `glissa-nonexistent-${Date.now()}`);
    s.mergeStatus = 'pending-review';
    assert.equal(await s._computeWorktreeSignature(), null, 'a failed git read yields null, not a false-empty signature');
    await s.checkWorktreeChange();
    assert.equal(s.mergeStatus, 'pending-review', 'a git failure must NOT demote a real review gate');
    assert.deepEqual(statuses, [], 'no merge-status broadcast on a failed read');
    assert.equal(changes.length, 0, 'no worktree-changed broadcast on a failed read');
  } finally { s.destroy(); }
});

test('checkWorktreeChange is a no-op with no worktree', async () => {
  const s = makeSession();
  const changes = [];
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    await assert.doesNotReject(() => s.checkWorktreeChange());
    assert.equal(changes.length, 0);
  } finally { s.destroy(); }
});

// The signal the integration-ref watcher fans out: when the integration branch moves WITHOUT this
// worktree changing (a sibling's merge or an out-of-band CLI merge into develop), the session's gate
// (ahead-count vs develop) shifts, so checkWorktreeChange must move the signature and re-emit. This is
// what replaces the old 10s poll's cross-session job; the integration-ref watcher only delivers the
// nudge, this re-check is what notices the moved gate.
test('checkWorktreeChange detects an out-of-band merge into the integration branch (gate clears)', { skip: !GIT }, async () => {
  const repo = initRepoDevelopFeature(); // HEAD = feat, one commit ahead of develop
  const s = makeSession({ integrationBranch: 'develop' });
  const changes = [];
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    s.worktreeDir = repo;
    await s.checkWorktreeChange();          // baseline: feat is 1 ahead of develop
    const baseline = changes.length;
    // Land feat on develop out-of-band (a CLI ff-merge), the move the integration-ref watcher would catch.
    // The worktree itself does not change (HEAD stays feat), only develop advances under it.
    git(['checkout', 'develop'], repo);
    git(['merge', '--ff-only', 'feat'], repo);
    git(['checkout', 'feat'], repo);
    await s.checkWorktreeChange();
    assert.equal(changes.length, baseline + 1, 'an integration-branch move (ahead 1 -> 0) moves the signature and re-emits');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

// --- parked-merge recovery: behind/rebaseInProgress signature fields + parked -> pending-review demotion ---

// A LINKED worktree (git worktree add) on a new branch at feat's commit: 1 ahead of develop, behind 0,
// clean. A linked worktree's .git is a FILE, so the per-worktree gitdir (where rebase-merge lives) is NOT
// <wt>/.git/rebase-merge; the probe must go through `git rev-parse --git-path`. Returns { repo, wt }.
function initLinkedWorktree() {
  const repo = initRepoDevelopFeature();
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-lwt-')), 'wt');
  git(['worktree', 'add', wt, '-b', 'feat2', 'feat'], repo);
  return { repo, wt };
}

// A repo where feat tracks a STALE remote upstream (refs/remotes/origin/develop pinned at develop's
// pre-advance sha), so _resolveEffectiveBase resolves the upstream while `behind` must be measured
// against the LOCAL develop (the ref a merge actually fast-forwards). diverge commits on develop
// (feat diverges: behind > 0); landFeat fast-forwards develop to feat (develop already contains the
// work: behind 0 while ahead-vs-upstream stays > 0, the tolerated two-bases edge).
// Commit on develop while feat stays put, so the two diverge (feat is ahead AND behind develop).
function advanceDevelop(repo) {
  git(['checkout', 'develop'], repo);
  fs.writeFileSync(path.join(repo, 'develop.txt'), 'develop work\n', 'utf8');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'develop advanced'], repo);
  git(['checkout', 'feat'], repo);
}

function initStaleUpstream({ diverge = false, landFeat = false } = {}) {
  const repo = initRepoDevelopFeature(); // HEAD = feat, 1 ahead of develop
  // A remote named origin must exist (its fetch refspec is what makes refs/remotes/origin/* a tracking
  // branch --set-upstream-to accepts); the URL is never fetched, the repo itself is a fine dummy.
  git(['remote', 'add', 'origin', repo], repo);
  const staleSha = git(['rev-parse', 'develop'], repo).trim();
  git(['update-ref', 'refs/remotes/origin/develop', staleSha], repo);
  git(['branch', '--set-upstream-to=origin/develop', 'feat'], repo);
  if (diverge) advanceDevelop(repo);
  if (landFeat) {
    git(['checkout', 'develop'], repo);
    git(['merge', '--ff-only', 'feat'], repo);
    git(['checkout', 'feat'], repo);
  }
  return repo;
}

test('_computeWorktreeSignature reports behind and rebaseInProgress', { skip: !GIT }, async () => {
  const repo = initRepoDevelopFeature(); // clean, feat 1 ahead of develop, on top of it
  const s = makeSession({ integrationBranch: 'develop' });
  try {
    s.worktreeDir = repo;
    const sig = await s._computeWorktreeSignature();
    assert.equal(sig.ahead, '1');
    assert.equal(sig.behind, '0');
    assert.equal(sig.rebaseInProgress, false);
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange demotes parked to pending-review after a resolved rebase (clean, ahead, behind 0)', { skip: !GIT }, async () => {
  const repo = initRepoDevelopFeature(); // the post-resolve shape: clean, on top of develop, work unmerged
  const s = makeSession({ integrationBranch: 'develop' });
  const statuses = [];
  const changes = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    s.worktreeDir = repo;
    s.mergeStatus = 'parked';
    await s.checkWorktreeChange();
    assert.equal(s.mergeStatus, 'pending-review', 'Merge handed back once the rebase landed');
    assert.deepEqual(statuses, ['pending-review'], 'demotion broadcast exactly once');
    assert.equal(changes.length, 1, 'worktree-changed emitted so the diff refreshes');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange keeps parked while the worktree is still dirty', { skip: !GIT }, async () => {
  const repo = initRepoDevelopFeature();
  const s = makeSession({ integrationBranch: 'develop' });
  const statuses = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    s.worktreeDir = repo;
    fs.writeFileSync(path.join(repo, 'conflicted.txt'), 'unresolved\n', 'utf8');
    s.mergeStatus = 'parked';
    await s.checkWorktreeChange();
    assert.equal(s.mergeStatus, 'parked', 'a dirty tree is not mergeable');
    assert.deepEqual(statuses, [], 'no demotion broadcast');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange keeps parked while behind > 0 (diverged, FF impossible)', { skip: !GIT }, async () => {
  const repo = initRepoDevelopFeature();
  advanceDevelop(repo); // feat and develop diverge: the un-rebased park shape (the Option-B trap)
  const s = makeSession({ integrationBranch: 'develop' });
  const statuses = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    s.worktreeDir = repo;
    s.mergeStatus = 'parked';
    await s.checkWorktreeChange();
    assert.equal(s.mergeStatus, 'parked', 'clean+ahead alone must NOT re-enable Merge before the rebase');
    assert.deepEqual(statuses, [], 'no demotion broadcast');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange still demotes an empty parked worktree to none', { skip: !GIT }, async () => {
  const repo = initOneCommitRepo(); // clean, ahead 0: nothing left to review
  const s = makeSession();
  const statuses = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    s.worktreeDir = repo;
    s.mergeStatus = 'parked';
    await s.checkWorktreeChange();
    assert.equal(s.mergeStatus, 'none', 'an empty parked worktree clears the gate entirely');
    assert.deepEqual(statuses, ['none']);
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange does not demote parked while a rebase is in progress (linked worktree, real gitdir path)', { skip: !GIT }, async (t) => {
  let repo, wt;
  try { ({ repo, wt } = initLinkedWorktree()); } catch { t.skip('git worktree add unavailable'); return; }
  // Derive the marker dir from git itself: for a linked worktree this is under the per-worktree gitdir
  // (<common>/.git/worktrees/<name>/rebase-merge), never <wt>/.git/rebase-merge (.git is a FILE here).
  const markerOut = git(['rev-parse', '--git-path', 'rebase-merge'], wt).trim();
  const marker = path.isAbsolute(markerOut) ? markerOut : path.resolve(wt, markerOut);
  fs.mkdirSync(marker, { recursive: true });
  const s = makeSession({ integrationBranch: 'develop' });
  const statuses = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    s.worktreeDir = wt;
    s.mergeStatus = 'parked';
    const sig = await s._computeWorktreeSignature();
    assert.equal(sig.rebaseInProgress, true, 'the probe sees the per-worktree rebase-merge dir');
    assert.equal(sig.ahead, '1');
    assert.equal(sig.behind, '0');
    await s.checkWorktreeChange();
    assert.equal(s.mergeStatus, 'parked', 'a mid-rebase clean stop must never look mergeable');
    assert.deepEqual(statuses, [], 'no demotion broadcast');
  } finally {
    s.destroy();
    // Deregister the worktree before deleting its dir, so the repo never holds a dangling registration.
    try { git(['worktree', 'remove', '--force', wt], repo); } catch { /* best-effort; repo dir goes next */ }
    fs.rmSync(path.dirname(wt), { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('behind/rebaseInProgress fields do not change the sig hash', { skip: !GIT }, async () => {
  const repo = initRepoDevelopFeature();
  const s = makeSession({ integrationBranch: 'develop' });
  try {
    s.worktreeDir = repo;
    const sig = await s._computeWorktreeSignature();
    const status = git(['--no-optional-locks', 'status', '--porcelain'], repo);
    const head = git(['rev-parse', 'HEAD'], repo).trim();
    const expected = crypto.createHash('sha1').update(`${status} ${head} 1`).digest('hex');
    assert.equal(sig.sig, expected, 'hash is still sha1(status head ahead); new fields are not folded in');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange demotes a byte-identical park (lost-FF reproduction, equal sig)', { skip: !GIT }, async () => {
  const repo = initRepoDevelopFeature();
  const s = makeSession({ integrationBranch: 'develop' });
  const statuses = [];
  const changes = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    s.worktreeDir = repo;
    s.mergeStatus = 'parked';
    await s.checkWorktreeChange();           // establishes _lastWorktreeSig and demotes
    assert.equal(s.mergeStatus, 'pending-review');
    assert.equal(changes.length, 1);
    // Re-park WITHOUT touching the worktree: a lost fast-forward leaves the git state byte-identical,
    // so the next check sees sig === _lastWorktreeSig. The demotion must still fire and still emit.
    s.mergeStatus = 'parked';
    await s.checkWorktreeChange();
    assert.equal(s.mergeStatus, 'pending-review', 'the signature dedup must not swallow the demotion');
    assert.deepEqual(statuses, ['pending-review', 'pending-review']);
    assert.equal(changes.length, 2, 'a demotion forces the emit even on an equal signature');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('behind is measured against the integration branch, not a stale upstream', { skip: !GIT }, async (t) => {
  let repo;
  try { repo = initStaleUpstream({ diverge: true }); } catch { t.skip('cannot configure an upstream in this sandbox'); return; }
  const s = makeSession({ integrationBranch: 'develop' });
  const statuses = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    s.worktreeDir = repo;
    const sig = await s._computeWorktreeSignature();
    assert.equal(sig.ahead, '1', 'ahead still uses the effective base (the stale upstream)');
    assert.ok(Number(sig.behind) > 0, 'behind counts the advanced LOCAL develop, not the stale upstream');
    s.mergeStatus = 'parked';
    await s.checkWorktreeChange();
    assert.equal(s.mergeStatus, 'parked', 'no demote-then-repark: truly behind the merge target stays parked');
    assert.deepEqual(statuses, []);
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('two-bases edge: integration already contains the commits demotes, then mergeKeep clears to none', { skip: !GIT }, async (t) => {
  let repo;
  try { repo = initStaleUpstream({ landFeat: true }); } catch { t.skip('cannot configure an upstream in this sandbox'); return; }
  // develop already contains feat's work (behind 0, nothing to merge) while the stale upstream keeps
  // ahead > 0: the tolerated benign demotion. The re-enabled button's path (mergeAndContinue/mergeKeep)
  // then self-corrects via nothing-to-commit -> 'none'.
  const gw = fakeGitWorkspace({ mergeKeepResult: { merged: false, reason: 'nothing-to-commit' } });
  const s = makeSession({ integrationBranch: 'develop', gitWorkspace: gw });
  try {
    s.worktreeDir = repo;
    s._workspace = { cwd: repo, isGit: true, branch: 'feat', base: 'develop' };
    s.mergeStatus = 'parked';
    await s.checkWorktreeChange();
    assert.equal(s.mergeStatus, 'pending-review', 'benign demotion fires (ahead vs stale upstream, behind 0 vs develop)');
    s.state = STATES.IDLE; // quiescent live session, or mergeAndContinue returns not-continuable
    const r = await s.mergeAndContinue();
    assert.equal(r.reason, 'nothing-to-commit');
    assert.equal(s.mergeStatus, 'none', 'one click clears the gate; no demote-then-repark loop');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('resetToDormant: returns to DORMANT only when settled (PTY dead + no worktree), else no-op', async () => {
  { // allowed: finished, PTY dead, worktree already merged/discarded
    const s = makeSession();
    try {
      s.state = STATES.DONE; // simulate a finished session
      s.mergeStatus = 'merged'; // simulate a just-completed merge
      // ptyProcess null and worktreeDir null by construction (never started)
      const ok = s.resetToDormant();
      assert.equal(ok, true);
      assert.equal(s.state, STATES.DORMANT);
      assert.equal(s.mergeStatus, 'none', 'mergeStatus cleared on a successful reset');
    } finally { s.destroy(); }
  }
  { // rejected: a worktree is still on disk (unmerged work) -> no reset, state preserved
    const s = makeSession();
    try {
      s.state = STATES.DONE;
      s.worktreeDir = '/tmp/some-worktree';
      s.mergeStatus = 'pending-review';
      const ok = s.resetToDormant();
      assert.equal(ok, false);
      assert.equal(s.state, STATES.DONE, 'state unchanged when the guard rejects');
      assert.equal(s.mergeStatus, 'pending-review', 'mergeStatus untouched when not reset');
    } finally { s.destroy(); }
  }
});

test('finishAndMerge refuses while actively RUNNING (mid-work, no merge)', async () => {
  const s = makeSession();
  try {
    s.state = STATES.RUNNING;
    const r = s.finishAndMerge();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-finishable');
    assert.equal(s.state, STATES.RUNNING, 'state untouched');
  } finally { s.destroy(); }
});

test('finishAndMerge from DONE merges immediately and resets to dormant', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt, mergeResult: { merged: true, branch: null } });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    await s.start();              // provisions the worktree (_workspace set)
    s.kill = () => {};       // keep destroy()'s kill from invoking a real taskkill
    s.ptyProcess = null;     // simulate the PTY having exited
    s.state = STATES.DONE;
    s.mergeStatus = 'pending-review';
    const r = s.finishAndMerge();
    assert.equal(r.ok, true);
    await drain(); // the settled-branch reset is async (fire-and-forget + .finally clear)
    assert.equal(gw.calls.mergeBack.length, 1, 'merged once');
    assert.equal(s.state, STATES.DORMANT, 'returned to dormant after a clean merge');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('finishAndMerge from COMPLETE ends the session, then merges + resets on exit', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt, mergeResult: { merged: true, branch: null } });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    await s.start();
    s.state = STATES.COMPLETE; // a completed turn with the PTY still alive
    let killed = false;
    s.kill = () => { killed = true; }; // stub real taskkill; we drive the exit by hand below
    const r = s.finishAndMerge();
    assert.equal(r.pending, true, 'deferred until the PTY exits');
    assert.equal(killed, true, 'PTY ended first');
    assert.equal(s.state, STATES.DONE, 'killSession transitioned to DONE');
    assert.equal(gw.calls.mergeBack.length, 0, 'not merged yet (still settling)');
    // Simulate _handlePtyExit: worktree settles to pending-review, PTY cleared, exit emitted.
    s.hasChanges = () => true;
    await s._settleWorktreeOnExit();
    s.ptyProcess = null;
    s.emit('exit', { exitCode: 0 });
    await drain(); // the once("exit") handler awaits the merge+reset before clearing _finishing
    assert.equal(gw.calls.mergeBack.length, 1, 'merged after the exit settled the worktree');
    assert.equal(s.state, STATES.DORMANT, 'returned to dormant');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('_settleWorktreeOnExit: a changed worktree -> pending-review; an unchanged one -> silent discard', { skip: !WIN }, async () => {
  { // changed
    const wt = realWorktreeDir();
    const gw = fakeGitWorkspace({ worktreeDir: wt });
    const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
    try {
      await s.start();
      s.hasChanges = () => true; // stub the porcelain probe
      s.state = STATES.DONE;     // simulate a real PTY exit
      await s._settleWorktreeOnExit();
      assert.equal(s.mergeStatus, 'pending-review');
      assert.equal(s.worktreeDir, wt, 'worktree kept for review');
      assert.equal(gw.calls.discard.length, 0);
    } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
  }
  { // unchanged
    const wt = realWorktreeDir();
    const gw = fakeGitWorkspace({ worktreeDir: wt });
    const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
    try {
      await s.start();
      s.hasChanges = () => false;
      s.state = STATES.DONE;
      await s._settleWorktreeOnExit();
      assert.equal(s.mergeStatus, 'none');
      assert.equal(s.worktreeDir, null, 'empty worktree auto-discarded');
      assert.equal(gw.calls.discard.length, 1);
    } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
  }
});

// --- teardown mutex: finishAndMerge and restart cannot race each other's queued exit handler ---

test('teardown mutex: a queued finish refuses a racing restart, then completes on exit', async () => {
  const s = makeSession();
  try {
    s.state = STATES.COMPLETE;
    s.kill = () => {};
    let started = 0;
    s.start = () => { started++; }; // detect any respawn attempt
    const r = s.finishAndMerge();
    assert.equal(r.pending, true);
    assert.equal(s.state, STATES.DONE, 'card now shows DONE - the dashboard would send `restart`');
    // The race: a `restart` arriving before the queued exit must be refused (not respawn on the
    // worktree the finish is about to merge).
    const restarted = s.restart();
    assert.equal(restarted, false, 'restart refused while a finish teardown is queued');
    assert.equal(started, 0, 'no respawn');
    assert.equal(s.state, STATES.DONE, 'still DONE, untouched');
    // Exit settles -> finish completes.
    s.mergeWorktree = async () => ({ merged: true });
    s.ptyProcess = null;
    s.emit('exit', { exitCode: 0 });
    await drain();
    assert.equal(s.state, STATES.DORMANT);
  } finally { s.destroy(); }
});

test('teardown mutex is symmetric: finishAndMerge and restart mutually exclude', async () => {
  { // finish pending -> restart refused
    const s = makeSession();
    try {
      s.state = STATES.COMPLETE;
      s.kill = () => {};
      s.finishAndMerge(); // sets _finishing, kills -> DONE
      const restarted = s.restart();
      assert.equal(restarted, false, 'restart refused while a finish teardown is queued');
      assert.equal(s.state, STATES.DONE, 'state untouched');
      s.mergeWorktree = async () => ({ merged: true });
      s.ptyProcess = null; s.emit('exit', { exitCode: 0 }); await drain(); // let the finish drain
    } finally { s.destroy(); }
  }
  { // a force-restart already pending -> finishAndMerge refused
    const s = makeSession();
    try {
      s.state = STATES.DONE;
      s._pendingRestart = true;
      const r = s.finishAndMerge();
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'in-progress');
      assert.equal(s.state, STATES.DONE, 'state untouched while another teardown is queued');
    } finally { s.destroy(); }
  }
});

// === Item 1 async-conversion guards =====================================================

// start()'s provision is now awaited; a destroy() landing in that await window must not let the spawn
// below proceed. A create that resolves on a held deferred lets destroy() slip in mid-await.
test('start(): destroy() during the provision await -> no spawn', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  let releaseCreate;
  const createHeld = new Promise((r) => { releaseCreate = r; });
  let spawns = 0;
  const gw = {
    calls: { create: [], mergeBack: [], mergeKeep: [], discard: [] },
    async create(args) {
      this.calls.create.push(args);
      await createHeld; // hold provision open so destroy() can land in the await window
      return { cwd: wt, isGit: true, branch: `glissa/session/${args.label}`, base: args.baseBranch, baseSha: 'b' };
    },
    mergeBack() { return { merged: true, branch: null }; },
    mergeKeep() { return { merged: true, kept: true }; },
    discard() {},
  };
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => { spawns++; return fakePty(); } });
  try {
    const p = s.start();        // suspends on the held create
    s.destroy();                 // lands during the provision await
    releaseCreate();
    await p;
    await drain();
    assert.equal(spawns, 0, 'no PTY spawned after destroy() during the provision await');
  } finally { fs.rmSync(wt, { recursive: true, force: true }); }
});

// The re-entry guard refuses a SECOND concurrent merge on the same session (keyed strictly on 'merging'),
// invoking the engine exactly once.
test('mergeWorktree re-entry: a second call while merging is refused, engine invoked once', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  let releaseMerge;
  const mergeHeld = new Promise((r) => { releaseMerge = r; });
  let mergeCalls = 0;
  const gw = {
    calls: { create: [], mergeBack: [], mergeKeep: [], discard: [] },
    create(args) { this.calls.create.push(args); return { cwd: wt, isGit: true, branch: `glissa/session/${args.label}`, base: args.baseBranch, baseSha: 'b' }; },
    async mergeBack() { mergeCalls++; await mergeHeld; return { merged: true, branch: null }; },
    mergeKeep() { return { merged: true, kept: true }; },
    discard() {},
  };
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    await s.start();
    const p1 = s.mergeWorktree();        // sets 'merging', wedges in the engine
    const r2 = await s.mergeWorktree();  // second call: refused before touching the engine
    assert.equal(r2.merged, false);
    assert.equal(r2.reason, 'merge-in-progress');
    assert.equal(mergeCalls, 1, 'engine invoked exactly once');
    releaseMerge();
    await p1;
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

// The guard keys on 'merging' ONLY, so it does NOT block the legitimate finish path, which calls
// mergeWorktree while mergeStatus is 'pending-review' (settled-on-exit). A finishAndMerge on a DONE
// changed-tree session MUST still invoke the engine's mergeBack.
test('mergeWorktree guard does NOT block the finish path (pending-review -> merge runs)', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt, mergeResult: { merged: true, branch: null } });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    await s.start();
    s.kill = () => {};
    s.ptyProcess = null;
    s.state = STATES.DONE;
    s.mergeStatus = 'pending-review'; // settled-on-exit, NOT 'merging'
    const r = s.finishAndMerge();
    assert.equal(r.ok, true);
    await drain();
    assert.equal(gw.calls.mergeBack.length, 1, 'the finish path runs the engine merge (guard not tripped)');
    assert.equal(s.state, STATES.DORMANT);
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

// _handlePtyExit must settle the worktree BEFORE emitting "exit" (the order Finish relies on). With an
// async settle, the order is preserved via await: capture the sequence and assert settle-then-exit.
test('_handlePtyExit: settle completes before "exit" is emitted (changed tree)', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  const order = [];
  try {
    await s.start();
    s.hasChanges = () => true;
    // Mark settle via the merge-status broadcast (pending-review fires inside _settleWorktreeOnExit).
    s.on('merge-status', (e) => { if (e.mergeStatus === 'pending-review') order.push('settle'); });
    s.on('exit', () => order.push('exit'));
    s.state = STATES.IDLE; // a live state; the exit transition lands on DONE so settle runs
    await s._handlePtyExit(0, null);
    assert.deepEqual(order, ['settle', 'exit'], 'settle precedes the exit emit');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

// A settle that REJECTS must NOT skip the exit emit, or a queued once("exit") handler never fires and the
// teardown mutex (_finishing/_pendingRestart) is stranded -> permanent deadlock. The exit must still fire
// and a pending flag must clear.
test('_handlePtyExit: a rejecting settle still emits "exit" and clears the teardown flag (no deadlock)', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    await s.start();
    // Force the settle path to reject (an unchanged tree calls discard; make it throw).
    s.hasChanges = () => false;
    s._gitWorkspace.discard = () => Promise.reject(new Error('settle boom'));
    let exited = false;
    s._finishing = true; // simulate a queued finish whose flag must still clear via its once-handler
    s.once('exit', () => { exited = true; s._finishing = false; });
    s.state = STATES.DONE;
    await s._handlePtyExit(0, null);
    await drain();
    assert.equal(exited, true, 'exit emitted despite the settle rejection');
    assert.equal(s._finishing, false, 'the teardown flag cleared (no deadlock)');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

// The settled (DONE/FAILED) branch of finishAndMerge now sets _finishing synchronously before the async
// reset, so a SECOND click landing while the first reset is awaiting is refused (in-progress) and the
// engine merge runs once.
test('finishAndMerge settled-branch mutex: a double-click is refused, engine merges once', { skip: !WIN }, async () => {
  const wt = realWorktreeDir();
  let releaseMerge;
  const mergeHeld = new Promise((r) => { releaseMerge = r; });
  let mergeCalls = 0;
  const gw = {
    calls: { create: [], mergeBack: [], mergeKeep: [], discard: [] },
    create(args) { this.calls.create.push(args); return { cwd: wt, isGit: true, branch: `glissa/session/${args.label}`, base: args.baseBranch, baseSha: 'b' }; },
    async mergeBack() { mergeCalls++; await mergeHeld; return { merged: true, branch: null }; },
    mergeKeep() { return { merged: true, kept: true }; },
    discard() {},
  };
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    await s.start();
    s.kill = () => {};
    s.ptyProcess = null;
    s.state = STATES.DONE;
    s.mergeStatus = 'pending-review';
    const r1 = s.finishAndMerge();   // settled branch: sets _finishing, fires the async (held) reset
    assert.equal(r1.ok, true);
    const r2 = s.finishAndMerge();   // second click while the reset awaits: refused
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'in-progress');
    releaseMerge();
    await drain();
    assert.equal(mergeCalls, 1, 'engine merge ran exactly once');
    assert.equal(s._finishing, false, 'flag cleared after the reset resolved');
    assert.equal(s.state, STATES.DORMANT);
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

// Run `fn` while capturing any unhandledRejection; returns the captured reasons. The settled-branch fired
// reset is detached (not awaited by the caller), so a rejection that escapes would surface here.
async function captureUnhandled(fn) {
  const reasons = [];
  const onUnhandled = (reason) => { reasons.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    await drain();
    await drain(); // a second hop lets any escaped rejection reach the handler before we read it
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
  return reasons;
}

// The settled-branch fired reset (finishAndMerge DONE) must NOT leak an unhandledRejection if the reset
// throws, while the mutex flag still clears - the .finally(clear).catch(swallow) contract.
test('finishAndMerge settled-branch: a throwing reset clears the flag and never leaks an unhandledRejection', async () => {
  const reasons = await captureUnhandled(async () => {
    const s = makeSession();
    try {
      s.state = STATES.DONE;
      s.mergeStatus = 'merged';
      s.mergeWorktree = async () => ({ merged: true }); // settle: nothing to merge here
      s.resetToDormant = () => { throw new Error('reset boom'); }; // force the reset to reject
      const r = s.finishAndMerge();
      assert.equal(r.ok, true);
      await drain();
      assert.equal(s._finishing, false, 'flag cleared even though the reset threw');
    } finally { s.destroy(); }
  });
  assert.deepEqual(reasons, [], 'no unhandledRejection escaped the settled-branch reset');
});

