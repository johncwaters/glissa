'use strict';

const { EventEmitter } = require('node:events');
const { NotificationManager } = require('../notifications/notification-manager');
const { NOTIFICATION_STATES: NS } = require('../shared/notification-states');

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        expected: ${JSON.stringify(expected)}`);
    console.error(`        got:      ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

console.log('\n--- Unit Tests ---');

// Test: IDLE -> PENDING -> DELIVERED (happy path)
{
  console.log('\nHappy path (trigger -> deliver):');
  const nm = new NotificationManager({ debounceMs: 0 });
  const calls = [];
  nm.registerChannel('mock', (name, cat, msg, ctx) => calls.push({ name, cat, msg, ctx }));
  nm.trigger('s1', 'waiting', 'needs input');
  assert('state is DELIVERED', nm.getNotificationState('s1'), NS.DELIVERED);
  assert('channel called once', calls.length, 1);
  assert('channel got sessionName', calls[0].name, 's1');
  assert('channel got category', calls[0].cat, 'waiting');
  assert('channel got message', calls[0].msg, 'needs input');
  assert('context.escalationCount is 0', calls[0].ctx.escalationCount, 0);
  nm.destroy();
}

// Test: trigger while focused -> SUPPRESSED (deferred, delivered on blur)
{
  console.log('\nFocus suppression:');
  const nm = new NotificationManager({ debounceMs: 0 });
  const calls = [];
  nm.registerChannel('mock', () => calls.push(1));
  nm.setFocusSuppressed(true);
  nm.trigger('s1', 'waiting', 'needs input');
  assert('state is SUPPRESSED (held)', nm.getNotificationState('s1'), NS.SUPPRESSED);
  assert('channel NOT called while focused', calls.length, 0);
  nm.setFocusSuppressed(false);
  assert('delivered on blur', calls.length, 1);
  nm.destroy();
}

// Test: debounce is per-session + category. A same-session re-fire inside the window is
// suppressed; a different session hitting the same category is NOT cross-suppressed.
{
  console.log('\nDebounce suppression (per-session):');
  const nm = new NotificationManager({ debounceMs: 60000 });
  const calls = [];
  nm.registerChannel('mock', () => calls.push(1));
  nm.trigger('s1', 'waiting', 'needs input');
  assert('first trigger delivers', calls.length, 1);
  // Acknowledge to reset s1, then re-trigger s1 within the window -> debounced.
  nm.acknowledge('s1');
  nm.trigger('s1', 'waiting', 'needs input again');
  assert('same-session re-trigger debounced', calls.length, 1);
  assert('s1 state is IDLE (debounced)', nm.getNotificationState('s1'), NS.IDLE);
  // A different session hitting the same category still delivers (no cross-suppression).
  nm.trigger('s2', 'waiting', 'other session needs input');
  assert('different session not cross-suppressed', calls.length, 2);
  assert('s2 state is DELIVERED', nm.getNotificationState('s2'), NS.DELIVERED);
  nm.destroy();
}

// Test: COMPLETE trigger - one-shot, no escalation
{
  console.log('\nCOMPLETE is one-shot (no escalation):');
  const nm = new NotificationManager({ escalationIntervalMs: 30, debounceMs: 0 });
  const calls = [];
  nm.registerChannel('mock', () => calls.push(1));
  nm.trigger('s1', 'complete', 'finished');
  assert('state is DELIVERED', nm.getNotificationState('s1'), NS.DELIVERED);
  assert('channel called once', calls.length, 1);
  nm.destroy(); // destroy before timer could fire (shouldn't exist anyway)
}

// Test: FAILED trigger - one-shot, no escalation
{
  console.log('\nFAILED is one-shot (no escalation):');
  const nm = new NotificationManager({ escalationIntervalMs: 30, debounceMs: 0 });
  const calls = [];
  nm.registerChannel('mock', () => calls.push(1));
  nm.trigger('s1', 'failed', 'oops');
  assert('state is DELIVERED', nm.getNotificationState('s1'), NS.DELIVERED);
  assert('channel called once', calls.length, 1);
  nm.destroy();
}

// Test: acknowledge from DELIVERED
{
  console.log('\nAcknowledge from DELIVERED:');
  const nm = new NotificationManager({ debounceMs: 0 });
  nm.registerChannel('mock', () => {});
  nm.trigger('s1', 'waiting', 'needs input');
  nm.acknowledge('s1');
  assert('state is IDLE after ack', nm.getNotificationState('s1'), NS.IDLE);
  nm.destroy();
}

