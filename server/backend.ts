import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { resolveAdapter } from '../session/adapters/index.ts';
import type { Session } from '../session/sessions.ts';
import { createConfigStore, generateProjectId, ensureProjectIds, glissaHomeDir } from './config-store.ts';
import type { GlissaConfig } from './config-store.ts';
import { createLifecycle } from './server-lifecycle.ts';
import { execFileAsync, spawn } from './child-process-safe.ts';
import { createBackendHttpApp } from './backend-http.ts';
import { createBackendWebSockets } from './backend-websockets.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import { createBackendShutdown } from './backend-shutdown.ts';
import { createBackendTrust } from './backend-trust.ts';
import { createSessionEventWiring, persistSessionField } from './session-event-wiring.ts';
import {
  carryWorktreeAcrossRecreate,
  createSessionRegistry,
  reconcileSessionWorktrees,
  runAutoResume,
} from './session-registry.ts';
import { createBackendLanes } from './backend-lanes.ts';
import type { BackendLaneOptions } from './backend-lanes.ts';
import { decideWasActiveFlip, shouldStartAfterModify } from './core/session-registry-core.ts';
import { createBackendHealth } from './backend-health.ts';
import { createBackendNotifications } from './backend-notifications.ts';
import { createBackendControl } from './backend-control.ts';
import { createBackendUpdateCheck } from './backend-update.ts';
import { normalizeUpdateChannel } from './core/update-core.ts';
import type { CheckForUpdate } from './backend-update.ts';
import { createBackendSessionRuntime } from './backend-session-runtime.ts';
import { createUpdateApplyLane } from './update-apply.ts';
import { packageRoot } from './runtime-paths.ts';

interface CreateBackendOptions extends BackendLaneOptions {
  staticDir?: string | null;
  settingsDefaults?: Record<string, unknown>;
  checkForUpdate?: CheckForUpdate | null;
  onRestart?: (() => void) | null;
}

