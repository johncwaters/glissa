'use strict';

// Every control connection is told its own trust so the dashboard can stop offering server-machine
// actions a paired phone cannot act on. Display metadata only; nothing is enforced on it.
// Fake-controlWss harness, same shape as control-dispatch.test.js (no backend boot).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../server/control-handlers');

function connectWith(glissaTrust) {
  const controlWss = new EventEmitter();
  const sent = [];
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: () => {}, glissaTrust };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: { projects: [], teams: [] },
    configStore: { save: (fn) => fn({ projects: [], teams: [] }), getSettings: () => ({}) },
    applyConfigReload: () => {},
    broadcastControl: () => {},
  });
  controlWss.emit('connection', ws);
  return sent;
}

test('a remote-stamped connection is told it is remote', () => {
  const sent = connectWith('remote');
  assert.deepEqual(sent.find((m) => m.type === 'client-trust'), { type: 'client-trust', trust: 'remote' });
});

test('an unstamped connection (remote mode off) is told it is local', () => {
  const sent = connectWith(undefined);
  assert.deepEqual(sent.find((m) => m.type === 'client-trust'), { type: 'client-trust', trust: 'local' });
});

test('the snapshot stays the first frame of a connection', () => {
  const sent = connectWith('local');
  assert.equal(sent[0].type, 'snapshot', 'control-ws.js resets its replay cursor on the first seq-less snapshot');
  assert.equal(sent[1].type, 'client-trust');
});
