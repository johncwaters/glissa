// Control-WS dispatch hardening: a bracket lookup on the handler map resolves inherited keys, so a
// {"type":"__proto__"} message used to dereference Object.prototype and throw synchronously inside the
// 'message' listener, killing the whole process (no uncaughtException handler exists by design). The
// dispatch must ignore non-string and non-own-property types.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createReplayLog } from '../server/control-replay-core.ts';
import type { ReplayLog } from '../server/control-replay-core.ts';
import type { ControlConnection } from './helpers/control-harness.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

interface DispatchFrame {
  type: string;
  seq?: number;
  n?: number;
  requestId?: string;
  serverBuild?: string | null;
}

function harness(): ControlConnection<DispatchFrame> {
  const server = createControlServer(controlDeps({ projects: [] }));
  const connection = connectControl<DispatchFrame>(server);
  connection.sent.length = 0; // drop the connect preamble
  return connection;
}

test('inherited-key message types are ignored, not dispatched', () => {
  const h = harness();
  assert.doesNotThrow(() => h.send({ type: '__proto__' }));
  assert.doesNotThrow(() => h.send({ type: 'constructor' }));
  assert.doesNotThrow(() => h.send({ type: 'hasOwnProperty' }));
  assert.equal(h.sent.length, 0, 'nothing sent back');
});

test('non-string and unknown message types are ignored', () => {
  const h = harness();
  assert.doesNotThrow(() => h.send({ type: 42 }));
  assert.doesNotThrow(() => h.send({ type: null }));
  assert.doesNotThrow(() => h.send({}));
  assert.doesNotThrow(() => h.send({ type: 'no-such-handler' }));
  assert.equal(h.sent.length, 0, 'nothing sent back');
});

test('non-object payloads are ignored', () => {
  const h = harness();
  assert.doesNotThrow(() => h.send(null), 'a literal null frame must not crash the dispatch');
  assert.doesNotThrow(() => h.send(42));
  assert.doesNotThrow(() => h.send('kill'));
  assert.doesNotThrow(() => h.send(['type', 'kill']));
  assert.equal(h.sent.length, 0, 'nothing sent back');
});

test('ping with requestId replies pong on the requesting socket only', () => {
  const h = harness();
  h.send({ type: 'ping', requestId: 'r1' });
  assert.deepEqual(h.sent, [{ type: 'pong', requestId: 'r1' }]);
});

test('ping without requestId sends no reply', () => {
  const h = harness();
  h.send({ type: 'ping' });
  assert.equal(h.sent.length, 0, 'nothing sent back');
});

// Item D: control-WS replay of transient broadcasts missed across a reconnect gap.
// This harness wires a real createReplayLog through broadcastControl (mirroring backend.ts's
// stamp-then-fanout) and lets a test connect a fresh socket with an explicit `?since=` cursor,
// like a reconnecting dashboard would.
function harnessWithReplay(replayLog: ReplayLog) {
  const server = createControlServer(controlDeps({ projects: [] }, {
    broadcastControl: (msg) => { replayLog.stamp({ ...msg }); },
    controlReplayLog: replayLog,
  }));
  return {
    // Drops the per-connection client-trust frame: these tests count REPLAY frames, and the
    // connection preamble is pinned by control-client-trust.test.ts instead.
    connect(url: string): DispatchFrame[] {
      const connection = connectControl<DispatchFrame>(server, { url });
      return connection.sent.filter((frame) => frame.type !== 'client-trust');
    },
  };
}

test('a reconnect with ?since replays only the missed replayable broadcasts, after the snapshot', () => {
  const replayLog = createReplayLog();
  const h = harnessWithReplay(replayLog);

  // Broadcasts that happened while this client was disconnected.
  replayLog.stamp({ type: 'notify', message: 'hi' });
  replayLog.stamp({ type: 'session-changed', id: 'a' });

  const sent = h.connect('/control?since=0');
  assert.equal(sent.length, 2, 'snapshot then exactly one replayed notify');
  assert.equal(sent[0].type, 'snapshot');
  assert.equal(sent[1].type, 'notify');
});

