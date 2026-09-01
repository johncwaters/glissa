const DEFAULT_BASE_MS = 60_000;
const DEFAULT_MAX_MS = 30 * 60_000;

function nextBackoffMs({
  attempt = 1,
  baseMs = DEFAULT_BASE_MS,
  maxMs = DEFAULT_MAX_MS,
  retryAfterMs = null,
  random = Math.random,
}: {
  attempt?: number;
  baseMs?: number;
  maxMs?: number;
  retryAfterMs?: number | null;
  random?: () => number;
} = {}): number {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs, maxMs);
  const exponent = Math.max(0, Math.min(attempt, 20) - 1);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  return Math.round(random() * ceiling);
}

function shouldSkipTick({ now = 0, backoffUntil = 0 }: { now?: number; backoffUntil?: number } = {}): boolean {
  return backoffUntil > now;
}

function parseRetryAfterMs(header: unknown, now: number = Date.now()): number | null {
  if (header == null) return null;
  const raw = String(header).trim();
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10) * 1000;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  const delta = at - now;
  if (delta > 0) return delta;
  return null;
}

export {
  nextBackoffMs, parseRetryAfterMs, shouldSkipTick, DEFAULT_BASE_MS, DEFAULT_MAX_MS,
};
