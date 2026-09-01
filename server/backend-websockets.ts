import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import { createReplayLog } from './control-replay-core.ts';
import type { ControlMessageRecord, ReplayLog } from './control-replay-core.ts';
import { decideControlSend } from './core/control-send-core.ts';
import { decideHostAllowed } from './core/host-policy.ts';
import { classifyRequestOrigin, decideUpgradeAccess } from './core/request-trust.ts';
import type { RequestTrust } from './core/request-trust.ts';
import { classifyUpgradePath, dataSessionIdFromUrl, upgradeTokenFromUrl } from './core/upgrade-route.ts';
import { isApplicableViewerSize, pickSizeAfterDeparture } from './core/viewer-size-core.ts';
import { createWsSender } from './ws-sender.ts';

type ControlBroadcast = (message: ControlMessageRecord) => void;

type ControlSocket = WebSocket & { glissaTrust?: RequestTrust };

type UpgradeSocket = Duplex & { localPort?: number };

interface ViewerSizeRecord {
  cols: number;
  rows: number;
  resizeSeq: number;
}

interface VisionsUpgradeLane {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

interface BackendWebSocketDependencies {
  remote: { enabled: boolean; allowedOrigins: string[] };
  remoteAuth: { isUpgradeAuthorized: (request: IncomingMessage) => boolean } | null;
  remoteListenerPort: number | null;
  allowedHosts: string[];
  listenerPortsFor: (socket: { localPort?: number | null } | null) => number[];
  tokenMatches: (token: string | null) => boolean;
  getSession: (id: string) => Session | null;
  getVisionsLane: () => VisionsUpgradeLane | null;
  logger: Pick<Console, 'warn'>;
}

interface BackendWebSockets {
  controlWss: WebSocketServer;
  dataWss: WebSocketServer;
  controlReplayLog: ReplayLog;
  sessionDataClients: Map<string, Map<WebSocket, ViewerSizeRecord | null>>;
  broadcastControl: ControlBroadcast;
  broadcastLocalControl: ControlBroadcast;
  closeSessionDataClients(sessionId: string): void;
  attachDataConnection(): void;
  handleUpgrade(request: IncomingMessage, socket: UpgradeSocket, head: Buffer): void;
}

function sendControlFrame(client: WebSocket, payload: string, type: string, logger: Pick<Console, 'warn'>): void {
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

function frameType(stamped: ControlMessageRecord): string {
  return typeof stamped.type === 'string' ? stamped.type : '';
}

function createBackendWebSockets(dependencies: BackendWebSocketDependencies): BackendWebSockets {
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
  const sessionDataClients = new Map<string, Map<WebSocket, ViewerSizeRecord | null>>();
  let nextViewerResizeSeq = 0;

  function controlClients(): Iterable<ControlSocket> {
    return controlWss.clients as Set<ControlSocket>;
  }

  function broadcastControl(message: ControlMessageRecord): void {
    const stamped = controlReplayLog.stamp({ ...message });
    const payload = JSON.stringify(stamped);
    for (const client of controlClients()) {
      sendControlFrame(client, payload, frameType(stamped), logger);
    }
  }

  function broadcastLocalControl(message: ControlMessageRecord): void {
    const stamped = controlReplayLog.stamp({ ...message });
    const payload = JSON.stringify(stamped);
    for (const client of controlClients()) {
      if (client.glissaTrust === 'remote') continue;
      sendControlFrame(client, payload, frameType(stamped), logger);
    }
  }

  function closeSessionDataClients(sessionId: string): void {
    const clients = sessionDataClients.get(sessionId);
    if (!clients) return;
    for (const socket of clients.keys()) {
      socket.close(1001, 'Session removed');
    }
    sessionDataClients.delete(sessionId);
  }

  function attachDataConnection(): void {
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

      const releaseViewerSize = (): void => {
        if (!viewerSizeMap.get(socket)) return;
        viewerSizeMap.set(socket, null);
        if (sessionDataClients.get(activeSessionId) !== viewerSizeMap) return;
        const successor = pickSizeAfterDeparture(viewerSizeMap, socket);
        if (!successor) return;
        session.resize(successor.cols, successor.rows);
      };

      const replay = session.getReplayBuffer();
      const startOffset = session.getOutputOffset();
      const sender = createWsSender(socket, {
        source: { getBufferSince: (offset: number) => session.getBufferSince(offset) },
        startOffset,
      });
      if (replay) sender.sendImmediate(replay);

      const dataListener = (data: string) => sender.onData(data);
      session.on('data', dataListener);
      socket.on('message', (raw) => {
        let message: Record<string, unknown> | null = null;
        try {
          message = JSON.parse(String(raw));
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

  function handleUpgrade(request: IncomingMessage, socket: UpgradeSocket, head: Buffer): void {
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
    const decision = decideUpgradeAccess({
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
        (webSocket as ControlSocket).glissaTrust = trust;
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

export { createBackendWebSockets };
export type {
  BackendWebSocketDependencies,
  BackendWebSockets,
  ControlBroadcast,
  ControlSocket,
  UpgradeSocket,
  ViewerSizeRecord,
};
