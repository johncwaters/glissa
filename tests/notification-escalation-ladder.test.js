'use strict';

// The escalation ladder's last rung (2026-08 review, section 5, promoted by the operator's ruling to
// the section's one endorsed durability investment).
//
// The shape: deliver browser best-effort, wait for an acknowledgement, and escalate an unacknowledged
// notification to the off-dashboard channel EVEN WHILE CONNECTIONS ARE OPEN. A dashboard being open
// is what the ordinary Telegram gate keys on, and this rung is the one delivery that disbelieves it:
// the operator was shown a browser notification and did not act on it.
//
// Time is driven BY HAND here (node:test mock timers, the same mechanism tests/notification-manager.js
// already uses on this class). Racing real timers against sleeps meant a settle that overran its margin
// on a loaded machine read as a rung that fired, so the restart test failed under CI load and passed
// idle. Ticking to an exact moment asserts the thing the test is actually about: whether a timer was
// armed for that moment at all.

const test = require('node:test');
const assert = require('node:assert/strict');

const { NotificationManager } = require('../notifications/notification-manager');
const { NOTIFICATION_STATES: NS, NOTIFICATION_TRANSITIONS } = require('../shared/notification-states.ts');
const { decideTelegramNotification } = require('../notifications/channels/telegram');

const PHONE_MS = 50;
// Long enough to prove nothing further is armed, and well under the 60s escalation interval below so
// the browser ping-pong stays out of these assertions.
const QUIET_MS = PHONE_MS * 20;

function makeManager({ withPhoneChannel = true, phoneEscalationMs = PHONE_MS } = {}) {
  const manager = new NotificationManager({ escalationIntervalMs: 60000, debounceMs: 0, phoneEscalationMs });
  const browser = [];
  const phone = [];
  manager.registerChannel('web', (session, category, message, context) => {
    browser.push({ session, category, message, context });
  });
  if (withPhoneChannel) {
    manager.registerChannel('telegram', (session, category, message, context) => {
      phone.push({ session, category, message, context });
    }, { offDashboard: true });
  }
  // The off-dashboard channel is CALLED on every delivery, as it always has been - its own gate is
  // what decides whether anything leaves the machine. What is new is the flagged delivery, so that is
  // what the rung assertions count.
  const escalations = () => phone.filter((delivery) => delivery.context.phoneEscalation === true);
  return { manager, browser, phone, escalations };
}

const useFakeClock = (t) => t.mock.timers.enable({ apis: ['setTimeout'] });

test('the ladder is explicit in the transition table', () => {
  assert.equal(NOTIFICATION_TRANSITIONS[NS.DELIVERED].phone_escalation, NS.ESCALATED_PHONE);
  assert.equal(NOTIFICATION_TRANSITIONS[NS.ESCALATED].phone_escalation, NS.ESCALATED_PHONE);
  assert.equal(NOTIFICATION_TRANSITIONS[NS.ESCALATED_PHONE].acknowledge, NS.ACKNOWLEDGED);
  assert.equal(NOTIFICATION_TRANSITIONS[NS.ESCALATED_PHONE].trigger, NS.PENDING);
  assert.equal(NOTIFICATION_TRANSITIONS[NS.ESCALATED_PHONE].session_destroyed, NS.IDLE);
  assert.equal(
    NOTIFICATION_TRANSITIONS[NS.ESCALATED_PHONE].phone_escalation, undefined,
    'the rung fires once per entry, so there is no edge back to itself'
  );
});

test('an unacknowledged completion reaches the phone, and only the phone', (t) => {
  useFakeClock(t);
  const { manager, browser, escalations } = makeManager();
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'build finished');
  assert.equal(browser.length, 1, 'the browser notification is best-effort and immediate');

  t.mock.timers.tick(PHONE_MS - 1);
  assert.equal(escalations().length, 0, 'the phone rung has not come due yet');

  t.mock.timers.tick(1);
  assert.equal(manager.getNotificationState('sess-1'), NS.ESCALATED_PHONE);
  assert.equal(escalations().length, 1);
  assert.equal(browser.length, 1, 're-toasting a browser that already ignored it would just repeat it');
});

test('an acknowledgement before the rung comes due cancels it', (t) => {
  useFakeClock(t);
  const { manager, escalations } = makeManager();
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'build finished');
  manager.acknowledge('sess-1');
  t.mock.timers.tick(QUIET_MS);

  assert.deepEqual(escalations(), [], 'the operator reacted; there is nothing to escalate');
  assert.equal(manager.getNotificationState('sess-1'), NS.IDLE);
});

test('a fresh trigger restarts the ladder rather than inheriting the old entry timer', (t) => {
  useFakeClock(t);
  const { manager, escalations } = makeManager();
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'first');
  t.mock.timers.tick(PHONE_MS / 2);
  manager.trigger('sess-1', 'waiting', 'second');

  // The replaced entry's rung was due exactly here.
  t.mock.timers.tick(PHONE_MS / 2);
  assert.deepEqual(escalations(), [], 'the replaced entry does not escalate on the new one behalf');

  // And the replacement's own rung is due half a delay later, timed from ITS delivery.
  t.mock.timers.tick(PHONE_MS / 2);
  assert.equal(escalations().length, 1);
  assert.equal(escalations()[0].message, 'second');
});

