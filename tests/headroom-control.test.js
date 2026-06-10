'use strict';

// Verifies the three Headroom control-WS handlers dispatch correctly, with the supervisor
// injected as a fake (the real supervisor behavior is covered by headroom-service.test.js).
// Mirrors the team-control.test.js harness: fake controlWss + fake ws capturing sent JSON.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../control-handlers');

function harness(depsOverride = {}) {
  const controlWss = new EventEmitter();
  const sent = [];
  let messageHandler = null;
  const ws = {
    send: (s) => sent.push(JSON.parse(s)),
    on: (ev, h) => { if (ev === 'message') messageHandler = h; },
  };
  const savedConfig = { projects: [], teams: [] };
  const deps = {
    sessions: new Map(),
    config: { projects: [], teams: [] },
    configStore: {
      save: (fn) => { fn(savedConfig); return savedConfig; },
      getSettings: () => ({}),
    },
    broadcastControl: () => {},
    applySettingsReload: () => {},
    ...depsOverride,
  };
  registerControlHandlers(controlWss, deps);
  controlWss.emit('connection', ws);
  sent.length = 0; // drop the initial snapshot
  return { send: (msg) => messageHandler(JSON.stringify(msg)), sent, savedConfig };
}

function fakeHeadroom(state = 'stopped') {
  const calls = { start: 0, stop: 0 };
  return {
    calls,
    getStatus: () => ({ state, port: 8787, pid: null, version: '0.24.0', error: null, logTail: [] }),
    start: () => { calls.start++; return Promise.resolve(); },
    stop: () => {
      calls.stop++;
      if (state === 'running-external') return { ok: false, error: 'Headroom proxy is external (not started by Glissa); not stopping it' };
      return { ok: true };
    },
  };
}

test('get-headroom-status echoes requestId and the supervisor snapshot', () => {
  const h = harness({ headroomService: fakeHeadroom('running') });
  h.send({ type: 'get-headroom-status', requestId: 'q1' });
  const msg = h.sent.find((m) => m.type === 'headroom-status');
  assert.ok(msg, 'sent a headroom-status reply');
  assert.equal(msg.requestId, 'q1');
  assert.equal(msg.state, 'running');
  assert.equal(msg.port, 8787);
});

test('get-headroom-status without a wired supervisor degrades to not-installed (full shape)', () => {
  const h = harness();
  h.send({ type: 'get-headroom-status', requestId: 'q2' });
  const msg = h.sent.find((m) => m.type === 'headroom-status');
  assert.equal(msg.state, 'not-installed');
  // shape parity with a real getStatus() payload so the chip can read any field
  assert.equal(msg.port, null);
  assert.deepEqual(msg.logTail, []);
});

test('start-headroom delegates to the supervisor (progress rides the broadcast)', () => {
  const svc = fakeHeadroom('stopped');
  const h = harness({ headroomService: svc });
  h.send({ type: 'start-headroom' });
  assert.equal(svc.calls.start, 1);
  assert.equal(h.sent.filter((m) => m.type === 'error').length, 0);
});

test('stop-headroom on an owned proxy succeeds silently', () => {
  const svc = fakeHeadroom('running');
  const h = harness({ headroomService: svc });
  h.send({ type: 'stop-headroom' });
  assert.equal(svc.calls.stop, 1);
  assert.equal(h.sent.filter((m) => m.type === 'error').length, 0);
});

test('stop-headroom on running-external is refused with an error reply', () => {
  const svc = fakeHeadroom('running-external');
  const h = harness({ headroomService: svc });
  h.send({ type: 'stop-headroom' });
  const err = h.sent.find((m) => m.type === 'error');
  assert.ok(err, 'an error reply is sent');
  assert.match(err.message, /external/);
});

test('start/stop without a wired supervisor reply with an error instead of crashing', () => {
  const h = harness();
  h.send({ type: 'start-headroom' });
  h.send({ type: 'stop-headroom' });
  const errs = h.sent.filter((m) => m.type === 'error');
  assert.equal(errs.length, 2);
});

test('update-settings rejects an out-of-range headroomPort', () => {
  const h = harness();
  h.send({ type: 'update-settings', requestId: 'u1', settings: { headroomPort: 80 } });
  const err = h.sent.find((m) => m.type === 'settings-error');
  assert.ok(err, 'rejected with settings-error');
  assert.match(err.message, /1024 and 65535/);
});

test('update-settings rejects a non-integer headroomPort', () => {
  const h = harness();
  h.send({ type: 'update-settings', requestId: 'u2', settings: { headroomPort: '8787' } });
  assert.ok(h.sent.some((m) => m.type === 'settings-error'));
});

test('update-settings persists a valid headroomPort and headroomEasyStart', () => {
  const h = harness();
  h.send({
    type: 'update-settings', requestId: 'u3',
    settings: { headroomPort: 9090, headroomEasyStart: true },
  });
  assert.ok(h.sent.some((m) => m.type === 'settings-updated'));
  assert.equal(h.savedConfig.headroomPort, 9090);
  assert.equal(h.savedConfig.headroomEasyStart, true);
});
