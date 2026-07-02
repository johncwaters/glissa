'use strict';

// Tests for the pure cross-tab notification claim (public/notify-dedupe-core.mjs).
// Two open dashboard tabs both receive every `notify` broadcast; the localStorage
// claim lets exactly one construct the (re-alerting) Notification.

const test = require('node:test');
const assert = require('node:assert/strict');

const importCore = () => import('../public/notify-dedupe-core.mjs');

function memoryStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

test('first claim wins, a second claim within the TTL loses', async () => {
  const { claimNotification } = await importCore();
  const store = memoryStore();
  assert.equal(claimNotification(store, 'k', 1000, 4000), true, 'tab A wins');
  assert.equal(claimNotification(store, 'k', 1005, 4000), false, 'tab B loses');
});

test('the claim expires: an escalation re-fire after the TTL claims again', async () => {
  const { claimNotification } = await importCore();
  const store = memoryStore();
  assert.equal(claimNotification(store, 'k', 1000, 4000), true);
  assert.equal(claimNotification(store, 'k', 6000, 4000), true, 'past the TTL: fresh event');
});

test('different keys never contend (per session+category)', async () => {
  const { claimNotification, claimKey } = await importCore();
  const store = memoryStore();
  assert.equal(claimNotification(store, claimKey('s1', 'waiting'), 1000), true);
  assert.equal(claimNotification(store, claimKey('s1', 'complete'), 1001), true);
  assert.equal(claimNotification(store, claimKey('s2', 'waiting'), 1002), true);
});

test('a garbage stored value is treated as no claim', async () => {
  const { claimNotification } = await importCore();
  const store = memoryStore();
  store.setItem('k', 'not-a-number');
  assert.equal(claimNotification(store, 'k', 1000, 4000), true);
});

test('a throwing store fails open (single-tab must never be silenced)', async () => {
  const { claimNotification } = await importCore();
  const broken = {
    getItem: () => { throw new Error('storage disabled'); },
    setItem: () => { throw new Error('storage disabled'); },
  };
  assert.equal(claimNotification(broken, 'k', 1000, 4000), true);
});

test('claimKey is stable and null-safe', async () => {
  const { claimKey } = await importCore();
  assert.equal(claimKey('s1', 'waiting'), 'glissa-notify-claim-s1-waiting');
  assert.equal(claimKey(undefined, undefined), 'glissa-notify-claim--');
});
