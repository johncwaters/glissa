import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduler } from '../public/render-scheduler.ts';
import type { SchedulerOptions } from '../public/render-scheduler.ts';

function makeSink() {
  const calls: string[] = [];
  const drains: (() => void)[] = [];
  return {
    write(data: string, onDrained: () => void): void {
      calls.push(data);
      drains.push(onDrained);
    },
    drainOne(): void {
      const onDrained = drains.shift();
      if (onDrained) onDrained();
    },
    drainAll(): void {
      for (const onDrained of drains.splice(0)) onDrained();
    },
    calls,
  };
}

function setup(opts: Pick<SchedulerOptions, 'budget' | 'maxChunkBytes'> = {}) {
  const queue: { id: number; callback: FrameRequestCallback }[] = [];
  let nextId = 1;
  const sched = createScheduler({
    ...opts,
    requestFrame: (callback) => {
      const id = nextId;
      nextId += 1;
      queue.push({ id, callback });
      return id;
    },
    cancelFrame: (id) => {
      const at = queue.findIndex((frame) => frame.id === id);
      if (at !== -1) queue.splice(at, 1);
    },
  });
  return {
    sched,
    runFrame(): boolean {
      const frame = queue.shift();
      if (frame) frame.callback(0);
      return Boolean(frame);
    },
    pendingFrames(): number {
      return queue.length;
    },
  };
}

test('drains all enqueued data in order, coalesced (no loss)', () => {
  const { sched, runFrame } = setup({ budget: 4 });
  const sink = makeSink();
  sched.register('a', sink.write);
  sched.enqueue('a', 'hello ');
  sched.enqueue('a', 'world');
  runFrame();
  assert.deepEqual(sink.calls, ['hello world']);
  sink.drainAll();
  assert.equal(sched.running(), false, 'parked after drain');
});

test('one in-flight write per sink: no second write until the callback fires', () => {
  const { sched, runFrame } = setup({ budget: 4 });
  const sink = makeSink();
  sched.register('a', sink.write);
  sched.enqueue('a', 'first');
  runFrame();
  assert.deepEqual(sink.calls, ['first']);
  sched.enqueue('a', 'second');
  runFrame();
  assert.deepEqual(sink.calls, ['first']);
  sink.drainOne();
  runFrame();
  assert.deepEqual(sink.calls, ['first', 'second']);
});

test('services at most `budget` sinks per frame', () => {
  const { sched, runFrame } = setup({ budget: 2 });
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const sinks = new Map<string, ReturnType<typeof makeSink>>();
  for (const id of ids) {
    const sink = makeSink();
    sinks.set(id, sink);
    sched.register(id, sink.write);
    sched.enqueue(id, 'x');
  }
  runFrame();
  const written = ids.filter((id) => (sinks.get(id)?.calls.length ?? 0) > 0);
  assert.equal(written.length, 2, 'only budget=2 sinks serviced this frame');
});

test('round-robin: budget=1 services both sinks over two frames (fairness)', () => {
  const { sched, runFrame } = setup({ budget: 1 });
  const first = makeSink();
  const second = makeSink();
  sched.register('a', first.write);
  sched.register('b', second.write);
  sched.enqueue('a', 'x');
  sched.enqueue('b', 'y');
  runFrame();
  runFrame();
  assert.equal(first.calls.length, 1, 'a serviced');
  assert.equal(second.calls.length, 1, 'b serviced: neither starves');
});

test('parks (schedules no frame) when nothing is dirty, re-arms on enqueue', () => {
  const { sched, runFrame, pendingFrames } = setup({ budget: 4 });
  const sink = makeSink();
  sched.register('a', sink.write);
  assert.equal(pendingFrames(), 0, 'no frame before any data');
  sched.enqueue('a', 'x');
  assert.equal(pendingFrames(), 1, 'armed on enqueue');
  runFrame();
  sink.drainAll();
  assert.equal(pendingFrames(), 0, 'parked after drain: no busy spin');
  assert.equal(sched.running(), false);
});

test('unregister removes the sink; enqueue to it is a no-op and a pending callback is inert', () => {
  const { sched, runFrame } = setup({ budget: 4 });
  const sink = makeSink();
  sched.register('a', sink.write);
  sched.enqueue('a', 'live');
  runFrame();
  sched.unregister('a');
  sched.enqueue('a', 'after');
  assert.equal(sched.has('a'), false);
  sink.drainAll();
  runFrame();
  assert.deepEqual(sink.calls, ['live'], 'no write after unregister');
});

test('splits a chunk larger than maxChunkBytes, carrying the remainder', () => {
  const { sched, runFrame } = setup({ budget: 4, maxChunkBytes: 4 });
  const sink = makeSink();
  sched.register('a', sink.write);
  sched.enqueue('a', 'abcdefg');
  runFrame();
  assert.deepEqual(sink.calls, ['abcd'], 'first maxChunk bytes');
  sink.drainOne();
  runFrame();
  assert.deepEqual(sink.calls, ['abcd', 'efg'], 'remainder carried to next service');
});

test('a chatty sink does not starve others (budget bounds it; round-robin services the rest)', () => {
  const { sched, runFrame } = setup({ budget: 1 });
  const chatty = makeSink();
  const quiet = makeSink();
  sched.register('a', chatty.write);
  sched.register('b', quiet.write);
  sched.enqueue('a', 'a1');
  sched.enqueue('b', 'b1');
  runFrame();
  sched.enqueue('a', 'a2');
  runFrame();
  assert.equal(quiet.calls.length, 1, 'b not starved by chatty a');
});

test('multi-chunk crossing the cap boundary: front-consumption + split correctness', () => {
  const { sched, runFrame } = setup({ budget: 4, maxChunkBytes: 4 });
  const sink = makeSink();
  sched.register('a', sink.write);
  sched.enqueue('a', 'ab');
  sched.enqueue('a', 'cd');
  sched.enqueue('a', 'ef');
  runFrame();
  assert.deepEqual(sink.calls, ['abcd'], 'first service coalesces ab+cd up to cap');
  sink.drainOne();
  runFrame();
  assert.deepEqual(sink.calls, ['abcd', 'ef'], 'remainder ef carried to next service');
});

test('multi-chunk with a chunk that straddles the cap boundary', () => {
  const { sched, runFrame } = setup({ budget: 4, maxChunkBytes: 4 });
  const sink = makeSink();
  sched.register('a', sink.write);
  sched.enqueue('a', 'ab');
  sched.enqueue('a', 'cde');
  runFrame();
  assert.deepEqual(sink.calls, ['ab'], 'first service stops before overflow (acc+next would exceed cap)');
  assert.equal(sink.calls[0].length <= 4, true, 'first chunk does not exceed cap');
  sink.drainOne();
  runFrame();
  assert.equal(sink.calls.length, 2, 'remainder carried to next service');
  assert.equal(sink.calls[0] + sink.calls[1], 'abcde', 'all data delivered, no loss');
});

test('large backlog produces same observable output as string accumulation would (regression guard)', () => {
  const { sched, runFrame } = setup({ budget: 4, maxChunkBytes: 50 });
  const sink = makeSink();
  sched.register('a', sink.write);
  const chunks: string[] = [];
  for (let index = 0; index < 100; index += 1) {
    const chunk = String(index % 10);
    chunks.push(chunk);
    sched.enqueue('a', chunk);
  }
  let framesLeft = 200;
  while (framesLeft > 0) {
    framesLeft -= 1;
    runFrame();
    sink.drainAll();
    if (!sched.running()) break;
  }
  assert.equal(sink.calls.join(''), chunks.join(''), 'all data delivered in order, no loss or duplication');
});
