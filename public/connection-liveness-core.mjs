const READY_STATE_CONNECTING = 0;
const READY_STATE_OPEN = 1;
const READY_STATE_CLOSING = 2;
const READY_STATE_CLOSED = 3;

export function decideLivenessAction({ hasSocket, readyState, retryPending }) {
  if (retryPending) return 'retry-now';
  if (!hasSocket) return 'connect';
  if (readyState === READY_STATE_CONNECTING) return 'wait';
  if (readyState === READY_STATE_OPEN) return 'probe';
  if (readyState === READY_STATE_CLOSING) return 'connect';
  if (readyState === READY_STATE_CLOSED) return 'connect';
  return 'connect';
}
