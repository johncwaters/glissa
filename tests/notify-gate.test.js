'use strict';

// Tests for the once-per-work-cycle notification gate (session-core/notify-gate.js) and its
// backend wiring contract, plus a NotificationManager regression guard that the 'waiting'
// escalation ping-pong is untouched by the gate change (the gate sits at the call site,
// BEFORE the manager; the manager's debounce/suppression/escalation are unchanged).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createNotifyGate, decideNotification } = require('../session-core/notify-gate');
const { STATES } = require('../shared/states');
const { NotificationManager } = require('../notification-manager');

// ---------------------------------------------------------------------------
// Gate unit behavior
// ---------------------------------------------------------------------------

test('fire returns true once per category per cycle, false on repeats', () => {
  const gate = createNotifyGate();
  assert.equal(gate.fire('complete'), true);
  assert.equal(gate.fire('complete'), false);
  assert.equal(gate.fire('complete'), false);
});

test('categories are independent: a spent complete never blocks failed or vice versa', () => {
  const gate = createNotifyGate();
  assert.equal(gate.fire('complete'), true);
  assert.equal(gate.fire('failed'), true);
  assert.equal(gate.fire('complete'), false);
  assert.equal(gate.fire('failed'), false);
});

test('reset re-arms every category', () => {
  const gate = createNotifyGate();
  gate.fire('complete');
  gate.fire('failed');
  gate.reset();
  assert.equal(gate.fire('complete'), true);
  assert.equal(gate.fire('failed'), true);
});

test('a falsy category never fires', () => {
  const gate = createNotifyGate();
  assert.equal(gate.fire(''), false);
  assert.equal(gate.fire(null), false);
  assert.equal(gate.fire(undefined), false);
});

// ---------------------------------------------------------------------------
// Backend wiring contract. These sequences execute the SAME decideNotification
// the backend state-change listener calls (no hand-mirrored copy to drift), so
// a logic change in the production decision breaks these tests directly.
// Self-transitions never reach the listener (sessions.js transition() returns
// early without emitting), so each sequence below lists only real entered states.
// ---------------------------------------------------------------------------

function runSequence(states) {
  const gate = createNotifyGate();
  const fired = [];
  for (const to of states) {
    const category = decideNotification(to, gate);
    if (category) fired.push(category);
  }
  return fired;
}

test('wiring contract: the reset states exist in shared/states.js', () => {
  assert.equal(typeof STATES.RUNNING, 'string');
  assert.equal(typeof STATES.INITIALIZING, 'string');
  assert.notEqual(STATES.RUNNING, STATES.INITIALIZING);
});

test('AC1 reproduced bug: dismiss-opened IDLE window re-complete notifies once', () => {
  // RUNNING -> COMPLETE (notify) -> dismiss -> IDLE -> late ready -> COMPLETE (suppressed)
  const fired = runSequence([STATES.RUNNING, STATES.COMPLETE, STATES.IDLE, STATES.COMPLETE]);
  assert.deepEqual(fired, ['complete']);
});

test('AC2 exit pair: COMPLETE then DONE notifies once regardless of elapsed time', () => {
  const fired = runSequence([STATES.RUNNING, STATES.COMPLETE, STATES.DONE]);
  assert.deepEqual(fired, ['complete']);
});

test('AC3 per-category: a waiting notification does not consume the cycle complete', () => {
  // Turn ends at a prompt ('waiting' fires), then a late Stop completes it.
  const fired = runSequence([STATES.RUNNING, STATES.WAITING, STATES.COMPLETE]);
  assert.deepEqual(fired, ['waiting', 'complete']);
});

test('AC4 new cycle: a genuinely new turn re-notifies (title bounce is a new cycle by design)', () => {
  const fired = runSequence([STATES.RUNNING, STATES.COMPLETE, STATES.RUNNING, STATES.COMPLETE]);
  assert.deepEqual(fired, ['complete', 'complete']);
});

test('AC5 direct exit: RUNNING -> DONE notifies once', () => {
  const fired = runSequence([STATES.RUNNING, STATES.DONE]);
  assert.deepEqual(fired, ['complete']);
});

test('AC6 failed is gated and a restart (INITIALIZING) re-arms it', () => {
  const fired = runSequence([
    STATES.RUNNING, STATES.FAILED,
    STATES.INITIALIZING, STATES.STARTING, STATES.IDLE, STATES.RUNNING, STATES.FAILED,
  ]);
  assert.deepEqual(fired, ['failed', 'failed']);
});

test('AC6b restart after a completed exit re-arms complete', () => {
  const fired = runSequence([
    STATES.RUNNING, STATES.COMPLETE, STATES.DONE,
    STATES.INITIALIZING, STATES.STARTING, STATES.IDLE, STATES.COMPLETE,
  ]);
  // The post-restart late-ready IDLE -> COMPLETE is a fresh cycle and must notify.
  assert.deepEqual(fired, ['complete', 'complete']);
});

test('user_kill never notifies: killing a RUNNING session is not "finished working"', () => {
  const gate = createNotifyGate();
  assert.equal(decideNotification(STATES.RUNNING, gate), null); // cycle opens
  assert.equal(decideNotification(STATES.DONE, gate, 'user_kill'), null, 'kill is silent');
  // The category was NOT spent: a later real completion in a new cycle still notifies.
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete');
});

test('DORMANT transitivity: DORMANT needs no reset entry because user_start passes INITIALIZING', () => {
  // DONE -> DORMANT (user_reset) does not reset; the only exit from DORMANT is
  // user_start -> INITIALIZING, which does. Do not add DORMANT to the reset set.
  const fired = runSequence([
    STATES.RUNNING, STATES.COMPLETE, STATES.DONE, STATES.DORMANT,
    STATES.INITIALIZING, STATES.STARTING, STATES.IDLE, STATES.COMPLETE,
  ]);
  assert.deepEqual(fired, ['complete', 'complete']);
});

// ---------------------------------------------------------------------------
// NotificationManager regression: 'waiting' escalation ping-pong is untouched.
// First direct coverage for notification-manager.js.
// ---------------------------------------------------------------------------

test('waiting escalation still re-delivers on the interval and stops on acknowledge', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = new NotificationManager({ escalationIntervalMs: 1000, debounceMs: 0 });
  const deliveries = [];
  manager.registerChannel('test', (session, category, message, context) => {
    deliveries.push({ category, escalationCount: context.escalationCount });
  });

  manager.trigger('s1', 'waiting', 'needs input');
  assert.equal(deliveries.length, 1);

  t.mock.timers.tick(1000); // DELIVERED -> ESCALATED re-delivery
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].escalationCount, 1);

  t.mock.timers.tick(1000); // ESCALATED -> DELIVERED ping-pong re-delivery
  assert.equal(deliveries.length, 3);

  manager.acknowledge('s1');
  t.mock.timers.tick(10000);
  assert.equal(deliveries.length, 3, 'no re-delivery after acknowledge');

  manager.destroy();
});

test('complete delivers once with no escalation timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = new NotificationManager({ escalationIntervalMs: 1000, debounceMs: 0 });
  const deliveries = [];
  manager.registerChannel('test', (session, category) => deliveries.push(category));

  manager.trigger('s1', 'complete', 'finished working');
  assert.equal(deliveries.length, 1);

  t.mock.timers.tick(60000);
  assert.equal(deliveries.length, 1, 'complete never escalates');

  manager.destroy();
});
