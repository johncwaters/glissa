'use strict';

// Pure normalization of the Claude Code statusLine payload, which is the ONLY channel that publishes
// the official `/usage` plan limits to anything outside Claude Code. Every field it carries is
// conditional (live-probed, 2.1.235): rate_limits is absent on the startup invocation and on
// non-subscription plans, and each window can be absent on its own. The matrix below is what keeps
// "absent" from silently becoming "0% used".

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeStatuslinePayload,
  shouldBroadcastPlanLimits,
  buildPlanLimitsMessage,
  planLimitsSignature,
} = require('../server/core/usage-statusline-core');

const NOW = 1_800_000_000_000;

// A realistic post-API-response invocation, trimmed to the fields Glissa reads.
function fullPayload(overrides = {}) {
  return {
    session_id: 'c1c1c1c1-2222-4333-8444-555555555555',
    transcript_path: 'C:/Users/x/.claude/projects/repo/abc.jsonl',
    cwd: 'C:/repos/glissa',
    prompt_id: 'p-1',
    model: { id: 'claude-opus-4-5', display_name: 'Opus 4.5' },
    version: '2.1.235',
    cost: {
      total_cost_usd: 1.2345,
      total_duration_ms: 12000,
      total_api_duration_ms: 9000,
      total_lines_added: 10,
      total_lines_removed: 2,
    },
    context_window: {
      total_input_tokens: 1000,
      total_output_tokens: 200,
      context_window_size: 200000,
      current_usage: null,
      used_percentage: 42.00000000000001,
      remaining_percentage: 57.99999999999999,
    },
    rate_limits: {
      five_hour: { used_percentage: 12.000000000000002, resets_at: 1_800_003_600 },
      seven_day: { used_percentage: 68.4, resets_at: 1_800_400_000 },
    },
    ...overrides,
  };
}

test('normalize: the full payload, with percentages rounded and reset times in ms', () => {
  const snap = normalizeStatuslinePayload(fullPayload(), NOW);
  assert.equal(snap.ts, NOW);
  assert.equal(snap.claudeSessionId, 'c1c1c1c1-2222-4333-8444-555555555555');
  assert.equal(snap.sessionCostUSD, 1.2345);
  // Binary-float noise is rounded away, which is also what makes the broadcast throttle stable.
  assert.equal(snap.contextPct, 42);
  assert.deepEqual(snap.rateLimits.fiveHour, { pct: 12, resetsAtMs: 1_800_003_600_000 });
  assert.deepEqual(snap.rateLimits.sevenDay, { pct: 68.4, resetsAtMs: 1_800_400_000_000 });
});

test('normalize: rejects anything that is not an object', () => {
  assert.equal(normalizeStatuslinePayload(null, NOW), null);
  assert.equal(normalizeStatuslinePayload(undefined, NOW), null);
  assert.equal(normalizeStatuslinePayload('{}', NOW), null);
  assert.equal(normalizeStatuslinePayload(42, NOW), null);
  assert.equal(normalizeStatuslinePayload([], NOW), null);
});

// The startup invocation. Everything else still has to normalize so the session cost lands.
test('normalize: absent rate_limits yields null limits, not zeroed windows', () => {
  const payload = fullPayload();
  delete payload.rate_limits;
  const snap = normalizeStatuslinePayload(payload, NOW);
  assert.equal(snap.rateLimits, null);
  assert.equal(snap.sessionCostUSD, 1.2345);
  assert.equal(snap.contextPct, 42);
});

