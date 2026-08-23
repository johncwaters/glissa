'use strict';

// The escalation ladder's last rung (2026-08 review, section 5, promoted by the operator's ruling to
// the section's one endorsed durability investment).
//
// The shape: deliver browser best-effort, wait for an acknowledgement, and escalate an unacknowledged
// notification to the off-dashboard channel EVEN WHILE CONNECTIONS ARE OPEN. A dashboard being open
// is what the ordinary Telegram gate keys on, and this rung is the one delivery that disbelieves it:
// the operator was shown a browser notification and did not act on it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { NotificationManager } = require('../notifications/notification-manager');
const { NOTIFICATION_STATES: NS, NOTIFICATION_TRANSITIONS } = require('../shared/notification-states');
const { decideTelegramNotification } = require('../notifications/channels/telegram');

const PHONE_MS = 50;

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

const settle = (ms = PHONE_MS + 30) => new Promise((resolve) => setTimeout(resolve, ms));

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

test('an unacknowledged completion reaches the phone, and only the phone', async (t) => {
  const { manager, browser, escalations } = makeManager();
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'build finished');
  assert.equal(browser.length, 1, 'the browser notification is best-effort and immediate');
  assert.equal(escalations().length, 0, 'the phone rung has not come due yet');

  await settle();

  assert.equal(manager.getNotificationState('sess-1'), NS.ESCALATED_PHONE);
  assert.equal(escalations().length, 1);
  assert.equal(browser.length, 1, 're-toasting a browser that already ignored it would just repeat it');
});

test('an acknowledgement before the rung comes due cancels it', async (t) => {
  const { manager, escalations } = makeManager();
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'build finished');
  manager.acknowledge('sess-1');
  await settle();

  assert.deepEqual(escalations(), [], 'the operator reacted; there is nothing to escalate');
  assert.equal(manager.getNotificationState('sess-1'), NS.IDLE);
});

test('a fresh trigger restarts the ladder rather than inheriting the old entry timer', async (t) => {
  const { manager, escalations } = makeManager();
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'first');
  await settle(PHONE_MS / 2);
  manager.trigger('sess-1', 'waiting', 'second');
  await settle(PHONE_MS / 2);
  assert.deepEqual(escalations(), [], 'the replaced entry does not escalate on the new one behalf');

  await settle();
  assert.equal(escalations().length, 1);
  assert.equal(escalations()[0].message, 'second');
});

test('the rung fires once per entry, not once per escalation round', async (t) => {
  const { manager, escalations } = makeManager();
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'waiting', 'needs input');
  await settle();
  assert.equal(escalations().length, 1);

  // Back to the browser ping-pong: being reached on the phone does not end an escalation that exists
  // because the agent is still blocked.
  manager._transition('sess-1', 'escalation_tick');
  assert.equal(manager.getNotificationState('sess-1'), NS.DELIVERED);
  await settle();
  assert.equal(escalations().length, 1, 'the rung is latched for the life of the entry');
});

test('with no off-dashboard channel registered nothing is armed at all', async (t) => {
  const { manager, browser } = makeManager({ withPhoneChannel: false });
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'build finished');
  await settle();

  assert.equal(browser.length, 1);
  assert.equal(manager.getNotificationState('sess-1'), NS.DELIVERED, 'no rung to climb, so no state change');
});

test('a zero escalation delay switches the ladder off', async (t) => {
  const { manager, escalations } = makeManager({ phoneEscalationMs: 0 });
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'build finished');
  await settle();

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
