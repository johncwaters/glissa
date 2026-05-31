'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWsSender, DEFAULTS } = require('../ws-sender');

// Minimal ws double: records sends/close, exposes a settable bufferedAmount.
function fakeWs({ bufferedAmount = 0, readyState = 1 } = {}) {
  return {
    readyState,
    bufferedAmount,
    sent: [],
    closed: null,
    send(d) { this.sent.push(d); },
    close(code, reason) { this.closed = { code, reason }; this.readyState = 3; },
  };
}

// Deterministic scheduler: nothing runs until the test pumps it.
function manualScheduler() {
  const micro = [];
  const timers = [];
  return {
    setImmediateFn: (fn) => { micro.push(fn); return {}; },
    setTimeoutFn: (fn) => { const t = { fn, cleared: false }; timers.push(t); return t; },
    clearTimeoutFn: (t) => { if (t) t.cleared = true; },
    runMicro() { for (const fn of micro.splice(0)) fn(); },
    runTimers() { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); },
    pendingTimers() { return timers.filter((t) => !t.cleared).length; },
  };
}

function makeSender(ws, sched, opts = {}) {
  return createWsSender(ws, {
    setImmediateFn: sched.setImmediateFn,
    setTimeoutFn: sched.setTimeoutFn,
    clearTimeoutFn: sched.clearTimeoutFn,
    ...opts,
  });
}

test('normal data coalesces until the scheduled flush', () => {
  const ws = fakeWs();
  const sched = manualScheduler();
  const s = makeSender(ws, sched);

  s.onData('a');
  s.onData('b');
  assert.deepEqual(ws.sent, [], 'nothing sent before the immediate fires');
  sched.runMicro();
  assert.deepEqual(ws.sent, ['ab'], 'coalesced into one frame');
});

test('AC6: input marks the next PTY frame to flush immediately (no tick wait)', () => {
  const ws = fakeWs();
  const sched = manualScheduler();
  const s = makeSender(ws, sched);

  s.markInputFlush();
  s.onData('\x1b[C'); // echo
  assert.deepEqual(ws.sent, ['\x1b[C'], 'echo sent synchronously, before runMicro');
});

test('echo flushes any already-coalesced bulk in order (no reordering)', () => {
  const ws = fakeWs();
  const sched = manualScheduler();
  const s = makeSender(ws, sched);

  s.onData('bulk'); // queued, flush scheduled
  s.markInputFlush();
  s.onData('X'); // echo appended after bulk, then immediate flush
  assert.deepEqual(ws.sent, ['bulkX'], 'bulk precedes echo; single ordered frame');
});

test('a chunk >= maxSendBuffer flushes synchronously', () => {
  const ws = fakeWs();
  const sched = manualScheduler();
  const s = makeSender(ws, sched, { maxSendBuffer: 8 });

  s.onData('0123456789'); // 10 bytes > cap
  assert.deepEqual(ws.sent, ['0123456789'], 'over-cap frame sent without waiting');
});

test('skips the send when over high-water; output is dropped locally (kept in ring buffer) and a stall close is armed', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const s = makeSender(ws, sched, { maxSendBuffer: 4 });

  s.onData('flood'); // crosses cap -> flushSend -> over high-water -> skip
  assert.deepEqual(ws.sent, [], 'nothing sent while backed up');
  assert.equal(sched.pendingTimers(), 1, 'stall-close timer armed');
});

test('closes a client pinned over high-water past the stall timeout', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const s = makeSender(ws, sched, { maxSendBuffer: 4 });

  s.onData('flood');
  assert.equal(ws.closed, null, 'not closed yet');
  sched.runTimers(); // stall grace elapses, still pinned
  assert.ok(ws.closed, 'wedged client closed');
  assert.equal(ws.closed.code, 1013);
});

test('a recovered client (drained below low-water) resumes sending and the stall close is cancelled', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const s = makeSender(ws, sched, { maxSendBuffer: 4 });

  s.onData('flood'); // skipped, stall armed
  ws.bufferedAmount = 0; // client caught up
  s.onData('y'); // queued, flush scheduled
  sched.runMicro();
  assert.deepEqual(ws.sent, ['y'], 'resumes after recovery');
  sched.runTimers();
  assert.equal(ws.closed, null, 'stall close was cancelled on the successful send');
});

test('AC6 guard (n2): echo flush still respects backpressure on a wedged tab', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const s = makeSender(ws, sched);

  s.markInputFlush();
  s.onData('e'); // echo, but over high-water
  assert.deepEqual(ws.sent, [], 'echo not force-sent past the high-water guard');
  assert.equal(sched.pendingTimers(), 1, 'stall close armed instead');
});

test('T10: a sustained flood to a wedged client is dropped locally (bounded), never queued into the socket', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const s = makeSender(ws, sched, { maxSendBuffer: 1024 });

  // ~5 MiB in 64 KiB chunks while the client is pinned above high-water.
  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 80; i++) s.onData(chunk);
  assert.deepEqual(ws.sent, [], 'nothing forwarded to a wedged socket — no unbounded userspace queue');

  // On recovery only NEW data flows; the 5 MiB backlog was dropped locally
  // (it lives in the session ring buffer and replays on reconnect), proving the
  // local buffer does not grow with the flood.
  ws.bufferedAmount = 0;
  s.onData('fresh');
  sched.runMicro();
  assert.deepEqual(ws.sent, ['fresh'], 'backlog dropped, not replayed from a growing local buffer');
});

test('sendImmediate sends the replay frame when healthy and skips when backed up', () => {
  const sched = manualScheduler();

  const healthy = fakeWs();
  const a = makeSender(healthy, sched);
  assert.equal(a.sendImmediate('REPLAY'), true);
  assert.deepEqual(healthy.sent, ['REPLAY']);

  const wedged = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const b = makeSender(wedged, sched);
  assert.equal(b.sendImmediate('REPLAY'), false, 'replay skipped on a backed-up socket');
  assert.deepEqual(wedged.sent, []);
});

test('does not send on a non-open socket', () => {
  const ws = fakeWs({ readyState: 0 });
  const sched = manualScheduler();
  const s = makeSender(ws, sched);
  s.onData('x');
  sched.runMicro();
  assert.deepEqual(ws.sent, []);
});

test('destroy stops further sends and clears timers', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const s = makeSender(ws, sched, { maxSendBuffer: 4 });

  s.onData('flood'); // arms a stall timer
  s.destroy();
  assert.equal(sched.pendingTimers(), 0, 'stall timer cleared on destroy');
  s.onData('more');
  ws.bufferedAmount = 0;
  sched.runMicro();
  assert.deepEqual(ws.sent, [], 'no sends after destroy');
});
