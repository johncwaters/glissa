import test from 'node:test';
import assert from 'node:assert/strict';

import { createWsSender, DEFAULTS } from '../server/ws-sender.ts';
import type { WsSender, WsSenderOptions, WsSenderSocket } from '../server/ws-sender.ts';
import type { OutputRingSlice } from '../session/core/output-ring.ts';

interface FakeWs extends WsSenderSocket {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  closed: { code?: number; reason?: string } | null;
}

function fakeWs({ bufferedAmount = 0, readyState = 1 }: { bufferedAmount?: number; readyState?: number } = {}): FakeWs {
  return {
    readyState,
    bufferedAmount,
    sent: [],
    closed: null,
    send(data: string) { this.sent.push(data); },
    close(code?: number, reason?: string) {
      this.closed = { code, reason };
      this.readyState = 3;
    },
  };
}

interface ManualTimer {
  fn: () => void;
  cleared: boolean;
}

function closeRecordOf(ws: FakeWs): { code?: number; reason?: string } | null {
  return ws.closed;
}

function framesOf(ws: FakeWs): string[] {
  return ws.sent;
}

function manualScheduler() {
  const micro: (() => void)[] = [];
  const timers: ManualTimer[] = [];
  const handles = new Map<NodeJS.Timeout, ManualTimer>();
  let nextHandle = 0;
  return {
    setImmediateFn: (fn: () => void) => {
      micro.push(fn);
      return {};
    },
    setTimeoutFn: (fn: () => void): NodeJS.Timeout => {
      const timer: ManualTimer = { fn, cleared: false };
      timers.push(timer);
      nextHandle += 1;
      const handle = handleFor(nextHandle);
      handles.set(handle, timer);
      return handle;
    },
    clearTimeoutFn: (handle: NodeJS.Timeout) => {
      const timer = handles.get(handle);
      if (timer) timer.cleared = true;
    },
    runMicro() { for (const fn of micro.splice(0)) fn(); },
    runTimers() {
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
    },
    pendingTimers() { return timers.filter((timer) => !timer.cleared).length; },
  };
}

function handleFor(seed: number): NodeJS.Timeout {
  const handle = setTimeout(() => {}, 60_000 + seed);
  handle.unref();
  clearTimeout(handle);
  return handle;
}

function makeSender(ws: WsSenderSocket, sched: ReturnType<typeof manualScheduler>, opts: WsSenderOptions = {}): WsSender {
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
  s.onData('\x1b[C');
  assert.deepEqual(ws.sent, ['\x1b[C'], 'echo sent synchronously, before runMicro');
});

test('echo flushes any already-coalesced bulk in order (no reordering)', () => {
  const ws = fakeWs();
  const sched = manualScheduler();
  const s = makeSender(ws, sched);

  s.onData('bulk');
  s.markInputFlush();
  s.onData('X');
  assert.deepEqual(ws.sent, ['bulkX'], 'bulk precedes echo; single ordered frame');
});

test('a chunk >= maxSendBuffer flushes synchronously', () => {
  const ws = fakeWs();
  const sched = manualScheduler();
  const s = makeSender(ws, sched, { maxSendBuffer: 8 });

  s.onData('0123456789');
  assert.deepEqual(ws.sent, ['0123456789'], 'over-cap frame sent without waiting');
});

test('skips the send when over high-water; output is dropped locally (kept in ring buffer) and a stall close is armed', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const s = makeSender(ws, sched, { maxSendBuffer: 4 });

  s.onData('flood');
  assert.deepEqual(ws.sent, [], 'nothing sent while backed up');
  assert.equal(sched.pendingTimers(), 1, 'stall-close timer armed');
});

test('closes a client pinned over high-water past the stall timeout', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const s = makeSender(ws, sched, { maxSendBuffer: 4 });

  s.onData('flood');
  assert.equal(ws.closed, null, 'not closed yet');
  sched.runTimers();
  const closed = closeRecordOf(ws);
  assert.ok(closed, 'wedged client closed');
  assert.equal(closed.code, 1013);
});

test('a recovered client (drained below low-water) resumes sending and the stall close is cancelled', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const s = makeSender(ws, sched, { maxSendBuffer: 4 });

  s.onData('flood');
  ws.bufferedAmount = 0;
  s.onData('y');
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
  s.onData('e');
  assert.deepEqual(ws.sent, [], 'echo not force-sent past the high-water guard');
  assert.equal(sched.pendingTimers(), 1, 'stall close armed instead');
});

test('T10: a sustained flood to a wedged client is dropped locally (bounded), never queued into the socket', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const s = makeSender(ws, sched, { maxSendBuffer: 1024 });

  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 80; i++) s.onData(chunk);
  assert.deepEqual(ws.sent, [], 'nothing forwarded to a wedged socket: no unbounded userspace queue');

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

  s.onData('flood');
  s.destroy();
  assert.equal(sched.pendingTimers(), 0, 'stall timer cleared on destroy');
  s.onData('more');
  ws.bufferedAmount = 0;
  sched.runMicro();
  assert.deepEqual(ws.sent, [], 'no sends after destroy');
});

