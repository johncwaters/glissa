'use strict';

/*
 * The one inbound message the Navigator tab sends: `navigator-set-intent` (docs/archive/plan-navigator.md, M5).
 * The handler validates and delegates, nothing more: what a correction DOES to the standing statement
 * is decided by the merge in server/core/navigator-intent-core.js. With the lane off (config.navigator
 * absent) it must refuse the way every other absent-lane handler does rather than crash the dispatch.
 *
 * Same fake-controlWss harness as control-dispatch.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../server/control-handlers');

function harness({ navigatorLane = null } = {}) {
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
    navigatorLane,
  });
  controlWss.emit('connection', ws);
  sent.length = 0;
  return { send: (msg) => messageHandler(JSON.stringify(msg)), sent };
}

function fakeLane() {
  const corrections = [];
  return { corrections, setOperatorIntent: (text) => { corrections.push(text); return true; } };
}

test('a correction reaches the lane exactly as it was typed', () => {
  const lane = fakeLane();
  const h = harness({ navigatorLane: lane });

  h.send({ type: 'navigator-set-intent', text: '  refactor of the spawn path  ' });
  assert.deepEqual(lane.corrections, ['  refactor of the spawn path  '], 'trimming is the merge rule, not the handler');
  assert.equal(h.sent.length, 0, 'the lane broadcasts the result; the handler answers nothing');
});

test('an empty or absent text is a clear, not an error', () => {
  const lane = fakeLane();
  const h = harness({ navigatorLane: lane });

  h.send({ type: 'navigator-set-intent', text: '' });
  h.send({ type: 'navigator-set-intent' });
  assert.deepEqual(lane.corrections, ['', ''], 'clearing is how control goes back to the model');
  assert.equal(h.sent.length, 0);
});

test('a non-string text is refused rather than coerced', () => {
  const lane = fakeLane();
  const h = harness({ navigatorLane: lane });

  h.send({ type: 'navigator-set-intent', text: 42 });
  h.send({ type: 'navigator-set-intent', text: { text: 'nope' } });
  assert.deepEqual(lane.corrections, []);
  assert.deepEqual(h.sent.map((msg) => msg.type), ['error', 'error']);
  assert.match(h.sent[0].message, /must be a string/);
});

test('with the navigator lane off the correction is refused, and nothing crashes', () => {
  const h = harness();
  assert.doesNotThrow(() => h.send({ type: 'navigator-set-intent', text: 'anything at all' }));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, 'error');
  assert.match(h.sent[0].message, /not running/);
});
