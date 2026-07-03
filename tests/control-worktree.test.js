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
    calls: { merge: 0, discard: 0, diff: 0 },
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

// --- park-session: return-to-DORMANT delegates to Session.parkToDormant (logic tested there) ---

test('park-session dispatches to session.parkToDormant()', () => {
  let parked = 0;
  const s = {
    id: 'p1', name: 'p1', ephemeral: false, state: 'COMPLETE',
    parkToDormant() { parked++; return { ok: true, pending: true }; },
    toSnapshot() { return { id: this.id, name: this.name }; },
  };
  const h = harness(new Map([['p1', s]]));
  h.send({ type: 'park-session', id: 'p1' });
  assert.equal(parked, 1);
});

test('park-session on an unknown session is a no-op (no throw)', () => {
  const h = harness(new Map());
  assert.doesNotThrow(() => h.send({ type: 'park-session', id: 'nope' }));
});