function fakeRing() {
  let full = '';
  let base = 0;
  const calls: number[] = [];
  return {
    produce(chunk: string) { full += chunk; },
    setBase(next: number) { base = next; },
    end() { return full.length; },
    calls,
    getBufferSince(offset: number): OutputRingSlice {
      calls.push(offset);
      const end = full.length;
      if (offset >= end) return { data: '', base, end, evicted: false };
      if (offset < base) return { data: full.slice(base), base, end, evicted: true };
      return { data: full.slice(offset), base, end, evicted: false };
    },
  };
}

function feed(ring: ReturnType<typeof fakeRing>, sender: WsSender, chunk: string): void {
  ring.produce(chunk);
  sender.onData(chunk);
}

test('AC1: gap-free in-place recovery: drop then drain backfills the exact missed range', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });

  feed(ring, s, 'aaaa');
  feed(ring, s, 'bbbb');
  assert.deepEqual(ws.sent, [], 'nothing sent while pinned');

  ws.bufferedAmount = 0;
  feed(ring, s, 'cccc');

  const intended = 'aaaabbbbcccc';
  assert.equal(ws.sent.join(''), intended, 'gap-free: full stream, in order');
  assert.equal(ws.sent.join('').length, intended.length, 'no overshoot / no duplication');
});

test('AC2: happy path (no drop) never calls the source and sends each byte once', () => {
  const ws = fakeWs();
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

test('AC3: bounded memory with a source: flood to a pinned client queues nothing, defers backfill to drain', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 1024 });

  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 50; i++) feed(ring, s, chunk);
  assert.deepEqual(ws.sent, [], 'nothing forwarded to a pinned socket (no userspace queue)');
  assert.equal(ring.calls.length, 0, 'source not materialized until drain');

  ws.bufferedAmount = 0;
  feed(ring, s, 'tail');
  assert.equal(ring.calls.length, 1, 'exactly one getBufferSince per drain episode');
  assert.equal(ws.sent.length, 1, 'one backfill frame');
  assert.equal(framesOf(ws)[0]?.length, 50 * 64 * 1024 + 4, 'backfill = entire missed range + tail');
});

test('AC3: sustained flood arms the stall timer once (no per-frame re-arm)', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });

  for (let i = 0; i < 20; i++) feed(ring, s, 'aaaa');
  assert.equal(sched.pendingTimers(), 1, 'exactly one stall timer across the whole flood');
});

test('AC4: evicted fallback: missed range scrolled out of the ring -> CLEAR + full replay', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });

  feed(ring, s, 'aaaa');
  ring.setBase(2);
  ws.bufferedAmount = 0;
  feed(ring, s, 'bbbb');

  assert.equal(ws.sent.length, 1, 'one backfill frame');
  assert.ok(ws.sent[0].startsWith('\x1bc\x1b[2J\x1b[3J\x1b[H'), 'frame begins with the CLEAR sequence');
  assert.equal(ws.sent[0], '\x1bc\x1b[2J\x1b[3J\x1b[H' + 'aabbbb', 'CLEAR + retained replay tail');
});

test('AC6: sendImmediate does not advance the live offset (backfill resumes from startOffset)', () => {
  const ws = fakeWs();
  const sched = manualScheduler();
  const ring = fakeRing();
  ring.produce('R'.repeat(100));
  const s = makeSender(ws, sched, { source: ring, startOffset: 100 });

  assert.equal(s.sendImmediate('REPLAY'), true, 'replay sent on a healthy socket');

  ws.bufferedAmount = DEFAULTS.highWaterMark + 1;
  ring.produce('LIVE');
  s.onData('LIVE');
  sched.runMicro();
  ws.bufferedAmount = 0;
  ring.produce('Z');
  s.onData('Z');

  assert.ok(ring.calls.includes(100), 'backfill queried getBufferSince(100): sendImmediate did not advance sentOffset');
  assert.ok(!ring.calls.includes(106), 'sentOffset was not bumped by the 6-byte replay frame');
});

test('AC7: quiet-drain: a drop then silence recovers the tail via the stall-timer re-check', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });

  feed(ring, s, 'aaaa');
  assert.deepEqual(ws.sent, []);

  ws.bufferedAmount = 0;
  sched.runTimers();
  assert.equal(ws.sent.join(''), 'aaaa', 'tail recovered without any new output');
  assert.equal(ws.closed, null, 'a drained client is not closed');
});

