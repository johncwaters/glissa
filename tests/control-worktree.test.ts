// Control-WS dispatch for the worktree review gate: merge-session / discard-session-worktree delegate
// to the Session, and request-session-diff replies with the session's diff. Session behavior itself is
// covered in sessions-worktree.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import type { ControlConnection } from './helpers/control-harness.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';
import { plainSession } from './helpers/fake-session.ts';

interface WorktreeFrame {
  type: string;
  id?: string;
  session?: string;
  message?: string;
  committed?: unknown;
  uncommitted?: unknown;
  hasCommits?: boolean;
  branch?: string;
  upstream?: string;
  state?: string;
  ahead?: number;
  behind?: number;
  fetched?: boolean;
  action?: string;
  error?: string | null;
}

function harness(sessions: Map<string, Session>): ControlConnection<WorktreeFrame> {
  const server = createControlServer(controlDeps({ projects: [] }, { sessions }));
  const connection = connectControl<WorktreeFrame>(server);
  connection.sent.length = 0; // drop the connect preamble
  return connection;
}

function oneSession(session: Session): Map<string, Session> {
  return new Map([[session.id, session]]);
}

test('merge-session dispatches to session.mergeWorktree()', () => {
  let merges = 0;
  const s = plainSession('p1');
  s.mergeWorktree = async () => { merges += 1; return { merged: true }; };
  const h = harness(oneSession(s));
  h.send({ type: 'merge-session', id: 'p1' });
  assert.equal(merges, 1);
});

test('discard-session-worktree dispatches to session.discardWorktree()', () => {
  let discards = 0;
  const s = plainSession('p1');
  s.discardWorktree = async () => { discards += 1; };
  const h = harness(oneSession(s));
  h.send({ type: 'discard-session-worktree', id: 'p1' });
  assert.equal(discards, 1);
});

test('request-session-diff replies with the committed + uncommitted diff and the merge gate', async () => {
  let diffs = 0;
  const s = plainSession('p1');
  s.getDiff = async () => {
    diffs += 1;
    return {
      committed: { stat: ' f.js | 1 +', diff: '+x\n' },
      uncommitted: { stat: ' g.js | 1 +', diff: '+y\n' },
      hasCommits: true,
    };
  };
  const h = harness(oneSession(s));
  // The handler is async (getDiff shells out to git), so the reply is sent on a later tick; the
  // dispatcher returns the handler promise through the harness so we can await it before asserting.
  await h.send({ type: 'request-session-diff', id: 'p1' });
  const msg = h.sent.find((m) => m.type === 'session-diff');
  assert.ok(msg, 'sent a session-diff message');
  assert.equal(msg.id, 'p1');
  assert.deepEqual(msg.committed, { stat: ' f.js | 1 +', diff: '+x\n' });
  assert.deepEqual(msg.uncommitted, { stat: ' g.js | 1 +', diff: '+y\n' });
  assert.equal(msg.hasCommits, true);
  assert.equal(diffs, 1);
});

test('merge-session on an unknown session is a no-op (no throw)', () => {
  const h = harness(new Map());
  assert.doesNotThrow(() => h.send({ type: 'merge-session', id: 'nope' }));
});

test("request-branch-sync replies with the session's branch sync status", async () => {
  let syncs = 0;
  const s = plainSession('p1');
  s.getBranchSync = async () => {
    syncs += 1;
    return { branch: 'develop', upstream: 'origin/develop', state: 'ahead', ahead: 2, behind: 0, fetched: true, action: 'none', error: null };
  };
  const h = harness(oneSession(s));
  await h.send({ type: 'request-branch-sync', id: 'p1' });
  const msg = h.sent.find((m) => m.type === 'branch-sync-status');
  assert.ok(msg, 'sent a branch-sync-status message');
  assert.equal(msg.id, 'p1');
  assert.equal(msg.branch, 'develop');
  assert.equal(msg.upstream, 'origin/develop');
  assert.equal(msg.state, 'ahead');
  assert.equal(msg.ahead, 2);
  assert.equal(msg.behind, 0);
  assert.equal(msg.fetched, true);
  assert.equal(syncs, 1);
});

test('request-branch-sync on an unknown session is a no-op (no throw)', () => {
  const h = harness(new Map());
  assert.doesNotThrow(() => h.send({ type: 'request-branch-sync', id: 'nope' }));
});