// Test: acknowledge from IDLE is a no-op
{
  console.log('\nAcknowledge from IDLE (no-op):');
  const nm = new NotificationManager({ debounceMs: 0 });
  nm.acknowledge('nonexistent');
  assert('no crash', true, true);
  nm.destroy();
}

// Test: multiple sessions tracked independently
{
  console.log('\nIndependent session tracking:');
  const nm = new NotificationManager({ debounceMs: 0 });
  const calls = [];
  nm.registerChannel('mock', (name) => calls.push(name));
  nm.trigger('s1', 'waiting', 'needs input');
  nm.trigger('s2', 'complete', 'finished');
  assert('s1 is DELIVERED', nm.getNotificationState('s1'), NS.DELIVERED);
  assert('s2 is DELIVERED', nm.getNotificationState('s2'), NS.DELIVERED);
  nm.acknowledge('s1');
  assert('s1 is IDLE after ack', nm.getNotificationState('s1'), NS.IDLE);
  assert('s2 still DELIVERED', nm.getNotificationState('s2'), NS.DELIVERED);
  nm.destroy();
}

// Test: destroy() clears all state
{
  console.log('\ndestroy() cleanup:');
  const nm = new NotificationManager({ debounceMs: 0 });
  nm.registerChannel('mock', () => {});
  nm.trigger('s1', 'waiting', 'needs input');
  nm.trigger('s2', 'failed', 'oops');
  nm.destroy();
  assert('s1 IDLE after destroy', nm.getNotificationState('s1'), NS.IDLE);
  assert('s2 IDLE after destroy', nm.getNotificationState('s2'), NS.IDLE);
}

// Test: multiple channels called in order
{
  console.log('\nMultiple channels:');
  const nm = new NotificationManager({ debounceMs: 0 });
  const order = [];
  nm.registerChannel('first', () => order.push('first'));
  nm.registerChannel('second', () => order.push('second'));
  nm.trigger('s1', 'waiting', 'test');
  assert('both channels called', order.length, 2);
  assert('first channel first', order[0], 'first');
  assert('second channel second', order[1], 'second');
  nm.destroy();
}

// Test: channel error doesn't crash
{
  console.log('\nChannel error handling:');
  const nm = new NotificationManager({ debounceMs: 0 });
  const calls = [];
  nm.registerChannel('broken', () => { throw new Error('boom'); });
  nm.registerChannel('working', () => calls.push(1));
  nm.trigger('s1', 'waiting', 'test');
  assert('second channel still called after first throws', calls.length, 1);
  nm.destroy();
}

// Test: session_destroyed from any state -> IDLE
{
  console.log('\nsession_destroyed cleanup:');
  const nm = new NotificationManager({ debounceMs: 0 });
  nm.registerChannel('mock', () => {});
  nm.trigger('s1', 'waiting', 'test');
  // Manually call _transition with session_destroyed
  nm._ensureEntry('s1'); // ensure it exists (trigger already created it)
  nm._transition('s1', 'session_destroyed');
  // After session_destroyed -> IDLE, entry is deleted
  assert('state is IDLE after session_destroyed', nm.getNotificationState('s1'), NS.IDLE);
  nm.destroy();
}

// Test: notification-state-change event emitted
{
  console.log('\nnotification-state-change event:');
  const nm = new NotificationManager({ debounceMs: 0 });
  nm.registerChannel('mock', () => {});
  const events = [];
  nm.on('notification-state-change', (e) => events.push(e));
  nm.trigger('s1', 'complete', 'done');
  // PENDING is transient, so we should see: IDLE->PENDING, PENDING->DELIVERED
  assert('events emitted', events.length >= 1, true);
  const deliveredEvent = events.find(e => e.to === NS.DELIVERED);
  assert('DELIVERED event has session', deliveredEvent?.session, 's1');
  assert('DELIVERED event has category', deliveredEvent?.category, 'complete');
  nm.destroy();
}

// Test: updateSettings changes intervals
{
  console.log('\nupdateSettings:');
  const nm = new NotificationManager({ escalationIntervalMs: 999, debounceMs: 111 });
  nm.updateSettings({ escalationIntervalMs: 500, debounceMs: 200 });
  assert('escalation updated', nm._escalationIntervalMs, 500);
  assert('debounce updated', nm._debounceMs, 200);
  nm.destroy();
}

