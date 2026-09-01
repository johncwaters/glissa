'use strict';

// Protocol ping/pong and the zombie reaper (2026-08 review, section 1).
//
// THE ACCEPTANCE TEST is the last one here: a half-open socket used to sit in the presence count
// until the OS timeout, and while it did, the Telegram zero-connections gate stayed shut. That gate
// is the channel of last resort - it exists precisely for when nobody is looking at a dashboard - so
// a connection nobody is on silently disabled the one notification that would have reached the
// operator.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createHeartbeat } = require('../server/ws-heartbeat');
const { planHeartbeatSweep, DEFAULT_DEADLINE_MS } = require('../server/core/heartbeat-core.ts');
const { createClientPresence, decideOffDashboardDelivery } = require('../server/core/client-presence.ts');

// A socket that answers pings, or does not. terminate() emits 'close' the way ws does, which is what
// the presence bookkeeping listens to.
function fakeSocket({ answersPings = true } = {}) {
  const ws = new EventEmitter();
  ws.pings = 0;
  ws.terminated = false;
  ws.ping = () => {
    ws.pings += 1;
    if (answersPings) ws.emit('pong');
  };
  ws.terminate = () => { ws.terminated = true; ws.emit('close'); };
  return ws;
}

function fakeServer(clients) {
  return { clients: new Set(clients) };
}

test('planHeartbeatSweep pings the live and terminates only the silent', () => {
  const now = 1_000_000;
  const plan = planHeartbeatSweep([
    { key: 'fresh', lastSeenAt: now },
    { key: 'recent', lastSeenAt: now - 1000 },
    { key: 'silent', lastSeenAt: now - DEFAULT_DEADLINE_MS - 1 },
  ], { now });
  assert.deepEqual(plan.terminate, ['silent']);
  assert.deepEqual(plan.ping, ['fresh', 'recent']);
});

test('a socket exactly at the deadline is not yet silence', () => {
  const now = 1_000_000;
  const plan = planHeartbeatSweep([{ key: 'edge', lastSeenAt: now - DEFAULT_DEADLINE_MS }], { now });
  assert.deepEqual(plan.terminate, []);
});

test('a socket with no recorded sighting is treated as just seen, never reaped on its first sweep', () => {
  const plan = planHeartbeatSweep([{ key: 'new', lastSeenAt: undefined }], { now: 5000 });
  assert.deepEqual(plan.terminate, []);
  assert.deepEqual(plan.ping, ['new']);
});

test('a live socket is pinged and stays, sweep after sweep', () => {
  let clock = 1000;
  const ws = fakeSocket();
  const heartbeat = createHeartbeat({ servers: [fakeServer([ws])], now: () => clock });
  heartbeat.track(ws);

  clock += 30_000;
  heartbeat.sweep();
  clock += 30_000;
  heartbeat.sweep();
  assert.equal(ws.pings, 2);
  assert.equal(ws.terminated, false, 'the pong keeps resetting the deadline');
});

test('a socket that never answers is terminated once the deadline passes', () => {
  let clock = 1000;
  const ws = fakeSocket({ answersPings: false });
  const terminated = [];
  const heartbeat = createHeartbeat({
    servers: [fakeServer([ws])], now: () => clock, onTerminate: (dead) => terminated.push(dead),
  });
  heartbeat.track(ws);

  clock += 30_000;
  heartbeat.sweep();
  assert.equal(ws.terminated, false, 'one missed round is a hiccup, not a dead socket');

  clock += 60_000;
  heartbeat.sweep();
  assert.equal(ws.terminated, true);
  assert.deepEqual(terminated, [ws]);
});

test('any traffic counts as liveness, so a busy socket is never probed into a false positive', () => {
  let clock = 1000;
  const ws = fakeSocket({ answersPings: false });
  const heartbeat = createHeartbeat({ servers: [fakeServer([ws])], now: () => clock });
  heartbeat.track(ws);

  clock += 60_000;
  ws.emit('message', '{"type":"ping"}');
  clock += 30_000;
  heartbeat.sweep();
  assert.equal(ws.terminated, false);
});

test('start and stop own exactly one interval', () => {
  const intervals = [];
  const cleared = [];
  const heartbeat = createHeartbeat({
    servers: [],
    setIntervalFn: (fn, ms) => { const handle = { fn, ms }; intervals.push(handle); return handle; },
    clearIntervalFn: (handle) => cleared.push(handle),
  });
  heartbeat.start();
  heartbeat.start();
  assert.equal(intervals.length, 1, 'a second start is a no-op, not a second timer');
  heartbeat.stop();
  assert.deepEqual(cleared, intervals);
});

// The one that matters: presence drains and the phone channel opens.
test('a zombie connection stops blocking the Telegram gate once the heartbeat reaps it', () => {
  let clock = 1000;
  const presence = createClientPresence();
  const zombie = fakeSocket({ answersPings: false });
  const heartbeat = createHeartbeat({ servers: [fakeServer([zombie])], now: () => clock });

  // Exactly what backend.js wires: presence on connect, presence off on close, heartbeat tracking.
  presence.connect(zombie);
  zombie.on('close', () => presence.disconnect(zombie));
  heartbeat.track(zombie);

  assert.equal(presence.connectionCount(), 1);
  assert.equal(
    decideOffDashboardDelivery(presence.connectionCount()), false,
    'the bug: a socket nobody is on looks like a dashboard someone is watching'
  );

  clock += DEFAULT_DEADLINE_MS + 1;
  heartbeat.sweep();

  assert.equal(zombie.terminated, true);
  assert.equal(presence.connectionCount(), 0, 'terminate emits close, which drains the presence count');
  assert.equal(
    decideOffDashboardDelivery(presence.connectionCount()), true,
    'and the channel of last resort can finally fire'
  );
});
