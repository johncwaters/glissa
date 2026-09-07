const PLAN_HASH_PREFIX = '#plan/';

export function createPlanHash(sessionId: string) {
  return `${PLAN_HASH_PREFIX}${encodeURIComponent(sessionId)}`;
}

export function resolvePlanTarget(hash: string): string | null {
  if (!hash.startsWith(PLAN_HASH_PREFIX)) return null;
  const encodedId = hash.slice(PLAN_HASH_PREFIX.length);
  if (!encodedId || encodedId.includes('/')) return null;
  try {
    const id = decodeURIComponent(encodedId);
    return id || null;
  } catch {
    return null;
  }
}
