import test from 'node:test';
import assert from 'node:assert/strict';

import { SCREEN_RESET, pendingResizes } from '../session/core/screen-keeper-core.ts';
import type { ResizeMarker } from '../session/core/screen-keeper-core.ts';

function marker(cols: number, atOffset: number): ResizeMarker {
  return { cols, rows: 24, atOffset };
}

test('the reset prefix is the exact escape run the sender and the keeper both write', () => {
  assert.equal(SCREEN_RESET, '\x1bc\x1b[2J\x1b[3J\x1b[H');
});

test('a marker whose bytes are already parsed is due immediately', () => {
  const split = pendingResizes([marker(100, 0)], 0);
  assert.deepEqual(split.due, [marker(100, 0)]);
  assert.deepEqual(split.rest, []);
});

test('a marker ahead of the parse waits, so old-width bytes never parse at the new width', () => {
  const split = pendingResizes([marker(100, 500)], 499);
  assert.deepEqual(split.due, []);
  assert.deepEqual(split.rest, [marker(100, 500)]);
});

test('markers come due in stream order, never out of it', () => {
  const queue = [marker(100, 10), marker(120, 20), marker(140, 30)];
  const first = pendingResizes(queue, 25);
  assert.deepEqual(first.due, [marker(100, 10), marker(120, 20)]);
  assert.deepEqual(first.rest, [marker(140, 30)]);
  const second = pendingResizes(first.rest, 30);
  assert.deepEqual(second.due, [marker(140, 30)]);
  assert.deepEqual(second.rest, []);
});

test('a later marker never overtakes an earlier one that is still waiting', () => {
  const split = pendingResizes([marker(100, 40), marker(120, 10)], 20);
  assert.deepEqual(split.due, [], 'the head gates the queue, so nothing behind it can jump ahead');
  assert.equal(split.rest.length, 2);
});

test('an empty queue splits into two empty halves', () => {
  const split = pendingResizes([], 999);
  assert.deepEqual(split.due, []);
  assert.deepEqual(split.rest, []);
});

test('the input queue is never mutated in place', () => {
  const queue = [marker(100, 10), marker(120, 20)];
  pendingResizes(queue, 20);
  assert.equal(queue.length, 2);
});
