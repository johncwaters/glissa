// ── Control WebSocket module ──────────────────────────────────
// Owns the control WebSocket connection, reconnect logic, and request/response.

import { nextReconnectDelayMs } from './reconnect-backoff.mjs';
import { decideLivenessAction } from './connection-liveness-core.mjs';
import { buildWebSocketUrl } from './ws-url-core.mjs';
import { clearPageToken, loadPageToken, pageToken, withPageToken } from './ws-token.js';
import { ServerMessage } from '#shared/contracts/control-messages.ts';


/** @type {WebSocket|null} */
let controlWs = null;
/** @type {number|null} */
let controlRetryTimer = null;
// Consecutive failed attempts since the last connection that actually opened; drives the backoff.
let controlRetryAttempt = 0;
const pendingRequests = new Map(); // requestId -> { resolve, timer }
/** @type {Promise<'ok'|'dead'>|null} */
let livenessProbePromise = null;
let connectingSince = 0;
// True while the page token is being fetched: connectControl has no socket yet and must not open a
// second one when the liveness probe (which sees a null socket) asks it to connect again.
let tokenFetchPending = false;

// Highest control-broadcast seq seen so far. Survives across reconnects (unlike the server,
// which holds no per-connection state) so a reconnect can declare `?since=<lastSeq>` and
// recover exactly the transient broadcasts (notify, ...) missed during the gap.
let lastSeq = 0;

/** @type {((message: unknown) => void)|null} */
let _messageHandler = null;
/** @type {((state: string, label: string) => void)|null} */
let _connectionStateCallback = null;

// ── Public API ────────────────────────────────────────────────

export function setConnectionStateCallback(fn) {
  _connectionStateCallback = fn;
}

export function onControlMessage(handler) {
  _messageHandler = handler;
}

export function sendControlMsg(msg) {
  if (controlWs?.readyState === WebSocket.OPEN) {
    controlWs.send(JSON.stringify(msg));
  }
}

export function sendControlRequest(type, payload) {
  const requestId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Request timed out'));
    }, 5000);
    pendingRequests.set(requestId, { resolve, reject, timer });
    if (controlWs?.readyState !== WebSocket.OPEN) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(new Error('Not connected'));
      return;
    }
    controlWs.send(JSON.stringify({ type, requestId, ...payload }));
  });
}

export function connectControl() {
  if (controlRetryTimer !== null) {
    if (controlRetryTimer !== null) clearTimeout(controlRetryTimer);
    controlRetryTimer = null;
  }
  // The server refuses a tokenless control socket, so the first connect of a page load fetches the
  // token and comes back here. A failed fetch still connects (and is refused), which lands on the
  // normal close/backoff path rather than a tight retry loop.
  if (!pageToken() && !tokenFetchPending) {
    tokenFetchPending = true;
    void loadPageToken().finally(() => {
      tokenFetchPending = false;
      connectControl();
    });
    return;
  }
  if (tokenFetchPending) return;

  // lastSeq > 0 only once a message has actually been processed, which never happens before
  // the first connection - so this doubles as "is this a reconnect" without a separate flag.
  const since = lastSeq > 0 ? `?since=${lastSeq}` : '';
  const url = buildWebSocketUrl(location, withPageToken(`/control${since}`));
  const ws = new WebSocket(url);
  controlWs = ws;
  connectingSince = Date.now();
  let hasEverOpened = false;

  ws.addEventListener('open', () => {
    hasEverOpened = true;
    controlRetryAttempt = 0;
    if (_connectionStateCallback) _connectionStateCallback('connected', 'Connected');
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.warn('[control] Dropped malformed server JSON message');
      return;
    }
    const parsedMessage = ServerMessage.safeParse(msg);
    if (!parsedMessage.success) {
      console.warn(`[control] Dropped invalid server message: ${parsedMessage.error.issues[0]?.message || 'invalid payload'}`);
      return;
    }
    msg = parsedMessage.data;

    // A server restart resets its replay log's seq counter back to 1, so a stale lastSeq
    // carried over from before the restart would otherwise dedupe away every live broadcast
    // until seq climbs back past it (dashboard looks connected but is actually frozen). The
    // per-connection snapshot is sent directly by control-handlers.js, never through
    // broadcastControl, so it is always seq-less and always the first message on a (re)connect;
    // a config-reload snapshot BROADCAST is stamped and must not reset the cursor.
    if (msg.type === 'snapshot' && typeof msg.seq !== 'number') lastSeq = 0;

    // Dedupe against the replay/live race: a seq at or below what we've already processed
    // (from a prior connection, or replay overlapping a live send) is a repeat. Update BEFORE
    // dispatching so a handler that itself triggers another message sees the advanced cursor.
    // Messages without a numeric seq (request/response replies) always pass through.
    if (typeof msg.seq === 'number') {
      if (msg.seq <= lastSeq) return;
      lastSeq = msg.seq;
    }

    // Route requestId-based responses to pending callbacks
    if (msg.requestId && pendingRequests.has(msg.requestId)) {
      const pending = pendingRequests.get(msg.requestId);
      clearTimeout(pending.timer);
      pendingRequests.delete(msg.requestId);
      pending.resolve(msg);
      return;
    }

    if (_messageHandler) _messageHandler(msg);
  });

  ws.addEventListener('close', () => {
    // A liveness check may have already replaced a CLOSING socket; the superseded close must not
    // null the live socket or schedule a duplicate reconnect. Its pendings age out on their timeout.
    if (controlWs !== ws) return;
    controlWs = null;
    // A response can never arrive on a dead socket; failing fast beats each caller waiting out its
    // 5s request timeout.
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    pendingRequests.clear();
    // Never-opened socket was refused by a new per-process token from server restart; clear cache to refetch.
    if (!hasEverOpened) clearPageToken();
    if (_connectionStateCallback) _connectionStateCallback('disconnected', 'Reconnecting');
    const retryDelayMs = nextReconnectDelayMs(controlRetryAttempt);
    controlRetryAttempt += 1;
    controlRetryTimer = setTimeout(connectControl, retryDelayMs);
  });
}

export async function checkControlLiveness() {
  if (livenessProbePromise) return livenessProbePromise;
  const action = decideLivenessAction({
    hasSocket: !!controlWs,
    readyState: controlWs?.readyState,
    retryPending: controlRetryTimer !== null,
    connectingAgeMs: Date.now() - connectingSince,
  });
  if (action === 'retry-now') {
    if (controlRetryTimer !== null) clearTimeout(controlRetryTimer);
    controlRetryTimer = null;
    controlRetryAttempt = 0;
    connectControl();
    return 'reconnecting';
  }
  if (action === 'connect') {
    // Abort a wedged CONNECTING/CLOSING socket first; its close event is ignored by the
    // active-socket guard once connectControl has replaced it.
    controlWs?.close();
    controlRetryAttempt = 0;
    connectControl();
    return 'reconnecting';
  }
  if (action === 'wait') return 'reconnecting';
  const probedSocket = controlWs;
  livenessProbePromise = sendControlRequest('ping', {})
    .then(() => /** @type {'ok'} */ ('ok'))
    .catch(() => {
      if (controlWs === probedSocket && probedSocket) probedSocket.close();
      return /** @type {'dead'} */ ('dead');
    })
    .finally(() => {
      livenessProbePromise = null;
    });
  return livenessProbePromise;
}
