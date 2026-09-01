import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyControlMessage, decideControlSend, REFRESHABLE_TYPES,
  DEFAULT_HIGH_WATER_MARK, DEFAULT_HARD_CEILING,
} from '../server/core/control-send-core.ts';
import { REPLAYABLE_EXACT } from '../server/control-replay-core.ts';

test('a healthy socket sends everything', () => {
  for (const type of ['notify', 'health-snapshot', 'session-state', 'usage-sessions']) {
    assert.deepEqual(decideControlSend({ bufferedAmount: 0, type }), { action: 'send', reason: null }, type);
  }
});

test('past the high-water mark only the periodic pushes drop', () => {
  const bufferedAmount = DEFAULT_HIGH_WATER_MARK;
  assert.equal(decideControlSend({ bufferedAmount, type: 'health-snapshot' }).action, 'drop');
  assert.equal(decideControlSend({ bufferedAmount, type: 'usage-sessions' }).action, 'drop');

  assert.equal(decideControlSend({ bufferedAmount, type: 'usage-report' }).action, 'send');
  assert.equal(decideControlSend({ bufferedAmount, type: 'notify' }).action, 'send');
  assert.equal(decideControlSend({ bufferedAmount, type: 'session-error' }).action, 'send');
  assert.equal(decideControlSend({ bufferedAmount, type: 'usage-budget-alert' }).action, 'send');
  assert.equal(decideControlSend({ bufferedAmount, type: 'session-state' }).action, 'send',
    'a delta nothing re-sends is not dropped: a stale card is a bug the operator sees');
});

test('past the hard ceiling the socket is closed rather than fed', () => {
  const bufferedAmount = DEFAULT_HARD_CEILING;
  for (const type of ['notify', 'health-snapshot', 'session-state']) {
    assert.deepEqual(decideControlSend({ bufferedAmount, type }), { action: 'close', reason: 'ceiling' }, type);
  }
});

test('no replayable type is ever classified as droppable', () => {
  for (const type of REPLAYABLE_EXACT) {
    assert.equal(classifyControlMessage(type), 'critical', type);
    assert.equal(REFRESHABLE_TYPES.has(type), false, type);
  }
});

test('an unknown type is normal, so a new message class is never silently droppable', () => {
  assert.equal(classifyControlMessage('some-future-frame'), 'normal');
  assert.equal(decideControlSend({ bufferedAmount: DEFAULT_HIGH_WATER_MARK, type: 'some-future-frame' }).action, 'send');
});

test('a missing bufferedAmount reads as zero rather than as a wedged socket', () => {
  assert.equal(decideControlSend({ bufferedAmount: undefined, type: 'health-snapshot' }).action, 'send');
});

test('the thresholds are overridable, so a test can drive the policy without megabytes', () => {
  const opts = { highWaterMark: 10, hardCeiling: 100 };
  assert.equal(decideControlSend({ bufferedAmount: 9, type: 'health-snapshot', ...opts }).action, 'send');
  assert.equal(decideControlSend({ bufferedAmount: 10, type: 'health-snapshot', ...opts }).action, 'drop');
  assert.equal(decideControlSend({ bufferedAmount: 100, type: 'health-snapshot', ...opts }).action, 'close');
});
