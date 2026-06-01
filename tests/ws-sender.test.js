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

// ── Backfill source (Option A: gap-free in-place recovery) ───────────────────

// Minimal session-ring double for the injected backfill source. `produce` models the
// session pushing a chunk into the ring (advancing the monotonic total) BEFORE it emits
// 'data' — the ORDER CONTRACT the sender's onData short-circuit relies on. `calls`
// records every offset getBufferSince was asked for (to assert call count + no-advance).
function fakeRing() {
  let full = '';   // everything produced from offset 0 (the intended stream)
  let base = 0;    // oldest retained offset; offsets < base are "evicted"
  const calls = [];
  return {
    produce(chunk) { full += chunk; },
    setBase(b) { base = b; },
    end() { return full.length; },
    calls,
    getBufferSince(offset) {
      calls.push(offset);
      const end = full.length;
      if (offset >= end) return { data: '', base, end, evicted: false };
      if (offset < base) return { data: full.slice(base), base, end, evicted: true };
      return { data: full.slice(offset), base, end, evicted: false };
    },
  };
}

// Feed a chunk the way the server does: ring push (+total) BEFORE the sender sees it.
function feed(ring, sender, chunk) {
  ring.produce(chunk);
  sender.onData(chunk);
}

test('AC1: gap-free in-place recovery — drop then drain backfills the exact missed range', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });

  feed(ring, s, 'aaaa'); // >= maxSendBuffer -> flushes synchronously -> dropped (pinned)
  feed(ring, s, 'bbbb'); // dropped (pinned)
  assert.deepEqual(ws.sent, [], 'nothing sent while pinned');

  ws.bufferedAmount = 0;
  feed(ring, s, 'cccc'); // drained -> onData short-circuit backfills the whole range

  const intended = 'aaaabbbbcccc';
  assert.equal(ws.sent.join(''), intended, 'gap-free: full stream, in order');
  assert.equal(ws.sent.join('').length, intended.length, 'no overshoot / no duplication');
});

test('AC2: happy path (no drop) never calls the source and sends each byte once', () => {
  const ws = fakeWs(); // healthy
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring });

  feed(ring, s, 'hello');
  sched.runMicro();
  feed(ring, s, 'world');
  sched.runMicro();

  assert.equal(ws.sent.join(''), 'helloworld', 'all bytes sent once, in order');
  assert.equal(ring.calls.length, 0, 'no backfill on the happy path');
});

test('AC3: bounded memory with a source — flood to a pinned client queues nothing, defers backfill to drain', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 1024 });

  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 50; i++) feed(ring, s, chunk); // ~3 MiB while pinned
  assert.deepEqual(ws.sent, [], 'nothing forwarded to a pinned socket (no userspace queue)');
  assert.equal(ring.calls.length, 0, 'source not materialized until drain');

  ws.bufferedAmount = 0;
  feed(ring, s, 'tail');
  assert.equal(ring.calls.length, 1, 'exactly one getBufferSince per drain episode');
  assert.equal(ws.sent.length, 1, 'one backfill frame');
  assert.equal(ws.sent[0].length, 50 * 64 * 1024 + 4, 'backfill = entire missed range + tail');
});

test('AC3: sustained flood arms the stall timer once (no per-frame re-arm)', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });

  for (let i = 0; i < 20; i++) feed(ring, s, 'aaaa'); // 20 drops while pinned
  assert.equal(sched.pendingTimers(), 1, 'exactly one stall timer across the whole flood');
});

test('AC4: evicted fallback — missed range scrolled out of the ring -> CLEAR + full replay', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });

  feed(ring, s, 'aaaa'); // dropped while pinned (sentOffset still 0)
  ring.setBase(2);       // simulate eviction: offsets < 2 are gone
  ws.bufferedAmount = 0;
  feed(ring, s, 'bbbb'); // drained -> backfill; sentOffset(0) < base(2) -> evicted

  assert.equal(ws.sent.length, 1, 'one backfill frame');
  assert.ok(ws.sent[0].startsWith('\x1b[2J\x1b[3J\x1b[H'), 'frame begins with the CLEAR sequence');
  assert.equal(ws.sent[0], '\x1b[2J\x1b[3J\x1b[H' + 'aabbbb', 'CLEAR + retained replay tail');
});

