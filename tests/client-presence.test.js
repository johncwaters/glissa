'use strict';

// Per-connection focus suppression (server/core/client-presence.js). The rule remote mode forced:
// a notification is held ONLY while every open control connection reports focused. The failure this
// replaces is a dashboard focused at the desk suppressing a paired phone forever.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createClientPresence, decideFocusSuppression, decideOffDashboardDelivery,
} = require('../server/core/client-presence');

test('decideFocusSuppression: zero connections never suppresses', () => {
  assert.equal(decideFocusSuppression([]), false);
  assert.equal(decideFocusSuppression(undefined), false);
  assert.equal(decideFocusSuppression(null), false);
});

test('decideFocusSuppression: one connection follows its own focus', () => {
  assert.equal(decideFocusSuppression([true]), true);
  assert.equal(decideFocusSuppression([false]), false);
});

test('decideFocusSuppression: N connections suppress only when ALL report focused', () => {
  assert.equal(decideFocusSuppression([true, true]), true);
  assert.equal(decideFocusSuppression([true, false]), false, 'the unfocused device must be told');
  assert.equal(decideFocusSuppression([false, true]), false);
  assert.equal(decideFocusSuppression([false, false]), false);
  assert.equal(decideFocusSuppression([true, true, true]), true);
  assert.equal(decideFocusSuppression([true, true, false]), false);
});

test('decideOffDashboardDelivery: only a completely absent dashboard warrants an off-dashboard ping', () => {
  assert.equal(decideOffDashboardDelivery(0), true);
  assert.equal(decideOffDashboardDelivery(1), false);
  assert.equal(decideOffDashboardDelivery(5), false);
});

test('a connection registers as unfocused until it reports otherwise', () => {
  const presence = createClientPresence();
  presence.connect('a');
  assert.equal(presence.connectionCount(), 1);
  assert.equal(presence.shouldSuppress(), false, 'a silent connection must not suppress');
  presence.setFocus('a', true);
  assert.equal(presence.shouldSuppress(), true);
});

test('connect is idempotent and never clobbers a reported focus', () => {
  const presence = createClientPresence();
  presence.connect('a');
  presence.setFocus('a', true);
  presence.connect('a');
  assert.equal(presence.connectionCount(), 1);
  assert.equal(presence.shouldSuppress(), true, 'a duplicate connect must not reset focus to false');
});

test('desk focused + phone connected: the phone still gets delivered', () => {
  const presence = createClientPresence();
  presence.connect('desk');
  presence.connect('phone');
  presence.setFocus('desk', true);
  assert.equal(presence.shouldSuppress(), false);
  presence.setFocus('phone', true);
  assert.equal(presence.shouldSuppress(), true, 'every screen shows the dashboard');
});

test('blur of the last focused connection releases suppression', () => {
  const presence = createClientPresence();
  presence.connect('a');
  presence.connect('b');
  presence.setFocus('a', true);
  presence.setFocus('b', true);
  assert.equal(presence.shouldSuppress(), true);
  presence.setFocus('b', false);
  assert.equal(presence.shouldSuppress(), false);
});

test('disconnect recounts: a dashboard that dies while focused cannot suppress forever', () => {
  const presence = createClientPresence();
  presence.connect('crashed');
  presence.setFocus('crashed', true);
  assert.equal(presence.shouldSuppress(), true);
  presence.disconnect('crashed');
  assert.equal(presence.connectionCount(), 0);
  assert.equal(presence.shouldSuppress(), false);
  assert.equal(presence.shouldSendOffDashboard(), true);
});

test('disconnecting the unfocused peer of a focused connection re-suppresses', () => {
  const presence = createClientPresence();
  presence.connect('desk');
  presence.connect('phone');
  presence.setFocus('desk', true);
  assert.equal(presence.shouldSuppress(), false);
  presence.disconnect('phone');
  assert.equal(presence.shouldSuppress(), true, 'only the focused desk is left watching');
});

test('a focus report from an unregistered connection is honored, not dropped', () => {
  const presence = createClientPresence();
  presence.setFocus('early', true);
  assert.equal(presence.connectionCount(), 1);
  assert.equal(presence.shouldSuppress(), true);
});

test('disconnect of an unknown key is a no-op', () => {
  const presence = createClientPresence();
  presence.connect('a');
  presence.disconnect('ghost');
  assert.equal(presence.connectionCount(), 1);
});

test('shouldSendOffDashboard tracks connections, not focus', () => {
  const presence = createClientPresence();
  assert.equal(presence.shouldSendOffDashboard(), true, 'nobody connected');
  presence.connect('a');
  assert.equal(presence.shouldSendOffDashboard(), false, 'an unfocused tab still raises the browser toast');
  presence.setFocus('a', true);
  assert.equal(presence.shouldSendOffDashboard(), false);
  presence.disconnect('a');
  assert.equal(presence.shouldSendOffDashboard(), true);
});
