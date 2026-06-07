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

const { Session } = require('../sessions');
const { STATES } = require('../shared/states');
const WIN = process.platform === 'win32';

function fakePty(pid = 2147483646) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

// A real temp dir so the spawn_success guard (fs.existsSync on the worktree) passes.
function realWorktreeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-wt-fake-'));
}

function fakeGitWorkspace(opts = {}) {
  const calls = { create: [], mergeBack: [], discard: [] };
  return {
    calls,
    create(args) {
      calls.create.push(args);
      if (opts.createResult) return opts.createResult;
      return { cwd: opts.worktreeDir, isGit: true, branch: `glissa/session/${args.label}`, base: args.baseBranch, baseSha: 'basesha' };
    },
    mergeBack(args) { calls.mergeBack.push(args); return opts.mergeResult || { merged: true, branch: null }; },
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

test('start() BLOCKS when the integration branch is missing — stays DORMANT, no spawn, notice set', () => {
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
