'use strict';

const { WebSocketServer } = require('ws');
const { STATES } = require('../shared/states');
const { createReplayLog } = require('./control-replay-core');
const { decideControlSend } = require('./core/control-send-core');
const { decideHostAllowed } = require('./core/host-policy');
const { classifyRequestOrigin, decideUpgradeAccess } = require('./core/request-trust');
const { classifyUpgradePath, dataSessionIdFromUrl, upgradeTokenFromUrl } = require('./core/upgrade-route');
const { isApplicableViewerSize, pickSizeAfterDeparture } = require('./core/viewer-size-core');
const { createWsSender } = require('./ws-sender');

/** @type {(options: { remoteEnabled: boolean, trust: string, origin?: string, allowedOrigins: string[], authenticated: boolean, listenerPorts?: number[], dashboardRoute?: boolean, tokenOk?: boolean }) => { allow: boolean, reason: string|null }} */
const decideWebSocketUpgradeAccess = /** @type {(options: { remoteEnabled: boolean, trust: string, origin?: string, allowedOrigins: string[], authenticated: boolean, listenerPorts?: number[], dashboardRoute?: boolean, tokenOk?: boolean }) => { allow: boolean, reason: string|null }} */ (decideUpgradeAccess);

/**
 * A control-plane broadcast. Messages are JSON frames keyed by `type`, so the parameter is the
 * string-keyed record the sender stamps and serializes, not a bare `object`.
 * @typedef {(message: Record<string, unknown>) => void} ControlBroadcast
 */

/**
 * @typedef {object} BackendWebSocketDependencies
 * @property {{ enabled: boolean, allowedOrigins: string[] }} remote
 * @property {{ isUpgradeAuthorized: (request: import('http').IncomingMessage) => boolean }|null} remoteAuth
 * @property {number|null} remoteListenerPort
 * @property {string[]} allowedHosts
 * @property {(socket: { localPort?: number }|null) => number[]} listenerPortsFor
 * @property {(token: string|null) => boolean} tokenMatches
 * @property {(id: string) => any|null} getSession
 * @property {() => { handleUpgrade: (request: object, socket: object, head: Buffer) => void }|null} getVisionsLane
 * @property {Pick<Console, 'warn'>} logger
 */

function sendControlFrame(client, payload, type, logger) {
  if (client.readyState !== 1) return;
  const decision = decideControlSend({ bufferedAmount: client.bufferedAmount, type });
  if (decision.action === 'drop') return;
  if (decision.action === 'close') {
    logger.warn(`[control-ws] client past the buffer ceiling (${client.bufferedAmount} bytes) - closing so it reconnects`);
    try {
      client.terminate();
    } catch {}
    return;
  }
  client.send(payload);
}

