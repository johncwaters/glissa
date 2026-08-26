'use strict';

const { createStopperCollector } = require('./core/shutdown-core');

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
 * @property {{ idle: () => unknown }} telegramOutbox
 * @property {{ stop: () => void }} heartbeat
 * @property {{ close: () => void }} controlWss
 * @property {{ close: () => void }} dataWss
 */

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
    if (dependencies.memoryIngest) stoppers.add('memory-ingest', () => dependencies.memoryIngest.stop());
    if (dependencies.memoryDistiller) stoppers.add('memory-distill', () => dependencies.memoryDistiller.stop());
    if (dependencies.memoryStore) stoppers.add('memory-store', () => dependencies.memoryStore.stop());
    stoppers.add('telegram-outbox', () => dependencies.telegramOutbox.idle());
    destroySessions([dependencies.visionsSessions, dependencies.memoryDistillSessions], pendingReaps);
    dependencies.heartbeat.stop();
    dependencies.controlWss.close();
    dependencies.dataWss.close();
    return { reaps: pendingReaps, stoppers: stoppers.entries() };
  };
}

module.exports = { createBackendShutdown };
