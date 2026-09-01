import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createHeartbeat } from '../server/ws-heartbeat.ts';
import type { HeartbeatServer, HeartbeatSocket } from '../server/ws-heartbeat.ts';
import { planHeartbeatSweep, DEFAULT_DEADLINE_MS } from '../server/core/heartbeat-core.ts';
import { createClientPresence, decideOffDashboardDelivery } from '../server/core/client-presence.ts';

type FakeSocket = EventEmitter & {
  pings: number;
  terminated: boolean;
  ping: () => void;
  terminate: () => void;
};

function fakeSocket({ answersPings = true }: { answersPings?: boolean } = {}): FakeSocket {
  const emitter = new EventEmitter();
  const ws: FakeSocket = Object.assign(emitter, {
    pings: 0,
    terminated: false,
    ping: () => {
      ws.pings += 1;
      if (answersPings) ws.emit('pong');
    },
    terminate: () => {
      ws.terminated = true;
      ws.emit('close');
    },
  });
  return ws;
}

function fakeServer(clients: HeartbeatSocket[]): HeartbeatServer {
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
  const terminated: HeartbeatSocket[] = [];
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
  const intervals: NodeJS.Timeout[] = [];
  const cleared: NodeJS.Timeout[] = [];
  const heartbeat = createHeartbeat({
    servers: [],
    setIntervalFn: (fn, ms) => {
      const handle = setInterval(fn, ms);
      handle.unref();
      intervals.push(handle);
      return handle;
    },
    clearIntervalFn: (handle) => {
      clearInterval(handle);
      cleared.push(handle);
    },
  });
  heartbeat.start();
  heartbeat.start();
  assert.equal(intervals.length, 1, 'a second start is a no-op, not a second timer');
  heartbeat.stop();
  assert.deepEqual(cleared, intervals);
});

test('a zombie connection stops blocking the Telegram gate once the heartbeat reaps it', () => {
  let clock = 1000;
  const presence = createClientPresence();
  const zombie = fakeSocket({ answersPings: false });
  const heartbeat = createHeartbeat({ servers: [fakeServer([zombie])], now: () => clock });

  presence.connect(zombie);
  zombie.on('close', () => presence.disconnect(zombie));
  heartbeat.track(zombie);

  assert.equal(presence.connectionCount(), 1);
  assert.equal(
    decideOffDashboardDelivery(presence.connectionCount()), false,
    'the bug: a socket nobody is on looks like a dashboard someone is watching',
  );

  clock += DEFAULT_DEADLINE_MS + 1;
  heartbeat.sweep();

  assert.equal(zombie.terminated, true);
  assert.equal(presence.connectionCount(), 0, 'terminate emits close, which drains the presence count');
  assert.equal(
    decideOffDashboardDelivery(presence.connectionCount()), true,
    'and the channel of last resort can finally fire',
  );
});
