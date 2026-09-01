// carryWorktreeAcrossRecreate: a config modify (path/permission change) replaces the Session object
// via _modifyChangedSessions, but destroy() leaves the old instance's worktree checked out on the
// session branch. The carry-over must hand the worktree to the new Session (same path) or settle it
// (path changed) so the recreated session never trips branch-in-use against its own surviving branch
// and silently runs in place. Driven directly with real Sessions whose worktree seams are replaced
// (module-level export, same pattern as decideWasActiveFlip / runAutoResume in
// backend-auto-resume.test.ts).

import test from 'node:test';
import assert from 'node:assert/strict';

import { carryWorktreeAcrossRecreate, shouldStartAfterModify } from '../server/backend.ts';
import { STATES } from '../shared/states.ts';
import { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';

type AdoptOptions = Parameters<Session['adoptWorktree']>[0];

interface WorktreeCarry {
  cwd: string;
  isGit: boolean;
  branch: string;
  base: string;
}

interface OldSessionFixture {
  session: Session;
  calls: { settleChecks: number; discard: number };
}

interface NewSessionFixture {
  session: Session;
  adopted: AdoptOptions[];
}

function sessionAt(id: string, projectPath: string): Session {
  return new Session({ id, name: id, path: projectPath, ptySpawn: () => fakePty() });
}

// `unmergedWork` names WHY the tree still holds work - 'dirty' (uncommitted changes) or 'committed'
// (a clean tree whose branch is ahead of the integration branch, the shape that used to be discarded
// with its commits) - and null means there is nothing to keep.
function fakeOldSession({ path: projectPath = 'C:/proj', worktreeDir = 'C:/wts/proj-abc', workspace, killReap, unmergedWork = null }: {
  path?: string;
  worktreeDir?: string | null;
  workspace?: WorktreeCarry | null;
  killReap?: Promise<void>;
  unmergedWork?: string | null;
} = {}): OldSessionFixture {
  const calls = { settleChecks: 0, discard: 0 };
  const session = sessionAt('old', projectPath);
  const carry: WorktreeCarry | null = workspace === undefined
    ? { cwd: worktreeDir ?? '', isGit: true, branch: 'glissa/session/sess-1', base: 'develop' }
    : workspace;
  session._killReap = killReap ?? null;
  session.getWorktreeCarry = () => {
    if (!worktreeDir || !carry) return null;
    return { worktreeDir, branch: carry.branch, base: carry.base };
  };
  // Mirrors Session.discardWorktreeIfClean's contract: any unmerged work -> kept (false), an empty
  // worktree -> discarded (true).
  session.discardWorktreeIfClean = async () => {
    calls.settleChecks += 1;
    if (unmergedWork) return false;
    calls.discard += 1;
    return true;
  };
  return { session, calls };
}

function fakeNewSession(projectPath = 'C:/proj'): NewSessionFixture {
  const adopted: AdoptOptions[] = [];
  const session = sessionAt('new', projectPath);
  session.adoptWorktree = (args: AdoptOptions) => { adopted.push(args); };
  return { session, adopted };
}

test('same path: the new session adopts the surviving worktree (dir, branch, base carried)', () => {
  const oldSess = fakeOldSession();
  const newSess = fakeNewSession('C:/proj');
  carryWorktreeAcrossRecreate(oldSess.session, newSess.session);
  assert.equal(newSess.adopted.length, 1, 'adopted once');
  assert.deepEqual(newSess.adopted[0], {
    worktreeDir: 'C:/wts/proj-abc',
    branch: 'glissa/session/sess-1',
    base: 'develop',
  });
  assert.equal(oldSess.calls.discard, 0, 'nothing discarded');
});

test('path changed + clean worktree: discarded after the kill reap settles, never adopted', async () => {
  const release: { resolve: (() => void) | null } = { resolve: null };
  const reap = new Promise<void>((resolve) => { release.resolve = resolve; });
  const oldSess = fakeOldSession({ path: 'C:/old-proj', killReap: reap, unmergedWork: null });
  const newSess = fakeNewSession('C:/new-proj');
  const settled = carryWorktreeAcrossRecreate(oldSess.session, newSess.session);
  assert.equal(newSess.adopted.length, 0, 'a foreign-repo worktree is never adopted');
  assert.equal(oldSess.calls.discard, 0, 'discard waits for the PTY kill reap (Windows cwd lock)');
  assert.ok(release.resolve, 'the reap gate is armed');
  release.resolve();
  await settled;
  assert.equal(oldSess.calls.discard, 1, 'clean worktree discarded once the reap settled');
});

test('path changed + dirty worktree: left on disk untouched (no data loss)', async () => {
  const oldSess = fakeOldSession({ path: 'C:/old-proj', unmergedWork: 'dirty' });
  const newSess = fakeNewSession('C:/new-proj');
  await carryWorktreeAcrossRecreate(oldSess.session, newSess.session);
  assert.equal(newSess.adopted.length, 0);
  assert.equal(oldSess.calls.settleChecks, 1, 'work test consulted');
  assert.equal(oldSess.calls.discard, 0, 'unmerged work is never destroyed');
});

// The committed-but-clean shape: the session committed, so `git status --porcelain` is empty, but the
// branch is ahead of the integration branch. Discarding here deletes the branch and with it the only
// ref to those commits, so the carry-over must keep the worktree exactly as the dirty case does.
test('path changed + committed-but-clean worktree: kept on disk (commits are work too)', async () => {
  const oldSess = fakeOldSession({ path: 'C:/old-proj', unmergedWork: 'committed' });
  const newSess = fakeNewSession('C:/new-proj');
  await carryWorktreeAcrossRecreate(oldSess.session, newSess.session);
  assert.equal(newSess.adopted.length, 0);
  assert.equal(oldSess.calls.settleChecks, 1, 'work test consulted');
  assert.equal(oldSess.calls.discard, 0, 'a committed branch is never deleted by the carry-over');
});

test('a casing-only path difference still adopts on win32 (case-insensitive filesystem)', { skip: process.platform !== 'win32' }, () => {
  const oldSess = fakeOldSession({ path: 'C:/Proj' });
  const newSess = fakeNewSession('c:/proj');
  carryWorktreeAcrossRecreate(oldSess.session, newSess.session);
  assert.equal(newSess.adopted.length, 1, 'same physical directory: adopted, not settled as a repo change');
  assert.equal(oldSess.calls.discard, 0);
});

test('no surviving worktree (in-place or already settled): a no-op', () => {
  const bare = fakeOldSession({ worktreeDir: null, workspace: null });
  const newSess = fakeNewSession();
  carryWorktreeAcrossRecreate(bare.session, newSess.session);
  carryWorktreeAcrossRecreate(null, newSess.session);
  assert.equal(newSess.adopted.length, 0);
});

test('path changed: a rejecting kill reap still settles the carry without throwing', async () => {
  const oldSess = fakeOldSession({
    path: 'C:/old-proj',
    killReap: Promise.reject(new Error('taskkill lost')),
    unmergedWork: null,
  });
  const newSess = fakeNewSession('C:/new-proj');
  await assert.doesNotReject(() => Promise.resolve(carryWorktreeAcrossRecreate(oldSess.session, newSess.session)));
  assert.equal(oldSess.calls.discard, 1, 'reap rejection is swallowed, discard still runs');
});

// -- shouldStartAfterModify --
// A config reload that replaced a session's record decides here whether to (re)start it. Ticking a Mill
// tab checkbox goes through the same reload, so a DORMANT card must come back dormant rather than
// spawning a Claude session (with that project's dangerouslySkipPermissions) nobody asked for.

test('a DORMANT session is recreated without being started', () => {
  assert.equal(shouldStartAfterModify(STATES.DORMANT), false);
});

test('every live state keeps the documented recreate-and-restart behavior', () => {
  for (const state of Object.values(STATES)) {
    if (state === STATES.DORMANT) continue;
    assert.equal(shouldStartAfterModify(state), true, state);
  }
});