test('normalize: each window is independently optional', () => {
  const onlyFive = normalizeStatuslinePayload(fullPayload({
    rate_limits: { five_hour: { used_percentage: 5, resets_at: 1_800_003_600 } },
  }), NOW);
  assert.deepEqual(onlyFive.rateLimits.fiveHour, { pct: 5, resetsAtMs: 1_800_003_600_000 });
  assert.equal(onlyFive.rateLimits.sevenDay, null);

  const onlySeven = normalizeStatuslinePayload(fullPayload({
    rate_limits: { seven_day: { used_percentage: 5, resets_at: 1_800_003_600 } },
  }), NOW);
  assert.equal(onlySeven.rateLimits.fiveHour, null);
  assert.deepEqual(onlySeven.rateLimits.sevenDay, { pct: 5, resetsAtMs: 1_800_003_600_000 });

  // A rate_limits object with nothing usable in it is the same as not having one.
  assert.equal(normalizeStatuslinePayload(fullPayload({ rate_limits: {} }), NOW).rateLimits, null);
  assert.equal(normalizeStatuslinePayload(fullPayload({ rate_limits: { five_hour: {} } }), NOW).rateLimits, null);
  assert.equal(normalizeStatuslinePayload(fullPayload({ rate_limits: 'nope' }), NOW).rateLimits, null);
});

test('normalize: a window keeps whichever half it reported', () => {
  const pctOnly = normalizeStatuslinePayload(fullPayload({
    rate_limits: { five_hour: { used_percentage: 33.33 } },
  }), NOW);
  assert.deepEqual(pctOnly.rateLimits.fiveHour, { pct: 33.3, resetsAtMs: null });

  const resetOnly = normalizeStatuslinePayload(fullPayload({
    rate_limits: { five_hour: { resets_at: 1_800_003_600 } },
  }), NOW);
  assert.deepEqual(resetOnly.rateLimits.fiveHour, { pct: null, resetsAtMs: 1_800_003_600_000 });
});

test('normalize: absent, null and non-numeric cost or context stay null', () => {
  const noCost = normalizeStatuslinePayload(fullPayload({ cost: null, context_window: null }), NOW);
  assert.equal(noCost.sessionCostUSD, null);
  assert.equal(noCost.contextPct, null);

  const bad = normalizeStatuslinePayload(fullPayload({
    cost: { total_cost_usd: 'free' },
    context_window: { used_percentage: null },
  }), NOW);
  assert.equal(bad.sessionCostUSD, null);
  assert.equal(bad.contextPct, null);

  // A genuinely free session reports 0, which is a fact and must survive.
  const zero = normalizeStatuslinePayload(fullPayload({ cost: { total_cost_usd: 0 } }), NOW);
  assert.equal(zero.sessionCostUSD, 0);
});

test('normalize: a missing or blank session id is null, never an empty string', () => {
  assert.equal(normalizeStatuslinePayload(fullPayload({ session_id: '   ' }), NOW).claudeSessionId, null);
  const payload = fullPayload();
  delete payload.session_id;
  assert.equal(normalizeStatuslinePayload(payload, NOW).claudeSessionId, null);
});

test('normalize: reset times are seconds, and a value already in ms is not multiplied again', () => {
  const seconds = normalizeStatuslinePayload(fullPayload({
    rate_limits: { five_hour: { used_percentage: 1, resets_at: 1_800_003_600 } },
  }), NOW);
  assert.equal(seconds.rateLimits.fiveHour.resetsAtMs, 1_800_003_600_000);
  // Defensive: a future unit change degrades to a correct countdown instead of a year-3000 one.
  const millis = normalizeStatuslinePayload(fullPayload({
    rate_limits: { five_hour: { used_percentage: 1, resets_at: 1_800_003_600_000 } },
  }), NOW);
  assert.equal(millis.rateLimits.fiveHour.resetsAtMs, 1_800_003_600_000);
  // Zero and negative are not times.
  const zero = normalizeStatuslinePayload(fullPayload({
    rate_limits: { five_hour: { used_percentage: 1, resets_at: 0 } },
  }), NOW);
  assert.equal(zero.rateLimits.fiveHour.resetsAtMs, null);
});

test('normalize: a negative percentage clamps to zero rather than rendering a backwards bar', () => {
  const snap = normalizeStatuslinePayload(fullPayload({
    rate_limits: { five_hour: { used_percentage: -3, resets_at: 1_800_003_600 } },
  }), NOW);
  assert.equal(snap.rateLimits.fiveHour.pct, 0);
});

