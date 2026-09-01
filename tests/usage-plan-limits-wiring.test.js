'use strict';

// The plan-limit half of the usage lane, driven through createUsageWiring with every side effect
// injected (the pr-poller pattern): the statusLine ingest, the broadcast throttle, the machine-wide
// snapshot, the kill switch, and the officialCostUSD stamp on the per-card push.
//
// No scanner, no fs, no network: ingestStatusline is on the hot path of every live turn of every
// session, so it is tested for exactly what it is, an O(1) normalize plus two map writes.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUsageWiring, resolveUsageConfig, DEFAULT_USAGE_CONFIG } = require('../server/usage-wiring.ts');

const GLISSA_ID = 'a0000000-0000-4000-8000-000000000001';
const CLAUDE_ID = 'c1c1c1c1-2222-4333-8444-555555555555';

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

function harness({ usage = {}, totals = null } = {}) {
  const sent = [];
  let now = 1_800_000_000_000;
  const scanner = {
    runPass: async () => ({ newEntries: 1, partial: false }),
    sessionTotals: () => totals || new Map([[CLAUDE_ID, { tokens: 1200, costUSD: 0.42, lastTs: now }]]),
    buildReport: () => ({ ts: now, totals: {}, daily: [], models: [], sessions: [], blocks: [], activeBlock: null, tokenLimit: null, pricing: { missing: [] }, scan: { dirs: [], files: 0, entries: 0, lastScanMs: 0, partial: false } }),
    stats: () => ({ resolutionError: null }),
  };
  const wiring = createUsageWiring({
    config: { usage: { ...usage } },
    sessions: new Map([[GLISSA_ID, { resumeSessionId: CLAUDE_ID, ephemeral: false }]]),
    broadcast: (msg) => sent.push(msg),
    controlClientCount: () => 1,
    createScanner: () => scanner,
    loadPricingFn: async () => ({ table: {}, source: 'snapshot', fetchedAt: null }),
    nowFn: () => now,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: { warn() {} },
  });
  return {
    wiring,
    sent,
    planMessages: () => sent.filter((msg) => msg.type === 'plan-limits'),
    sessionMessages: () => sent.filter((msg) => msg.type === 'usage-sessions'),
    advance: (ms) => { now += ms; },
  };
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
  const h = harness();
  h.wiring.ingestStatusline(statuslinePayload());
  assert.equal(h.planMessages().length, 1);
  const msg = h.planMessages()[0];
  assert.equal(msg.type, 'plan-limits');
  assert.equal(msg.source, 'statusline');
  assert.deepEqual(msg.fiveHour, { pct: 12, resetsAtMs: 1_800_003_600_000 });
  assert.deepEqual(msg.sevenDay, { pct: 68.4, resetsAtMs: 1_800_400_000_000 });
  assert.deepEqual(h.wiring.getPlanLimitsMessage(), msg);
});

// The whole reason for the throttle: this fires several times inside one turn, ~300ms apart.
test('repeat payloads with unchanged numbers never reach the wire', () => {
  const h = harness();
  h.wiring.ingestStatusline(statuslinePayload());
  for (let i = 0; i < 20; i++) {
    h.advance(300);
    h.wiring.ingestStatusline(statuslinePayload());
  }
  assert.equal(h.planMessages().length, 1);
  h.advance(300);
  h.wiring.ingestStatusline(statuslinePayload({ five: 13.5 }));
  assert.equal(h.planMessages().length, 2);
  assert.equal(h.planMessages()[1].fiveHour.pct, 13.5);
});

test('the startup payload (no rate_limits) neither broadcasts nor blanks a good snapshot', () => {
  const h = harness();
  h.wiring.ingestStatusline({ session_id: CLAUDE_ID, cost: { total_cost_usd: 0.2 } });
  assert.equal(h.planMessages().length, 0);
  assert.equal(h.wiring.getPlanLimitsMessage(), null);

  h.wiring.ingestStatusline(statuslinePayload());
  assert.equal(h.planMessages().length, 1);
  // A later limitless payload must not erase what the account already reported.
  h.wiring.ingestStatusline({ session_id: CLAUDE_ID, cost: { total_cost_usd: 0.3 } });
  assert.equal(h.planMessages().length, 1);
  assert.equal(h.wiring.getPlanLimitsMessage().fiveHour.pct, 12);
});

test('garbage and non-objects are dropped without throwing', () => {
  const h = harness();
  for (const bad of [null, undefined, 42, 'x', [], { rate_limits: 'no' }]) {
    h.wiring.ingestStatusline(bad);
  }
  assert.equal(h.planMessages().length, 0);
  assert.equal(h.wiring.getPlanLimitsMessage(), null);
});

test('planLimits false is fully inert, on the write and on the read', () => {
  const h = harness({ usage: { planLimits: false } });
  h.wiring.ingestStatusline(statuslinePayload());
  assert.equal(h.planMessages().length, 0);
  assert.equal(h.wiring.getPlanLimitsMessage(), null);
});

test('officialCostUSD rides the per-card push, keyed by the Claude session id', async () => {
  const h = harness();
  await h.wiring.start();
  const before = h.sessionMessages().at(-1);
  assert.ok(before, 'the first pass pushed a baseline');
  assert.equal(before.sessions[0].id, GLISSA_ID);
  // Nothing official reported yet: null, distinct from a zero cost.
  assert.equal(before.sessions[0].officialCostUSD, null);
  assert.equal(before.sessions[0].costUSD, 0.42, 'the scanner estimate is untouched');

  h.wiring.ingestStatusline(statuslinePayload({ cost: 2.75 }));
  h.wiring.refreshSessions();
  const after = h.sessionMessages().at(-1);
  assert.equal(after.sessions[0].officialCostUSD, 2.75);
  assert.equal(after.sessions[0].costUSD, 0.42, 'official cost does not overwrite the estimate');
});

test('a cost for a different conversation is not attributed to this card', async () => {
  const h = harness();
  await h.wiring.start();
  h.wiring.ingestStatusline(statuslinePayload({ cost: 9.99, sessionId: 'some-other-claude-session' }));
  h.wiring.refreshSessions();
  assert.equal(h.sessionMessages().at(-1).sessions[0].officialCostUSD, null);
});

test('a stopped lane ingests nothing', async () => {
  const h = harness();
  await h.wiring.stop();
  h.wiring.ingestStatusline(statuslinePayload());
  assert.equal(h.planMessages().length, 0);
});
