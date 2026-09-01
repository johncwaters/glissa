import type { WebSocket, WebSocketServer } from 'ws';
import type { Session } from '../session/sessions.ts';
import type { ControlBroadcast, ControlSocket } from './backend-websockets.ts';
import type { ConfigStore, GlissaConfig, ProjectEntry } from './config-store.ts';
import { registerControlHandlers } from './control-handlers.ts';
import type { MillControl } from './control-handlers.ts';
import type { ReplayLog } from './control-replay-core.ts';
import { packVariantProjects } from './core/pack-core.ts';

interface SnapshotLane {
  snapshotMessage: () => Record<string, unknown>;
}

interface LaneReader {
  currentIngest: () => SnapshotLane | null;
  currentVisions: () => SnapshotLane | null;
}

interface PosthogControl {
  getStatus: () => Record<string, unknown> | null;
  setIssueStatus: (args: { projectId: string; issueId: string; action: string }) => Promise<Record<string, unknown>>;
  archiveInvestigation: (args: { id: string }) => Promise<Record<string, unknown>>;
}

interface PrReviewControl {
  getStatus: () => Record<string, unknown> | null;
}

interface PackControl {
  getVersions: () => Record<string, string>;
  ensureBuilt: (names: string[], options?: { projects?: Record<string, unknown>[] | null }) => Promise<unknown>;
}

interface UsageControl {
  getSessionsMessage: () => Record<string, unknown> | null;
  getCachedReport: () => Record<string, unknown> | null;
  requestReport: (args: { days?: number; force?: boolean; requestId?: string | null }) => Promise<Record<string, unknown>>;
  getPlanLimitsMessage: () => Record<string, unknown> | null;
}

interface BackendControlMill extends MillControl {
  listPackNames: () => Promise<string[]>;
  resolvePackSourceRoots: (name: string) => Promise<string[]>;
}

interface BackendControlDependencies {
  controlWss: WebSocketServer;
  sessions: Map<string, Session>;
  config: GlissaConfig;
  configStore: ConfigStore;
  broadcastControl: ControlBroadcast;
  controlReplayLog: ReplayLog;
  getRtkInstallStatus: () => Record<string, unknown> | null;
  generateProjectId: () => string;
  makeSession: (project: ProjectEntry, config: GlissaConfig) => Session;
  wireSessionEvents: (session: Session) => void;
  applyConfigReload: (config: GlissaConfig) => void;
  applySettingsReload: (config: GlissaConfig) => void;
  requestShutdown: () => unknown;
  requestRestart: () => unknown;
  handleClientFocus: (socket: ControlSocket, focused: boolean) => void;
  buildHealthSnapshot: () => Record<string, unknown>;
  getUpdateStatus: () => { updateAvailable?: boolean } | null;
  laneAssembly: LaneReader;
  posthog: PosthogControl;
  prReview: PrReviewControl;
  packService: PackControl;
  usage: UsageControl;
  mill: BackendControlMill;
  packsAutoRebuildEnabled: boolean;
  serverBuild: () => string;
  logger: Pick<Console, 'warn'>;
}

function createBackendControl(dependencies: BackendControlDependencies): void {
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
  const sendLaneSnapshotOnConnect = (
    laneName: string,
    readLane: () => SnapshotLane | null,
    refuseRemote: boolean,
  ): void => {
    controlWss.on('connection', (socket: WebSocket) => {
      if (socket.readyState !== 1) return;
      if (refuseRemote && (socket as ControlSocket).glissaTrust === 'remote') return;
      const lane = readLane();
      if (!lane) return;
      try {
        socket.send(JSON.stringify(lane.snapshotMessage()));
      } catch (sendError) {
        logger.warn(`[${laneName}] connect-time snapshot send failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
      }
    });
  };

  sendLaneSnapshotOnConnect('visions', laneAssembly.currentVisions, false);
  sendLaneSnapshotOnConnect('ingest', laneAssembly.currentIngest, true);
}

export { createBackendControl };
export type {
  BackendControlDependencies,
  LaneReader,
  PackControl,
  PosthogControl,
  PrReviewControl,
  SnapshotLane,
  UsageControl,
};
