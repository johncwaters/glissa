import type { WebSocket } from 'ws';
import type { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import type { ControlBroadcast } from './backend-websockets.ts';

const HEALTH_SNAPSHOT_INTERVAL_MS = 10000;

interface IngestTapReader {
  hasSessionTap(session: Session): boolean;
}

interface BackendHealthDependencies {
  sessions: Map<string, Session>;
  getAllSessions: () => Session[];
  sessionDataClients: Map<string, Map<WebSocket, unknown>>;
  getIngestLane: () => IngestTapReader | null;
  controlWss: { clients: Set<WebSocket> };
  dataWss: { clients: Set<WebSocket> };
  broadcastControl: ControlBroadcast;
}

interface BackendHealth {
  buildHealthSnapshot(): Record<string, unknown>;
  healthInterval: NodeJS.Timeout;
}

function createBackendHealth(dependencies: BackendHealthDependencies): BackendHealth {
  function buildHealthSnapshot(): Record<string, unknown> {
    const memory = process.memoryUsage();
    const sessionStats: Record<string, unknown>[] = [];
    let alivePtyCount = 0;
    let sleepingCount = 0;
    let totalDataListeners = 0;
    let totalOutputBufferBytes = 0;
    let listenerMismatch = false;
    let orphanPty = false;
    let destroyedReachable = false;
    for (const session of dependencies.getAllSessions()) {
      const stats = {
        ...session.getHealthStats(),
        detection: session.getDetectionStats(),
        ephemeral: !!session.ephemeral,
      };
      sessionStats.push(stats);
      if (stats.hasPty) alivePtyCount += 1;
      if (stats.sleeping) sleepingCount += 1;
      totalDataListeners += stats.dataListenerCount;
      totalOutputBufferBytes += stats.outputBufferBytes;
      if (!session.ephemeral) {
        const clientCount = dependencies.sessionDataClients.get(stats.id)?.size || 0;
        const ingestTapCount = dependencies.getIngestLane()?.hasSessionTap(session) ? 1 : 0;
        if (stats.dataListenerCount !== clientCount + ingestTapCount) listenerMismatch = true;
        if (stats.hasPty && (stats.state === STATES.DONE || stats.state === STATES.FAILED || stats.state === STATES.DORMANT)) {
          orphanPty = true;
        }
      }
      if (stats.destroyed) destroyedReachable = true;
    }
    let dataClientTotal = 0;
    for (const clients of dependencies.sessionDataClients.values()) {
      dataClientTotal += clients.size;
    }
    let activeResources = 0;
    try {
      activeResources = process.getActiveResourcesInfo().length;
    } catch {}
    return {
      timestamp: Date.now(),
      uptimeSeconds: Math.round(process.uptime()),
      process: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
        activeResources,
      },
      sessions: {
        total: dependencies.sessions.size,
        alivePty: alivePtyCount,
        sleeping: sleepingCount,
        totalDataListeners,
        totalOutputBufferBytes,
        list: sessionStats,
      },
      websockets: {
        control: dependencies.controlWss.clients.size,
        data: dependencies.dataWss.clients.size,
        dataPerSessionTotal: dataClientTotal,
      },
      anomalies: { listenerMismatch, orphanPty, destroyedReachable },
    };
  }

  const healthInterval = setInterval(() => {
    for (const [id, session] of dependencies.sessions) {
      if (session.refreshGitContext()) {
        dependencies.broadcastControl({ type: 'session-git', id, worktree: !!session.isWorktree });
      }
    }
    if (dependencies.controlWss.clients.size === 0) return;
    dependencies.broadcastControl({ type: 'health-snapshot', stats: buildHealthSnapshot() });
  }, HEALTH_SNAPSHOT_INTERVAL_MS);
  healthInterval.unref();

  return { buildHealthSnapshot, healthInterval };
}

export { createBackendHealth };
export type { BackendHealth, BackendHealthDependencies };