test('AC6: sendImmediate does not advance the live offset (backfill resumes from startOffset)', () => {
  const ws = fakeWs();
  const sched = manualScheduler();
  const ring = fakeRing();
  ring.produce('R'.repeat(100)); // 100 historical bytes; live baseline = 100
  const s = makeSender(ws, sched, { source: ring, startOffset: 100 });

  assert.equal(s.sendImmediate('REPLAY'), true, 'replay sent on a healthy socket');

  ws.bufferedAmount = DEFAULTS.highWaterMark + 1;
  ring.produce('LIVE');
  s.onData('LIVE'); // appended, then dropped on the scheduled flush
  sched.runMicro();
  ws.bufferedAmount = 0;
  ring.produce('Z');
  s.onData('Z'); // drained -> backfill

  assert.ok(ring.calls.includes(100), 'backfill queried getBufferSince(100) — sendImmediate did not advance sentOffset');
  assert.ok(!ring.calls.includes(106), 'sentOffset was not bumped by the 6-byte replay frame');
});

test('AC7: quiet-drain — a drop then silence recovers the tail via the stall-timer re-check', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });

  feed(ring, s, 'aaaa'); // dropped, desynced, stall timer armed
  assert.deepEqual(ws.sent, []);

  ws.bufferedAmount = 0; // drained, but NO further onData/flush
  sched.runTimers();     // stall timer fires -> maybeBackfill recovers the tail
  assert.equal(ws.sent.join(''), 'aaaa', 'tail recovered without any new output');
  assert.equal(ws.closed, null, 'a drained client is not closed');
});

test('timer-fired backfill then onData does not double-send', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });

  feed(ring, s, 'aaaa'); // dropped, desynced
  ws.bufferedAmount = 0;
  sched.runTimers();     // timer backfill: sends 'aaaa', clears desynced
  assert.equal(ws.sent.join(''), 'aaaa');

  feed(ring, s, 'bbbb'); // desynced now false -> normal append
  sched.runMicro();
  assert.equal(ws.sent.join(''), 'aaaabbbb', 'no second backfill; only new data, once');
  assert.equal(ring.calls.length, 1, 'getBufferSince called exactly once (the timer backfill)');
});

test('two drop episodes each backfill their own missed slice, gap-free', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });

  // Episode 1: drop, then drain via the timer.
  feed(ring, s, 'aaaa');
  assert.equal(sched.pendingTimers(), 1, 'episode 1 armed one timer');
  ws.bufferedAmount = 0;
  sched.runTimers();
  assert.equal(ws.sent.join(''), 'aaaa');

  // Episode 2: a fresh drop re-arms and backfills its own slice.
  ws.bufferedAmount = DEFAULTS.highWaterMark + 1;
  feed(ring, s, 'bbbb'); // dropped
  assert.equal(sched.pendingTimers(), 1, 'episode 2 re-armed after episode 1 cleared');
  ws.bufferedAmount = 0;
  feed(ring, s, 'cccc'); // drained -> backfill picks up bbbb + cccc
  assert.equal(ws.sent.join(''), 'aaaabbbbcccc', 'gap-free across both episodes');
});

test('AC9 (sender half): a re-baselined client (fresh startOffset=0) recovers a post-restart drop gap-free', () => {
  // After an in-place restart the backend force-closes the old socket; the client
  // reconnects and the new sender starts at startOffset=0 against the reset ring. A drop
  // on that fresh sender must backfill from 0 (NOT hit the offset>=end empty branch that a
  // stale-high sentOffset would have caused).
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing(); // fresh ring, end = 0
  const s = makeSender(ws, sched, { source: ring, startOffset: 0, maxSendBuffer: 4 });

  feed(ring, s, 'newpty-output'); // first post-restart output, dropped while pinned
  ws.bufferedAmount = 0;
  feed(ring, s, '!');             // drained -> backfill from offset 0
  assert.equal(ws.sent.join(''), 'newpty-output!', 'fresh-baseline client recovers gap-free');
  assert.ok(ring.calls.every((o) => o >= 0), 'backfill ran from a valid (non-stale) offset');
});

test('a sub-cap frame buffered across a drain is not double-sent (regression)', () => {
  // A sub-cap frame can sit in sendBuffer (scheduled, not yet flushed) while the socket
  // is pinned. On drain, the backfill covers those bytes (they are already in the ring),
  // so the subsequent flush must NOT re-send sendBuffer. Both drain paths are checked.

  // (a) recovered by the scheduled micro-flush after drain.
  {
    const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
    const sched = manualScheduler();
    const ring = fakeRing();
    const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });
    feed(ring, s, 'AAAA'); // >= cap -> flushes synchronously, dropped while pinned
    feed(ring, s, 'CC');   // sub-cap -> sits in sendBuffer, flush scheduled
    ws.bufferedAmount = 0;
    sched.runMicro();      // scheduled flush fires post-drain
    assert.equal(ws.sent.join(''), 'AAAACC', 'gap-free, no duplicated tail');
  }

  // (b) recovered by the stall-timer re-check, with the scheduled flush still pending.
  {
    const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
    const sched = manualScheduler();
    const ring = fakeRing();
    const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });
    feed(ring, s, 'AAAA'); // dropped while pinned, stall armed
    feed(ring, s, 'CC');   // sub-cap -> sendBuffer='CC', micro flush scheduled
    ws.bufferedAmount = 0;
    sched.runTimers();     // stall-timer backfill fires first
    sched.runMicro();      // then the still-pending scheduled flush
    assert.equal(ws.sent.join(''), 'AAAACC', 'timer backfill then pending flush: no duplicate');
  }
});

