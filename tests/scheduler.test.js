'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeNextFire, createScheduler } = require('../server/scheduler');

const SCHEDULE = { days: ['tue', 'thu', 'sat'], time: '05:00', tz: 'America/Denver' };

test('computeNextFire returns 05:00 MDT (=11:00Z) for a summer Tuesday', () => {
  // 2026-06-02 is a Tuesday; Denver is on MDT (UTC-6) in June.
  const from = Date.parse('2026-06-02T10:00:00Z'); // 04:00 MDT, before the 05:00 fire
  assert.equal(computeNextFire(SCHEDULE, from), Date.parse('2026-06-02T11:00:00Z'));
});

test('computeNextFire skips non-scheduled days to the next scheduled day', () => {
  // 2026-06-03 is a Wednesday (not scheduled) -> next is Thursday 2026-06-04 05:00 MDT = 11:00Z.
  const from = Date.parse('2026-06-03T00:00:00Z');
  assert.equal(computeNextFire(SCHEDULE, from), Date.parse('2026-06-04T11:00:00Z'));
});

test('computeNextFire uses MST (=12:00Z) before the spring-forward transition', () => {
  // 2026-03-03 is a Tuesday, before DST starts (Mar 8 2026); Denver is on MST (UTC-7).
  const from = Date.parse('2026-03-02T12:00:00Z');
  assert.equal(computeNextFire(SCHEDULE, from), Date.parse('2026-03-03T12:00:00Z'));
});

test('computeNextFire uses MDT (=11:00Z) after the spring-forward transition', () => {
  // DST begins 2026-03-08; the next Tuesday 2026-03-10 is on MDT (UTC-6).
  const from = Date.parse('2026-03-07T13:00:00Z'); // after Sat 05:00 MST fire, before Tue
  assert.equal(computeNextFire(SCHEDULE, from), Date.parse('2026-03-10T11:00:00Z'));
});

test('computeNextFire is correct across the fall-back transition', () => {
  // DST ends 2026-11-01. Thu 2026-10-29 is MDT (=11:00Z); Tue 2026-11-03 is MST (=12:00Z).
  assert.equal(
    computeNextFire(SCHEDULE, Date.parse('2026-10-28T00:00:00Z')),
    Date.parse('2026-10-29T11:00:00Z'),
  );
  assert.equal(
    computeNextFire(SCHEDULE, Date.parse('2026-11-02T00:00:00Z')),
    Date.parse('2026-11-03T12:00:00Z'),
  );
});

test('computeNextFire returns null when no days are scheduled', () => {
  assert.equal(computeNextFire({ days: [], time: '05:00', tz: 'America/Denver' }), null);
});

test('createScheduler arms the next delay, fires onFire, and re-arms (injected timer)', () => {
  const now = 1_000_000;
  let captured = null;
  const fakeSetTimeout = (fn, delay) => {
    captured = { fn, delay };
    return { unref() {} };
  };
  const fires = [];
  const sched = createScheduler({
    now: () => now,
    computeNextFire: () => now + 5000,
    setTimeoutFn: fakeSetTimeout,
    clearTimeoutFn: () => {},
    onFire: (key) => fires.push(key),
  });

  sched.arm(SCHEDULE, 'marketing:proj-1');
  assert.equal(captured.delay, 5000, 'armed for the computed delay');

  captured.fn(); // simulate the timer firing
  assert.deepEqual(fires, ['marketing:proj-1'], 'onFire called with the key');
  assert.equal(captured.delay, 5000, 're-armed after firing');
});

test('createScheduler clamps a far-future delay to a <=24h re-check hop', () => {
  const now = 0;
  let captured = null;
  const sched = createScheduler({
    now: () => now,
    computeNextFire: () => now + 40 * 24 * 60 * 60 * 1000, // 40 days out (> 32-bit ceiling)
    setTimeoutFn: (fn, delay) => {
      captured = { fn, delay };
      return { unref() {} };
    },
    clearTimeoutFn: () => {},
    onFire: () => {},
  });
  sched.arm(SCHEDULE, 'k');
  assert.equal(captured.delay, 24 * 60 * 60 * 1000, 'clamped to a 24h hop');
});
