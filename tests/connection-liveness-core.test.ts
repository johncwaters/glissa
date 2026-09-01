import test from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTING_WEDGE_MS, decideLivenessAction } from '../public/connection-liveness-core.ts';

test('retryPending reconnects immediately before inspecting the socket', () => {
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 1, retryPending: true }), 'retry-now');
  assert.equal(decideLivenessAction({ hasSocket: false, readyState: null, retryPending: true }), 'retry-now');
});

test('missing socket starts a new connection', () => {
  assert.equal(decideLivenessAction({ hasSocket: false, readyState: null, retryPending: false }), 'connect');
});

test('connecting socket waits for the browser connection attempt', () => {
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 0, retryPending: false }), 'wait');
});

test('connecting socket wedged past the threshold is replaced', () => {
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 0, retryPending: false, connectingAgeMs: CONNECTING_WEDGE_MS }), 'wait');
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 0, retryPending: false, connectingAgeMs: CONNECTING_WEDGE_MS + 1 }), 'connect');
});

test('open socket probes with an application ping', () => {
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 1, retryPending: false }), 'probe');
});

test('closing and closed sockets start a replacement connection', () => {
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 2, retryPending: false }), 'connect');
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 3, retryPending: false }), 'connect');
});

test('unknown or absent readyState is treated like no usable socket', () => {
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 99, retryPending: false }), 'connect');
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: null, retryPending: false }), 'connect');
});
