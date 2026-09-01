// The plan-limit half of the usage lane, driven through createUsageWiring with every side effect
// injected (the pr-poller pattern): the statusLine ingest, the broadcast throttle, the machine-wide
// snapshot, the kill switch, and the officialCostUSD stamp on the per-card push.
//
// No scanner, no fs, no network: ingestStatusline is on the hot path of every live turn of every
// session, so it is tested for exactly what it is, an O(1) normalize plus two map writes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createUsageWiring, resolveUsageConfig, DEFAULT_USAGE_CONFIG } from '../server/usage-wiring.ts';

const GLISSA_ID = 'a0000000-0000-4000-8000-000000000001';
const CLAUDE_ID = 'c1c1c1c1-2222-4333-8444-555555555555';

interface RateWindow {
  pct: number;
  resetsAtMs: number;
}

interface PlanLimitsFrame {
  type: 'plan-limits';
  source: string;
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
}

interface UsageSessionsFrame {
  type: 'usage-sessions';
  sessions: {
    id: string;
    tokens: number;
    costUSD: number;
    officialCostUSD: number | null | undefined;
  }[];
}

function isPlanLimits(frame: Record<string, unknown>): frame is Record<string, unknown> & PlanLimitsFrame {
  return frame.type === 'plan-limits';
}

function isUsageSessions(frame: Record<string, unknown>): frame is Record<string, unknown> & UsageSessionsFrame {
  return frame.type === 'usage-sessions';
}

function statuslinePayload({ five = 12, seven = 68.4, cost = 1.5, sessionId = CLAUDE_ID } = {}) {
  return {
    session_id: sessionId,
    cost: { total_cost_usd: cost },
    context_window: { used_percentage: 40 },
    rate_limits: {
      five_hour: { used_percentage: five, resets_at: 1_800_003_600 },
      seven_day: { used_percentage: seven, resets_at: 1_800_400_000 },
    },
  };
}

function harness({ usage = {} }: { usage?: Record<string, unknown> } = {}) {
  const sent: Record<string, unknown>[] = [];
  let now = 1_800_000_000_000;
  const scanner = {
    runPass: async () => ({ files: 1, entries: 1, newEntries: 1, partial: false, durationMs: 0 }),
    sessionTotals: () => new Map([[CLAUDE_ID, { tokens: 1200, costUSD: 0.42, lastTs: now }]]),
    // Only requestReport reads this, and no test here asks for a report.
    buildReport: (): never => { throw new Error('this suite never builds a report'); },
    stats: () => ({ dirs: [], files: 0, entries: 0, lastScanMs: 0, resolutionError: null }),
    budgetSpend: () => ({ todayKey: '2027-01-15', monthKey: '2027-01', todayUsd: 0, monthUsd: 0 }),
  };
  const wiring = createUsageWiring({
    config: { usage: { ...usage } },
    sessions: new Map([[GLISSA_ID, { resumeSessionId: CLAUDE_ID, ephemeral: false }]]),
    broadcast: (message) => { sent.push(message); },
    controlClientCount: () => 1,
    createScanner: () => scanner,
    loadPricingFn: async () => ({ table: new Map(), source: 'snapshot', fetchedAt: null }),
    nowFn: () => now,
    // An inert handle: the lane owns a timer it never gets to fire, so no scan pass runs behind a test.
    setIntervalFn: () => {
      const handle = setTimeout(() => {}, 0);
      handle.unref();
      return handle;
    },
    clearIntervalFn: (handle) => clearTimeout(handle),
    logger: { warn() {}, log() {} },
  });
  return {
    wiring,
    sent,
    planMessages: (): PlanLimitsFrame[] => sent.filter(isPlanLimits),
    sessionMessages: (): UsageSessionsFrame[] => sent.filter(isUsageSessions),
    advance: (ms: number) => { now += ms; },
  };
}

function lastSessionRow(frames: UsageSessionsFrame[]) {
  const frame = frames.at(-1);
  assert.ok(frame, 'a usage-sessions frame was pushed');
  const row = frame.sessions[0];
  assert.ok(row, 'the frame carries the card row');
  return row;
}

test('planLimits defaults on, and rides the usage config resolver', () => {
  assert.equal(DEFAULT_USAGE_CONFIG.planLimits, true);
  assert.equal(resolveUsageConfig(undefined).planLimits, true);
  assert.equal(resolveUsageConfig({}).planLimits, true);
  assert.equal(resolveUsageConfig({ planLimits: false }).planLimits, false);
  // Defensive like every other key here: a hand-edited non-boolean falls back rather than throwing.
  assert.equal(resolveUsageConfig({ planLimits: 'no' }).planLimits, true);
});

