'use strict';

const { createStopperCollector } = require('./core/shutdown-core.ts');

/**
 * @typedef {object} BackendShutdownDependencies
 * @property {() => void} cancelAutoResume
 * @property {NodeJS.Timeout} healthInterval
 * @property {() => (() => void)|null} getStopConfigWatch
 * @property {{ stop: () => void }|null} remoteAuth
 * @property {() => void} stopUpdateCheck
 * @property {{ destroy: () => void }} notificationManager
 * @property {{ destroy: () => void }} telegramChannel
 * @property {Map<string, any>} sessions
 * @property {Map<string, any>} reviewSessions
 * @property {Map<string, any>} investigationSessions
 * @property {Map<string, any>} distillSessions
 * @property {Map<string, any>} visionsSessions
 * @property {Map<string, any>} memoryDistillSessions
 * @property {{ stop: () => unknown }} branchGc
 * @property {{ stopPoller: () => unknown }} prReview
 * @property {{ stopPoller: () => unknown }} posthog
 * @property {{ stop: () => unknown }} packService
 * @property {{ stop: () => unknown }} usage
 * @property {{ stop: () => unknown }} packDistiller
 * @property {() => { stop: () => unknown }|null} getIngestLane
 * @property {() => { stop: () => unknown }|null} getVisionsLane
 * @property {{ stop: () => unknown }|null} memoryIngest
 * @property {{ stop: () => unknown }|null} memoryDistiller
 * @property {{ stop: () => unknown }|null} memoryStore
 * @property {(() => Promise<void>)|null} [millMetricsIdle]
 * @property {MillMetricsPort|null} [millMetricsPort]
 * @property {{ idle: () => unknown }} telegramOutbox
 * @property {{ stop: () => void }} heartbeat
 * @property {{ close: () => void }} controlWss
 * @property {{ close: () => void }} dataWss
 */

// A destroyed session never transitions, so its accumulator would be dropped mid-run and the delivery
// it was measuring would come back as live on the next boot. Closing here is what puts the record in
// the write queue the mill-metrics stopper then drains.
function closeMeasuredSessions(millMetricsPort, sessions) {
  if (!millMetricsPort) return;
  for (const id of sessions.keys()) millMetricsPort.onSessionTeardown(id);
}

function destroySessions(sessionMaps, pendingReaps) {
  for (const sessions of sessionMaps) {
    for (const session of sessions.values()) {
      session.destroy();
      if (session._killReap) pendingReaps.push(session._killReap);
    }
  }
}

/** @param {BackendShutdownDependencies} dependencies */
function createBackendShutdown(dependencies) {
  let isShuttingDown = false;

  return function shutdown() {
    if (isShuttingDown) return { reaps: [], stoppers: [] };
    isShuttingDown = true;
    const stoppers = createStopperCollector();
    dependencies.cancelAutoResume();
    clearInterval(dependencies.healthInterval);
    const stopConfigWatch = dependencies.getStopConfigWatch();
    if (stopConfigWatch) stopConfigWatch();
    if (dependencies.remoteAuth) dependencies.remoteAuth.stop();
    dependencies.stopUpdateCheck();

    dependencies.notificationManager.destroy();
    dependencies.telegramChannel.destroy();
    const pendingReaps = [];
    closeMeasuredSessions(dependencies.millMetricsPort, dependencies.sessions);
    destroySessions([dependencies.sessions], pendingReaps);
    stoppers.add('branch-gc', () => dependencies.branchGc.stop());
    stoppers.add('pr-review', () => dependencies.prReview.stopPoller());
    destroySessions([dependencies.reviewSessions], pendingReaps);
    stoppers.add('posthog', () => dependencies.posthog.stopPoller());
    stoppers.add('pack-service', () => dependencies.packService.stop());
    stoppers.add('usage', () => dependencies.usage.stop());
    stoppers.add('pack-distiller', () => dependencies.packDistiller.stop());
    destroySessions([dependencies.distillSessions, dependencies.investigationSessions], pendingReaps);
    stoppers.add('ingest', () => dependencies.getIngestLane()?.stop());
    stoppers.add('visions', () => dependencies.getVisionsLane()?.stop());
    const memoryIngest = dependencies.memoryIngest;
    if (memoryIngest) stoppers.add('memory-ingest', () => memoryIngest.stop());
    const memoryDistiller = dependencies.memoryDistiller;
    if (memoryDistiller) stoppers.add('memory-distill', () => memoryDistiller.stop());
    const memoryStore = dependencies.memoryStore;
    if (memoryStore) stoppers.add('memory-store', () => memoryStore.stop());
    // The lane's own idle, never a snapshot of its store: a store swap in flight has no store to
    // snapshot, and that window is exactly when writes are queued.
    const millMetricsIdle = dependencies.millMetricsIdle;
    if (millMetricsIdle) stoppers.add('mill-metrics', () => millMetricsIdle());
    stoppers.add('telegram-outbox', () => dependencies.telegramOutbox.idle());
    destroySessions([dependencies.visionsSessions, dependencies.memoryDistillSessions], pendingReaps);
    dependencies.heartbeat.stop();
    dependencies.controlWss.close();
    dependencies.dataWss.close();
    return { reaps: pendingReaps, stoppers: stoppers.entries() };
  };
}

module.exports = { createBackendShutdown };
