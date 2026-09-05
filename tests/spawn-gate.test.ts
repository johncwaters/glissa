import test from 'node:test';
import assert from 'node:assert/strict';

import { createSpawnGate, isQueueAdmissionTimeout } from '../server/spawn-gate.ts';

function deferredResolve(): { promise: Promise<void>; resolve: () => void } {
  let settle: () => void = () => {};
  const promise = new Promise<void>((resolve) => { settle = resolve; });
  return { promise, resolve: () => settle() };
}


test('run executes queued work one-at-a-time, in submission order', async () => {
  const gate = createSpawnGate();
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];

  const task = (id: string) => gate.run(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(id);
    inFlight -= 1;
    return id;
  });

  const results = await Promise.all([task('a'), task('b'), task('c')]);
  assert.equal(maxInFlight, 1, 'spawns never overlapped');
  assert.deepEqual(order, ['a', 'b', 'c'], 'ran in order');
  assert.deepEqual(results, ['a', 'b', 'c'], 'each caller got its own result');
});

test('a rejected task is surfaced to its caller and does not deadlock the gate', async () => {
  const gate = createSpawnGate();
  await assert.rejects(gate.run(async () => {
    throw new Error('boom');
  }), /boom/);
  const ok = await gate.run(async () => 'ok');
  assert.equal(ok, 'ok', 'gate still runs after a rejection');
});

test('an admission timeout rejects the caller and never starts the work afterwards', async () => {
  const gate = createSpawnGate();
  const blocked = deferredResolve();
  let lateWorkRan = false;
  const holding = gate.run(() => blocked.promise);
  const admission = gate.run(() => { lateWorkRan = true; }, { admissionTimeoutMs: 5 });
  await assert.rejects(admission, (error: unknown) => isQueueAdmissionTimeout(error));
  blocked.resolve();
  await holding;
  await gate.run(() => 'after');
  assert.equal(lateWorkRan, false, 'the abandoned task never reached the front of the queue');
});

test('work admitted before the deadline keeps running past it', async () => {
  const gate = createSpawnGate();
  const slow = await gate.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 'done';
  }, { admissionTimeoutMs: 5 });
  assert.equal(slow, 'done');
});

test('an admission timeout leaves the queue usable for the next caller', async () => {
  const gate = createSpawnGate();
  const blocked = deferredResolve();
  const holding = gate.run(() => blocked.promise);
  await assert.rejects(gate.run(() => 'never', { admissionTimeoutMs: 5 }));
  blocked.resolve();
  await holding;
  assert.equal(await gate.run(() => 'ok'), 'ok');
});
