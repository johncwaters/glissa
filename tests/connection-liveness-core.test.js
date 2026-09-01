'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const importCore = () => import('../public/connection-liveness-core.ts');

test('retryPending reconnects immediately before inspecting the socket', async () => {
  const { decideLivenessAction } = await importCore();
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 1, retryPending: true }), 'retry-now');
  assert.equal(decideLivenessAction({ hasSocket: false, readyState: undefined, retryPending: true }), 'retry-now');
});

test('missing socket starts a new connection', async () => {
  const { decideLivenessAction } = await importCore();
  assert.equal(decideLivenessAction({ hasSocket: false, readyState: undefined, retryPending: false }), 'connect');
});

test('connecting socket waits for the browser connection attempt', async () => {
  const { decideLivenessAction } = await importCore();
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 0, retryPending: false }), 'wait');
});

test('connecting socket wedged past the threshold is replaced', async () => {
  const { CONNECTING_WEDGE_MS, decideLivenessAction } = await importCore();
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 0, retryPending: false, connectingAgeMs: CONNECTING_WEDGE_MS }), 'wait');
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 0, retryPending: false, connectingAgeMs: CONNECTING_WEDGE_MS + 1 }), 'connect');
});

test('open socket probes with an application ping', async () => {
  const { decideLivenessAction } = await importCore();
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 1, retryPending: false }), 'probe');
});

test('closing and closed sockets start a replacement connection', async () => {
  const { decideLivenessAction } = await importCore();
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 2, retryPending: false }), 'connect');
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 3, retryPending: false }), 'connect');
});

test('unknown readyState is treated like no usable socket', async () => {
  const { decideLivenessAction } = await importCore();
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 99, retryPending: false }), 'connect');
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: undefined, retryPending: false }), 'connect');
});