// Stale seq on a cached object silently drops it behind a younger lane's replay.
test('a cached lane status replayed on connect carries no stale seq', () => {
  const replayLog = createReplayLog();
  const posthogStatus = { type: 'posthog-status', configured: true };
  const prStatus = { type: 'pr-status', configured: true };
  const server = createControlServer(controlDeps({ projects: [] }, {
    broadcastControl: (msg) => { replayLog.stamp({ ...msg }); },
    controlReplayLog: replayLog,
    getPosthogStatus: () => posthogStatus,
    getPrStatus: () => prStatus,
  }));
  replayLog.stamp({ ...prStatus });
  replayLog.stamp({ ...posthogStatus });

  const { sent } = connectControl<DispatchFrame>(server, { url: '/control' });

  const replayed = sent.filter((m) => m.type === 'posthog-status' || m.type === 'pr-status');
  assert.equal(replayed.length, 2, 'both cached lane statuses replayed');
  for (const msg of replayed) assert.equal(msg.seq, undefined, `${msg.type} must be seq-less`);
});

test('no ?since param (first connect) replays nothing', () => {
  const replayLog = createReplayLog();
  const h = harnessWithReplay(replayLog);
  replayLog.stamp({ type: 'notify', message: 'hi' });

  const sent = h.connect('/control');
  assert.equal(sent.length, 1, 'snapshot only');
  assert.equal(sent[0].type, 'snapshot');
});

test('a since behind an overflowed ring still replays the surviving entries and logs the evicted note', (t) => {
  const replayLog = createReplayLog({ maxEntries: 2 });
  const h = harnessWithReplay(replayLog);
  replayLog.stamp({ type: 'notify', n: 1 }); // evicted once n:3 lands
  replayLog.stamp({ type: 'notify', n: 2 });
  replayLog.stamp({ type: 'notify', n: 3 });

  // t.mock.method (not a manual `console.log = fn` swap) - the test runner's own reporting
  // instrumentation does not play well with a hand-rolled monkey-patch of console.log here.
  const logSpy = t.mock.method(console, 'log');
  const sent = h.connect('/control?since=0');

  assert.equal(sent.length, 3, 'snapshot plus the two surviving notify entries');
  assert.equal(sent[0].type, 'snapshot');
  assert.deepEqual(sent.slice(1).map((m) => m.n), [2, 3]);
  assert.ok(
    logSpy.mock.calls.some((call) => String(call.arguments[0]).includes('stale')),
    'the evicted-cursor note is logged for the caller',
  );
});

// Fix (Item D follow-up): the client-side seq reset on server restart relies on the per-connection
// snapshot ALWAYS being seq-less, so it can be told apart from a config-reload snapshot broadcast
// (which IS stamped, and must not reset the client's cursor). Locks that invariant server-side.
test('the per-connection snapshot has no seq, but a snapshot sent through broadcastControl does', () => {
  const replayLog = createReplayLog();
  const h = harnessWithReplay(replayLog);

  const sent = h.connect('/control');
  assert.equal(sent[0].type, 'snapshot');
  assert.equal('seq' in sent[0], false, 'the per-connection snapshot bypasses broadcastControl/stamp');

  const broadcastSnapshot = replayLog.stamp({ type: 'snapshot', sessions: [] });
  assert.equal(typeof broadcastSnapshot.seq, 'number', 'a snapshot broadcast through stamp is numbered like any other broadcast');
});

// Envelope versioning (2026-08 review, section 1). The dashboard is served by the same process, so
// the only skew case is a tab left open across a server update: it reconnects to a backend whose
// frames its bundle may predate. The client reloads on a CHANGE (public/app.ts noteServerBuild).
test('the connect snapshot identifies the backend build it came from', () => {
  const server = createControlServer(controlDeps({ projects: [] }, { serverBuild: () => '0.22.0+deadbeef' }));
  const { sent } = connectControl<DispatchFrame>(server);
  assert.equal(sent[0].type, 'snapshot');
  assert.equal(sent[0].serverBuild, '0.22.0+deadbeef');
});

test('a caller that declares no build sends null rather than omitting the field', () => {
  const server = createControlServer(controlDeps({ projects: [] }));
  const { sent } = connectControl<DispatchFrame>(server);
  assert.equal(sent[0].serverBuild, null, 'an absent field would read as "unchanged" to the client');
});
