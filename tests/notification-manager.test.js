'use strict';

// NotificationManager lifecycle tests for the reliability fixes:
//   - focus suppression DEFERS (SUPPRESSED state) and delivers on blur, never drops
//   - trigger validates the transition BEFORE mutating the entry (no category corruption)
//   - trigger from DELIVERED/ESCALATED replaces the live notification (team re-notify)
//   - the acknowledge-before-trigger backend ordering delivers on notifying-to-notifying hops
// The escalation ping-pong and gate interplay live in tests/notify-gate.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { NotificationManager } = require('../notifications/notification-manager');
const { NOTIFICATION_STATES: NS } = require('../shared/notification-states');

function makeManager(opts = {}) {
  const manager = new NotificationManager({ escalationIntervalMs: 60000, debounceMs: 0, ...opts });
  const deliveries = [];
  manager.registerChannel('test', (session, category, message, context) => {
    deliveries.push({ session, category, message, escalationCount: context.escalationCount });
  });
  return { manager, deliveries };
}

test('focus suppression defers: held while focused, delivered once on blur', () => {
  const { manager, deliveries } = makeManager();
  manager.setFocusSuppressed(true);
  manager.trigger('s1', 'complete', 'finished working');
  assert.equal(deliveries.length, 0, 'nothing delivered while focused');
  assert.equal(manager.getNotificationState('s1'), NS.SUPPRESSED, 'held, not dropped');
  manager.setFocusSuppressed(false);
  assert.equal(deliveries.length, 1, 'delivered on blur');
  assert.equal(deliveries[0].category, 'complete');
  assert.equal(manager.getNotificationState('s1'), NS.DELIVERED);
  manager.destroy();
});

test('a suppressed notification acknowledged before blur is discarded silently', () => {
  const { manager, deliveries } = makeManager();
  manager.setFocusSuppressed(true);
  manager.trigger('s1', 'waiting', 'needs input');
  manager.acknowledge('s1'); // the user answered in the terminal while focused
  manager.setFocusSuppressed(false);
  assert.equal(deliveries.length, 0, 'no stale toast after the user already acted');
  assert.equal(manager.getNotificationState('s1'), NS.IDLE);
  manager.destroy();
});

test('unsuppress on blur delivers every held session, and a waiting entry arms escalation', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, deliveries } = makeManager({ escalationIntervalMs: 1000 });
  manager.setFocusSuppressed(true);
  manager.trigger('s1', 'waiting', 'needs input');
  manager.trigger('s2', 'complete', 'finished');
  manager.setFocusSuppressed(false);
  assert.deepEqual(deliveries.map((d) => d.category).sort(), ['complete', 'waiting']);
  t.mock.timers.tick(1000);
  assert.equal(deliveries.length, 3, 'the waiting entry escalates from its post-blur delivery');
  manager.destroy();
});

test('re-suppression while blurred-held is impossible to double-deliver (idempotent setFocusSuppressed)', () => {
  const { manager, deliveries } = makeManager();
  manager.setFocusSuppressed(true);
  manager.trigger('s1', 'complete', 'finished');
  manager.setFocusSuppressed(false);
  manager.setFocusSuppressed(false); // duplicate blur event
  assert.equal(deliveries.length, 1);
  manager.destroy();
});

test('trigger on a DELIVERED entry replaces it (a second team run notifies again)', () => {
  const { manager, deliveries } = makeManager();
  assert.equal(manager.trigger('team:marketing', 'complete', 'run 1 done'), true);
  // Never acknowledged: team pseudo-sessions have no state-change to clear them.
  assert.equal(manager.trigger('team:marketing', 'complete', 'run 2 done'), true);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].message, 'run 2 done');
  manager.destroy();
});

test('trigger replacing a waiting entry clears its escalation timer (no ghost re-fire)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, deliveries } = makeManager({ escalationIntervalMs: 1000 });
  manager.trigger('s1', 'waiting', 'needs input');
  manager.trigger('s1', 'complete', 'finished'); // replaces; complete never escalates
  t.mock.timers.tick(5000);
  assert.deepEqual(deliveries.map((d) => d.category), ['waiting', 'complete'],
    'no escalation re-fire under the stale waiting timer');
  manager.destroy();
});

test('backend ordering contract: acknowledge-then-trigger on WAITING -> COMPLETE delivers the completion', () => {
  const { manager, deliveries } = makeManager();
  // WAITING entry delivered...
  manager.trigger('s1', 'waiting', 'needs input');
  // ...then a late authoritative Stop: the listener acknowledges (leaving WAITING) first,
  // then triggers 'complete' for the entered state.
  manager.acknowledge('s1');
  manager.trigger('s1', 'complete', 'finished working');
  assert.deepEqual(deliveries.map((d) => d.category), ['waiting', 'complete']);
  manager.destroy();
});

test('debounce still coalesces rapid same-category re-triggers per session', () => {
  const { manager, deliveries } = makeManager({ debounceMs: 60000 });
  manager.trigger('s1', 'complete', 'first');
  manager.acknowledge('s1');
  manager.trigger('s1', 'complete', 'second'); // within the window -> debounced
  manager.trigger('s2', 'complete', 'other session'); // never cross-suppressed
  assert.deepEqual(deliveries.map((d) => d.message), ['first', 'other session']);
  manager.destroy();
});

test('the debounce map is pruned lazily (no unbounded growth across sessions)', () => {
  const { manager } = makeManager({ debounceMs: 10 });
  const start = Date.now();
  manager.trigger('s1', 'complete', 'x');
  // Force the recorded entry past the window, then record another category.
  manager._recentCategories.set('s1\0complete', start - 1000);
  manager.acknowledge('s1');
  manager.trigger('s2', 'complete', 'y');
  assert.equal(manager._recentCategories.has('s1\0complete'), false, 'stale key swept');
  manager.destroy();
});
