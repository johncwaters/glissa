// ── Control WebSocket module ──────────────────────────────────
// Owns the control WebSocket connection, reconnect logic, and request/response.

const RECONNECT_DELAY_MS = 3000;

let controlWs = null;
let controlRetryTimer = null;
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

export function sendControlMsg(msg) {
  if (controlWs && controlWs.readyState === WebSocket.OPEN) {
    controlWs.send(JSON.stringify(msg));
  }
}

export function sendControlRequest(type, payload) {
  const requestId = type + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Request timed out'));
    }, 5000);
    pendingRequests.set(requestId, { resolve, timer });
    if (controlWs && controlWs.readyState === WebSocket.OPEN) {
      controlWs.send(JSON.stringify({ type, requestId, ...payload }));
    } else {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(new Error('Not connected'));
    }
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
    if (_connectionStateCallback) _connectionStateCallback('disconnected', 'Reconnecting');
    controlRetryTimer = setTimeout(connectControl, RECONNECT_DELAY_MS);
  });

  ws.addEventListener('error', () => {
    // close fires next
  });
}
