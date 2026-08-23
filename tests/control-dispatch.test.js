'use strict';

// Control-WS dispatch hardening: a bracket lookup on the handler map resolves inherited keys, so a
// {"type":"__proto__"} message used to dereference Object.prototype and throw synchronously inside the
// 'message' listener, killing the whole process (no uncaughtException handler exists by design). The
// dispatch must ignore non-string and non-own-property types. Mirrors the fake-controlWss harness used
// by control-resume.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../server/control-handlers');
const { createReplayLog } = require('../server/control-replay-core');

function harness() {
  const controlWss = new EventEmitter();
  const sent = [];
  let messageHandler = null;
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: (ev, h) => { if (ev === 'message') messageHandler = h; } };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: { projects: [], teams: [] },
    configStore: { save: (fn) => fn({ projects: [], teams: [] }), getSettings: () => ({}) },
    applyConfigReload: () => {},
    broadcastControl: () => {},
  });
  controlWss.emit('connection', ws);
  sent.length = 0; // drop the initial snapshot
  return { send: (msg) => messageHandler(JSON.stringify(msg)), sent };
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
// This harness wires a real createReplayLog through broadcastControl (mirroring backend.js's
// stamp-then-fanout) and lets a test connect a fresh ws with an explicit `?since=` cursor,
// like a reconnecting dashboard would.
function harnessWithReplay(replayLog) {
  const controlWss = new EventEmitter();
  function connect(url) {
    const sent = [];
    let messageHandler = null;
    // Drop the per-connection client-trust frame: these tests count REPLAY frames, and the
    // connection preamble is pinned by control-client-trust.test.js instead.
    const ws = {
      send: (s) => { const msg = JSON.parse(s); if (msg.type !== 'client-trust') sent.push(msg); },
      on: (ev, h) => { if (ev === 'message') messageHandler = h; },
    };
    controlWss.emit('connection', ws, { url });
    return { sent, send: (msg) => messageHandler(JSON.stringify(msg)) };
  }
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: { projects: [], teams: [] },
    configStore: { save: (fn) => fn({ projects: [], teams: [] }), getSettings: () => ({}) },
    applyConfigReload: () => {},
    broadcastControl: (msg) => replayLog.stamp({ ...msg }),
    controlReplayLog: replayLog,
  });
  return { connect };
}

test('a reconnect with ?since replays only the missed replayable broadcasts, after the snapshot', () => {
  const replayLog = createReplayLog();
  const h = harnessWithReplay(replayLog);

  // Broadcasts that happened while this client was disconnected.
  replayLog.stamp({ type: 'notify', message: 'hi' });
  replayLog.stamp({ type: 'session-changed', id: 'a' });

  const client = h.connect('/control?since=0');
  assert.equal(client.sent.length, 2, 'snapshot then exactly one replayed notify');
  assert.equal(client.sent[0].type, 'snapshot');
  assert.equal(client.sent[1].type, 'notify');
});

// Stale seq on a cached object silently drops it behind a younger lane's replay.
test('a cached lane status replayed on connect carries no stale seq', () => {
  const replayLog = createReplayLog();
  const broadcastControl = (msg) => replayLog.stamp({ ...msg });
  const posthogStatus = { type: 'posthog-status', configured: true };
  const prStatus = { type: 'pr-status', configured: true };
  broadcastControl(prStatus);
  broadcastControl(posthogStatus);

  const controlWss = new EventEmitter();
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: { projects: [], teams: [] },
    configStore: { save: (fn) => fn({ projects: [], teams: [] }), getSettings: () => ({}) },
    applyConfigReload: () => {},
    broadcastControl,
    controlReplayLog: replayLog,
    getPosthogStatus: () => posthogStatus,
    getPrStatus: () => prStatus,
  });
  const sent = [];
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: () => {} };
  controlWss.emit('connection', ws, { url: '/control' });

  const replayed = sent.filter((m) => m.type === 'posthog-status' || m.type === 'pr-status');
  assert.equal(replayed.length, 2, 'both cached lane statuses replayed');
  for (const msg of replayed) assert.equal(msg.seq, undefined, `${msg.type} must be seq-less`);
});

test('no ?since param (first connect) replays nothing', () => {
  const replayLog = createReplayLog();
  const h = harnessWithReplay(replayLog);
  replayLog.stamp({ type: 'notify', message: 'hi' });

  const client = h.connect('/control');
  assert.equal(client.sent.length, 1, 'snapshot only');
  assert.equal(client.sent[0].type, 'snapshot');
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
  const client = h.connect('/control?since=0');

  assert.equal(client.sent.length, 3, 'snapshot plus the two surviving notify entries');
  assert.equal(client.sent[0].type, 'snapshot');
  assert.deepEqual(client.sent.slice(1).map((m) => m.n), [2, 3]);
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

  const client = h.connect('/control');
  assert.equal(client.sent[0].type, 'snapshot');
  assert.equal('seq' in client.sent[0], false, 'the per-connection snapshot bypasses broadcastControl/stamp');

  const broadcastSnapshot = replayLog.stamp({ type: 'snapshot', sessions: [] });
  assert.equal(typeof broadcastSnapshot.seq, 'number', 'a snapshot broadcast through stamp is numbered like any other broadcast');
});

// Envelope versioning (2026-08 review, section 1). The dashboard is served by the same process, so
// the only skew case is a tab left open across a server update: it reconnects to a backend whose
// frames its bundle may predate. The client reloads on a CHANGE (public/app.js noteServerBuild).
test('the connect snapshot identifies the backend build it came from', () => {
  const controlWss = new EventEmitter();
  const sent = [];
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: () => {} };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: { projects: [], teams: [] },
    configStore: { save: (fn) => fn({ projects: [], teams: [] }), getSettings: () => ({}) },
    applyConfigReload: () => {},
    broadcastControl: () => {},
    serverBuild: () => '0.22.0+deadbeef',
  });
  controlWss.emit('connection', ws);
  assert.equal(sent[0].type, 'snapshot');
  assert.equal(sent[0].serverBuild, '0.22.0+deadbeef');
});

test('a caller that declares no build sends null rather than omitting the field', () => {
  const h = harnessSnapshot();
  assert.equal(h.snapshot.serverBuild, null, 'an absent field would read as "unchanged" to the client');
});

function harnessSnapshot() {
  const controlWss = new EventEmitter();
  const sent = [];
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: () => {} };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: { projects: [], teams: [] },
    configStore: { save: (fn) => fn({ projects: [], teams: [] }), getSettings: () => ({}) },
    applyConfigReload: () => {},
    broadcastControl: () => {},
  });
  controlWss.emit('connection', ws);
  return { snapshot: sent[0] };
}
