/*
 * Glissa Backend - Express + WebSocket server factory
 *
 * Control WebSocket additions:
 *   Client → Server: { type: 'shutdown' }
 *   Server → Client: { type: 'shutting-down' }
 *
 * Exports a single function `createBackend(httpServer, options)` that wires
 * Express middleware, control/data WebSocket servers, and session management
 * onto a provided HTTP server. Used by both:
 *   - server.js (production: standalone HTTP server)
 *   - vite.config.js (dev: attached to Vite's internal HTTP server)
 *
 * node-pty crash risk: Sessions spawn native PTY processes via node-pty.
 * If the Node process crashes without calling shutdown(), PTY child processes
 * may become orphaned. SIGINT handlers in server.js and the Vite plugin
 * mitigate this for graceful exits, but unexpected crashes (segfault, OOM)
 * cannot be caught. This is a known limitation of node-pty.
 */

'use strict';

const crypto = require('node:crypto');
const { resolveAdapter } = require('../session/adapters');
const { createConfigStore, generateProjectId, ensureProjectIds } = require('./config-store');
const { createLifecycle } = require('./server-lifecycle');
const { spawn } = require('./child-process-safe');
const { createBackendHttpApp } = require('./backend-http');
const { createBackendWebSockets } = require('./backend-websockets');
const { createBackendShutdown } = require('./backend-shutdown');
const { createBackendTrust } = require('./backend-trust');
const { createSessionEventWiring, persistSessionField } = require('./session-event-wiring');
const {
  carryWorktreeAcrossRecreate,
  createSessionRegistry,
  reconcileSessionWorktrees,
  runAutoResume,
} = require('./session-registry');
const { createBackendLanes } = require('./backend-lanes');
const { decideWasActiveFlip, shouldStartAfterModify } = require('./core/session-registry-core');
const { createBackendHealth } = require('./backend-health');
const { createBackendNotifications } = require('./backend-notifications');
const { createBackendControl } = require('./backend-control');
const { createBackendUpdateCheck } = require('./backend-update');
const { createBackendSessionRuntime } = require('./backend-session-runtime');

/**
 * Create and wire the Glissa backend onto an existing HTTP server.
 *
 * @param {import('http').Server} httpServer - HTTP server to attach to
 * @param {import('./backend-lanes').BackendLaneOptions & {
 *   staticDir?: string | null,
 *   settingsDefaults?: Record<string, unknown>,
 *   checkForUpdate?: (() => Promise<unknown>) | null,
 *   onRestart?: (() => void) | null,
 * }} [options]
 *   staticDir: 'auto' detects dist/ vs public/ (production), null skips static serving entirely
 *   (Vite mode), and a string is an absolute path to serve from.
 */
function createBackend(httpServer, options = {}) {
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
  const serverBuild = `${require('../package.json').version}+${crypto.randomBytes(4).toString('hex')}`;

  let broadcastControl = null;
  let gitWorkspace = null;
  const sessionRuntime = createBackendSessionRuntime({
    httpServer,
    config,
    configStore,
    getGitWorkspace: () => gitWorkspace,
    getBroadcastControl: () => broadcastControl,
    logger: console,
  });
  const { getHookPort, hookRouter, makeSession, rtkInstall } = sessionRuntime;

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
    getVisionsLane: () => laneAssembly.current('visions'),
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

  const sessions = new Map();
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
    getIngestLane: () => laneAssembly.current('ingest'),
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

  function getSessionAny(id) {
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
    broadcastControl,
    telegramChannel,
    notificationManager,
    getIngestLane: () => laneAssembly.current('ingest'),
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
    getIngestLane: () => laneAssembly.current('ingest'),
    broadcastControl,
    applySettingsReload,
    spawnGate,
    gitWorkspaceSync,
    reconcileSessionWorktrees,
    carryWorktreeAcrossRecreate,
    ensureProjectIds,
    resolveAgentId: (agent) => resolveAdapter(agent).id,
    logger: console,
  });
  sessionRegistry.initialize();
  const { applyConfigReload } = sessionRegistry;

  laneAssembly.startMemoryLanes();
  void rtkInstall.maybeInstall();
  laneAssembly.startRuntimeLanes();

  function applySettingsReload(newConfig) {
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
    currentVersion: require('../package.json').version,
    checkForUpdate: options.checkForUpdate,
    getControlClientCount: () => controlWss.clients.size,
    broadcastControl,
    logger: console,
  });
  let stopConfigWatch = null;
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
    getIngestLane: () => laneAssembly.current('ingest'),
    getVisionsLane: () => laneAssembly.current('visions'),
    memoryIngest,
    memoryDistiller,
    memoryStore,
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
      attach(remoteHttpServer) {
        remoteHttpServer.on('request', app);
        remoteHttpServer.on('upgrade', handleUpgrade);
      },
    },
  };
}

module.exports = {
  createBackend, runAutoResume, persistSessionField, decideWasActiveFlip, carryWorktreeAcrossRecreate,
  reconcileSessionWorktrees, shouldStartAfterModify,
};
