'use strict';

// Baseline uses the project's p90 so one past spike cannot hide the next one.

const { toCount } = require('./posthog-core');

const DEFAULT_TRAFFIC_SPIKE_MULTIPLIER = 3;
const DEFAULT_TRAFFIC_SPIKE_MIN_USERS = 10;
const DEFAULT_TRAFFIC_SPIKE_COOLDOWN_MINUTES = 360;
const DEFAULT_TRAFFIC_BASELINE_DAYS = 7;
// Below a day of hourly samples the p90 is mostly one part of one daily cycle, so a normal morning
// reads as a spike against a quiet night. Day one of a lane reports nothing rather than lying.
const MIN_BASELINE_SAMPLE_HOURS = 24;
// An active spike that has doubled again since the last ping is climbing, not merely continuing.
const ESCALATION_GROWTH_FACTOR = 2;
// Per-project traffic state, parked under an underscore key so a server that iterates issue keys
// (everything not starting with '_') loads a newer state file unharmed.
const TRAFFIC_KEY = '_traffic';

function sortedUserCounts(buckets) {
  const list = Array.isArray(buckets) ? buckets : [];
  return list
    .filter((row) => row && typeof row === 'object')
    .map((row) => Math.max(0, toCount(row.users, 0)))
    .sort((a, b) => a - b);
}

function quantile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil(fraction * sortedValues.length) - 1;
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, index))];
}

function median(sortedValues) {
  if (sortedValues.length === 0) return 0;
  const mid = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[mid];
  return (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

/** The project's own normal, from its hourly unique-user counts. Empty input reports zeroes. */
function computeBaseline(buckets) {
  const values = sortedUserCounts(buckets);
  return {
    p90: quantile(values, 0.9),
    median: median(values),
    sampleHours: values.length,
  };
}

function normalizeState(prev) {
  const entry = prev && typeof prev === 'object' ? prev : {};
  return {
    active: entry.active === true,
    lastPingAt: toCount(entry.lastPingAt, 0),
    lastPingedUsers: toCount(entry.lastPingedUsers, 0),
    peakUsers: toCount(entry.peakUsers, 0),
  };
}

// The floor of 1 keeps a project whose baseline hour is genuinely 0 users from making every single
// visitor a 3x spike; it also keeps the ratio finite.
function baselineFloor(baseline) {
  return Math.max(toCount(baseline?.p90, 0), 1);
}

/** How many times its own normal the current window is running at. */
function spikeMultiple(currentUsers, baseline) {
  return toCount(currentUsers, 0) / baselineFloor(baseline);
}

/** Compact multiple for a ping line: 12x, 3.4x, 1.5x. */
function formatMultiple(multiple) {
  const value = toCount(multiple, 0);
  if (value >= 10) return `${Math.round(value)}x`;
  return `${(Math.round(value * 10) / 10)}x`;
}

/** The one-line body of a traffic ping. Every number the operator needs to judge it, no prose. */
function spikeSummaryLine({ currentUsers, baseline, multiple } = {}) {
  const ratio = multiple === undefined ? spikeMultiple(currentUsers, baseline) : multiple;
  return `${toCount(currentUsers, 0)} users in the last hour, ~${formatMultiple(ratio)} normal (p90 ${toCount(baseline?.p90, 0)})`;
}

function verdict(action, reason, nextState, multiple) {
  return { action, reason, nextState, multiple };
}

// The clear action is silent downstream: it only re-arms future spike pings.
function decideTrafficSpike({ currentUsers, baseline, prev, now, cfg } = {}) {
  const options = cfg && typeof cfg === 'object' ? cfg : {};
  const multiplier = toCount(options.multiplier, DEFAULT_TRAFFIC_SPIKE_MULTIPLIER);
  const minUsers = toCount(options.minUsers, DEFAULT_TRAFFIC_SPIKE_MIN_USERS);
  const cooldownMinutes = toCount(options.cooldownMinutes, DEFAULT_TRAFFIC_SPIKE_COOLDOWN_MINUTES);
  const users = Math.max(0, toCount(currentUsers, 0));
  const state = normalizeState(prev);
  const nowMs = toCount(now, 0);
  const floor = baselineFloor(baseline);
  const multiple = users / floor;
  const sampleHours = toCount(baseline?.sampleHours, 0);

  if (sampleHours < MIN_BASELINE_SAMPLE_HOURS) {
    return verdict('none', 'insufficient-baseline', state, multiple);
  }

  const isSpiking = users >= multiplier * floor && users >= minUsers;

  if (state.active) {
    if (state.lastPingedUsers > 0 && users >= ESCALATION_GROWTH_FACTOR * state.lastPingedUsers) {
      return verdict('escalate', 'still-climbing', {
        active: true,
        lastPingAt: nowMs,
        lastPingedUsers: users,
        peakUsers: Math.max(state.peakUsers, users),
      }, multiple);
    }
    if (users < (multiplier / 2) * floor) {
      return verdict('clear', 'back-to-normal', {
        active: false,
        lastPingAt: state.lastPingAt,
        lastPingedUsers: 0,
        peakUsers: 0,
      }, multiple);
    }
    return verdict('none', 'already-reported', {
      ...state,
      peakUsers: Math.max(state.peakUsers, users),
    }, multiple);
  }

  if (!isSpiking) return verdict('none', 'no-spike', state, multiple);

  // Inside the cooldown the spike is still recorded as active, so the tick it ends still clears and
  // the next genuine takeoff pings; only the buzz is withheld.
  if (state.lastPingAt > 0 && nowMs - state.lastPingAt < cooldownMinutes * 60000) {
    return verdict('none', 'cooldown', {
      active: true,
      lastPingAt: state.lastPingAt,
      lastPingedUsers: users,
      peakUsers: Math.max(state.peakUsers, users),
    }, multiple);
  }

  return verdict('ping', 'spike-started', {
    active: true,
    lastPingAt: nowMs,
    lastPingedUsers: users,
    peakUsers: Math.max(state.peakUsers, users),
  }, multiple);
}

module.exports = {
  computeBaseline,
  decideTrafficSpike,
  spikeMultiple,
  formatMultiple,
  spikeSummaryLine,
  TRAFFIC_KEY,
  MIN_BASELINE_SAMPLE_HOURS,
  ESCALATION_GROWTH_FACTOR,
  DEFAULT_TRAFFIC_SPIKE_MULTIPLIER,
  DEFAULT_TRAFFIC_SPIKE_MIN_USERS,
  DEFAULT_TRAFFIC_SPIKE_COOLDOWN_MINUTES,
  DEFAULT_TRAFFIC_BASELINE_DAYS,
};
