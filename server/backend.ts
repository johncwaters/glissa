/*
 * Glissa Backend - Express + WebSocket server factory
 *
 * Control WebSocket additions:
 *   Client -> Server: { type: 'shutdown' }
 *   Server -> Client: { type: 'shutting-down' }
 *
 * Exports a single function `createBackend(httpServer, options)` that wires
 * Express middleware, control/data WebSocket servers, and session management
 * onto a provided HTTP server. Used by both:
 *   - server/main.ts (production: standalone HTTP server)
 *   - vite.config.ts (dev: attached to Vite's internal HTTP server)
 *
 * node-pty crash risk: Sessions spawn native PTY processes via node-pty.
 * If the Node process crashes without calling shutdown(), PTY child processes
 * may become orphaned. SIGINT handlers in server/main.ts and the Vite plugin
 * mitigate this for graceful exits, but unexpected crashes (segfault, OOM)
 * cannot be caught. This is a known limitation of node-pty.
 */

import crypto from 'node:crypto';
import type { Server } from 'node:http';
import packageJson from '../package.json' with { type: 'json' };
import { resolveAdapter } from '../session/adapters/index.ts';
import type { Session } from '../session/sessions.ts';
import { createConfigStore, generateProjectId, ensureProjectIds } from './config-store.ts';
import type { GlissaConfig } from './config-store.ts';
import { createLifecycle } from './server-lifecycle.ts';
import { spawn } from './child-process-safe.ts';
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
import type { CheckForUpdate } from './backend-update.ts';
import { createBackendSessionRuntime } from './backend-session-runtime.ts';

interface CreateBackendOptions extends BackendLaneOptions {
  staticDir?: string | null;
  settingsDefaults?: Record<string, unknown>;
  checkForUpdate?: CheckForUpdate | null;
  onRestart?: (() => void) | null;
}

/**
 * Create and wire the Glissa backend onto an existing HTTP server. `staticDir` 'auto' detects dist/ vs
 * public/ (production), null skips static serving entirely (Vite mode), and a string is an absolute
 * path to serve from.
 */
function createBackend(httpServer: Server, options: CreateBackendOptions = {}) {
  const { staticDir = 'auto', settingsDefaults } = options;

  // settingsDefaults is a per-launch fallback for keys config.json omits, never persisted (the dev
  // server defaults debugMode on that way). Production passes nothing and behaves as before.
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

  // What the connect snapshot tells the page about which backend it is talking to. A tab left open
  // across a server update reconnects to frames its bundle may predate, so the client reloads when
  // this changes (public/app.js). The boot id is what makes a same-version restart, and a dev rebuild,
  // visible at all.
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
    getAllSessions: () => [
      ...sessions.values(),
      ...reviewSessions.values(),
      ...investigationSessions.values(),
      ...distillSessions.values(),
      ...visionsSessions.values(),
      ...memoryDistillSessions.values(),
    ],
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
    packsAutoRebuildEnabled,
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
    checkForUpdate: options.checkForUpdate || undefined,
    getControlClientCount: () => controlWss.clients.size,
    broadcastControl,
    logger: console,
  });
  let stopConfigWatch: (() => void) | null = null;
  const shutdown = createBackendShutdown({
    cancelAutoResume: sessionRegistry.cancelAutoResume,
    healthInterval,
    getStopConfigWatch: () => stopConfigWatch,
    remoteAuth,
    stopUpdateCheck: updateCheck.stop,
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
    laneAssembly,
    posthog,
    prReview,
    packService,
    usage,
    mill,
    packsAutoRebuildEnabled,
    serverBuild: () => serverBuild,
    logger: console,
  });

  webSockets.attachDataConnection();
  const { handleUpgrade } = webSockets;
  httpServer.on('upgrade', handleUpgrade);

  stopConfigWatch = configStore.watchForChanges((newConfig) => {
    applyConfigReload(newConfig);
  });
  updateCheck.start();

  // attach() wires the SAME Express app and upgrade handler onto the remote listener's HTTP server.
  // Sharing them is what makes the two listeners identical except for the trust classification, so a
  // route can never exist on one and be forgotten on the other. The Vite dev plugin never calls it,
  // which is why remote mode is inert in dev by design.
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
