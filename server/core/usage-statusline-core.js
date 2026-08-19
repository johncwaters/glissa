'use strict';

// Pure normalization of one Claude Code statusLine payload. Every field is conditional by contract
// (live-probed 2.1.235: rate_limits absent at startup and on non-subscription plans, each window
// independently absent), so absent stays null, never zero: a 0% plan limit is a claim Claude made.

const { numberOrNull } = require('./usage-number-core');

// Reported percentages carry binary-float noise, so round before comparing or rendering.
const PCT_DECIMALS = 1;

// Above this, resets_at is already milliseconds; a future unit change degrades to a correct countdown.
const SECONDS_CEILING = 1e12;

function roundPct(value) {
  const numeric = numberOrNull(value);
  if (numeric === null) return null;
  const factor = 10 ** PCT_DECIMALS;
  return Math.max(0, Math.round(numeric * factor) / factor);
}

function resetsAtMs(value) {
  const numeric = numberOrNull(value);
  if (numeric === null || numeric <= 0) return null;
  if (numeric > SECONDS_CEILING) return Math.round(numeric);
  return Math.round(numeric * 1000);
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// A window with neither usable field is absent, not empty: a 0% bar for it would invent a fact.
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

// ts is the receive time: the payload carries no timestamp and freshness is what the panel needs.
function normalizeStatuslinePayload(payload, nowMs) {
  if (!isPlainObject(payload)) return null;
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  const cost = isPlainObject(payload.cost) ? payload.cost : null;
  const context = isPlainObject(payload.context_window) ? payload.context_window : null;
  return {
    rateLimits: normalizeRateLimits(payload.rate_limits),
    sessionCostUSD: cost ? numberOrNull(cost.total_cost_usd) : null,
    contextPct: context ? roundPct(context.used_percentage) : null,
    claudeSessionId: sessionId || null,
    ts: numberOrNull(nowMs) ?? 0,
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

// Throttle: statusLine lands several times per turn, so only a rounded-pct or reset change broadcasts.
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
