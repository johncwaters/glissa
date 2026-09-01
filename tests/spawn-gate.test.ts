import test from 'node:test';
import assert from 'node:assert/strict';

import { createSpawnGate } from '../server/spawn-gate.ts';

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