test('a first payload with rate limits broadcasts once and becomes the snapshot', () => {
  const lane = harness();
  lane.wiring.ingestStatusline(statuslinePayload());
  assert.equal(lane.planMessages().length, 1);
  const message = lane.planMessages()[0];
  assert.equal(message.type, 'plan-limits');
  assert.equal(message.source, 'statusline');
  assert.deepEqual(message.fiveHour, { pct: 12, resetsAtMs: 1_800_003_600_000 });
  assert.deepEqual(message.sevenDay, { pct: 68.4, resetsAtMs: 1_800_400_000_000 });
  assert.deepEqual(lane.wiring.getPlanLimitsMessage(), message);
});

// The whole reason for the throttle: this fires several times inside one turn, ~300ms apart.
test('repeat payloads with unchanged numbers never reach the wire', () => {
  const lane = harness();
  lane.wiring.ingestStatusline(statuslinePayload());
  for (let round = 0; round < 20; round += 1) {
    lane.advance(300);
    lane.wiring.ingestStatusline(statuslinePayload());
  }
  assert.equal(lane.planMessages().length, 1);
  lane.advance(300);
  lane.wiring.ingestStatusline(statuslinePayload({ five: 13.5 }));
  assert.equal(lane.planMessages().length, 2);
  assert.equal(lane.planMessages()[1].fiveHour?.pct, 13.5);
});

test('the startup payload (no rate_limits) neither broadcasts nor blanks a good snapshot', () => {
  const lane = harness();
  lane.wiring.ingestStatusline({ session_id: CLAUDE_ID, cost: { total_cost_usd: 0.2 } });
  assert.equal(lane.planMessages().length, 0);
  assert.equal(lane.wiring.getPlanLimitsMessage(), null);

  lane.wiring.ingestStatusline(statuslinePayload());
  assert.equal(lane.planMessages().length, 1);
  // A later limitless payload must not erase what the account already reported.
  lane.wiring.ingestStatusline({ session_id: CLAUDE_ID, cost: { total_cost_usd: 0.3 } });
  assert.equal(lane.planMessages().length, 1);
  assert.equal(lane.wiring.getPlanLimitsMessage()?.fiveHour?.pct, 12);
});

test('garbage and non-objects are dropped without throwing', () => {
  const lane = harness();
  for (const bad of [null, undefined, 42, 'x', [], { rate_limits: 'no' }]) {
    lane.wiring.ingestStatusline(bad);
  }
  assert.equal(lane.planMessages().length, 0);
  assert.equal(lane.wiring.getPlanLimitsMessage(), null);
});

test('planLimits false is fully inert, on the write and on the read', () => {
  const lane = harness({ usage: { planLimits: false } });
  lane.wiring.ingestStatusline(statuslinePayload());
  assert.equal(lane.planMessages().length, 0);
  assert.equal(lane.wiring.getPlanLimitsMessage(), null);
});

test('officialCostUSD rides the per-card push, keyed by the Claude session id', async () => {
  const lane = harness();
  await lane.wiring.start();
  const before = lastSessionRow(lane.sessionMessages());
  assert.equal(before.id, GLISSA_ID);
  // Nothing official reported yet: null, distinct from a zero cost.
  assert.equal(before.officialCostUSD, null);
  assert.equal(before.costUSD, 0.42, 'the scanner estimate is untouched');

  lane.wiring.ingestStatusline(statuslinePayload({ cost: 2.75 }));
  lane.wiring.refreshSessions();
  const after = lastSessionRow(lane.sessionMessages());
  assert.equal(after.officialCostUSD, 2.75);
  assert.equal(after.costUSD, 0.42, 'official cost does not overwrite the estimate');
});

test('a cost for a different conversation is not attributed to this card', async () => {
  const lane = harness();
  await lane.wiring.start();
  lane.wiring.ingestStatusline(statuslinePayload({ cost: 9.99, sessionId: 'some-other-claude-session' }));
  lane.wiring.refreshSessions();
  assert.equal(lastSessionRow(lane.sessionMessages()).officialCostUSD, null);
});

test('a stopped lane ingests nothing', async () => {
  const lane = harness();
  await lane.wiring.stop();
  lane.wiring.ingestStatusline(statuslinePayload());
  assert.equal(lane.planMessages().length, 0);
});