// ---------------------------------------------------------------------------
// Async Tests (escalation timing, ping-pong)
// ---------------------------------------------------------------------------

console.log('\n--- Async Tests ---');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runAsyncTests() {
  let asyncPassed = 0;
  let asyncFailed = 0;

  const assertAsync = (label, actual, expected) => {
    if (actual === expected) {
      console.log(`  PASS  ${label}`);
      asyncPassed++;
    } else {
      console.error(`  FAIL  ${label}`);
      console.error(`        expected: ${JSON.stringify(expected)}`);
      console.error(`        got:      ${JSON.stringify(actual)}`);
      asyncFailed++;
    }
  };

  // Test: escalation fires for 'waiting' category
  const nm1 = new NotificationManager({ escalationIntervalMs: 40, debounceMs: 0 });
  const calls1 = [];
  nm1.registerChannel('mock', (_name, _cat, _msg, ctx) => calls1.push({ ctx }));
  nm1.trigger('s1', 'waiting', 'needs input');

  await delay(60);
  console.log('\nEscalation fires for waiting:');
  assertAsync('escalated to ESCALATED', nm1.getNotificationState('s1'), NS.ESCALATED);
  assertAsync('channel called twice (initial + escalation)', calls1.length, 2);
  assertAsync('escalation count is 1', calls1[1].ctx.escalationCount, 1);
  nm1.destroy();

  // Test: COMPLETE does NOT escalate
  const nm2 = new NotificationManager({ escalationIntervalMs: 30, debounceMs: 0 });
  const calls2 = [];
  nm2.registerChannel('mock', () => calls2.push(1));
  nm2.trigger('s1', 'complete', 'finished');

  await delay(60);
  console.log('\nCOMPLETE does NOT escalate after interval:');
  assertAsync('still DELIVERED (no escalation)', nm2.getNotificationState('s1'), NS.DELIVERED);
  assertAsync('channel still called once', calls2.length, 1);
  nm2.destroy();

  // Test: ping-pong cycle (DELIVERED -> ESCALATED -> DELIVERED -> ESCALATED)
  const nm3 = new NotificationManager({ escalationIntervalMs: 25, debounceMs: 0 });
  const calls3 = [];
  nm3.registerChannel('mock', (_name, _cat, _msg, ctx) => calls3.push(ctx.escalationCount));
  nm3.trigger('s1', 'waiting', 'needs input');

  await delay(100);
  console.log('\nPing-pong escalation cycle:');
  assertAsync('4+ channel calls (ping-pong cycle)', calls3.length >= 4, true);
  assertAsync('first call escalationCount=0', calls3[0], 0);
  assertAsync('second call (ESCALATED) count=1', calls3[1], 1);
  assertAsync('third call (DELIVERED re-entry) count=1', calls3[2], 1);
  assertAsync('fourth call (ESCALATED) count=2', calls3[3], 2);
  nm3.destroy();

  // Test: acknowledge during escalation clears timers
  const nm4 = new NotificationManager({ escalationIntervalMs: 40, debounceMs: 0 });
  const calls4 = [];
  nm4.registerChannel('mock', () => calls4.push(1));
  nm4.trigger('s1', 'waiting', 'needs input');

  await delay(50);
  const countBeforeAck = calls4.length;
  nm4.acknowledge('s1');
  assertAsync('acknowledged', nm4.getNotificationState('s1'), NS.IDLE);

  await delay(60);
  console.log('\nAcknowledge stops escalation:');
  assertAsync('no further calls after ack', calls4.length, countBeforeAck);
  nm4.destroy();

  // Test: focus change during DELIVERED suppresses next trigger but not current
  const nm5 = new NotificationManager({ escalationIntervalMs: 5000, debounceMs: 0 });
  const calls5 = [];
  nm5.registerChannel('mock', () => calls5.push(1));
  nm5.trigger('s1', 'waiting', 'needs input');
  console.log('\nFocus change during DELIVERED:');
  assertAsync('delivered (1 call)', calls5.length, 1);
  nm5.setFocusSuppressed(true);
  nm5.acknowledge('s1');
  nm5.trigger('s2', 'waiting', 'other session');
  assertAsync('second trigger suppressed', calls5.length, 1);
  assertAsync('s2 is SUPPRESSED (held for blur)', nm5.getNotificationState('s2'), NS.SUPPRESSED);
  nm5.destroy();

  // Integration: mock Session emits state-change events
  console.log('\nIntegration: mock Session state-change events:');
  const nm6 = new NotificationManager({ escalationIntervalMs: 5000, debounceMs: 0 });
  const calls6 = [];
  nm6.registerChannel('mock', (name, cat) => calls6.push({ name, cat }));

  const mockSession = new EventEmitter();
  mockSession.name = 'test-session';

  const STATES = require('../shared/states').STATES;
  // Mirrors the backend.js state-change -> notification wiring: COMPLETE and DONE both notify under
  // 'complete', and DONE is in the acknowledge set so a restart clears the entry.
  mockSession.on('state-change', ({ from, to }) => {
    if (to === STATES.WAITING) {
      nm6.trigger('test-session', 'waiting', `test-session needs your input`);
    } else if (to === STATES.COMPLETE || to === STATES.DONE) {
      nm6.trigger('test-session', 'complete', `test-session finished working`);
    } else if (to === STATES.FAILED) {
      nm6.trigger('test-session', 'failed', `test-session failed`);
    }
    if (from === STATES.WAITING || from === STATES.COMPLETE || from === STATES.DONE || from === STATES.FAILED) {
      nm6.acknowledge('test-session');
    }
  });

  mockSession.emit('state-change', { from: STATES.RUNNING, to: STATES.WAITING });
  assertAsync('WAITING triggers notification', calls6.length, 1);
  assertAsync('category is waiting', calls6[0].cat, 'waiting');
  assertAsync('state is DELIVERED', nm6.getNotificationState('test-session'), NS.DELIVERED);

  mockSession.emit('state-change', { from: STATES.WAITING, to: STATES.RUNNING });
  assertAsync('leaving WAITING acknowledges', nm6.getNotificationState('test-session'), NS.IDLE);

  mockSession.emit('state-change', { from: STATES.RUNNING, to: STATES.FAILED });
  assertAsync('FAILED triggers notification', calls6.length, 2);
  assertAsync('FAILED category', calls6[1].cat, 'failed');

  // Restart clears a delivered 'complete' so the session can notify again. A direct RUNNING->DONE
  // exit leaves a 'complete' entry in DELIVERED; the restart (DONE->INITIALIZING) must acknowledge it,
  // otherwise the next trigger is a silent no-op (DELIVERED has no 'trigger' transition).
  mockSession.emit('state-change', { from: STATES.FAILED, to: STATES.INITIALIZING }); // clear FAILED entry
  mockSession.emit('state-change', { from: STATES.RUNNING, to: STATES.DONE });
  assertAsync('DONE triggers completion notification', calls6.length, 3);
  assertAsync('DONE category is complete', calls6[2].cat, 'complete');
  assertAsync('DONE state is DELIVERED', nm6.getNotificationState('test-session'), NS.DELIVERED);

  mockSession.emit('state-change', { from: STATES.DONE, to: STATES.INITIALIZING });
  assertAsync('leaving DONE acknowledges (restart clears entry)', nm6.getNotificationState('test-session'), NS.IDLE);

  mockSession.emit('state-change', { from: STATES.RUNNING, to: STATES.WAITING });
  assertAsync('restarted session still notifies (not wedged)', calls6.length, 4);
  assertAsync('post-restart WAITING delivered', nm6.getNotificationState('test-session'), NS.DELIVERED);
  nm6.destroy();

  // Force-restart scenario
  console.log('\nForce-restart scenario:');
  const nm7 = new NotificationManager({ escalationIntervalMs: 30, debounceMs: 0 });
  const calls7 = [];
  nm7.registerChannel('mock', () => calls7.push(1));
  nm7.trigger('s1', 'waiting', 'needs input');

  await delay(50);
  const preAckCount = calls7.length;
  nm7.acknowledge('s1');
  assertAsync('acknowledged after force-restart', nm7.getNotificationState('s1'), NS.IDLE);

  await delay(60);
  assertAsync('no further escalation after force-restart ack', calls7.length, preAckCount);
  nm7.destroy();

  passed += asyncPassed;
  failed += asyncFailed;
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

runAsyncTests().then((exitCode) => { // NOSONAR - CJS project cannot use top-level await
  process.exit(exitCode);
});
