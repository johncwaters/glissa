import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeBaseline,
  decideTrafficSpike,
  spikeMultiple,
  formatMultiple,
  spikeSummaryLine,
  MIN_BASELINE_SAMPLE_HOURS,
  DEFAULT_TRAFFIC_SPIKE_MULTIPLIER,
  DEFAULT_TRAFFIC_SPIKE_MIN_USERS,
  DEFAULT_TRAFFIC_SPIKE_COOLDOWN_MINUTES,
  DEFAULT_TRAFFIC_BASELINE_DAYS,
} from '../server/core/traffic-spike-core.ts';

const HOUR_MS = 3600000;

function flatBuckets(users: number, count = 48) {
  return Array.from({ length: count }, (_, i) => ({ bucket: `h${i}`, users }));
}

test('computeBaseline reports the p90, the median and the sample size', () => {
  const buckets = Array.from({ length: 10 }, (_, i) => ({ bucket: `h${i}`, users: i + 1 }));
  const baseline = computeBaseline(buckets);
  assert.equal(baseline.p90, 9);
  assert.equal(baseline.median, 5.5);
  assert.equal(baseline.sampleHours, 10);
});

test('computeBaseline is unmoved by bucket order', () => {
  const ordered = computeBaseline([{ users: 1 }, { users: 2 }, { users: 100 }]);
  const shuffled = computeBaseline([{ users: 100 }, { users: 1 }, { users: 2 }]);
  assert.deepEqual(ordered, shuffled);
});

test('computeBaseline returns zeroes for empty or unusable input', () => {
  assert.deepEqual(computeBaseline([]), { p90: 0, median: 0, sampleHours: 0 });
  assert.deepEqual(computeBaseline(null), { p90: 0, median: 0, sampleHours: 0 });
  assert.deepEqual(computeBaseline([null, 'nope']), { p90: 0, median: 0, sampleHours: 0 });
});

test('computeBaseline coerces missing or negative user counts to zero', () => {
  const baseline = computeBaseline([{ users: undefined }, { users: -5 }, { users: '4' }]);
  assert.equal(baseline.sampleHours, 3);
  assert.equal(baseline.p90, 4);
});

test('computeBaseline takes an odd-length median from the middle sample', () => {
  assert.equal(computeBaseline([{ users: 1 }, { users: 7 }, { users: 3 }]).median, 3);
});

test('a baseline shorter than a day never decides anything', () => {
  const verdict = decideTrafficSpike({
    currentUsers: 5000,
    baseline: computeBaseline(flatBuckets(2, MIN_BASELINE_SAMPLE_HOURS - 1)),
    prev: null,
    now: 10 * HOUR_MS,
    cfg: {},
  });
  assert.equal(verdict.action, 'none');
  assert.equal(verdict.reason, 'insufficient-baseline');
  assert.equal(verdict.nextState.active, false);
});

test('exactly a day of samples is enough to decide', () => {
  const verdict = decideTrafficSpike({
    currentUsers: 5000,
    baseline: computeBaseline(flatBuckets(2, MIN_BASELINE_SAMPLE_HOURS)),
    prev: null,
    now: 10 * HOUR_MS,
    cfg: {},
  });
  assert.equal(verdict.action, 'ping');
});

test('a spike needs BOTH the multiplier and the absolute floor', () => {
  const baseline = computeBaseline(flatBuckets(10));
  const overMultipleUnderFloor = decideTrafficSpike({
    currentUsers: 30, baseline: computeBaseline(flatBuckets(1)), prev: null, now: HOUR_MS, cfg: { minUsers: 50 },
  });
  assert.equal(overMultipleUnderFloor.action, 'none');
  assert.equal(overMultipleUnderFloor.reason, 'no-spike');

  const overFloorUnderMultiple = decideTrafficSpike({
    currentUsers: 29, baseline, prev: null, now: HOUR_MS, cfg: {},
  });
  assert.equal(overFloorUnderMultiple.action, 'none');
});

