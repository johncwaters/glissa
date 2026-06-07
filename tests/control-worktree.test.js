'use strict';

// Control-WS dispatch for the worktree review gate: merge-session / discard-session-worktree delegate
// to the Session, and request-session-diff replies with the session's diff. Mirrors the fake-controlWss
// harness used by team-control.test.js. Session behavior itself is covered in sessions-worktree.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../control-handlers');
const { STATES } = require('../shared/states');

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
    getDiff() { this.calls.diff++; return { stat: ' f.js | 1 +', diff: '+x\n' }; },
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

test('request-session-diff replies with the session diff (stat + diff)', () => {
  const s = fakeSession('p1');
  const h = harness(new Map([['p1', s]]));
  h.send({ type: 'request-session-diff', id: 'p1' });
  const msg = h.sent.find((m) => m.type === 'session-diff');
  assert.ok(msg, 'sent a session-diff message');
  assert.equal(msg.id, 'p1');
  assert.equal(msg.stat, ' f.js | 1 +');
  assert.equal(msg.diff, '+x\n');
  assert.equal(s.calls.diff, 1);
});

test('merge-session on an unknown session is a no-op (no throw)', () => {
  const h = harness(new Map());
  assert.doesNotThrow(() => h.send({ type: 'merge-session', id: 'nope' }));
});

// --- finish-session: one-click close-out (merge, then reset-to-dormant ONLY on a clean merge) ---

function fakeFinishSession(id, { state = STATES.DONE, mergeResult = { merged: true } } = {}) {
  return {
    id, name: id, ephemeral: false, state,
    calls: { merge: 0, reset: 0 },
    mergeWorktree() { this.calls.merge++; return mergeResult; },
    resetToDormant() { this.calls.reset++; return true; },
    toSnapshot() { return { id: this.id, name: this.name }; },
  };
}

test('finish-session on a DONE session with a clean merge merges then resets to dormant', () => {
  const s = fakeFinishSession('p1', { state: STATES.DONE, mergeResult: { merged: true } });
  const h = harness(new Map([['p1', s]]));
  h.send({ type: 'finish-session', id: 'p1' });
  assert.equal(s.calls.merge, 1, 'merged once');
  assert.equal(s.calls.reset, 1, 'reset once after a clean merge');
});

test('finish-session does NOT reset when the merge parks (worktree preserved)', () => {
  const s = fakeFinishSession('p1', { state: STATES.DONE, mergeResult: { merged: false, parked: true } });
  const h = harness(new Map([['p1', s]]));
  h.send({ type: 'finish-session', id: 'p1' });
  assert.equal(s.calls.merge, 1, 'merge attempted');
  assert.equal(s.calls.reset, 0, 'never reset on a parked merge');
});

test('finish-session refuses to merge while the PTY is alive (state not DONE/FAILED)', () => {
  const s = fakeFinishSession('p1', { state: STATES.COMPLETE });
  const h = harness(new Map([['p1', s]]));
  h.send({ type: 'finish-session', id: 'p1' });
  assert.equal(s.calls.merge, 0, 'no merge attempted on a live session');
  assert.equal(s.calls.reset, 0);
});

test('finish-session merges a FAILED session too (settled, PTY dead)', () => {
  const s = fakeFinishSession('p1', { state: STATES.FAILED, mergeResult: { merged: true } });
  const h = harness(new Map([['p1', s]]));
  h.send({ type: 'finish-session', id: 'p1' });
  assert.equal(s.calls.merge, 1);
  assert.equal(s.calls.reset, 1);
});

test('finish-session on an unknown session is a no-op (no throw)', () => {
  const h = harness(new Map());
  assert.doesNotThrow(() => h.send({ type: 'finish-session', id: 'nope' }));
});
