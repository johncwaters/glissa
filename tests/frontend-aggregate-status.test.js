'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// aggregate-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/session-card/aggregate-core.mjs');

const C = (o) => ({ waiting: 0, failed: 0, done: 0, complete: 0, dormant: 0, total: 0, ...o });

test('computeAggregate: waiting dominates the ladder; alertCount = waiting+failed+complete', async () => {
  const { computeAggregate } = await importCore();
  const r = computeAggregate(C({ waiting: 2, failed: 1, complete: 1, total: 4 }));
  assert.equal(r.text, '2 sessions need input');
  assert.equal(r.severity, 'warning');
  assert.equal(r.alertCount, 4);
});

test('computeAggregate: failed outranks complete', async () => {
  const { computeAggregate } = await importCore();
  const r = computeAggregate(C({ failed: 1, complete: 2, total: 3 }));
  assert.equal(r.text, '1 session failed');
  assert.equal(r.severity, 'critical');
});

test('computeAggregate: complete -> finished', async () => {
  const { computeAggregate } = await importCore();
  const r = computeAggregate(C({ complete: 3, total: 5 }));
  assert.equal(r.text, '3 sessions finished');
  assert.equal(r.severity, 'done');
});

test('computeAggregate: all exited when done === total', async () => {
  const { computeAggregate } = await importCore();
  const r = computeAggregate(C({ done: 3, total: 3 }));
  assert.equal(r.text, 'All sessions exited');
  assert.equal(r.severity, 'done');
});

test('computeAggregate: all dormant', async () => {
  const { computeAggregate } = await importCore();
  const r = computeAggregate(C({ dormant: 2, total: 2 }));
  assert.equal(r.text, '2 sessions dormant');
  assert.equal(r.severity, '');
});

test('computeAggregate: running = total - done - dormant', async () => {
  const { computeAggregate } = await importCore();
  const r = computeAggregate(C({ done: 1, dormant: 1, total: 4 }));
  assert.equal(r.text, '2 sessions running');
  assert.equal(r.severity, 'success');
});

test('computeAggregate: singular has no plural s', async () => {
  const { computeAggregate } = await importCore();
  assert.equal(computeAggregate(C({ waiting: 1, total: 1 })).text, '1 session need input');
});

test('computeAggregate: empty -> blank text, zero alerts', async () => {
  const { computeAggregate } = await importCore();
  const r = computeAggregate(C({}));
  assert.equal(r.text, '');
  assert.equal(r.severity, '');
  assert.equal(r.alertCount, 0);
});
