'use strict';

// Control-WS dispatch hardening: a bracket lookup on the handler map resolves inherited keys, so a
// {"type":"__proto__"} message used to dereference Object.prototype and throw synchronously inside the
// 'message' listener, killing the whole process (no uncaughtException handler exists by design). The
// dispatch must ignore non-string and non-own-property types. Mirrors the fake-controlWss harness used
// by control-resume.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../control-handlers');

function harness() {
  const controlWss = new EventEmitter();
  const sent = [];
  let messageHandler = null;
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: (ev, h) => { if (ev === 'message') messageHandler = h; } };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: { projects: [], teams: [] },
    configStore: { save: (fn) => fn({ projects: [], teams: [] }), getSettings: () => ({}) },
    applyConfigReload: () => {},
    broadcastControl: () => {},
  });
  controlWss.emit('connection', ws);
  sent.length = 0; // drop the initial snapshot
  return { send: (msg) => messageHandler(JSON.stringify(msg)), sent };
}

test('inherited-key message types are ignored, not dispatched', () => {
  const h = harness();
  assert.doesNotThrow(() => h.send({ type: '__proto__' }));
  assert.doesNotThrow(() => h.send({ type: 'constructor' }));
  assert.doesNotThrow(() => h.send({ type: 'hasOwnProperty' }));
  assert.equal(h.sent.length, 0, 'nothing sent back');
});

test('non-string and unknown message types are ignored', () => {
  const h = harness();
  assert.doesNotThrow(() => h.send({ type: 42 }));
  assert.doesNotThrow(() => h.send({ type: null }));
  assert.doesNotThrow(() => h.send({}));
  assert.doesNotThrow(() => h.send({ type: 'no-such-handler' }));
  assert.equal(h.sent.length, 0, 'nothing sent back');
});

test('non-object payloads are ignored', () => {
  const h = harness();
  assert.doesNotThrow(() => h.send(null), 'a literal null frame must not crash the dispatch');
  assert.doesNotThrow(() => h.send(42));
  assert.doesNotThrow(() => h.send('kill'));
  assert.doesNotThrow(() => h.send(['type', 'kill']));
  assert.equal(h.sent.length, 0, 'nothing sent back');
});
