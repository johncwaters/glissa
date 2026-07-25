'use strict';

// carryWorktreeAcrossRecreate: a config modify (path/permission change) replaces the Session object
// via _modifyChangedSessions, but destroy() leaves the old instance's worktree checked out on the
// session branch. The carry-over must hand the worktree to the new Session (same path) or settle it
// (path changed) so the recreated session never trips branch-in-use against its own surviving branch
// and silently runs in place. Driven directly with fake sessions (module-level export, same pattern
// as decideWasActiveFlip / runAutoResume in backend-auto-resume.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const { carryWorktreeAcrossRecreate } = require('../server/backend');

function fakeOldSession({ path: projectPath = 'C:/proj', worktreeDir = 'C:/wts/proj-abc', workspace, killReap, hasChanges = false } = {}) {
  const calls = { settleChecks: 0, discard: 0 };
  return {
    calls,
    path: projectPath,
    worktreeDir,
    _workspace: workspace === undefined
      ? { cwd: worktreeDir, isGit: true, branch: 'glissa/session/sess-1', base: 'develop' }
      : workspace,
    _killReap: killReap,
    // Mirrors Session.discardWorktreeIfClean's contract: dirty -> kept (false), clean -> discarded (true).
    async discardWorktreeIfClean() {
      calls.settleChecks += 1;
      if (hasChanges) return false;
      calls.discard += 1;
      return true;
    },
  };
}

function fakeNewSession(projectPath = 'C:/proj') {
  const adopted = [];
  return { adopted, path: projectPath, adoptWorktree(args) { adopted.push(args); } };
}

test('same path: the new session adopts the surviving worktree (dir, branch, base carried)', () => {
  const oldSess = fakeOldSession();
  const newSess = fakeNewSession('C:/proj');
  carryWorktreeAcrossRecreate(oldSess, newSess);
  assert.equal(newSess.adopted.length, 1, 'adopted once');
  assert.deepEqual(newSess.adopted[0], {
    worktreeDir: 'C:/wts/proj-abc',
    branch: 'glissa/session/sess-1',
    base: 'develop',
  });
  assert.equal(oldSess.calls.discard, 0, 'nothing discarded');
});

test('path changed + clean worktree: discarded after the kill reap settles, never adopted', async () => {
  let releaseReap;
  const reap = new Promise((resolve) => { releaseReap = resolve; });
  const oldSess = fakeOldSession({ path: 'C:/old-proj', killReap: reap, hasChanges: false });
  const newSess = fakeNewSession('C:/new-proj');
  const settled = carryWorktreeAcrossRecreate(oldSess, newSess);
  assert.equal(newSess.adopted.length, 0, 'a foreign-repo worktree is never adopted');
  assert.equal(oldSess.calls.discard, 0, 'discard waits for the PTY kill reap (Windows cwd lock)');
  releaseReap();
  await settled;
  assert.equal(oldSess.calls.discard, 1, 'clean worktree discarded once the reap settled');
});

test('path changed + dirty worktree: left on disk untouched (no data loss)', async () => {
  const oldSess = fakeOldSession({ path: 'C:/old-proj', hasChanges: true });
  const newSess = fakeNewSession('C:/new-proj');
  await carryWorktreeAcrossRecreate(oldSess, newSess);
  assert.equal(newSess.adopted.length, 0);
  assert.equal(oldSess.calls.settleChecks, 1, 'dirty test consulted');
  assert.equal(oldSess.calls.discard, 0, 'unmerged work is never destroyed');
});

test('a casing-only path difference still adopts on win32 (case-insensitive filesystem)', { skip: process.platform !== 'win32' }, () => {
  const oldSess = fakeOldSession({ path: 'C:/Proj' });
  const newSess = fakeNewSession('c:/proj');
  carryWorktreeAcrossRecreate(oldSess, newSess);
  assert.equal(newSess.adopted.length, 1, 'same physical directory: adopted, not settled as a repo change');
  assert.equal(oldSess.calls.discard, 0);
});

test('no surviving worktree (in-place or already settled): a no-op', () => {
  const bare = fakeOldSession({ worktreeDir: null, workspace: null });
  const newSess = fakeNewSession();
  carryWorktreeAcrossRecreate(bare, newSess);
  carryWorktreeAcrossRecreate(null, newSess);
  assert.equal(newSess.adopted.length, 0);
});

test('path changed: a rejecting kill reap still settles the carry without throwing', async () => {
  const oldSess = fakeOldSession({ path: 'C:/old-proj', killReap: Promise.reject(new Error('taskkill lost')), hasChanges: false });
  const newSess = fakeNewSession('C:/new-proj');
  await assert.doesNotReject(() => carryWorktreeAcrossRecreate(oldSess, newSess));
  assert.equal(oldSess.calls.discard, 1, 'reap rejection is swallowed, discard still runs');
});