/** @param {BackendWebSocketDependencies} dependencies */
function createBackendWebSockets(dependencies) {
  const {
    remote,
    remoteAuth,
    remoteListenerPort,
    allowedHosts,
    listenerPortsFor,
    tokenMatches,
    getSession,
    getVisionsLane,
    logger,
  } = dependencies;
  const controlWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const dataWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const controlReplayLog = createReplayLog();
  /** @type {Map<string, Map<import('ws').WebSocket, { cols: number, rows: number, resizeSeq: number }|null>>} */
  const sessionDataClients = new Map();
  let nextViewerResizeSeq = 0;

  /** @type {ControlBroadcast} */
  function broadcastControl(message) {
    const stamped = controlReplayLog.stamp({ ...message });
    const payload = JSON.stringify(stamped);
    for (const client of controlWss.clients) {
      sendControlFrame(client, payload, stamped.type, logger);
    }
  }

  /** @type {ControlBroadcast} */
  function broadcastLocalControl(message) {
    const stamped = controlReplayLog.stamp({ ...message });
    const payload = JSON.stringify(stamped);
    for (const client of controlWss.clients) {
      if (client.glissaTrust === 'remote') continue;
      sendControlFrame(client, payload, stamped.type, logger);
    }
  }

  function closeSessionDataClients(sessionId) {
    const clients = sessionDataClients.get(sessionId);
    if (!clients) return;
    for (const socket of clients.keys()) {
      socket.close(1001, 'Session removed');
    }
    sessionDataClients.delete(sessionId);
  }

  function attachDataConnection() {
    dataWss.on('connection', (socket, request) => {
      const sessionId = dataSessionIdFromUrl(request.url);
      if (sessionId === null) {
        socket.close(1008, 'Invalid session id');
        return;
      }
      const session = getSession(sessionId);
      if (!session) {
        socket.close(1008, 'Session not found');
        return;
      }

      let viewerSizes = sessionDataClients.get(sessionId);
      if (!viewerSizes) {
        viewerSizes = new Map();
        sessionDataClients.set(sessionId, viewerSizes);
      }
      const activeSessionId = sessionId;
      const viewerSizeMap = viewerSizes;
      viewerSizeMap.set(socket, null);

      function releaseViewerSize() {
        if (!viewerSizeMap.get(socket)) return;
        viewerSizeMap.set(socket, null);
        if (sessionDataClients.get(activeSessionId) !== viewerSizeMap) return;
        const successor = pickSizeAfterDeparture(viewerSizeMap, socket);
        if (!successor) return;
        session.resize(successor.cols, successor.rows);
      }

      const replay = session.getReplayBuffer();
      const startOffset = session.getOutputOffset();
      const sender = createWsSender(socket, {
        source: { getBufferSince: (offset) => session.getBufferSince(offset) },
        startOffset,
      });
      if (replay) sender.sendImmediate(replay);

      const dataListener = (data) => sender.onData(data);
      session.on('data', dataListener);
      socket.on('message', (raw) => {
        /** @type {Record<string, unknown>|null} */
        let message = null;
        try {
          message = JSON.parse(raw);
        } catch {
          return;
        }
        if (!message || typeof message !== 'object') return;

        if (message.type === 'input' && typeof message.data === 'string') {
          if (message.data.length > 16384) {
            logger.warn(`[data-ws] Rejected oversized input (${message.data.length} chars) for ${session.name}`);
            broadcastControl({
              type: 'session-error',
              id: session.id,
              session: session.name,
              message: 'Paste too large - try pasting smaller chunks',
              timestamp: Date.now(),
            });
            return;
          }
          session.write(message.data);
          sender.markInputFlush();
          if (session.state === STATES.WAITING) session.transition('user_input');
          return;
        }
        if (message.type === 'resize') {
          const cols = Number(message.cols);
          const rows = Number(message.rows);
          if (isApplicableViewerSize(cols, rows)) {
            nextViewerResizeSeq += 1;
            viewerSizeMap.set(socket, { cols, rows, resizeSeq: nextViewerResizeSeq });
            session.resize(cols, rows);
          }
          return;
        }
        if (message.type === 'unview') releaseViewerSize();
      });

      socket.on('error', (error) => {
        const isPayload = error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
        const reason = isPayload ? 'Message too large - try pasting smaller chunks' : error.message;
        logger.warn(`[data-ws] Error for ${session.name}: ${error.message}`);
        broadcastControl({
          type: 'session-error',
          id: session.id,
          session: session.name,
          message: reason,
          timestamp: Date.now(),
        });
      });

      socket.on('close', () => {
        session.removeListener('data', dataListener);
        sender.destroy();
        releaseViewerSize();
        const clients = sessionDataClients.get(activeSessionId);
        if (!clients) return;
        clients.delete(socket);
        if (clients.size === 0) sessionDataClients.delete(activeSessionId);
      });
    });
  }

  function handleUpgrade(request, socket, head) {
    const route = classifyUpgradePath(request.url);
    const trust = classifyRequestOrigin({ localPort: socket.localPort, remoteListenerPort });
    const visionsLane = getVisionsLane();
    if (route === 'unknown' || (route === 'visions' && !visionsLane)) {
      if (trust === 'remote') socket.destroy();
      return;
    }
    if (route === 'visions' && (!visionsLane || trust === 'remote')) {
      socket.destroy();
      return;
    }
    if (route === 'visions' && !visionsLane) return;
    if (!decideHostAllowed(request.headers.host, allowedHosts)) {
      socket.destroy();
      return;
    }

    const authenticated = trust === 'remote' && remoteAuth ? remoteAuth.isUpgradeAuthorized(request) : false;
    const dashboardRoute = route === 'control' || route === 'data';
    const decision = decideWebSocketUpgradeAccess({
      remoteEnabled: remote.enabled,
      trust,
      origin: request.headers.origin,
      allowedOrigins: remote.allowedOrigins,
      authenticated,
      listenerPorts: listenerPortsFor(socket),
      dashboardRoute,
      tokenOk: dashboardRoute ? tokenMatches(upgradeTokenFromUrl(request.url)) : false,
    });
    if (!decision.allow) {
      if (remote.enabled) socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (route === 'control') {
      controlWss.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.glissaTrust = trust;
        controlWss.emit('connection', webSocket, request);
      });
      return;
    }
    if (route === 'visions') {
      if (!visionsLane) return;
      visionsLane.handleUpgrade(request, socket, head);
      return;
    }
    dataWss.handleUpgrade(request, socket, head, (webSocket) => {
      dataWss.emit('connection', webSocket, request);
    });
  }

  return {
    controlWss,
    dataWss,
    controlReplayLog,
    sessionDataClients,
    broadcastControl,
    broadcastLocalControl,
    closeSessionDataClients,
    attachDataConnection,
    handleUpgrade,
  };
}

module.exports = { createBackendWebSockets };
