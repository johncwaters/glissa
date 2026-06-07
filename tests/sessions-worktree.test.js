'use strict';

// Session-level worktree isolation wiring. start() provisions/reuses a worktree off the integration
// branch; a missing integration branch BLOCKS (stays DORMANT, never spawns in the real tree); a non-git
// path runs in place; merge/discard/exit-settle drive mergeStatus and delegate to the injected git
// engine. The git engine itself is exercised in team-git-session.test.js; a FAKE engine here isolates
// Session wiring. Spawn-path asserts are win32-gated (mirroring spawn-integration.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { Session } = require('../sessions');
const { STATES } = require('../shared/states');
const WIN = process.platform === 'win32';

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

test('start() provisions a worktree off the integration branch and spawns the PTY in it', { skip: !WIN }, () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt });
  const spawned = [];
  const s = makeSession({
    gitWorkspace: gw, integrationBranch: 'develop',
    ptySpawn: (file, args, optsArg) => { spawned.push(optsArg); return fakePty(); },
  });
  try {
    s.start();
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

test('start() BLOCKS when the integration branch is missing - stays DORMANT, no spawn, notice set', () => {
  const gw = fakeGitWorkspace({ createResult: { cwd: process.cwd(), isGit: false, reason: 'no-base-branch' } });
  const spawned = [];
  let blocked = null;
  const s = makeSession({
    gitWorkspace: gw, integrationBranch: 'develop',
    ptySpawn: (file, args, optsArg) => { spawned.push(optsArg); return fakePty(); },
  });
  s.on('worktree-blocked', (e) => { blocked = e; });
  try {
    s.start();
    assert.equal(spawned.length, 0, 'PTY never spawned (never ran in the real tree)');
    assert.equal(s.state, STATES.DORMANT, 'stays DORMANT');
    assert.ok(s.worktreeNotice && /not found/i.test(s.worktreeNotice), 'actionable notice set');
    assert.ok(blocked && blocked.branch === 'develop', 'worktree-blocked event emitted');
    assert.equal(s.toSnapshot().worktreeNotice, s.worktreeNotice);
  } finally {
    s.destroy();
  }
});

test('start() runs in place for a non-git path (the only in-place fallback)', { skip: !WIN }, () => {
  const gw = fakeGitWorkspace({ createResult: { cwd: process.cwd(), isGit: false } });
  const spawned = [];
  const s = makeSession({
    gitWorkspace: gw, integrationBranch: 'develop',
    ptySpawn: (file, args, optsArg) => { spawned.push(optsArg); return fakePty(); },
  });
  try {
    s.start();
    assert.equal(s.worktreeDir, null, 'no worktree');
    assert.equal(s.isWorktree, false);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].cwd, process.cwd(), 'spawned in place at the repo path');
    assert.equal(s.state, STATES.STARTING);
  } finally {
    s.destroy();
  }
});

test('restart REUSES the existing worktree (never silently recreates over in-progress work)', { skip: !WIN }, () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    s.start();
    s.start(); // restart funnels through start()
    assert.equal(gw.calls.create.length, 1, 'worktree created once across two starts');
    assert.equal(s.worktreeDir, wt);
  } finally {
    s.destroy();
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('mergeWorktree delegates to the engine and clears the worktree on success', { skip: !WIN }, () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt, mergeResult: { merged: true, branch: null } });
  const statuses = [];
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    s.start();
    const r = s.mergeWorktree();
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

