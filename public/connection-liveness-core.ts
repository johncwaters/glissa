const READY_STATE_CONNECTING = 0;
const READY_STATE_OPEN = 1;

export const CONNECTING_WEDGE_MS = 10000;

export function decideLivenessAction({ hasSocket, readyState, retryPending, connectingAgeMs = 0 }: { hasSocket: boolean; readyState: number | null; retryPending: boolean; connectingAgeMs?: number }) {
  if (retryPending) return 'retry-now';
  if (!hasSocket) return 'connect';
  if (readyState === READY_STATE_CONNECTING) {
    return connectingAgeMs > CONNECTING_WEDGE_MS ? 'connect' : 'wait';
  }
  if (readyState === READY_STATE_OPEN) return 'probe';
  return 'connect';
}
