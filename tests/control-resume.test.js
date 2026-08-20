'use strict';

// Control-WS dispatch for the per-card resume binding: resume-conversation persists resumeSessionId on
// the project record, sets it on the live Session, and broadcasts/acks. Validation rejects unsafe ids.
// (The list-conversations handler shells out to git + reads ~/.claude and is covered at the discovery
// layer in conversation-history.test.js, so it is not re-exercised here.) Mirrors the fake-controlWss
// harness used by control-worktree.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../server/control-handlers');

function harness(sessions, cfg) {
  const controlWss = new EventEmitter();
  const sent = [];
  const broadcasts = [];
  const saveCalls = [];
  let messageHandler = null;
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: (ev, h) => { if (ev === 'message') messageHandler = h; } };
  registerControlHandlers(controlWss, {
    sessions,
    config: cfg,
    configStore: {
      save: (fn) => { saveCalls.push(1); fn(cfg); return cfg; },
      getSettings: () => ({}),
    },
    applyConfigReload: () => {},
    broadcastControl: (m) => broadcasts.push(m),
  });
  controlWss.emit('connection', ws);
  sent.length = 0; // drop the initial snapshot
  return { send: (msg) => messageHandler(JSON.stringify(msg)), sent, broadcasts, saveCalls };
}

function fakeSession(id) {
  let resume = null;
  return {
    id, name: id, path: 'C:/repo', ephemeral: false,
    restartOptions: [],
    forceRestartOptions: [],
    setResumeConversation(v) { resume = v || null; },
    restart(options) { this.restartOptions.push(options); return true; },
    forceRestart(options) { this.forceRestartOptions.push(options); return true; },
    get resumeSessionId() { return resume; },
    toSnapshot() { return { id: this.id, name: this.name, resumeSessionId: resume }; },
  };
}

test('resume-conversation persists the id, sets it on the session, broadcasts + acks', () => {
  const s = fakeSession('p1');
  const cfg = { projects: [{ id: 'p1', name: 'p1', path: 'C:/repo' }], teams: [] };
  const h = harness(new Map([['p1', s]]), cfg);

  h.send({ type: 'resume-conversation', id: 'p1', conversationId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' });

  assert.equal(cfg.projects[0].resumeSessionId, '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', 'persisted on project record');
  assert.equal(s.resumeSessionId, '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', 'set on live session');
  const bc = h.broadcasts.find((m) => m.type === 'session-resume');
  assert.ok(bc && bc.id === 'p1' && bc.resumeSessionId === '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', 'broadcast session-resume');
  const ack = h.sent.find((m) => m.type === 'resume-conversation-ack');
  assert.ok(ack && ack.ok === true, 'acked ok');
});

test('resume-conversation with an empty id clears the binding', () => {
  const s = fakeSession('p1');
  s.setResumeConversation('prior-0000-0000-0000-000000000000');
  const cfg = { projects: [{ id: 'p1', name: 'p1', path: 'C:/repo', resumeSessionId: 'prior-0000-0000-0000-000000000000' }], teams: [] };
  const h = harness(new Map([['p1', s]]), cfg);

  h.send({ type: 'resume-conversation', id: 'p1', conversationId: '' });

  assert.equal(cfg.projects[0].resumeSessionId, undefined, 'binding removed from project record');
  assert.equal(s.resumeSessionId, null, 'cleared on live session');
});

test('resume-conversation rejects an unsafe id without saving or mutating the session', () => {
  const s = fakeSession('p1');
  const cfg = { projects: [{ id: 'p1', name: 'p1', path: 'C:/repo' }], teams: [] };
  const h = harness(new Map([['p1', s]]), cfg);

  h.send({ type: 'resume-conversation', id: 'p1', conversationId: '../../etc/passwd' });

  assert.equal(h.saveCalls.length, 0, 'no persist for an invalid id');
  assert.equal(s.resumeSessionId, null, 'session untouched');
  const err = h.sent.find((m) => m.type === 'error');
  assert.ok(err && /invalid/i.test(err.message), 'sent an invalid-id error');
});

test('resume-conversation on an unknown session replies with an error (no throw)', () => {
  const cfg = { projects: [], teams: [] };
  const h = harness(new Map(), cfg);
  assert.doesNotThrow(() => h.send({ type: 'resume-conversation', id: 'nope', conversationId: 'x'.repeat(12) }));
  const err = h.sent.find((m) => m.type === 'error');
  assert.ok(err && /not found/i.test(err.message));
});

test('restart passes only boolean true as the fresh flag', () => {
  const s = fakeSession('p1');
  const cfg = { projects: [{ id: 'p1', name: 'p1', path: 'C:/repo' }], teams: [] };
  const h = harness(new Map([['p1', s]]), cfg);

  h.send({ type: 'restart', id: 'p1', fresh: true });
  h.send({ type: 'force-restart', id: 'p1', fresh: 'true' });

  assert.deepEqual(s.restartOptions, [{ fresh: true }]);
  assert.deepEqual(s.forceRestartOptions, [{ fresh: false }]);
});
