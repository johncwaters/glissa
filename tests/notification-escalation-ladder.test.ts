import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { NotificationManager } from '../notifications/notification-manager.ts';
import { NOTIFICATION_STATES as NS, NOTIFICATION_TRANSITIONS } from '../shared/notification-states.ts';
import { decideTelegramNotification } from '../notifications/channels/telegram.ts';
import type { NotificationContext } from '../notifications/notification-manager.ts';

interface RecordedDelivery {
  session: string;
  category: string;
  message: string;
  context: NotificationContext;
}

const PHONE_MS = 50;

const QUIET_MS = PHONE_MS * 20;

function makeManager({ withPhoneChannel = true, phoneEscalationMs = PHONE_MS } = {}) {
  const manager = new NotificationManager({ escalationIntervalMs: 60000, debounceMs: 0, phoneEscalationMs });
  const browser: RecordedDelivery[] = [];
  const phone: RecordedDelivery[] = [];
  manager.registerChannel('web', (session, category, message, context) => {
    browser.push({ session, category, message, context });
  });
  if (withPhoneChannel) {
    manager.registerChannel('telegram', (session, category, message, context) => {
      phone.push({ session, category, message, context });
    }, { offDashboard: true });
  }

  const escalations = () => phone.filter((delivery) => delivery.context.phoneEscalation === true);
  return { manager, browser, phone, escalations };
}

const useFakeClock = (t: TestContext) => t.mock.timers.enable({ apis: ['setTimeout'] });

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

  t.mock.timers.tick(PHONE_MS / 2);
  assert.deepEqual(escalations(), [], 'the replaced entry does not escalate on the new one behalf');

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

test('no timer is armed when the off-dashboard channel would not deliver', (t) => {
  useFakeClock(t);
  const manager = new NotificationManager({ escalationIntervalMs: 60000, debounceMs: 0, phoneEscalationMs: PHONE_MS });
  t.after(() => manager.destroy());
  const phone: RecordedDelivery[] = [];
  let telegramEnabled = false;
  manager.registerChannel('web', () => {});
  manager.registerChannel('telegram', (session, category, message, context) => {
    phone.push({ session, category, message, context });
  }, { offDashboard: true, canEscalate: () => telegramEnabled });

  manager.trigger('sess-1', 'complete', 'build finished');
  t.mock.timers.tick(QUIET_MS);
  assert.equal(manager.getNotificationState('sess-1'), NS.DELIVERED, 'nothing to escalate to');
  assert.equal(phone.filter((d) => d.context.phoneEscalation === true).length, 0);

  telegramEnabled = true;
  manager.trigger('sess-2', 'complete', 'other build finished');
  t.mock.timers.tick(PHONE_MS);
  assert.equal(manager.getNotificationState('sess-2'), NS.ESCALATED_PHONE);
});

test('the escalation timer is unref\'d', (t) => {
  const { manager } = makeManager({ phoneEscalationMs: 60_000 });
  t.after(() => manager.destroy());
  manager.trigger('sess-1', 'complete', 'build finished');
  const entry = manager._entries.get('sess-1');
  assert.ok(entry?.phoneTimer, 'a timer was armed');
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
