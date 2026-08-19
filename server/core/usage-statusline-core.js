'use strict';

/*
 * Pure normalization of one Claude Code statusLine payload into the only three things Glissa keeps
 * from it: the OFFICIAL plan rate limits (machine-wide, the numbers `/usage` shows), the session's own
 * cumulative cost estimate, and its context-window fill.
 *
 * Everything here is conditional by contract. Live-probed against Claude Code 2.1.235: `prompt_id`,
 * `session_name` and `rate_limits` are ABSENT on the startup invocation and appear from the first
 * post-API-response invocation onward, each rate-limit window can be independently absent, and the
 * whole `rate_limits` block never appears on a non-subscription plan. So every read below is
 * null-safe, and "absent" is preserved as null rather than coerced to zero: a plan limit reported as
 * 0% used is a very different statement from one Claude never sent.
 */

// The reported percentages carry binary-float noise (e.g. 12.000000000000002), so they are rounded
// before anything compares or renders them, which is also what makes the broadcast throttle stable.
const PCT_DECIMALS = 1;

// A statusLine invocation fires per assistant/tool step with a ~300ms floor, so a payload that moved
// nothing must not reach the wire. Anything above this is treated as already-milliseconds rather than
// seconds, so a future unit change degrades to a correct countdown instead of a year-3000 one.
const SECONDS_CEILING = 1e12;

function finiteNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function roundPct(value) {
  const numeric = finiteNumber(value);
  if (numeric === null) return null;
  const factor = 10 ** PCT_DECIMALS;
  return Math.max(0, Math.round(numeric * factor) / factor);
}

function resetsAtMs(value) {
  const numeric = finiteNumber(value);
  if (numeric === null || numeric <= 0) return null;
  if (numeric > SECONDS_CEILING) return Math.round(numeric);
  return Math.round(numeric * 1000);
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// One window ({ used_percentage, resets_at }). A window with neither usable field is absent, not empty:
// rendering a 0% bar for a window Claude did not report would invent a fact.
function normalizeWindow(raw) {
  if (!isPlainObject(raw)) return null;
  const pct = roundPct(raw.used_percentage);
  const resetsAt = resetsAtMs(raw.resets_at);
  if (pct === null && resetsAt === null) return null;
  return { pct, resetsAtMs: resetsAt };
}

function normalizeRateLimits(raw) {
  if (!isPlainObject(raw)) return null;
  const fiveHour = normalizeWindow(raw.five_hour);
  const sevenDay = normalizeWindow(raw.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

/*
 * payload -> { rateLimits, sessionCostUSD, contextPct, claudeSessionId, ts } or null for anything that
 * is not an object. `ts` is the receive time rather than anything in the payload: the statusLine blob
 * carries no timestamp, and freshness is what the panel needs it for.
 */
function normalizeStatuslinePayload(payload, nowMs) {
  if (!isPlainObject(payload)) return null;
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  const cost = isPlainObject(payload.cost) ? payload.cost : null;
  const context = isPlainObject(payload.context_window) ? payload.context_window : null;
  return {
    rateLimits: normalizeRateLimits(payload.rate_limits),
    sessionCostUSD: cost ? finiteNumber(cost.total_cost_usd) : null,
    contextPct: context ? roundPct(context.used_percentage) : null,
    claudeSessionId: sessionId || null,
    ts: finiteNumber(nowMs) ?? 0,
  };
}

function windowSignature(win) {
  if (!win) return 'none';
  return `${win.pct}:${win.resetsAtMs}`;
}

function planLimitsSignature(snapshot) {
  const limits = snapshot?.rateLimits;
  if (!limits) return null;
  return `${windowSignature(limits.fiveHour)}|${windowSignature(limits.sevenDay)}`;
}

/*
 * The throttle. A statusLine callback lands several times inside one turn, and the plan percentages
 * move far more slowly than that, so the wire only sees a change in a ROUNDED percentage or a reset
 * time. A snapshot with no rate limits at all (the startup invocation, or a non-subscription plan)
 * never broadcasts.
 */
function shouldBroadcastPlanLimits(previous, next) {
  const nextSignature = planLimitsSignature(next);
  if (nextSignature === null) return false;
  return nextSignature !== planLimitsSignature(previous);
}

function buildPlanLimitsMessage(snapshot) {
  if (!snapshot?.rateLimits) return null;
  return {
    type: 'plan-limits',
    ts: snapshot.ts,
    fiveHour: snapshot.rateLimits.fiveHour,
    sevenDay: snapshot.rateLimits.sevenDay,
    source: 'statusline',
  };
}

module.exports = {
  normalizeStatuslinePayload,
  shouldBroadcastPlanLimits,
  buildPlanLimitsMessage,
  planLimitsSignature,
  PCT_DECIMALS,
};