function createBackend(httpServer: Server, options: CreateBackendOptions = {}) {
  const { staticDir = 'auto', settingsDefaults } = options;

  const configStore = createConfigStore({ settingsDefaults });
  const { config } = configStore;
  const port = process.env.GLISSA_PORT
    ? Number.parseInt(process.env.GLISSA_PORT, 10)
    : (config.port || 3000);

  const trust = createBackendTrust({
    localPort: port,
    remoteConfig: config.remote,
    configPath: configStore.configPath,
    env: process.env,
  });
  const {
    remote,
    bindDecision,
    remoteListenerPort,
    pageToken,
    allowedHosts,
    remoteAuth,
    tokenMatches,
    listenerPortsFor,
  } = trust;

  const serverBuild = `${packageJson.version}+${crypto.randomBytes(4).toString('hex')}`;

  let broadcastControl: ControlBroadcast | null = null;
  let gitWorkspace: ReturnType<typeof createBackendLanes>['gitWorkspace'] | null = null;
  const sessionRuntime = createBackendSessionRuntime({
    httpServer,
    config,
    configStore,
    getGitWorkspace: () => gitWorkspace,
    getMillMetricsPort: () => laneAssembly.millMetrics.port,
    getBroadcastControl: () => broadcastControl,
    logger: console,
  });
  const { getHookPort, hookRouter, makeSession, rtkInstall } = sessionRuntime;

  const getCurrentIngestLane = () => laneAssembly.currentIngest();
  const getCurrentVisionsLane = () => laneAssembly.currentVisions();

  const app = createBackendHttpApp({
    staticDir,
    configStore,
    remote,
    remoteAuth,
    allowedHosts,
    listenerPortsFor,
    pageToken,
    hookRouter,
    getSession: getSessionAny,
    getUsage: () => usage,
  });

  const webSockets = createBackendWebSockets({
    remote,
    remoteAuth,
    remoteListenerPort,
    allowedHosts,
    listenerPortsFor,
    tokenMatches,
    getSession: getSessionAny,
    getVisionsLane: getCurrentVisionsLane,
    logger: console,
  });
  const {
    controlWss,
    dataWss,
    controlReplayLog,
    sessionDataClients,
    broadcastControl: broadcastControlFromWebSockets,
    broadcastLocalControl,
    closeSessionDataClients,
  } = webSockets;
  broadcastControl = broadcastControlFromWebSockets;

  const sessions = new Map<string, Session>();
  const health = createBackendHealth({
    sessions,
    getAllSessions: () => allLiveSessions(),
    sessionDataClients,
    getIngestLane: getCurrentIngestLane,
    controlWss,
    dataWss,
    broadcastControl,
  });
  const { buildHealthSnapshot, healthInterval } = health;

  const notifications = createBackendNotifications({
    config,
    configStore,
    sessions,
    controlWss,
    dataWss,
    broadcastControl,
    logger: console,
  });
  const {
    handleClientFocus,
    heartbeat,
    investigationSessions,
    notificationManager,
    reviewSessions,
    telegramChannel,
    telegramOutbox,
  } = notifications;

  function getSessionAny(id: string): Session | null {
    return sessions.get(id) || null;
  }

  const laneAssembly = createBackendLanes({
    config,
    configStore,
    sessions,
    reviewSessions,
    investigationSessions,
    closeSessionDataClients,
    hookRouter,
    getHookPort,
    broadcastControl,
    broadcastLocalControl,
    controlWss,
    options,
    logger: console,
  });
  const {
    allLiveSessions,
    branchGc,
    distillSessions,
    gitWorkspace: assembledGitWorkspace,
    gitWorkspaceSync,
    memoryDistillSessions,
    memoryDistiller,
    memoryIngest,
    memoryStore,
    mill,
    packDistiller,
    packService,
    posthog,
    prReview,
    recordLane,
    spawnGate,
    tapIngestForSession,
    usage,
    visionsSessions,
    visionsSetup,
  } = laneAssembly;
  gitWorkspace = assembledGitWorkspace;

  const wireSessionEvents = createSessionEventWiring({
    configStore,
    config,
    recordLane,
    usage,
    millMetricsPort: laneAssembly.millMetrics.port,
    broadcastControl,
    telegramChannel,
    notificationManager,
    getIngestLane: getCurrentIngestLane,
    tapIngestForSession,
    closeSessionDataClients,
    logger: console,
  });

  const sessionRegistry = createSessionRegistry({
    httpServer,
    sessions,
    config,
    configStore,
    makeSession,
    wireSessionEvents,
    closeSessionDataClients,
    notificationManager,
    millMetricsPort: laneAssembly.millMetrics.port,
    getIngestLane: getCurrentIngestLane,
    broadcastControl,
    applySettingsReload,
    spawnGate,
    gitWorkspaceSync,
    reconcileSessionWorktrees,
    carryWorktreeAcrossRecreate,
    ensureProjectIds,
    resolveAgentId: (agent: string | null | undefined) => {
      const adapter = resolveAdapter(agent);
      if (!adapter) throw new Error('Default agent adapter is unavailable');
      return adapter.id;
    },
    logger: console,
  });
  sessionRegistry.initialize();
  const { applyConfigReload } = sessionRegistry;

  laneAssembly.startMemoryLanes();
  void rtkInstall.maybeInstall();
  laneAssembly.startRuntimeLanes();

  function applySettingsReload(newConfig: GlissaConfig): void {
    configStore.applySettings(newConfig);
    updateCheck.applySettings();
    for (const [, sess] of sessions) {
      sess.updateSettings(config);
    }
    notifications.applySettings();
    laneAssembly.restartServiceLanes();
    void rtkInstall.maybeInstall();
    void visionsSetup.maybeApply();
    void laneAssembly.restartDynamicLanes();
  }

  const updateCheck = createBackendUpdateCheck({
    config,
    isLocalConfig: configStore.isLocalConfig,
    currentVersion: packageJson.version,
    platform: process.platform,
    checkForUpdate: options.checkForUpdate || undefined,
    fetchOrigin: (args) => assembledGitWorkspace.fetchOrigin(args),
    getUpdateJournal: () => updateApply.getJournal(),
    isRestartRequested: () => updateApply.isRestartRequested(),
    getControlClientCount: () => controlWss.clients.size,
    broadcastControl,
    logger: console,
  });
  const updateApply = createUpdateApplyLane({
    gitWorkspace: assembledGitWorkspace,
    runCommand: execFileAsync,
    fsPromises: fs.promises,
    packageRoot,
    journalPath: path.join(glissaHomeDir(), 'update-journal.json'),
    getUpdateStatus: updateCheck.getStatus,
    getUpdateChannel: () => normalizeUpdateChannel(config.updateChannel),
    broadcastControl: (message) => {
      broadcastControl(message);
      updateCheck.refreshApplyAvailability();
    },
    logger: console,
  });
  let stopConfigWatch: (() => void) | null = null;
  const shutdown = createBackendShutdown({
    cancelAutoResume: sessionRegistry.cancelAutoResume,
    healthInterval,
    getStopConfigWatch: () => stopConfigWatch,
    remoteAuth,
    stopUpdateCheck: updateCheck.stop,
    stopUpdateApply: updateApply.stop,
    notificationManager,
    telegramChannel,
    sessions,
    reviewSessions,
    investigationSessions,
    distillSessions,
    visionsSessions,
    memoryDistillSessions,
    branchGc,
    prReview,
    posthog,
    packService,
    usage,
    packDistiller,
    getIngestLane: getCurrentIngestLane,
    getVisionsLane: getCurrentVisionsLane,
    memoryIngest,
    memoryDistiller,
    memoryStore,
    millMetricsIdle: () => laneAssembly.millMetrics.whenIdle(),
    millMetricsPort: laneAssembly.millMetrics.port,
    telegramOutbox,
    heartbeat,
    controlWss,
    dataWss,
  });
  const { requestShutdown, requestRestart } = createLifecycle({
    shutdown,
    httpServer,
    onRestart: options.onRestart || null,
    spawn,
    beforeHandOff: updateApply.handOffStagedUpdate,
  });

  createBackendControl({
    controlWss,
    sessions,
    config,
    configStore,
    broadcastControl,
    controlReplayLog,
    getRtkInstallStatus: () => rtkInstall.getStatus(),
    generateProjectId,
    makeSession,
    wireSessionEvents,
    applyConfigReload,
    applySettingsReload,
    requestShutdown,
    requestRestart,
    handleClientFocus,
    buildHealthSnapshot,
    getUpdateStatus: updateCheck.getStatus,
    getUpdateJournal: updateApply.getJournal,
    checkNow: updateCheck.checkNow,
    applyUpdate: updateApply.applyUpdate,
    isStaging: updateApply.isStaging,
    noteRestartRequested: () => {
      updateApply.noteRestartRequested();
      updateCheck.refreshApplyAvailability();
    },
    laneAssembly,
    posthog,
    prReview,
    packService,
    usage,
    mill,
    serverBuild: () => serverBuild,
    logger: console,
  });

  webSockets.attachDataConnection();
  const { handleUpgrade } = webSockets;
  httpServer.on('upgrade', handleUpgrade);
  updateApply.startAfterListening(httpServer);

  stopConfigWatch = configStore.watchForChanges((newConfig) => {
    applyConfigReload(newConfig);
  });
  updateCheck.start();

  return {
    shutdown,
    port,
    app,
    getSession: getSessionAny,
    getLane: laneAssembly.current,
    bindHost: bindDecision.host,
    remote: {
      enabled: remote.enabled,
      port: remote.port,
      publicHost: remote.publicHost,
      attach(remoteHttpServer: Server) {
        remoteHttpServer.on('request', app);
        remoteHttpServer.on('upgrade', handleUpgrade);
      },
    },
  };
}

export {
  createBackend, runAutoResume, persistSessionField, decideWasActiveFlip, carryWorktreeAcrossRecreate,
  reconcileSessionWorktrees, shouldStartAfterModify,
};
export type { CreateBackendOptions };