test('the multiplier boundary is inclusive', () => {
  const baseline = computeBaseline(flatBuckets(10));
  const verdict = decideTrafficSpike({ currentUsers: 30, baseline, prev: null, now: HOUR_MS, cfg: {} });
  assert.equal(verdict.action, 'ping');
  assert.equal(verdict.reason, 'spike-started');
  assert.deepEqual(verdict.nextState, {
    active: true, lastPingAt: HOUR_MS, lastPingedUsers: 30, peakUsers: 30,
  });
});

test('a zero baseline is floored at one user so a single visitor is not a spike', () => {
  const baseline = computeBaseline(flatBuckets(0));
  assert.equal(decideTrafficSpike({ currentUsers: 3, baseline, prev: null, now: 1, cfg: {} }).action, 'none');
  assert.equal(decideTrafficSpike({ currentUsers: 12, baseline, prev: null, now: 1, cfg: {} }).action, 'ping');
});

test('a spike already reported stays quiet and tracks its peak', () => {
  const baseline = computeBaseline(flatBuckets(10));
  const prev = { active: true, lastPingAt: HOUR_MS, lastPingedUsers: 40, peakUsers: 40 };
  const verdict = decideTrafficSpike({ currentUsers: 45, baseline, prev, now: 2 * HOUR_MS, cfg: {} });
  assert.equal(verdict.action, 'none');
  assert.equal(verdict.reason, 'already-reported');
  assert.equal(verdict.nextState.active, true);
  assert.equal(verdict.nextState.peakUsers, 45);
  assert.equal(verdict.nextState.lastPingAt, HOUR_MS, 'a quiet tick does not restart the cooldown');
});

test('an active spike that doubled since its ping escalates', () => {
  const baseline = computeBaseline(flatBuckets(10));
  const prev = { active: true, lastPingAt: HOUR_MS, lastPingedUsers: 40, peakUsers: 40 };
  const verdict = decideTrafficSpike({ currentUsers: 80, baseline, prev, now: 3 * HOUR_MS, cfg: {} });
  assert.equal(verdict.action, 'escalate');
  assert.equal(verdict.reason, 'still-climbing');
  assert.deepEqual(verdict.nextState, {
    active: true, lastPingAt: 3 * HOUR_MS, lastPingedUsers: 80, peakUsers: 80,
  });
});

test('escalation is measured against the last PINGED count, not the peak', () => {
  const baseline = computeBaseline(flatBuckets(10));
  const prev = { active: true, lastPingAt: HOUR_MS, lastPingedUsers: 40, peakUsers: 200 };
  assert.equal(
    decideTrafficSpike({ currentUsers: 79, baseline, prev, now: 3 * HOUR_MS, cfg: {} }).action,
    'none',
  );
  assert.equal(
    decideTrafficSpike({ currentUsers: 80, baseline, prev, now: 3 * HOUR_MS, cfg: {} }).action,
    'escalate',
  );
});

test('an active entry with no pinged count cannot escalate off zero', () => {
  const baseline = computeBaseline(flatBuckets(10));
  const prev = { active: true, lastPingAt: HOUR_MS, lastPingedUsers: 0, peakUsers: 0 };
  const verdict = decideTrafficSpike({ currentUsers: 0, baseline, prev, now: 2 * HOUR_MS, cfg: {} });
  assert.notEqual(verdict.action, 'escalate');
});

test('traffic falling under half the multiplier clears the spike silently', () => {
  const baseline = computeBaseline(flatBuckets(10));
  const prev = { active: true, lastPingAt: HOUR_MS, lastPingedUsers: 40, peakUsers: 60 };
  const verdict = decideTrafficSpike({ currentUsers: 14, baseline, prev, now: 5 * HOUR_MS, cfg: {} });
  assert.equal(verdict.action, 'clear');
  assert.equal(verdict.reason, 'back-to-normal');
  assert.deepEqual(verdict.nextState, {
    active: false, lastPingAt: HOUR_MS, lastPingedUsers: 0, peakUsers: 0,
  });
});