test("resync-branch replies with the session's post-resync branch sync status, including action/error", async () => {
  let resyncs = 0;
  const s = plainSession('p1');
  s.resyncBranch = async () => {
    resyncs += 1;
    return { branch: 'develop', upstream: 'origin/develop', state: 'in-sync', ahead: 0, behind: 0, fetched: true, action: 'pushed', error: null };
  };
  const h = harness(oneSession(s));
  await h.send({ type: 'resync-branch', id: 'p1' });
  const msg = h.sent.find((m) => m.type === 'branch-sync-status');
  assert.ok(msg, 'sent a branch-sync-status message');
  assert.equal(msg.id, 'p1');
  assert.equal(msg.state, 'in-sync');
  assert.equal(msg.action, 'pushed');
  assert.equal(msg.error, null);
  assert.equal(resyncs, 1);
});

test('resync-branch on an unknown session is a no-op (no throw)', () => {
  const h = harness(new Map());
  assert.doesNotThrow(() => h.send({ type: 'resync-branch', id: 'nope' }));
});

// --- finish-session: one-click close-out delegates to Session.finishAndMerge (logic tested there) ---

test('finish-session dispatches to session.finishAndMerge()', () => {
  let finished = 0;
  const s = plainSession('p1');
  s.finishAndMerge = () => { finished += 1; return { ok: true }; };
  const h = harness(oneSession(s));
  h.send({ type: 'finish-session', id: 'p1' });
  assert.equal(finished, 1);
});

test('finish-session on an unknown session is a no-op (no throw)', () => {
  const h = harness(new Map());
  assert.doesNotThrow(() => h.send({ type: 'finish-session', id: 'nope' }));
});

// --- merge-continue-session: merge-as-you-go delegates to Session.mergeAndContinue (logic tested there) ---

test('merge-continue-session dispatches to session.mergeAndContinue()', () => {
  let merged = 0;
  const s = plainSession('p1');
  s.mergeAndContinue = async () => { merged += 1; return { merged: true, kept: true }; };
  const h = harness(oneSession(s));
  h.send({ type: 'merge-continue-session', id: 'p1' });
  assert.equal(merged, 1);
});

test('merge-continue-session on an unknown session is a no-op (no throw)', () => {
  const h = harness(new Map());
  assert.doesNotThrow(() => h.send({ type: 'merge-continue-session', id: 'nope' }));
});

test('merge-continue-session with force:true passes { force: true } through to session.mergeAndContinue()', () => {
  const calls: { force?: boolean }[] = [];
  const s = plainSession('p1');
  s.mergeAndContinue = async (options = {}) => { calls.push(options); return { merged: true, kept: true }; };
  const h = harness(oneSession(s));
  h.send({ type: 'merge-continue-session', id: 'p1', force: true });
  assert.deepEqual(calls, [{ force: true }]);
});

// --- refused merges reply to the requesting client (a silent guard refusal gave zero feedback) ---

test('merge-continue-session replies session-error when a pre-merge guard refuses', async () => {
  const s = plainSession('p1', 'worker');
  s.state = STATES.DONE;
  s.mergeAndContinue = async () => ({ merged: false, refused: true, reason: 'not-continuable' });
  const h = harness(oneSession(s));
  await h.send({ type: 'merge-continue-session', id: 'p1', force: true });
  const err = h.sent.find((m) => m.type === 'session-error');
  assert.ok(err, 'refusal replied to the requesting client');
  assert.equal(err.id, 'p1');
  assert.equal(err.session, 'worker');
  assert.match(String(err.message), /Merge refused: session state DONE is not mergeable/);
});

test('merge-session replies session-error when a merge is already in flight', async () => {
  const s = plainSession('p1');
  s.state = STATES.DONE;
  s.mergeWorktree = async () => ({ merged: false, refused: true, reason: 'merge-in-progress' });
  const h = harness(oneSession(s));
  await h.send({ type: 'merge-session', id: 'p1' });
  const err = h.sent.find((m) => m.type === 'session-error');
  assert.ok(err, 'refusal replied to the requesting client');
  assert.match(String(err.message), /Merge refused: a merge is already in flight/);
});

test('a merge that proceeds (or fails past the guards) sends no session-error reply', async () => {
  const s = plainSession('p1');
  s.mergeAndContinue = async () => ({ merged: false, reason: 'rebase-conflict', parked: true });
  const h = harness(oneSession(s));
  await h.send({ type: 'merge-continue-session', id: 'p1' });
  assert.equal(h.sent.find((m) => m.type === 'session-error'), undefined,
    'parked/failed merges already broadcast merge-status; no refusal reply');
});

test('merge-continue-session without force sends { force: false } (a truthy-but-not-true value never forces)', () => {
  const calls: { force?: boolean }[] = [];
  const s = plainSession('p1');
  s.mergeAndContinue = async (options = {}) => { calls.push(options); return { merged: true, kept: true }; };
  const h = harness(oneSession(s));
  h.send({ type: 'merge-continue-session', id: 'p1' });
  h.send({ type: 'merge-continue-session', id: 'p1', force: 'yes' });
  assert.deepEqual(calls, [{ force: false }, { force: false }]);
});
