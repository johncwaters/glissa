'use strict';

const { STATES } = require('../shared/states.ts');

const HEALTH_SNAPSHOT_INTERVAL_MS = 10000;

/**
 * @typedef {object} BackendHealthDependencies
 * @property {Map<string, any>} sessions
 * @property {() => any[]} getAllSessions
 * @property {Map<string, Map<any, any>>} sessionDataClients
 * @property {() => any|null} getIngestLane
 * @property {{ clients: Set<any> }} controlWss
 * @property {{ clients: Set<any> }} dataWss
 * @property {import('./backend-websockets').ControlBroadcast} broadcastControl
 */

/** @param {BackendHealthDependencies} dependencies */
function createBackendHealth(dependencies) {
  function buildHealthSnapshot() {
    const memory = process.memoryUsage();
    const sessionStats = [];
    let alivePtyCount = 0;
    let sleepingCount = 0;
    let totalDataListeners = 0;
    let totalOutputBufferBytes = 0;
    let listenerMismatch = false;
    let orphanPty = false;
    let destroyedReachable = false;
    for (const session of dependencies.getAllSessions()) {
      const stats = session.getHealthStats();
      stats.detection = session.getDetectionStats();
      stats.ephemeral = !!session.ephemeral;
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

module.exports = { createBackendHealth };
