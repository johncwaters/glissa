'use strict';

// Connect-time replay of a cached startup update-check result. A control client connecting AFTER the
// check resolved must receive one 'update-available' frame; the accessor is guarded so the four existing
// control-WS tests (which register handlers WITHOUT getUpdateStatus) never throw on connection.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../server/control-handlers');

function connect(deps) {
  const controlWss = new EventEmitter();
  const sent = [];
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: () => {} };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: { projects: [], teams: [] },
    configStore: { save: (fn) => fn({ projects: [], teams: [] }), getSettings: () => ({}) },
    applyConfigReload: () => {},
    broadcastControl: () => {},
    ...deps,
  });
  controlWss.emit('connection', ws);
  return sent;
}

test('no update-available when getUpdateStatus is absent (does not throw)', () => {
  let sent;
  assert.doesNotThrow(() => { sent = connect({}); });
  assert.equal(sent.filter((m) => m.type === 'update-available').length, 0);
});

test('no update-available when getUpdateStatus reports no update', () => {
  const sent = connect({ getUpdateStatus: () => ({ updateAvailable: false }) });
  assert.equal(sent.filter((m) => m.type === 'update-available').length, 0);
});

test('replays exactly one update-available frame when an update is cached', () => {
  const status = {
    updateAvailable: true,
    current: '0.16.0',
    latest: '0.17.0',
    command: 'git pull && npm ci && npm run build',
  };
  const sent = connect({ getUpdateStatus: () => status });
  const updates = sent.filter((m) => m.type === 'update-available');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { type: 'update-available', ...status });
});
