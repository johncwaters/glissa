import { nextReconnectDelayMs } from './reconnect-backoff.ts';
import { decideLivenessAction } from './connection-liveness-core.ts';
import { buildWebSocketUrl } from './ws-url-core.ts';
import { clearPageToken, loadPageToken, pageToken, withPageToken } from './ws-token.ts';
import { ServerMessage } from '#shared/contracts/control-messages.ts';

export type ControlMessageHandler = (message: ServerMessage) => void;
export type ConnectionStateCallback = (state: string, label: string) => void;

interface PendingRequest {
  resolve: (message: ServerMessage) => void;
  reject: (reason: Error) => void;
  timer: number;
}

let controlWs: WebSocket | null = null;
let controlRetryTimer: number | null = null;

let controlRetryAttempt = 0;
const pendingRequests = new Map<string, PendingRequest>();
let livenessProbePromise: Promise<'ok' | 'dead'> | null = null;
let connectingSince = 0;

let tokenFetchPending = false;

let lastSeq = 0;

let _messageHandler: ControlMessageHandler | null = null;
let _connectionStateCallback: ConnectionStateCallback | null = null;

export function setConnectionStateCallback(fn: ConnectionStateCallback) {
  _connectionStateCallback = fn;
}

export function onControlMessage(handler: ControlMessageHandler) {
  _messageHandler = handler;
}

export function sendControlMsg(msg: Record<string, unknown>): boolean {
  if (controlWs?.readyState !== WebSocket.OPEN) return false;
  controlWs.send(JSON.stringify(msg));
  return true;
}

export function sendControlRequest(type: string, payload?: Record<string, unknown>): Promise<ServerMessage> {
  const requestId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<ServerMessage>((resolve, reject) => {
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

  if (!pageToken() && !tokenFetchPending) {
    tokenFetchPending = true;
    void loadPageToken().finally(() => {
      tokenFetchPending = false;
      connectControl();
    });
    return;
  }
  if (tokenFetchPending) return;

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

  ws.addEventListener('message', (event: MessageEvent<string>) => {
    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(event.data);
    } catch {
      console.warn('[control] Dropped malformed server JSON message');
      return;
    }
    const parsedMessage = ServerMessage.safeParse(rawMessage);
    if (!parsedMessage.success) {
      console.warn(`[control] Dropped invalid server message: ${parsedMessage.error.issues[0]?.message || 'invalid payload'}`);
      return;
    }
    const msg = parsedMessage.data;

    if (msg.type === 'snapshot' && typeof msg.seq !== 'number') lastSeq = 0;

    if (typeof msg.seq === 'number') {
      if (msg.seq <= lastSeq) return;
      lastSeq = msg.seq;
    }

    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
    const pending = requestId ? pendingRequests.get(requestId) : undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      pending.resolve(msg);
      return;
    }

    if (_messageHandler) _messageHandler(msg);
  });

  ws.addEventListener('close', () => {
    if (controlWs !== ws) return;
    controlWs = null;

    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    pendingRequests.clear();

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
    readyState: controlWs?.readyState ?? null,
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
    controlWs?.close();
    controlRetryAttempt = 0;
    connectControl();
    return 'reconnecting';
  }
  if (action === 'wait') return 'reconnecting';
  const probedSocket = controlWs;
  livenessProbePromise = sendControlRequest('ping', {})
    .then((): 'ok' => 'ok')
    .catch((): 'dead' => {
      if (controlWs === probedSocket && probedSocket) probedSocket.close();
      return 'dead';
    })
    .finally(() => {
      livenessProbePromise = null;
    });
  return livenessProbePromise;
}
