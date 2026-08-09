// Shared reconnect delay for both WebSocket clients (control-ws.js, session-card/terminal.js).
//
// Pure: `random` is injected so the jitter is deterministic under test.
//
// A flat 500ms retry was fine on a desktop that only ever lost the socket to a server restart, but a
// phone that sleeps or drops off wifi comes back to a client that has been reconnecting twice a second
// for as long as the screen was off. Doubling to a cap bounds that; the jitter keeps several cards (one
// control socket plus one data socket per card) from re-landing in lockstep after a single restart.
// Retrying never gives up: this is a single-operator dashboard, and a give-up needs UI to recover from.

export const BASE_RECONNECT_DELAY_MS = 500;
export const MAX_RECONNECT_DELAY_MS = 30000;

export function nextReconnectDelayMs(attempt, random = Math.random) {
  const attemptsSoFar = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const nominalDelayMs = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attemptsSoFar, MAX_RECONNECT_DELAY_MS);
  return Math.round(nominalDelayMs * (0.5 + 0.5 * random()));
}
