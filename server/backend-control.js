'use strict';

const { registerControlHandlers } = require('./control-handlers');
const { packVariantProjects } = require('./core/pack-core');

/** @typedef {Record<string, unknown> & { projects: Array<Record<string, unknown>> }} BackendControlConfig */
/** @typedef {{ toSnapshot: () => Record<string, unknown> }} BackendControlSession */
/** @typedef {{ stamp: (message: Record<string, unknown>) => Record<string, unknown>, entriesSince: (since: number) => { entries: Record<string, unknown>[], evicted: boolean }, currentSeq: () => number }} ControlReplayLog */
/** @typedef {{ snapshotMessage: () => Record<string, unknown> }} SnapshotLane */
/** @typedef {{ current: (name: string) => SnapshotLane|null }} LaneReader */
/** @typedef {{ getStatus: () => Record<string, unknown>|null, setIssueStatus: (args: { projectId: string, issueId: string, action: string }) => Promise<Record<string, unknown>>, archiveInvestigation: (args: { id: string }) => Promise<Record<string, unknown>> }} PosthogControl */
/** @typedef {{ getStatus: () => Record<string, unknown>|null }} PrReviewControl */
/** @typedef {{ getVersions: () => Record<string, string>, ensureBuilt: (names: string[], options: { projects: Record<string, unknown>[] }) => Promise<unknown> }} PackControl */
/** @typedef {{ getSessionsMessage: () => Record<string, unknown>, getCachedReport: () => Record<string, unknown>|null, requestReport: (args: Record<string, unknown>) => Promise<Record<string, unknown>>, getPlanLimitsMessage: () => Record<string, unknown>|null }} UsageControl */
/** @typedef {{ requestReport: (message: Record<string, unknown>, send: (payload: Record<string, unknown>) => void) => Promise<void>, getCachedReport: () => Record<string, unknown>|null, listPackNames: () => Promise<string[]>, resolvePackSourceRoots: (name: string) => Promise<string[]> }} MillControl */

/**
 * @typedef {object} BackendControlDependencies
 * @property {import('ws').WebSocketServer} controlWss
 * @property {Map<string, BackendControlSession>} sessions
 * @property {BackendControlConfig} config
 * @property {{ configPath: string, config: BackendControlConfig, getSettings: () => Record<string, unknown>, save: (mutator: (config: BackendControlConfig) => void) => BackendControlConfig|null, isUnchosenLaunchDefault: (config: BackendControlConfig, key: string, value: boolean) => boolean }} configStore
 * @property {(message: Record<string, unknown>) => void} broadcastControl
 * @property {ControlReplayLog} controlReplayLog
 * @property {() => Record<string, unknown>|null} getRtkInstallStatus
 * @property {() => string} generateProjectId
 * @property {(project: Record<string, unknown>, config: BackendControlConfig) => BackendControlSession} makeSession
 * @property {(session: BackendControlSession) => void} wireSessionEvents
 * @property {(config: BackendControlConfig) => void} applyConfigReload
 * @property {(config: BackendControlConfig) => void} applySettingsReload
 * @property {() => unknown} requestShutdown
 * @property {() => unknown} requestRestart
 * @property {(socket: import('ws').WebSocket, focused: boolean) => void} handleClientFocus
 * @property {() => Record<string, unknown>} buildHealthSnapshot
 * @property {() => Record<string, unknown>|null} getUpdateStatus
 * @property {LaneReader} laneAssembly
 * @property {PosthogControl} posthog
 * @property {PrReviewControl} prReview
 * @property {PackControl} packService
 * @property {UsageControl} usage
 * @property {MillControl} mill
 * @property {boolean} packsAutoRebuildEnabled
 * @property {() => string} serverBuild
 * @property {Pick<Console, 'warn'>} logger
 */

/** @param {BackendControlDependencies} dependencies */
function createBackendControl(dependencies) {
  const {
    controlWss,
    sessions,
    config,
    configStore,
    broadcastControl,
    controlReplayLog,
    laneAssembly,
    posthog,
    prReview,
    packService,
    usage,
    mill,
    packsAutoRebuildEnabled,
    logger,
  } = dependencies;

  registerControlHandlers(controlWss, {
    sessions,
    config,
    configStore,
    broadcastControl,
    controlReplayLog,
    getRtkInstallStatus: dependencies.getRtkInstallStatus,
    generateProjectId: dependencies.generateProjectId,
    makeSession: dependencies.makeSession,
    wireSessionEvents: dependencies.wireSessionEvents,
    applyConfigReload: dependencies.applyConfigReload,
    applySettingsReload: dependencies.applySettingsReload,
    requestShutdown: dependencies.requestShutdown,
    requestRestart: dependencies.requestRestart,
    handleClientFocus: dependencies.handleClientFocus,
    buildHealthSnapshot: dependencies.buildHealthSnapshot,
    getUpdateStatus: dependencies.getUpdateStatus,
    getPosthogStatus: () => posthog.getStatus(),
    posthogSetIssueStatus: (args) => posthog.setIssueStatus(args),
    posthogArchiveInvestigation: (args) => posthog.archiveInvestigation(args),
    getPrStatus: () => prReview.getStatus(),
    getPackVersions: () => packService.getVersions(),
    serverBuild: dependencies.serverBuild,
    getUsageSessions: () => usage.getSessionsMessage(),
    getUsageReport: () => usage.getCachedReport(),
    requestUsageReport: (args) => usage.requestReport(args),
    getPlanLimits: () => usage.getPlanLimitsMessage(),
    millReport: mill,
    listPackNames: () => mill.listPackNames(),
    resolvePackSourceRoots: (name) => mill.resolvePackSourceRoots(name),
    ensurePacksBuilt: (names, savedConfig) => {
      if (!packsAutoRebuildEnabled) return Promise.resolve();
      return packService.ensureBuilt(names, { projects: packVariantProjects(savedConfig || config) });
    },
  });

  // Registered unconditionally and resolved live: a lane switched on by a later settings save rebuilds,
  // but no rebuild ever revisits this listener, so a boot-time gate left connect-time repair off for good.
  const sendLaneSnapshotOnConnect = (laneName, refuseRemote) => {
    controlWss.on('connection', (socket) => {
      if (socket.readyState !== 1) return;
      if (refuseRemote && socket.glissaTrust === 'remote') return;
      const lane = laneAssembly.current(laneName);
      if (!lane) return;
      try {
        socket.send(JSON.stringify(lane.snapshotMessage()));
      } catch (sendError) {
        logger.warn(`[${laneName}] connect-time snapshot send failed: ${sendError.message}`);
      }
    });
  };

  sendLaneSnapshotOnConnect('visions', false);
  sendLaneSnapshotOnConnect('ingest', true);
}

module.exports = { createBackendControl };
