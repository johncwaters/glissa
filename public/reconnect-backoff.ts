export const BASE_RECONNECT_DELAY_MS = 500;
export const MAX_RECONNECT_DELAY_MS = 30000;

export function nextReconnectDelayMs(attempt: unknown, random: () => number = Math.random) {
  const attemptsSoFar = typeof attempt === 'number' && Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const nominalDelayMs = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attemptsSoFar, MAX_RECONNECT_DELAY_MS);
  return Math.round(nominalDelayMs * (0.5 + 0.5 * random()));
}