// The throttle. statusLine fires per assistant and tool step with a ~300ms floor; the plan percentages
// move far more slowly, so an unchanged snapshot must never reach the wire.
test('shouldBroadcastPlanLimits: only a moved percentage or reset time broadcasts', () => {
  const first = normalizeStatuslinePayload(fullPayload(), NOW);
  assert.equal(shouldBroadcastPlanLimits(null, first), true);
  // Identical numbers, a later callback: silent.
  const same = normalizeStatuslinePayload(fullPayload(), NOW + 300);
  assert.equal(shouldBroadcastPlanLimits(first, same), false);
  // Noise below the rounding threshold is also silent, which is the point of rounding first.
  const noise = normalizeStatuslinePayload(fullPayload({
    rate_limits: {
      five_hour: { used_percentage: 12.0000000001, resets_at: 1_800_003_600 },
      seven_day: { used_percentage: 68.4, resets_at: 1_800_400_000 },
    },
  }), NOW + 600);
  assert.equal(shouldBroadcastPlanLimits(first, noise), false);

  const movedPct = normalizeStatuslinePayload(fullPayload({
    rate_limits: {
      five_hour: { used_percentage: 12.6, resets_at: 1_800_003_600 },
      seven_day: { used_percentage: 68.4, resets_at: 1_800_400_000 },
    },
  }), NOW + 900);
  assert.equal(shouldBroadcastPlanLimits(first, movedPct), true);

  const movedReset = normalizeStatuslinePayload(fullPayload({
    rate_limits: {
      five_hour: { used_percentage: 12, resets_at: 1_800_020_000 },
      seven_day: { used_percentage: 68.4, resets_at: 1_800_400_000 },
    },
  }), NOW + 1200);
  assert.equal(shouldBroadcastPlanLimits(first, movedReset), true);

  // A window appearing or disappearing is a change too.
  const droppedSeven = normalizeStatuslinePayload(fullPayload({
    rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_800_003_600 } },
  }), NOW + 1500);
  assert.equal(shouldBroadcastPlanLimits(first, droppedSeven), true);
});

test('shouldBroadcastPlanLimits: a snapshot with no rate limits never broadcasts', () => {
  const startup = normalizeStatuslinePayload({ session_id: 'x', cost: { total_cost_usd: 0.1 } }, NOW);
  assert.equal(shouldBroadcastPlanLimits(null, startup), false);
  const withLimits = normalizeStatuslinePayload(fullPayload(), NOW);
  // A later payload that lost its limits must not blank a good snapshot on the wire.
  assert.equal(shouldBroadcastPlanLimits(withLimits, startup), false);
  assert.equal(shouldBroadcastPlanLimits(null, null), false);
  assert.equal(planLimitsSignature(startup), null);
});

test('buildPlanLimitsMessage: the wire shape, or null with nothing to say', () => {
  const snap = normalizeStatuslinePayload(fullPayload(), NOW);
  assert.deepEqual(buildPlanLimitsMessage(snap), {
    type: 'plan-limits',
    ts: NOW,
    fiveHour: { pct: 12, resetsAtMs: 1_800_003_600_000 },
    sevenDay: { pct: 68.4, resetsAtMs: 1_800_400_000_000 },
    source: 'statusline',
  });
  assert.equal(buildPlanLimitsMessage(null), null);
  assert.equal(buildPlanLimitsMessage({ rateLimits: null }), null);
});

// Nothing from the payload beyond these five fields is kept: it also carries transcript_path, cwd and
// prompt_id, and none of that is worth retaining to draw two progress bars.
test('normalize: the snapshot carries no transcript path, cwd or prompt id', () => {
  const snap = normalizeStatuslinePayload(fullPayload(), NOW);
  assert.deepEqual(Object.keys(snap).sort(), ['claudeSessionId', 'contextPct', 'rateLimits', 'sessionCostUSD', 'ts']);
  const serialized = JSON.stringify(snap);
  assert.equal(serialized.includes('transcript'), false);
  assert.equal(serialized.includes('C:/repos/glissa'), false);
  assert.equal(serialized.includes('p-1'), false);
});
