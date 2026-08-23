'use strict';

// Error backoff for the polling lanes (2026-08 review, section 6: "a gh or PostHog outage is
// re-polled at full cadence every tick"). Full jitter, Retry-After honored, and the lane's interval
// timer deliberately untouched: an outage costs SKIPPED ticks, not a rescheduled timer chain, so the
// re-entrancy guard and the drain-on-stop behave exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  nextBackoffMs, parseRetryAfterMs, shouldSkipTick, DEFAULT_MAX_MS,
} = require('../server/core/lane-backoff');
const { createTickLoop } = require('../server/lane-runner');

test('full jitter picks a point inside the exponential ceiling, never the ceiling itself', () => {
  const baseMs = 1000;
  assert.equal(nextBackoffMs({ attempt: 1, baseMs, random: () => 0 }), 0);
  assert.equal(nextBackoffMs({ attempt: 1, baseMs, random: () => 1 }), 1000);
  assert.equal(nextBackoffMs({ attempt: 2, baseMs, random: () => 1 }), 2000);
  assert.equal(nextBackoffMs({ attempt: 4, baseMs, random: () => 1 }), 8000);
  assert.equal(nextBackoffMs({ attempt: 3, baseMs, random: () => 0.5 }), 2000);
});

// The point of jitter: several clients backing off in lockstep re-converge on one retry instant and
// hammer the recovering service together.
test('two clients at the same attempt do not pick the same wait', () => {
  const baseMs = 60_000;
  const a = nextBackoffMs({ attempt: 5, baseMs, random: () => 0.2 });
  const b = nextBackoffMs({ attempt: 5, baseMs, random: () => 0.9 });
  assert.notEqual(a, b);
});

test('the ceiling is capped, however long the outage runs', () => {
  assert.equal(nextBackoffMs({ attempt: 50, baseMs: 60_000, random: () => 1 }), DEFAULT_MAX_MS);
});

test('an explicit Retry-After wins over the guess, and is still capped', () => {
  assert.equal(nextBackoffMs({ attempt: 1, retryAfterMs: 45_000, random: () => 1 }), 45_000);
  assert.equal(nextBackoffMs({ attempt: 1, retryAfterMs: 999_999_999, maxMs: 60_000 }), 60_000);
  assert.equal(nextBackoffMs({ attempt: 1, retryAfterMs: 0, baseMs: 1000, random: () => 1 }), 1000);
});

test('Retry-After is read in both spellings the RFC allows', () => {
  assert.equal(parseRetryAfterMs('120'), 120_000);
  const now = Date.parse('2026-08-22T10:00:00Z');
  assert.equal(parseRetryAfterMs('Sat, 22 Aug 2026 10:02:00 GMT', now), 120_000);
  assert.equal(parseRetryAfterMs('Sat, 22 Aug 2026 09:58:00 GMT', now), null, 'a past date is not a wait');
  assert.equal(parseRetryAfterMs('nonsense'), null);
  assert.equal(parseRetryAfterMs(null), null);
});

test('a tick is skipped only while the window is genuinely open', () => {
  assert.equal(shouldSkipTick({ now: 100, backoffUntil: 200 }), true);
  assert.equal(shouldSkipTick({ now: 200, backoffUntil: 200 }), false);
  assert.equal(shouldSkipTick({ now: 300, backoffUntil: 0 }), false);
});

// --- the loop ---

function makeLoop(outcomes, { random = () => 1 } = {}) {
  let clock = 0;
  const ticks = [];
  const loop = createTickLoop({
    tag: 'test-lane',
    intervalMs: 1000,
    backoffBaseMs: 1000,
    now: () => clock,
    random,
    log: { warn: () => {} },
    tick: async () => {
      ticks.push(clock);
      return outcomes.shift() || null;
    },
  });
  return { loop, ticks, advance: (ms) => { clock += ms; } };
}

test('a failed poll opens a window that later ticks are skipped inside', async () => {
  const { loop, ticks, advance } = makeLoop([{ failed: true }]);
  await loop.tick();
  assert.equal(ticks.length, 1);
  assert.equal(loop.backoffUntil(), 1000);

  advance(500);
  await loop.tick();
  assert.equal(ticks.length, 1, 'the tick inside the window never ran');

  advance(600);
  await loop.tick();
  assert.equal(ticks.length, 2, 'and it resumes once the window is over');
});

test('consecutive failures back off further, and one success resets it', async () => {
  const { loop, advance } = makeLoop([{ failed: true }, { failed: true }, null]);
  await loop.tick();
  assert.equal(loop.backoffUntil(), 1000, 'attempt 1: base');

  advance(1000);
  await loop.tick();
  assert.equal(loop.backoffUntil(), 3000, 'attempt 2: double the base, from now');

  advance(2000);
  await loop.tick();
  assert.equal(loop.backoffUntil(), 0, 'a success clears the window and the streak');
});

test('a tick body that returns nothing never backs off (every lane before this)', async () => {
  const { loop, ticks, advance } = makeLoop([]);
  await loop.tick();
  advance(1);
  await loop.tick();
  assert.equal(ticks.length, 2);
  assert.equal(loop.backoffUntil(), 0);
});

test('a service-supplied Retry-After is what the loop waits', async () => {
  const { loop } = makeLoop([{ failed: true, retryAfterMs: 90_000 }]);
  await loop.tick();
  assert.equal(loop.backoffUntil(), 90_000);
});

test('stopping clears the window, so a restarted lane polls at once', async () => {
  const { loop } = makeLoop([{ failed: true }]);
  await loop.tick();
  assert.notEqual(loop.backoffUntil(), 0);
  await loop.stop();
  assert.equal(loop.backoffUntil(), 0);
});