test('mergeWorktree parks on a conflict (worktree preserved)', { skip: !WIN }, () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt, mergeResult: { merged: false, parked: true, reason: 'rebase-conflict', branch: 'glissa/session/wt-sess' } });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    s.start();
    const r = s.mergeWorktree();
    assert.equal(r.merged, false);
    assert.equal(s.mergeStatus, 'parked');
    assert.equal(s.worktreeDir, wt, 'parked worktree preserved');
  } finally {
    s.destroy();
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('mergeAndContinue from COMPLETE merges into develop but KEEPS the worktree + session alive', { skip: !WIN }, () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({
    worktreeDir: wt,
    mergeKeepResult: { merged: true, kept: true, branch: 'glissa/session/wt-sess', base: 'develop', baseSha: 'newbase' },
  });
  const statuses = [];
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    s.start();
    s.state = STATES.COMPLETE; // a completed turn, PTY still alive in the worktree
    const r = s.mergeAndContinue();
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

test('mergeAndContinue surfaces a stash-restore conflict as pending-review (not a silent clean none)', { skip: !WIN }, () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({
    worktreeDir: wt,
    mergeKeepResult: { merged: true, kept: true, branch: 'glissa/session/wt-sess', base: 'develop', baseSha: 'newbase', restoreConflict: true },
  });
  const statuses = [];
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  s.on('merge-status', (e) => statuses.push(e));
  try {
    s.start();
    s.state = STATES.COMPLETE;
    const r = s.mergeAndContinue();
    assert.equal(r.merged, true);
    assert.equal(s.baseSha, 'newbase', 'still tracks the new integration tip it was rebased onto');
    assert.equal(s.mergeStatus, 'pending-review', 'the reapplied-with-conflicts worktree is surfaced');
    assert.equal(statuses.at(-1).reason, 'restore-conflict');
    assert.equal(s.worktreeDir, wt, 'worktree kept alive');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('mergeAndContinue refuses while actively RUNNING (mid-edit; no merge)', { skip: !WIN }, () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    s.start();
    s.state = STATES.RUNNING;
    const r = s.mergeAndContinue();
    assert.equal(r.merged, false);
    assert.equal(r.reason, 'not-continuable');
    assert.equal(gw.calls.mergeKeep.length, 0, 'no merge attempted mid-work');
    assert.equal(s.worktreeDir, wt, 'worktree untouched');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('mergeAndContinue parks on a rebase conflict (worktree preserved, session continues)', { skip: !WIN }, () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({
    worktreeDir: wt,
    mergeKeepResult: { merged: false, parked: true, reason: 'rebase-conflict', branch: 'glissa/session/wt-sess' },
  });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    s.start();
    s.state = STATES.IDLE;
    const r = s.mergeAndContinue();
    assert.equal(r.merged, false);
    assert.equal(s.mergeStatus, 'parked');
    assert.equal(s.worktreeDir, wt, 'parked worktree preserved');
    assert.equal(s.state, STATES.IDLE, 'session not ended');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('pasteMergePrompt: a parked session pastes a context-rich merge prompt into its PTY (bracketed paste)', { skip: !WIN }, () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({
    worktreeDir: wt,
    mergeKeepResult: { merged: false, parked: true, reason: 'rebase-conflict', branch: 'glissa/session/wt-sess', conflicts: ['src/a.js', 'src/b.js'] },
  });
  const writes = [];
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => capturingPty(writes) });
  try {
    s.start();
    s.state = STATES.IDLE;
    s.mergeAndContinue(); // -> parked; stores reason + conflicts for the handoff
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

test('pasteMergePrompt: refused when not parked (no stray paste into a clean session)', { skip: !WIN }, () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt });
  const writes = [];
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => capturingPty(writes) });
  try {
    s.start();
    s.state = STATES.IDLE; // not parked
    assert.deepEqual(s.pasteMergePrompt(), { ok: false, reason: 'not-parked' });
    assert.equal(writes.length, 0, 'nothing written');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('adoptWorktree re-attaches an on-disk worktree as pending-review (restart re-adoption)', { skip: !WIN }, () => {
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
    s.mergeWorktree();
    assert.equal(gw.calls.mergeBack.length, 1);
    assert.equal(gw.calls.mergeBack[0].targetBranch, 'develop');
  } finally {
    s.destroy();
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('getDiff self-heals a stranded pending-review gate to none when nothing is reviewable', { skip: !GIT }, () => {
  const repo = initOneCommitRepo();
  const s = makeSession();
  const statuses = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    s.worktreeDir = repo;          // clean one-commit repo: no committed-vs-base diff, no working changes
    s.mergeStatus = 'pending-review'; // gate stranded after the operator merged/cleaned inside the live PTY
    const d = s.getDiff();
    assert.equal(d.committed.diff.trim(), '', 'no committed diff');
    assert.equal(d.uncommitted.diff.trim(), '', 'clean working tree');
    assert.equal(s.mergeStatus, 'none', 'gate demoted to none');
    assert.deepEqual(statuses, ['none'], 'broadcast the demotion exactly once');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('getDiff keeps pending-review when the worktree still has real changes', { skip: !GIT }, () => {
  const repo = initOneCommitRepo();
  const s = makeSession();
  const statuses = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    s.worktreeDir = repo;
    s.mergeStatus = 'pending-review';
    fs.writeFileSync(path.join(repo, 'work.txt'), 'new work\n', 'utf8'); // an untracked deliverable
    const d = s.getDiff();
    assert.notEqual(d.uncommitted.diff.trim(), '', 'untracked change shows via intent-to-add');
    assert.equal(s.mergeStatus, 'pending-review', 'gate preserved while there is something to review');
    assert.deepEqual(statuses, [], 'no demotion broadcast');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('getDiff: committed range + gate come from the integration branch, not a stale baseSha', { skip: !GIT }, () => {
  const repo = initRepoDevelopFeature();
  const s = makeSession({ integrationBranch: 'develop' });
  try {
    s.worktreeDir = repo;
    s.baseSha = git(['rev-parse', 'develop'], repo).trim(); // the (correct) fork point
    const d = s.getDiff();
    assert.equal(d.hasCommits, true, 'a commit ahead of develop is mergeable');
    assert.ok(d.committed.diff.includes('feature.txt'), 'committed diff shows the ahead commit');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('getDiff: a branch already on develop shows nothing to merge despite a stale baseSha (out-of-band merge)', { skip: !GIT }, () => {
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
    const d = s.getDiff();
    assert.equal(d.hasCommits, false, 'develop already contains the work -> nothing to merge');
    assert.equal(d.committed.diff.trim(), '', 'no phantom committed diff from the stale baseSha');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

// --- checkWorktreeChange: the live change funnel (turn-end hook / gitdir watch / backstop poll) ---

test('checkWorktreeChange emits worktree-changed on a real delta and dedups an unchanged worktree', { skip: !GIT }, () => {
  const repo = initOneCommitRepo();
  const s = makeSession();
  const changes = [];
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    s.worktreeDir = repo;
    s.checkWorktreeChange();                 // null -> baseline signature: one emit
    assert.equal(changes.length, 1, 'baseline emit');
    assert.ok(changes[0].sig, 'carries a signature token');
    s.checkWorktreeChange();                 // identical state: no re-emit
    assert.equal(changes.length, 1, 'no emit when nothing changed (signature dedup)');
    fs.writeFileSync(path.join(repo, 'work.txt'), 'new\n', 'utf8'); // an untracked deliverable
    s.checkWorktreeChange();
    assert.equal(changes.length, 2, 'a working-tree change re-emits');
    assert.notEqual(changes[1].sig, changes[0].sig, 'the signature actually moved');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange detects a COMMIT (no working-tree change) via the ahead-count/HEAD signature', { skip: !GIT }, () => {
  const repo = initRepoDevelopFeature(); // HEAD = feat, one commit ahead of develop
  const s = makeSession({ integrationBranch: 'develop' });
  const changes = [];
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    s.worktreeDir = repo;
    s.checkWorktreeChange();                 // baseline
    const baseline = changes.length;
    // Commit an already-saved file: the working tree is clean afterward, so only HEAD + ahead-count move.
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'more\n', 'utf8');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'second feat'], repo);
    s.checkWorktreeChange();
    assert.equal(changes.length, baseline + 1, 'a commit moves the signature even with a clean tree');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange is suppressed while merging (index mid-rewrite)', { skip: !GIT }, () => {
  const repo = initOneCommitRepo();
  const s = makeSession();
  const changes = [];
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    s.worktreeDir = repo;
    s.mergeStatus = 'merging';
    s.checkWorktreeChange();
    assert.equal(changes.length, 0, 'no broadcast while a merge is in flight');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange live-self-heals a stranded pending-review to none over an empty worktree', { skip: !GIT }, () => {
  const repo = initOneCommitRepo(); // clean: no working changes, no integration branch -> ahead 0
  const s = makeSession();
  const statuses = [];
  const changes = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    s.worktreeDir = repo;
    s.mergeStatus = 'pending-review'; // stranded after a merge/clean inside the live PTY
    s.checkWorktreeChange();
    assert.equal(s.mergeStatus, 'none', 'gate demoted live, no manual getDiff needed');
    assert.deepEqual(statuses, ['none'], 'demotion broadcast exactly once');
    assert.equal(changes.length, 1, 'still emits a change so the selected diff refreshes to empty');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange keeps pending-review while the worktree still has real changes', { skip: !GIT }, () => {
  const repo = initOneCommitRepo();
  const s = makeSession();
  const statuses = [];
  s.on('merge-status', (e) => statuses.push(e.mergeStatus));
  try {
    s.worktreeDir = repo;
    s.mergeStatus = 'pending-review';
    fs.writeFileSync(path.join(repo, 'work.txt'), 'real work\n', 'utf8'); // something to review
    s.checkWorktreeChange();
    assert.equal(s.mergeStatus, 'pending-review', 'gate preserved while there is something to review');
    assert.deepEqual(statuses, [], 'no demotion broadcast');
  } finally { s.destroy(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('checkWorktreeChange returns UNKNOWN (no broadcast, no demotion) when the worktree is unreadable', () => {
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
    assert.equal(s._computeWorktreeSignature(), null, 'a failed git read yields null, not a false-empty signature');
    s.checkWorktreeChange();
    assert.equal(s.mergeStatus, 'pending-review', 'a git failure must NOT demote a real review gate');
    assert.deepEqual(statuses, [], 'no merge-status broadcast on a failed read');
    assert.equal(changes.length, 0, 'no worktree-changed broadcast on a failed read');
  } finally { s.destroy(); }
});

test('checkWorktreeChange is a no-op with no worktree', () => {
  const s = makeSession();
  const changes = [];
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    assert.doesNotThrow(() => s.checkWorktreeChange());
    assert.equal(changes.length, 0);
  } finally { s.destroy(); }
});

test('resetToDormant: returns to DORMANT only when settled (PTY dead + no worktree), else no-op', () => {
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

test('finishAndMerge refuses while actively RUNNING (mid-work, no merge)', () => {
  const s = makeSession();
  try {
    s.state = STATES.RUNNING;
    const r = s.finishAndMerge();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-finishable');
    assert.equal(s.state, STATES.RUNNING, 'state untouched');
  } finally { s.destroy(); }
});

test('finishAndMerge from DONE merges immediately and resets to dormant', { skip: !WIN }, () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt, mergeResult: { merged: true, branch: null } });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    s.start();              // provisions the worktree (_workspace set)
    s.kill = () => {};       // keep destroy()'s kill from invoking a real taskkill
    s.ptyProcess = null;     // simulate the PTY having exited
    s.state = STATES.DONE;
    s.mergeStatus = 'pending-review';
    const r = s.finishAndMerge();
    assert.equal(r.ok, true);
    assert.equal(gw.calls.mergeBack.length, 1, 'merged once');
    assert.equal(s.state, STATES.DORMANT, 'returned to dormant after a clean merge');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('finishAndMerge from COMPLETE ends the session, then merges + resets on exit', { skip: !WIN }, () => {
  const wt = realWorktreeDir();
  const gw = fakeGitWorkspace({ worktreeDir: wt, mergeResult: { merged: true, branch: null } });
  const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
  try {
    s.start();
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
    s._settleWorktreeOnExit();
    s.ptyProcess = null;
    s.emit('exit', { exitCode: 0 });
    assert.equal(gw.calls.mergeBack.length, 1, 'merged after the exit settled the worktree');
    assert.equal(s.state, STATES.DORMANT, 'returned to dormant');
  } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('_settleWorktreeOnExit: a changed worktree -> pending-review; an unchanged one -> silent discard', { skip: !WIN }, () => {
  { // changed
    const wt = realWorktreeDir();
    const gw = fakeGitWorkspace({ worktreeDir: wt });
    const s = makeSession({ gitWorkspace: gw, integrationBranch: 'develop', ptySpawn: () => fakePty() });
    try {
      s.start();
      s.hasChanges = () => true; // stub the porcelain probe
      s.state = STATES.DONE;     // simulate a real PTY exit
      s._settleWorktreeOnExit();
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
      s.start();
      s.hasChanges = () => false;
      s.state = STATES.DONE;
      s._settleWorktreeOnExit();
      assert.equal(s.mergeStatus, 'none');
      assert.equal(s.worktreeDir, null, 'empty worktree auto-discarded');
      assert.equal(gw.calls.discard.length, 1);
    } finally { s.destroy(); fs.rmSync(wt, { recursive: true, force: true }); }
  }
});