test('timer-fired backfill then onData does not double-send', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });

  feed(ring, s, 'aaaa');
  ws.bufferedAmount = 0;
  sched.runTimers();
  assert.equal(ws.sent.join(''), 'aaaa');

  feed(ring, s, 'bbbb');
  sched.runMicro();
  assert.equal(ws.sent.join(''), 'aaaabbbb', 'no second backfill; only new data, once');
  assert.equal(ring.calls.length, 1, 'getBufferSince called exactly once (the timer backfill)');
});

test('two drop episodes each backfill their own missed slice, gap-free', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });

  feed(ring, s, 'aaaa');
  assert.equal(sched.pendingTimers(), 1, 'episode 1 armed one timer');
  ws.bufferedAmount = 0;
  sched.runTimers();
  assert.equal(ws.sent.join(''), 'aaaa');

  ws.bufferedAmount = DEFAULTS.highWaterMark + 1;
  feed(ring, s, 'bbbb');
  assert.equal(sched.pendingTimers(), 1, 'episode 2 re-armed after episode 1 cleared');
  ws.bufferedAmount = 0;
  feed(ring, s, 'cccc');
  assert.equal(ws.sent.join(''), 'aaaabbbbcccc', 'gap-free across both episodes');
});

test('AC9 (sender half): a re-baselined client (fresh startOffset=0) recovers a post-restart drop gap-free', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  const s = makeSender(ws, sched, { source: ring, startOffset: 0, maxSendBuffer: 4 });

  feed(ring, s, 'newpty-output');
  ws.bufferedAmount = 0;
  feed(ring, s, '!');
  assert.equal(ws.sent.join(''), 'newpty-output!', 'fresh-baseline client recovers gap-free');
  assert.ok(ring.calls.every((o) => o >= 0), 'backfill ran from a valid (non-stale) offset');
});

test('a sub-cap frame buffered across a drain is not double-sent (regression)', () => {
  {
    const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
    const sched = manualScheduler();
    const ring = fakeRing();
    const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });
    feed(ring, s, 'AAAA');
    feed(ring, s, 'CC');
    ws.bufferedAmount = 0;
    sched.runMicro();
    assert.equal(ws.sent.join(''), 'AAAACC', 'gap-free, no duplicated tail');
  }

  {
    const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
    const sched = manualScheduler();
    const ring = fakeRing();
    const s = makeSender(ws, sched, { source: ring, maxSendBuffer: 4 });
    feed(ring, s, 'AAAA');
    feed(ring, s, 'CC');
    ws.bufferedAmount = 0;
    sched.runTimers();
    sched.runMicro();
    assert.equal(ws.sent.join(''), 'AAAACC', 'timer backfill then pending flush: no duplicate');
  }
});

test('sendImmediate drop rewinds sentOffset to the replay base: recovers history + live', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const ring = fakeRing();
  ring.produce('R'.repeat(100));
  const s = makeSender(ws, sched, { source: ring, startOffset: 100 });

  assert.equal(s.sendImmediate('R'.repeat(100)), false, 'replay dropped while pinned');
  assert.deepEqual(ws.sent, [], 'nothing sent to the pinned socket');

  ws.bufferedAmount = 0;
  feed(ring, s, 'LIVE');

  assert.ok(ring.calls.includes(0), 'backfill queried getBufferSince(0): rewound to replay base');
  assert.ok(!ring.calls.includes(100), 'did NOT resume from the live baseline (pre-fix behavior)');
  assert.equal(ws.sent.join(''), `${'R'.repeat(100)}LIVE`, 'history + live recovered, in order');
});

test('sendImmediate drop with NO source neither rewinds nor desyncs (drop-and-forget unchanged)', () => {
  const ws = fakeWs({ bufferedAmount: DEFAULTS.highWaterMark + 1 });
  const sched = manualScheduler();
  const s = makeSender(ws, sched, { startOffset: 100 });

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

  feed(ring, s, 'LIVE');
  sched.runMicro();
  assert.equal(ws.sent.join(''), 'LIVE', 'baseline live send advanced sentOffset');

  ws.bufferedAmount = DEFAULTS.highWaterMark + 1;
  const orig = console.error;
  const errs: unknown[][] = [];
  console.error = (...args: unknown[]) => { errs.push(args); };
  try {
    assert.equal(s.sendImmediate('REPLAY'), false, 'dropped while pinned');
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1, 'loud guard fired exactly once');
  assert.match(String(errs[0]?.[0]), /non-fresh socket/, 'diagnostic identifies the violation');

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

  assert.equal(s.sendImmediate('R'.repeat(100)), false);
  ring.setBase(50);
  ws.bufferedAmount = 0;
  feed(ring, s, 'LIVE');

  assert.equal(ws.sent.length, 1, 'one backfill frame');
  assert.ok(ws.sent[0].startsWith('\x1bc\x1b[2J\x1b[3J\x1b[H'), 'CLEAR prefix on evicted recovery');
  assert.equal(ws.sent[0], `\x1bc\x1b[2J\x1b[3J\x1b[H${'R'.repeat(50)}LIVE`, 'CLEAR + retained tail');
});
