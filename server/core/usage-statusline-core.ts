// Pure normalization of one Claude Code statusLine payload. Every field is conditional by contract
// (live-probed 2.1.235: rate_limits absent at startup and on non-subscription plans, each window
// independently absent), so absent stays null, never zero: a 0% plan limit is a claim Claude made.

import { isPlainObject, numberOrNull } from './usage-number-core.ts';

// Reported percentages carry binary-float noise, so round before comparing or rendering.
const PCT_DECIMALS = 1;

// Above this, resets_at is already milliseconds; a future unit change degrades to a correct countdown.
const SECONDS_CEILING = 1e12;

export interface RateLimitWindow {
  pct: number | null;
  resetsAtMs: number | null;
}

export interface RateLimitWindows {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
}

export interface StatuslineSnapshot {
  rateLimits: RateLimitWindows | null;
  sessionCostUSD: number | null;
  contextPct: number | null;
  claudeSessionId: string | null;
  ts: number;
}

function roundPct(value: unknown): number | null {
  const numeric = numberOrNull(value);
  if (numeric === null) return null;
  const factor = 10 ** PCT_DECIMALS;
  return Math.max(0, Math.round(numeric * factor) / factor);
}

function resetsAtMs(value: unknown): number | null {
  const numeric = numberOrNull(value);
  if (numeric === null || numeric <= 0) return null;
  if (numeric > SECONDS_CEILING) return Math.round(numeric);
  return Math.round(numeric * 1000);
}

// A window with neither usable field is absent, not empty: a 0% bar for it would invent a fact.
function normalizeWindow(raw: unknown): RateLimitWindow | null {
  if (!isPlainObject(raw)) return null;
  const window = raw as Record<string, unknown>;
  const pct = roundPct(window.used_percentage);
  const resetsAt = resetsAtMs(window.resets_at);
  if (pct === null && resetsAt === null) return null;
  return { pct, resetsAtMs: resetsAt };
}

function normalizeRateLimits(raw: unknown): RateLimitWindows | null {
  if (!isPlainObject(raw)) return null;
  const limits = raw as Record<string, unknown>;
  const fiveHour = normalizeWindow(limits.five_hour);
  const sevenDay = normalizeWindow(limits.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

// ts is the receive time: the payload carries no timestamp and freshness is what the panel needs.
function normalizeStatuslinePayload(payload: unknown, nowMs: unknown): StatuslineSnapshot | null {
  if (!isPlainObject(payload)) return null;
  const fields = payload as Record<string, unknown>;
  const sessionId = typeof fields.session_id === 'string' ? fields.session_id.trim() : '';
  const cost = isPlainObject(fields.cost) ? (fields.cost as Record<string, unknown>) : null;
  const context = isPlainObject(fields.context_window) ? (fields.context_window as Record<string, unknown>) : null;
  return {
    rateLimits: normalizeRateLimits(fields.rate_limits),
    sessionCostUSD: cost ? numberOrNull(cost.total_cost_usd) : null,
    contextPct: context ? roundPct(context.used_percentage) : null,
    claudeSessionId: sessionId || null,
    ts: numberOrNull(nowMs) ?? 0,
  };
}

function windowSignature(win: RateLimitWindow | null): string {
  if (!win) return 'none';
  return `${win.pct}:${win.resetsAtMs}`;
}

function planLimitsSignature(snapshot: { rateLimits?: RateLimitWindows | null } | null | undefined): string | null {
  const limits = snapshot?.rateLimits;
  if (!limits) return null;
  return `${windowSignature(limits.fiveHour)}|${windowSignature(limits.sevenDay)}`;
}

// Throttle: statusLine lands several times per turn, so only a rounded-pct or reset change broadcasts.
function shouldBroadcastPlanLimits(
  previous: { rateLimits?: RateLimitWindows | null } | null | undefined,
  next: { rateLimits?: RateLimitWindows | null } | null | undefined,
): boolean {
  const nextSignature = planLimitsSignature(next);
  if (nextSignature === null) return false;
  return nextSignature !== planLimitsSignature(previous);
}

function buildPlanLimitsMessage(snapshot: { rateLimits?: RateLimitWindows | null; ts?: number } | null | undefined) {
  if (!snapshot?.rateLimits) return null;
  return {
    type: 'plan-limits',
    ts: snapshot.ts,
    fiveHour: snapshot.rateLimits.fiveHour,
    sevenDay: snapshot.rateLimits.sevenDay,
    source: 'statusline',
  };
}

export { normalizeStatuslinePayload, shouldBroadcastPlanLimits, buildPlanLimitsMessage, planLimitsSignature };
