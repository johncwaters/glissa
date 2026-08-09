'use strict';

// Tests for the shared WebSocket reconnect delay (public/reconnect-backoff.mjs), used by both the
// control-WS client and each card's data-WS client. `random` is injected, so jitter is pinned rather
// than sampled.

const test = require('node:test');
const assert = require('node:assert/strict');

const importCore = () => import('../public/reconnect-backoff.mjs');

test('the first retry waits 50-100% of the 500ms base', async () => {
  const { nextReconnectDelayMs } = await importCore();
  assert.equal(nextReconnectDelayMs(0, () => 0), 250, 'floor of the jitter window');
  assert.equal(nextReconnectDelayMs(0, () => 1), 500, 'ceiling is the nominal delay');
  assert.equal(nextReconnectDelayMs(0, () => 0.5), 375);
});

test('the nominal delay doubles per attempt', async () => {
  const { nextReconnectDelayMs } = await importCore();
  const nominal = (attempt) => nextReconnectDelayMs(attempt, () => 1);
  assert.deepEqual([nominal(0), nominal(1), nominal(2), nominal(3)], [500, 1000, 2000, 4000]);
});

test('the delay caps at 30s and stays there', async () => {
  const { nextReconnectDelayMs, MAX_RECONNECT_DELAY_MS } = await importCore();
  assert.equal(MAX_RECONNECT_DELAY_MS, 30000);
  assert.equal(nextReconnectDelayMs(6, () => 1), 30000, 'attempt 6 nominal (32s) is clamped');
  assert.equal(nextReconnectDelayMs(500, () => 1), 30000, 'an overnight outage cannot overflow past the cap');
  assert.equal(nextReconnectDelayMs(500, () => 0), 15000, 'jitter still applies at the cap');
});

test('every delay stays inside the 50-100% jitter window of its nominal value', async () => {
  const { nextReconnectDelayMs, BASE_RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS } = await importCore();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const nominal = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
    for (const random of [0, 0.13, 0.5, 0.87, 0.999]) {
      const delay = nextReconnectDelayMs(attempt, () => random);
      assert.ok(delay >= nominal / 2, `attempt ${attempt} random ${random}: ${delay} >= ${nominal / 2}`);
      assert.ok(delay <= nominal, `attempt ${attempt} random ${random}: ${delay} <= ${nominal}`);
    }
  }
});

test('the same injected random always yields the same delay', async () => {
  const { nextReconnectDelayMs } = await importCore();
  const random = () => 0.42;
  assert.equal(nextReconnectDelayMs(3, random), nextReconnectDelayMs(3, random));
});

test('a nonsense attempt count degrades to the first-retry window', async () => {
  const { nextReconnectDelayMs } = await importCore();
  for (const attempt of [-1, Number.NaN, undefined, null, 'many']) {
    assert.equal(nextReconnectDelayMs(attempt, () => 1), 500, `attempt ${String(attempt)}`);
  }
});
