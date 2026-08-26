'use strict';

/*
 * Pure error backoff for the polling lanes (2026-08 review, section 6: "a gh or PostHog outage is
 * re-polled at full cadence"). Full jitter, which is the AWS-recommended shape: the wait is a random
 * point in [0, base * 2^attempt) rather than the exponential itself, because several clients (or
 * several projects in one lane) backing off in lockstep re-converge on the same retry instant and
 * hammer the recovering service together.
 *
 * `Retry-After` wins when the service told us how long to wait: guessing over an explicit instruction
 * is how a client earns a longer ban. It is still capped, since a hostile or confused header must not
 * silence a lane for hours.
 *
 * The lane keeps its interval timer. This only decides which ticks to SKIP, so a lane's cadence, its
 * re-entrancy guard and its drain-on-stop are untouched: an outage costs skipped ticks rather than a
 * rescheduled timer chain.
 */

const DEFAULT_BASE_MS = 60_000;
const DEFAULT_MAX_MS = 30 * 60_000;

function nextBackoffMs({
  attempt = 1,
  baseMs = DEFAULT_BASE_MS,
  maxMs = DEFAULT_MAX_MS,
  retryAfterMs = null,
  random = Math.random,
} = {}) {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs, maxMs);
  const exponent = Math.max(0, Math.min(attempt, 20) - 1);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  return Math.round(random() * ceiling);
}

/** A tick is skipped while a backoff window is open. Equal to `until` is over, not still waiting. */
function shouldSkipTick({ now = 0, backoffUntil = 0 } = {}) {
  return backoffUntil > now;
}

/**
 * A `Retry-After` header, in ms. Accepts both spellings the RFC allows: delta-seconds, and an HTTP
 * date. Anything unparseable is null, so the caller falls back to its own exponential.
 */
function parseRetryAfterMs(header, now = Date.now()) {
  if (header == null) return null;
  const raw = String(header).trim();
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10) * 1000;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  const delta = at - now;
  return delta > 0 ? delta : null;
}

module.exports = {
  nextBackoffMs, parseRetryAfterMs, shouldSkipTick, DEFAULT_BASE_MS, DEFAULT_MAX_MS,
};