// ── sendImmediate (replay frame) dropped under backpressure ──────────────────
// The replay frame carries HISTORICAL bytes [base, startOffset). On a drop the sender
// rewinds sentOffset to that base so maybeBackfill re-pulls history + live, instead of
// resuming live-only and stranding the (already client-side-cleared) history.

test('sendImmediate drop rewinds sentOffset to the replay base — recovers history + live', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 }); // pinned at connect
  const sched = manualScheduler();
  const ring = fakeRing();
  ring.produce('R'.repeat(100)); // 100 historical bytes in the ring; base 0, live baseline 100
  const s = makeSender(ws, sched, { source: ring, startOffset: 100 });

  assert.equal(s.sendImmediate('R'.repeat(100)), false, 'replay dropped while pinned');
  assert.deepEqual(ws.sent, [], 'nothing sent to the pinned socket');

  ws.bufferedAmount = 0;
  feed(ring, s, 'LIVE'); // drained -> onData short-circuit backfills from the rewound base

  // THE bite: rewound to base 0, not the live baseline 100 (the pre-fix live-only bug).
  assert.ok(ring.calls.includes(0), 'backfill queried getBufferSince(0) — rewound to replay base');
  assert.ok(!ring.calls.includes(100), 'did NOT resume from the live baseline (pre-fix behavior)');
  assert.equal(ws.sent.join(''), 'R'.repeat(100) + 'LIVE', 'history + live recovered, in order');
});

test('sendImmediate drop with NO source neither rewinds nor desyncs (drop-and-forget unchanged)', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const s = makeSender(ws, sched, { startOffset: 100 }); // no source

  assert.equal(s.sendImmediate('R'.repeat(100)), false, 'replay dropped');
  assert.equal(sched.pendingTimers(), 1, 'stall timer still armed (close path preserved)');

  ws.bufferedAmount = 0;
  s.onData('LIVE');
  sched.runMicro();
  assert.equal(ws.sent.join(''), 'LIVE', 'only live output; no historical re-pull without a source');
});

test('sendImmediate drop on a non-fresh socket logs loudly and still rewinds', () => {
  const ws = fakeWs();
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, startOffset: 0 });

  // Make the socket non-fresh: a healthy live send advances sentOffset past initialOffset.
  feed(ring, s, 'LIVE');
  sched.runMicro();
  assert.equal(ws.sent.join(''), 'LIVE', 'baseline live send advanced sentOffset');

  ws.bufferedAmount = DEFAULTS.highWaterMark + 1;
  const orig = console.error;
  const errs = [];
  console.error = (...a) => errs.push(a);
  try {
    assert.equal(s.sendImmediate('REPLAY'), false, 'dropped while pinned');
  } finally {
    console.error = orig; // MANDATORY restore — node:test runs the file in ONE process
  }
  assert.equal(errs.length, 1, 'loud guard fired exactly once');
  assert.match(String(errs[0][0]), /non-fresh socket/, 'diagnostic identifies the violation');

  ws.bufferedAmount = 0;
  feed(ring, s, 'X');
  assert.ok(ring.calls.length >= 1, 'recovery still attempted after the loud guard (rewind happened)');
});

test('sendImmediate drop then eviction recovers via CLEAR + retained replay', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  ring.produce('R'.repeat(100));
  const s = makeSender(ws, sched, { source: ring, startOffset: 100 });

  assert.equal(s.sendImmediate('R'.repeat(100)), false); // dropped -> rewind to base 0
  ring.setBase(50);     // eviction: offsets < 50 scrolled out of the ring
  ws.bufferedAmount = 0;
  feed(ring, s, 'LIVE');

  assert.equal(ws.sent.length, 1, 'one backfill frame');
  assert.ok(ws.sent[0].startsWith('\x1b[2J\x1b[3J\x1b[H'), 'CLEAR prefix on evicted recovery');
  assert.equal(ws.sent[0], '\x1b[2J\x1b[3J\x1b[H' + 'R'.repeat(50) + 'LIVE', 'CLEAR + retained tail');
});
