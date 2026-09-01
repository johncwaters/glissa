import { toCount } from './posthog-core.ts';

const DEFAULT_TRAFFIC_SPIKE_MULTIPLIER = 3;
const DEFAULT_TRAFFIC_SPIKE_MIN_USERS = 10;
const DEFAULT_TRAFFIC_SPIKE_COOLDOWN_MINUTES = 360;
const DEFAULT_TRAFFIC_BASELINE_DAYS = 7;

const MIN_BASELINE_SAMPLE_HOURS = 24;

const ESCALATION_GROWTH_FACTOR = 2;

const TRAFFIC_KEY = '_traffic';

export interface TrafficBaseline {
  p90: number;
  median: number;
  sampleHours: number;
}

export interface TrafficState {
  active: boolean;
  lastPingAt: number;
  lastPingedUsers: number;
  peakUsers: number;
}

export interface TrafficVerdict {
  action: 'none' | 'ping' | 'escalate' | 'clear';
  reason: string;
  nextState: TrafficState;
  multiple: number;
}

function sortedUserCounts(buckets: unknown): number[] {
  const list: unknown[] = Array.isArray(buckets) ? buckets : [];
  return list
    .filter((row): row is { users?: unknown } => Boolean(row) && typeof row === 'object')
    .map((row) => Math.max(0, toCount(row.users, 0)))
    .sort((a, b) => a - b);
}

function quantile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil(fraction * sortedValues.length) - 1;
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, index))];
}

function median(sortedValues: number[]): number {
  if (sortedValues.length === 0) return 0;
  const mid = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[mid];
  return (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

function computeBaseline(buckets: unknown): TrafficBaseline {
  const values = sortedUserCounts(buckets);
  return {
    p90: quantile(values, 0.9),
    median: median(values),
    sampleHours: values.length,
  };
}

function normalizeState(prev: unknown): TrafficState {
  const entry: Record<string, unknown> = prev && typeof prev === 'object'
    ? (prev as Record<string, unknown>)
    : {};
  return {
    active: entry.active === true,
    lastPingAt: toCount(entry.lastPingAt, 0),
    lastPingedUsers: toCount(entry.lastPingedUsers, 0),
    peakUsers: toCount(entry.peakUsers, 0),
  };
}

function baselineFloor(baseline: { p90?: unknown } | null | undefined): number {
  return Math.max(toCount(baseline?.p90, 0), 1);
}

function spikeMultiple(currentUsers: unknown, baseline: { p90?: unknown } | null | undefined): number {
  return toCount(currentUsers, 0) / baselineFloor(baseline);
}

function formatMultiple(multiple: unknown): string {
  const value = toCount(multiple, 0);
  if (value >= 10) return `${Math.round(value)}x`;
  return `${(Math.round(value * 10) / 10)}x`;
}

function spikeSummaryLine({ currentUsers, baseline, multiple }: {
  currentUsers?: unknown;
  baseline?: { p90?: unknown } | null;
  multiple?: number;
} = {}): string {
  const ratio = multiple === undefined ? spikeMultiple(currentUsers, baseline) : multiple;
  return `${toCount(currentUsers, 0)} users in the last hour, ~${formatMultiple(ratio)} normal (p90 ${toCount(baseline?.p90, 0)})`;
}

function verdict(action: TrafficVerdict['action'], reason: string, nextState: TrafficState, multiple: number): TrafficVerdict {
  return { action, reason, nextState, multiple };
}

function nextTrafficState(state: TrafficState, users: number, overrides: Partial<TrafficState> = {}): TrafficState {
  return { ...state, peakUsers: Math.max(state.peakUsers, users), ...overrides };
}

function decideTrafficSpike({ currentUsers, baseline, prev, now, cfg }: {
  currentUsers?: unknown;
  baseline?: { p90?: unknown; sampleHours?: unknown } | null;
  prev?: unknown;
  now?: unknown;
  cfg?: unknown;
} = {}): TrafficVerdict {
  const options: Record<string, unknown> = cfg && typeof cfg === 'object'
    ? (cfg as Record<string, unknown>)
    : {};
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
      const escalated = nextTrafficState(state, users, { active: true, lastPingAt: nowMs, lastPingedUsers: users });
      return verdict('escalate', 'still-climbing', escalated, multiple);
    }
    if (users < (multiplier / 2) * floor) {
      const cleared = nextTrafficState(state, users, { active: false, lastPingedUsers: 0, peakUsers: 0 });
      return verdict('clear', 'back-to-normal', cleared, multiple);
    }
    return verdict('none', 'already-reported', nextTrafficState(state, users), multiple);
  }

  if (!isSpiking) return verdict('none', 'no-spike', state, multiple);

  if (state.lastPingAt > 0 && nowMs - state.lastPingAt < cooldownMinutes * 60000) {
    const held = nextTrafficState(state, users, { active: true, lastPingedUsers: users });
    return verdict('none', 'cooldown', held, multiple);
  }

  const started = nextTrafficState(state, users, { active: true, lastPingAt: nowMs, lastPingedUsers: users });
  return verdict('ping', 'spike-started', started, multiple);
}

export { computeBaseline, decideTrafficSpike, spikeMultiple, formatMultiple, spikeSummaryLine, TRAFFIC_KEY, MIN_BASELINE_SAMPLE_HOURS, DEFAULT_TRAFFIC_SPIKE_MULTIPLIER, DEFAULT_TRAFFIC_SPIKE_MIN_USERS, DEFAULT_TRAFFIC_SPIKE_COOLDOWN_MINUTES, DEFAULT_TRAFFIC_BASELINE_DAYS };