test('the rung fires once per entry, not once per escalation round', (t) => {
  useFakeClock(t);
  const { manager, escalations } = makeManager();
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'waiting', 'needs input');
  t.mock.timers.tick(PHONE_MS);
  assert.equal(escalations().length, 1);

  // Back to the browser ping-pong: being reached on the phone does not end an escalation that exists
  // because the agent is still blocked.
  manager._transition('sess-1', 'escalation_tick');
  assert.equal(manager.getNotificationState('sess-1'), NS.DELIVERED);
  t.mock.timers.tick(QUIET_MS);
  assert.equal(escalations().length, 1, 'the rung is latched for the life of the entry');
});

test('with no off-dashboard channel registered nothing is armed at all', (t) => {
  useFakeClock(t);
  const { manager, browser } = makeManager({ withPhoneChannel: false });
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'build finished');
  t.mock.timers.tick(QUIET_MS);

  assert.equal(browser.length, 1);
  assert.equal(manager.getNotificationState('sess-1'), NS.DELIVERED, 'no rung to climb, so no state change');
});

test('a zero escalation delay switches the ladder off', (t) => {
  useFakeClock(t);
  const { manager, escalations } = makeManager({ phoneEscalationMs: 0 });
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'build finished');
  t.mock.timers.tick(QUIET_MS);

  assert.deepEqual(escalations(), []);
  assert.equal(manager.getNotificationState('sess-1'), NS.DELIVERED);
});

// The gate the rung leans on: the AUDIENCE test is what it bypasses, never the opt-in or the
// credentials. An operator who never turned Telegram on is not escalated to.
test('the escalation bypasses the dashboard-open gate and nothing else', () => {
  const configured = { enabled: true, botToken: 'b', chatId: 'c' };
  assert.deepEqual(
    decideTelegramNotification({ ...configured, connectionCount: 3 }),
    { send: false, reason: 'dashboard-open' }
  );
  assert.deepEqual(
    decideTelegramNotification({ ...configured, connectionCount: 3, phoneEscalation: true }),
    { send: true, reason: 'unacknowledged-escalation' }
  );
  assert.deepEqual(
    decideTelegramNotification({ ...configured, enabled: false, connectionCount: 0, phoneEscalation: true }),
    { send: false, reason: 'disabled' }
  );
  assert.deepEqual(
    decideTelegramNotification({ ...configured, botToken: '', connectionCount: 0, phoneEscalation: true }),
    { send: false, reason: 'not-configured' }
  );
});

// The Telegram channel is registered UNCONDITIONALLY and decides per delivery, so "an off-dashboard
// channel exists" is not the same question as "one would deliver this". Arming on the former put a
// five-minute timer on every notification of every install that has Telegram off or unconfigured,
// firing into a channel that drops it.
test('no timer is armed when the off-dashboard channel would not deliver', (t) => {
  useFakeClock(t);
  const manager = new NotificationManager({ escalationIntervalMs: 60000, debounceMs: 0, phoneEscalationMs: PHONE_MS });
  t.after(() => manager.destroy());
  const phone = [];
  let telegramEnabled = false;
  manager.registerChannel('web', () => {});
  manager.registerChannel('telegram', (session, category, message, context) => {
    phone.push({ session, category, message, context });
  }, { offDashboard: true, canEscalate: () => telegramEnabled });

  manager.trigger('sess-1', 'complete', 'build finished');
  t.mock.timers.tick(QUIET_MS);
  assert.equal(manager.getNotificationState('sess-1'), NS.DELIVERED, 'nothing to escalate to');
  assert.equal(phone.filter((d) => d.context.phoneEscalation === true).length, 0);

  // The operator turns Telegram on; the NEXT notification arms, with no restart.
  telegramEnabled = true;
  manager.trigger('sess-2', 'complete', 'other build finished');
  t.mock.timers.tick(PHONE_MS);
  assert.equal(manager.getNotificationState('sess-2'), NS.ESCALATED_PHONE);
});

// A pending escalation is advisory. It must never be the reason the process stays alive for five
// minutes after everything else has shut down. Deliberately on the REAL timer path: a mocked handle
// reports hasRef() true whatever unref() did, so the default wiring is the only place this is true
// coverage rather than a restatement of the fake.
test('the escalation timer is unref\'d', (t) => {
  const { manager } = makeManager({ phoneEscalationMs: 60_000 });
  t.after(() => manager.destroy());
  manager.trigger('sess-1', 'complete', 'build finished');
  const entry = manager._entries.get('sess-1');
  assert.notEqual(entry.phoneTimer, null, 'a timer was armed');
  assert.equal(entry.phoneTimer.hasRef(), false, 'and it does not hold the event loop open');
});

test('the ladder delay is configurable through updateSettings', (t) => {
  useFakeClock(t);
  const { manager, escalations } = makeManager({ phoneEscalationMs: 60_000 });
  t.after(() => manager.destroy());
  manager.updateSettings({ phoneEscalationMs: PHONE_MS });
  manager.trigger('sess-1', 'complete', 'build finished');
  t.mock.timers.tick(PHONE_MS);
  assert.equal(escalations().length, 1, 'the new delay is what the next notification arms with');
});
