'use strict';

// Control-WS dispatch for the worktree review gate: merge-session / discard-session-worktree delegate
// to the Session, and request-session-diff replies with the session's diff. Mirrors the fake-controlWss
// harness used by team-control.test.js. Session behavior itself is covered in sessions-worktree.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../server/control-handlers');

function harness(sessions) {
  const controlWss = new EventEmitter();
  const sent = [];
  let messageHandler = null;
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: (ev, h) => { if (ev === 'message') messageHandler = h; } };
  registerControlHandlers(controlWss, {
    sessions,
    config: { projects: [], teams: [] },
    configStore: { save: (fn) => fn({ projects: [] }), getSettings: () => ({}) },
    broadcastControl: () => {},
  });
  controlWss.emit('connection', ws);
  sent.length = 0; // drop the initial snapshot
  return { send: (msg) => messageHandler(JSON.stringify(msg)), sent };
}

function fakeSession(id) {
  return {
    id, name: id, ephemeral: false,
    calls: { merge: 0, discard: 0, diff: 0, branchSync: 0 },
    mergeWorktree() { this.calls.merge++; return { merged: true }; },
    discardWorktree() { this.calls.discard++; },
    getDiff() {
      this.calls.diff++;
      return {
        committed: { stat: ' f.js | 1 +', diff: '+x\n' },
        uncommitted: { stat: ' g.js | 1 +', diff: '+y\n' },
        hasCommits: true,
      };
    },
    getBranchSync() {
      this.calls.branchSync++;
      return { branch: 'develop', upstream: 'origin/develop', state: 'ahead', ahead: 2, behind: 0, fetched: true };
    },
    resyncBranch() {
      this.calls.resync = (this.calls.resync || 0) + 1;
      return { branch: 'develop', upstream: 'origin/develop', state: 'in-sync', ahead: 0, behind: 0, fetched: true, action: 'pushed', error: null };
    },
    toSnapshot() { return { id: this.id, name: this.name }; },
  };
}

test('merge-session dispatches to session.mergeWorktree()', () => {
  const s = fakeSession('p1');
  const h = harness(new Map([['p1', s]]));
  h.send({ type: 'merge-session', id: 'p1' });
  assert.equal(s.calls.merge, 1);
});

test('discard-session-worktree dispatches to session.discardWorktree()', () => {
  const s = fakeSession('p1');
  const h = harness(new Map([['p1', s]]));
  h.send({ type: 'discard-session-worktree', id: 'p1' });
  assert.equal(s.calls.discard, 1);
});

test('request-session-diff replies with the committed + uncommitted diff and the merge gate', async () => {
  const s = fakeSession('p1');
  const h = harness(new Map([['p1', s]]));
  // The handler is async now (getDiff shells out to git), so the reply is sent on a later tick; the
  // dispatcher returns the handler promise through the harness so we can await it before asserting.
  await h.send({ type: 'request-session-diff', id: 'p1' });
  const msg = h.sent.find((m) => m.type === 'session-diff');
  assert.ok(msg, 'sent a session-diff message');
  assert.equal(msg.id, 'p1');
  assert.deepEqual(msg.committed, { stat: ' f.js | 1 +', diff: '+x\n' });
  assert.deepEqual(msg.uncommitted, { stat: ' g.js | 1 +', diff: '+y\n' });
  assert.equal(msg.hasCommits, true);
  assert.equal(s.calls.diff, 1);
});

test('merge-session on an unknown session is a no-op (no throw)', () => {
  const h = harness(new Map());
  assert.doesNotThrow(() => h.send({ type: 'merge-session', id: 'nope' }));
});

test('request-branch-sync replies with the session\'s branch sync status', async () => {
  const s = fakeSession('p1');
  const h = harness(new Map([['p1', s]]));
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
  assert.equal(s.calls.branchSync, 1);
});

test('request-branch-sync on an unknown session is a no-op (no throw)', () => {
  const h = harness(new Map());
  assert.doesNotThrow(() => h.send({ type: 'request-branch-sync', id: 'nope' }));
});

test('resync-branch replies with the session\'s post-resync branch sync status, including action/error', async () => {
  const s = fakeSession('p1');
  const h = harness(new Map([['p1', s]]));
  await h.send({ type: 'resync-branch', id: 'p1' });
  const msg = h.sent.find((m) => m.type === 'branch-sync-status');
  assert.ok(msg, 'sent a branch-sync-status message');
  assert.equal(msg.id, 'p1');
  assert.equal(msg.state, 'in-sync');
  assert.equal(msg.action, 'pushed');
  assert.equal(msg.error, null);
  assert.equal(s.calls.resync, 1);
});

