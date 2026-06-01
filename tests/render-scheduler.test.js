'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// render-scheduler is ESM (.mjs); dynamic-import it from this CJS test file.
const importSched = () => import('../public/render-scheduler.mjs');

// A sink whose write callbacks the test fires manually (models xterm's async
// parse-drain). drainOne/drainAll fire pending callbacks in FIFO order.
function makeSink() {
  const calls = [];
  const cbs = [];
  return {
    write(data, cb) { calls.push(data); cbs.push(cb); },
    drainOne() { const cb = cbs.shift(); if (cb) cb(); },
    drainAll() { for (const cb of cbs.splice(0)) cb(); },
    calls,
    cbs,
  };
}

// Build a scheduler with a manual frame queue so frames run only when the test
// calls runFrame() — no real requestAnimationFrame.
async function setup(opts = {}) {
  const { createScheduler } = await importSched();
  const queue = [];
  let nextId = 1;
  const sched = createScheduler({
    ...opts,
    requestFrame: (cb) => { const id = nextId++; queue.push({ id, cb }); return id; },
    cancelFrame: (id) => { const i = queue.findIndex((f) => f.id === id); if (i !== -1) queue.splice(i, 1); },
  });
  return {
    sched,
    runFrame() { const f = queue.shift(); if (f) f.cb(); return !!f; },
    pendingFrames() { return queue.length; },
  };
}

test('drains all enqueued data in order, coalesced (no loss)', async () => {
  const { sched, runFrame } = await setup({ budget: 4 });
  const s = makeSink();
  sched.register('a', s.write);
  sched.enqueue('a', 'hello ');
  sched.enqueue('a', 'world');
  runFrame();
  assert.deepEqual(s.calls, ['hello world']);
  s.drainAll();
  assert.equal(sched.running(), false, 'parked after drain');
});

test('one in-flight write per sink: no second write until the callback fires', async () => {
  const { sched, runFrame } = await setup({ budget: 4 });
  const s = makeSink();
  sched.register('a', s.write);
  sched.enqueue('a', 'first');
  runFrame();
  assert.deepEqual(s.calls, ['first']);
  sched.enqueue('a', 'second');
  runFrame(); // 'a' is in-flight -> must NOT be written again
  assert.deepEqual(s.calls, ['first']);
  s.drainOne(); // first drains -> 'a' becomes serviceable and re-arms
  runFrame();
  assert.deepEqual(s.calls, ['first', 'second']);
});

test('services at most `budget` sinks per frame', async () => {
  const { sched, runFrame } = await setup({ budget: 2 });
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const sinks = {};
  for (const id of ids) { sinks[id] = makeSink(); sched.register(id, sinks[id].write); sched.enqueue(id, 'x'); }
  runFrame();
  const written = ids.filter((id) => sinks[id].calls.length > 0);
  assert.equal(written.length, 2, 'only budget=2 sinks serviced this frame');
});

test('round-robin: budget=1 services both sinks over two frames (fairness)', async () => {
  const { sched, runFrame } = await setup({ budget: 1 });
  const a = makeSink();
  const b = makeSink();
  sched.register('a', a.write);
  sched.register('b', b.write);
  sched.enqueue('a', 'x');
  sched.enqueue('b', 'y');
  runFrame(); // services one
  runFrame(); // services the other (first is in-flight, rr advanced)
  assert.equal(a.calls.length, 1, 'a serviced');
  assert.equal(b.calls.length, 1, 'b serviced — neither starves');
});

test('parks (schedules no frame) when nothing is dirty, re-arms on enqueue', async () => {
  const { sched, runFrame, pendingFrames } = await setup({ budget: 4 });
  const s = makeSink();
  sched.register('a', s.write);
  assert.equal(pendingFrames(), 0, 'no frame before any data');
  sched.enqueue('a', 'x');
  assert.equal(pendingFrames(), 1, 'armed on enqueue');
  runFrame();
  s.drainAll();
  assert.equal(pendingFrames(), 0, 'parked after drain — no busy spin');
  assert.equal(sched.running(), false);
});

test('unregister removes the sink; enqueue to it is a no-op and a pending callback is inert', async () => {
  const { sched, runFrame } = await setup({ budget: 4 });
  const s = makeSink();
  sched.register('a', s.write);
  sched.enqueue('a', 'live');
  runFrame(); // 'a' written, in-flight
  sched.unregister('a');
  sched.enqueue('a', 'after'); // no sink -> ignored
  assert.equal(sched.has('a'), false);
  s.drainAll(); // the in-flight callback fires after unregister — must be inert
  runFrame();
  assert.deepEqual(s.calls, ['live'], 'no write after unregister');
});

test('splits a chunk larger than maxChunkBytes, carrying the remainder', async () => {
  const { sched, runFrame } = await setup({ budget: 4, maxChunkBytes: 4 });
  const s = makeSink();
  sched.register('a', s.write);
  sched.enqueue('a', 'abcdefg'); // 7 > 4
  runFrame();
  assert.deepEqual(s.calls, ['abcd'], 'first maxChunk bytes');
  s.drainOne();
  runFrame();
  assert.deepEqual(s.calls, ['abcd', 'efg'], 'remainder carried to next service');
});

test('a chatty sink does not starve others (budget bounds it; round-robin services the rest)', async () => {
  const { sched, runFrame } = await setup({ budget: 1 });
  const a = makeSink();
  const b = makeSink();
  sched.register('a', a.write);
  sched.register('b', b.write);
  // 'a' floods; 'b' sends once.
  sched.enqueue('a', 'a1');
  sched.enqueue('b', 'b1');
  runFrame();
  sched.enqueue('a', 'a2');
  runFrame();
  // 'b' must have been serviced despite 'a' being chatty.
  assert.equal(b.calls.length, 1, 'b not starved by chatty a');
});
