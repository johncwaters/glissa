// ── Control WebSocket module ──────────────────────────────────
// Owns the control WebSocket connection, reconnect logic, and request/response.

const RECONNECT_DELAY_MS = 500;

let controlWs = null;
let controlRetryTimer = null;
let reconnectDisabled = false;
const pendingRequests = new Map(); // requestId -> { resolve, timer }

let _messageHandler = null;
let _connectionStateCallback = null;

// ── Public API ────────────────────────────────────────────────

export function setConnectionStateCallback(fn) {
  _connectionStateCallback = fn;
}

export function onControlMessage(handler) {
  _messageHandler = handler;
}

export function disableReconnect() {
  reconnectDisabled = true;
  if (controlRetryTimer !== null) {
    clearTimeout(controlRetryTimer);
    controlRetryTimer = null;
  }
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
    clearTimeout(controlRetryTimer);
    controlRetryTimer = null;
  }

  const url = `ws://${location.host}/control`;
  const ws = new WebSocket(url);
  controlWs = ws;

  ws.addEventListener('open', () => {
    if (_connectionStateCallback) _connectionStateCallback('connected', 'Connected');
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
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
    controlWs = null;
    // A response can never arrive on a dead socket; failing fast beats each caller waiting out its
    // 5s request timeout.
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    pendingRequests.clear();
    if (reconnectDisabled) {
      if (_connectionStateCallback) _connectionStateCallback('shutdown', 'Server shut down');
      return;
    }
    if (_connectionStateCallback) _connectionStateCallback('disconnected', 'Reconnecting');
    controlRetryTimer = setTimeout(connectControl, RECONNECT_DELAY_MS);
  });

  ws.addEventListener('error', () => {
    // close fires next
  });
}
