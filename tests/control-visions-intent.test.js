'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../server/control-handlers');

function harness({ visionsLane = null } = {}) {
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
    visionsLane,
  });
  controlWss.emit('connection', ws);
  sent.length = 0;
  return { send: (msg) => messageHandler(JSON.stringify(msg)), sent };
}

test('visions-set-intent is no longer a control message', () => {
  const lane = { calls: 0, applyModelIntent: () => { lane.calls += 1; } };
  const h = harness({ visionsLane: lane });

  h.send({ type: 'visions-set-intent', text: '  refactor of the spawn path  ' });
  assert.equal(lane.calls, 0);
  assert.deepEqual(h.sent, []);
});
