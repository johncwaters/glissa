// NotificationManager lifecycle tests for the reliability fixes:
//   - focus suppression DEFERS (SUPPRESSED state) and delivers on blur, never drops
//   - trigger validates the transition BEFORE mutating the entry (no category corruption)
//   - trigger from DELIVERED/ESCALATED replaces the live notification (team re-notify)
//   - the acknowledge-before-trigger backend ordering delivers on notifying-to-notifying hops
// The escalation ping-pong and gate interplay live in tests/notify-gate.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NotificationManager } from '../notifications/notification-manager.ts';
import { NOTIFICATION_STATES as NS } from '../shared/notification-states.ts';
import type { NotificationManagerOptions } from '../notifications/notification-manager.ts';

interface RecordedDelivery {
  session: string;
  category: string;
  message: string;
  escalationCount: number;
}

function makeManager(opts: NotificationManagerOptions = {}) {
  const manager = new NotificationManager({ escalationIntervalMs: 60000, debounceMs: 0, ...opts });
  const deliveries: RecordedDelivery[] = [];
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

// ---------------------------------------------------------------------------
// Ported from the retired test/test-notification-manager.js manual harness: low-level
// unit behavior not otherwise covered by the scenario tests above or by notify-gate.test.js.
// ---------------------------------------------------------------------------

test('a failed trigger delivers once with no escalation timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, deliveries } = makeManager({ escalationIntervalMs: 1000 });
  manager.trigger('s1', 'failed', 'oops');
  assert.equal(deliveries.length, 1);
  t.mock.timers.tick(60000);
  assert.equal(deliveries.length, 1, 'failed never escalates');
  manager.destroy();
});

test('acknowledge on an entry with no active notification is a no-op', () => {
  const { manager } = makeManager();
  assert.doesNotThrow(() => manager.acknowledge('nonexistent'));
  manager.destroy();
});

test('destroy() clears every tracked entry back to IDLE', () => {
  const { manager } = makeManager();
  manager.trigger('s1', 'waiting', 'needs input');
  manager.trigger('s2', 'failed', 'oops');
  manager.destroy();
  assert.equal(manager.getNotificationState('s1'), NS.IDLE);
  assert.equal(manager.getNotificationState('s2'), NS.IDLE);
});

test('multiple registered channels are all called, in registration order', () => {
  const manager = new NotificationManager({ escalationIntervalMs: 60000, debounceMs: 0 });
  const order: string[] = [];
  manager.registerChannel('first', () => order.push('first'));
  manager.registerChannel('second', () => order.push('second'));
  manager.trigger('s1', 'waiting', 'test');
  assert.deepEqual(order, ['first', 'second']);
  manager.destroy();
});

test('a channel that throws does not block a later channel from delivering', () => {
  const manager = new NotificationManager({ escalationIntervalMs: 60000, debounceMs: 0 });
  const calls: number[] = [];
  manager.registerChannel('broken', () => { throw new Error('boom'); });
  manager.registerChannel('working', () => calls.push(1));
  manager.trigger('s1', 'waiting', 'test');
  assert.equal(calls.length, 1, 'the second channel still ran after the first threw');
  manager.destroy();
});

test('session_destroyed clears the entry back to IDLE from a live state', () => {
  const { manager } = makeManager();
  manager.trigger('s1', 'waiting', 'test');
  manager._transition('s1', 'session_destroyed');
  assert.equal(manager.getNotificationState('s1'), NS.IDLE);
  manager.destroy();
});

test('notification-state-change fires on delivery with the session and category', () => {
  const { manager } = makeManager();
  const events: { to: string; session: string; category: string | null }[] = [];
  manager.on('notification-state-change', (e) => events.push(e));
  manager.trigger('s1', 'complete', 'done');
  const deliveredEvent = events.find((e) => e.to === NS.DELIVERED);
  assert.equal(deliveredEvent?.session, 's1');
  assert.equal(deliveredEvent?.category, 'complete');
  manager.destroy();
});

test('updateSettings changes the escalation interval and debounce window', () => {
  const manager = new NotificationManager({ escalationIntervalMs: 999, debounceMs: 111 });
  manager.updateSettings({ escalationIntervalMs: 500, debounceMs: 200 });
  assert.equal(manager._escalationIntervalMs, 500);
  assert.equal(manager._debounceMs, 200);
  manager.destroy();
});
