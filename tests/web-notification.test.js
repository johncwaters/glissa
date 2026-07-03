'use strict';

// Payload-shape tests for channels/web-notification.js. The channel is a dumb
// delivery pipe: it takes a broadcast function and, per call, emits exactly
// one control-WS `notify` message with a fixed field set.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWebNotificationChannel } = require('../notifications/channels/web-notification');

function makeBroadcastSpy() {
  const calls = [];
  const broadcast = (msg) => calls.push(msg);
  return { broadcast, calls };
}

test('broadcasts a notify message with type/session/category/message fields', () => {
  const { broadcast, calls } = makeBroadcastSpy();
  const channel = createWebNotificationChannel(broadcast);

  channel('my-session', 'complete', 'finished working', { escalationCount: 0 });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: 'notify',
    session: 'my-session',
    category: 'complete',
    message: 'finished working',
    escalationCount: 0,
  });
});

test('carries escalationCount from context when present', () => {
  const { broadcast, calls } = makeBroadcastSpy();
  const channel = createWebNotificationChannel(broadcast);

  channel('s1', 'waiting', 'needs input', { escalationCount: 3 });

  assert.equal(calls[0].escalationCount, 3);
});

test('defaults escalationCount to 0 when context is null/undefined', () => {
  const { broadcast, calls } = makeBroadcastSpy();
  const channel = createWebNotificationChannel(broadcast);

  channel('s1', 'failed', 'crashed', null);
  channel('s1', 'failed', 'crashed', undefined);

  assert.equal(calls[0].escalationCount, 0);
  assert.equal(calls[1].escalationCount, 0);
});

test('each notification category (complete/waiting/failed) produces the same shape with its own category value', () => {
  const { broadcast, calls } = makeBroadcastSpy();
  const channel = createWebNotificationChannel(broadcast);

  channel('s1', 'complete', 'msg-complete', { escalationCount: 0 });
  channel('s1', 'waiting', 'msg-waiting', { escalationCount: 1 });
  channel('s1', 'failed', 'msg-failed', { escalationCount: 2 });

  assert.deepEqual(calls.map((c) => c.category), ['complete', 'waiting', 'failed']);
  assert.deepEqual(calls.map((c) => c.type), ['notify', 'notify', 'notify']);
  for (const call of calls) {
    assert.deepEqual(Object.keys(call).sort(), ['category', 'escalationCount', 'message', 'session', 'type']);
  }
});

test('does not mutate or read extra fields off the context object beyond escalationCount', () => {
  const { broadcast, calls } = makeBroadcastSpy();
  const channel = createWebNotificationChannel(broadcast);
  const context = { escalationCount: 1, unrelated: 'should-not-leak' };

  channel('s1', 'waiting', 'still waiting', context);

  assert.deepEqual(context, { escalationCount: 1, unrelated: 'should-not-leak' }, 'context left unmutated');
  assert.equal('unrelated' in calls[0], false, 'extra context fields must not leak into the payload');
});

test('createWebNotificationChannel returns a fresh function per call, each bound to its own broadcast', () => {
  const spyA = makeBroadcastSpy();
  const spyB = makeBroadcastSpy();
  const channelA = createWebNotificationChannel(spyA.broadcast);
  const channelB = createWebNotificationChannel(spyB.broadcast);

  channelA('s1', 'complete', 'a', {});
  channelB('s2', 'failed', 'b', {});

  assert.equal(spyA.calls.length, 1);
  assert.equal(spyB.calls.length, 1);
  assert.equal(spyA.calls[0].session, 's1');
  assert.equal(spyB.calls[0].session, 's2');
});

test('propagates a broadcast function throw to the caller (no swallowing)', () => {
  const broadcast = () => { throw new Error('ws down'); };
  const channel = createWebNotificationChannel(broadcast);

  assert.throws(() => channel('s1', 'complete', 'msg', {}), /ws down/);
});