test('resync-branch on an unknown session is a no-op (no throw)', () => {
  const h = harness(new Map());
  assert.doesNotThrow(() => h.send({ type: 'resync-branch', id: 'nope' }));
});

// --- finish-session: one-click close-out delegates to Session.finishAndMerge (logic tested there) ---

test('finish-session dispatches to session.finishAndMerge()', () => {
  let finished = 0;
  const s = {
    id: 'p1', name: 'p1', ephemeral: false,
    finishAndMerge() { finished++; return { ok: true }; },
    toSnapshot() { return { id: this.id, name: this.name }; },
  };
  const h = harness(new Map([['p1', s]]));
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
  const s = {
    id: 'p1', name: 'p1', ephemeral: false,
    mergeAndContinue() { merged++; return { merged: true, kept: true }; },
    toSnapshot() { return { id: this.id, name: this.name }; },
  };
  const h = harness(new Map([['p1', s]]));
  h.send({ type: 'merge-continue-session', id: 'p1' });
  assert.equal(merged, 1);
});

test('merge-continue-session on an unknown session is a no-op (no throw)', () => {
  const h = harness(new Map());
  assert.doesNotThrow(() => h.send({ type: 'merge-continue-session', id: 'nope' }));
});

test('merge-continue-session with force:true passes { force: true } through to session.mergeAndContinue()', () => {
  const calls = [];
  const s = {
    id: 'p1', name: 'p1', ephemeral: false,
    mergeAndContinue(opts) { calls.push(opts); return { merged: true, kept: true }; },
    toSnapshot() { return { id: this.id, name: this.name }; },
  };
  const h = harness(new Map([['p1', s]]));
  h.send({ type: 'merge-continue-session', id: 'p1', force: true });
  assert.deepEqual(calls, [{ force: true }]);
});

// --- refused merges reply to the requesting client (a silent guard refusal gave zero feedback) ---

test('merge-continue-session replies session-error when a pre-merge guard refuses', async () => {
  const s = {
    id: 'p1', name: 'worker', ephemeral: false, state: 'DONE',
    mergeAndContinue() { return { merged: false, refused: true, reason: 'not-continuable' }; },
    toSnapshot() { return { id: this.id, name: this.name }; },
  };
  const h = harness(new Map([['p1', s]]));
  await h.send({ type: 'merge-continue-session', id: 'p1', force: true });
  const err = h.sent.find((m) => m.type === 'session-error');
  assert.ok(err, 'refusal replied to the requesting client');
  assert.equal(err.id, 'p1');
  assert.equal(err.session, 'worker');
  assert.match(err.message, /Merge refused: session state DONE is not mergeable/);
});

test('merge-session replies session-error when a merge is already in flight', async () => {
  const s = {
    id: 'p1', name: 'p1', ephemeral: false, state: 'DONE',
    mergeWorktree() { return { merged: false, refused: true, reason: 'merge-in-progress' }; },
    toSnapshot() { return { id: this.id, name: this.name }; },
  };
  const h = harness(new Map([['p1', s]]));
  await h.send({ type: 'merge-session', id: 'p1' });
  const err = h.sent.find((m) => m.type === 'session-error');
  assert.ok(err, 'refusal replied to the requesting client');
  assert.match(err.message, /Merge refused: a merge is already in flight/);
});

test('a merge that proceeds (or fails past the guards) sends no session-error reply', async () => {
  const s = {
    id: 'p1', name: 'p1', ephemeral: false, state: 'IDLE',
    mergeAndContinue() { return { merged: false, reason: 'rebase-conflict', parked: true }; },
    toSnapshot() { return { id: this.id, name: this.name }; },
  };
  const h = harness(new Map([['p1', s]]));
  await h.send({ type: 'merge-continue-session', id: 'p1' });
  assert.equal(h.sent.find((m) => m.type === 'session-error'), undefined,
    'parked/failed merges already broadcast merge-status; no refusal reply');
});

test('merge-continue-session without force sends { force: false } (a truthy-but-not-true value never forces)', () => {
  const calls = [];
  const s = {
    id: 'p1', name: 'p1', ephemeral: false,
    mergeAndContinue(opts) { calls.push(opts); return { merged: true, kept: true }; },
    toSnapshot() { return { id: this.id, name: this.name }; },
  };
  const h = harness(new Map([['p1', s]]));
  h.send({ type: 'merge-continue-session', id: 'p1' });
  h.send({ type: 'merge-continue-session', id: 'p1', force: 'yes' });
  assert.deepEqual(calls, [{ force: false }, { force: false }]);
});
