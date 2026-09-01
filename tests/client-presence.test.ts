import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createClientPresence, decideFocusSuppression, decideOffDashboardDelivery,
} from '../server/core/client-presence.ts';

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

test('decideOffDashboardDelivery keys on connection count alone, never focus', () => {
  assert.equal(decideOffDashboardDelivery(0), true, 'nobody connected');
  assert.equal(decideOffDashboardDelivery(1), false, 'an unfocused tab still raises the browser toast');
  assert.equal(decideOffDashboardDelivery(3), false);
});