test('the clear threshold is exclusive: sitting exactly on it stays active', () => {
  const baseline = computeBaseline(flatBuckets(10));
  const prev = { active: true, lastPingAt: HOUR_MS, lastPingedUsers: 40, peakUsers: 40 };
  const verdict = decideTrafficSpike({ currentUsers: 15, baseline, prev, now: 5 * HOUR_MS, cfg: {} });
  assert.equal(verdict.action, 'none');
  assert.equal(verdict.nextState.active, true);
});

test('a cleared spike can ping again once the cooldown has passed', () => {
  const baseline = computeBaseline(flatBuckets(10));
  const cleared = { active: false, lastPingAt: HOUR_MS, lastPingedUsers: 0, peakUsers: 0 };
  const withinCooldown = decideTrafficSpike({
    currentUsers: 40, baseline, prev: cleared, now: HOUR_MS + 60000, cfg: {},
  });
  assert.equal(withinCooldown.action, 'none');
  assert.equal(withinCooldown.reason, 'cooldown');
  assert.equal(withinCooldown.nextState.active, true, 'still tracked, just not announced');
  assert.equal(withinCooldown.nextState.lastPingAt, HOUR_MS, 'the cooldown is not extended by a muted spike');

  const afterCooldown = decideTrafficSpike({
    currentUsers: 40,
    baseline,
    prev: cleared,
    now: HOUR_MS + (DEFAULT_TRAFFIC_SPIKE_COOLDOWN_MINUTES * 60000),
    cfg: {},
  });
  assert.equal(afterCooldown.action, 'ping');
});

test('a shorter configured cooldown releases the ping sooner', () => {
  const baseline = computeBaseline(flatBuckets(10));
  const cleared = { active: false, lastPingAt: HOUR_MS, lastPingedUsers: 0, peakUsers: 0 };
  const verdict = decideTrafficSpike({
    currentUsers: 40, baseline, prev: cleared, now: HOUR_MS + 600000, cfg: { cooldownMinutes: 5 },
  });
  assert.equal(verdict.action, 'ping');
});

test('a zero cooldown never mutes a spike', () => {
  const baseline = computeBaseline(flatBuckets(10));
  const cleared = { active: false, lastPingAt: HOUR_MS, lastPingedUsers: 0, peakUsers: 0 };
  const verdict = decideTrafficSpike({
    currentUsers: 40, baseline, prev: cleared, now: HOUR_MS + 1, cfg: { cooldownMinutes: 0 },
  });
  assert.equal(verdict.action, 'ping');
});

test('the defaults are the documented ones and apply when cfg is empty', () => {
  assert.equal(DEFAULT_TRAFFIC_SPIKE_MULTIPLIER, 3);
  assert.equal(DEFAULT_TRAFFIC_SPIKE_MIN_USERS, 10);
  assert.equal(DEFAULT_TRAFFIC_SPIKE_COOLDOWN_MINUTES, 360);
  assert.equal(DEFAULT_TRAFFIC_BASELINE_DAYS, 7);
  assert.equal(MIN_BASELINE_SAMPLE_HOURS, 24);

  const baseline = computeBaseline(flatBuckets(2));

  assert.equal(decideTrafficSpike({ currentUsers: 9, baseline, prev: null, now: 1 }).action, 'none');
  assert.equal(decideTrafficSpike({ currentUsers: 10, baseline, prev: null, now: 1 }).action, 'ping');
});

test('spikeMultiple and formatMultiple render a compact ratio', () => {
  assert.equal(spikeMultiple(87, { p90: 10 }), 8.7);
  assert.equal(formatMultiple(8.7), '8.7x');
  assert.equal(formatMultiple(12.4), '12x');
  assert.equal(formatMultiple(3), '3x');
});

test('spikeSummaryLine names the users, the multiple and the baseline', () => {
  assert.equal(
    spikeSummaryLine({ currentUsers: 87, baseline: { p90: 10 } }),
    '87 users in the last hour, ~8.7x normal (p90 10)',
  );
});
