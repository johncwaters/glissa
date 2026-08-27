'use strict';

const { createBranchGcWiring } = require('./branch-gc-wiring');
const { configSiblingPath } = require('./pairings-store');
const { createGitWorkspace, createGitWorkspaceSync } = require('./git-workspace');
const { createIngestLane } = require('./ingest-wiring');
const { dbPathForConfig } = require('./glissa-db');
const { createMemoryDistillSpawn, createMemoryDistiller } = require('./memory-distill');
const { createMemoryIngest, earliestLaneEntryMs } = require('./memory-ingest-wiring');
const { createMemoryStore } = require('./memory-store');
const { createMillWiring } = require('./mill-wiring');
const { createPackService } = require('./pack-service');
const {
  DEFAULT_INTERVAL_HOURS,
  DEFAULT_TIMEOUT_SECONDS,
  createDistillSpawn,
  createPackDistiller,
} = require('./pack-distiller');
const { createPosthogWiring } = require('./posthog-wiring');
const { createPrReviewWiring } = require('./pr-review-wiring');
const { createSpawnGate } = require('./spawn-gate');
const { createUsageWiring, resolveUsageConfig } = require('./usage-wiring');
const { createLaneLedger } = require('./usage-lane-ledger');
const { createVisionsDispatcher, createVisionsSpawn } = require('./visions-dispatch');
const { createVisionsSetup } = require('./visions-setup');
const { createVisionsWiring } = require('./visions-wiring');
const { resolveIngestConfig } = require('./core/ingest-core');
const { resolveMemoryConfig } = require('./core/memory-core');
const { resolveDistillConfig: resolveMemoryDistillConfig } = require('./core/memory-distill-core');
const { consumedPackNames, packVariantProjects } = require('./core/pack-core');
const { resolveVisionsConfig } = require('./core/visions-dispatch-core');
const { normalizeShapePath } = require('./core/visions-scope-core');

/** @typedef {Record<string, unknown> & { id: string, name: string, path: string, packs?: string[] }} BackendLaneProject */
/** @typedef {Record<string, unknown> & { projects: BackendLaneProject[], worktreeRerere?: boolean, usage?: Record<string, unknown>, ingest?: Record<string, unknown>, visions?: Record<string, unknown>, memory?: Record<string, unknown>, replayBufferKB?: number, packDistiller?: { enabled?: boolean, intervalHours?: number, timeoutSeconds?: number }, packsAutoRebuild?: boolean }} BackendLaneConfig */
/** @typedef {{ path?: string, worktreeDir?: string, toSnapshot: () => Record<string, unknown>, notePackUpdate: (name: string, version: string) => void }} BackendLaneSession */
/** @typedef {{ branchGcWiringOptions?: Record<string, unknown>, ingestLaneOptions?: Record<string, unknown>, packServiceOptions?: Record<string, unknown>, millWiringOptions?: Record<string, unknown>, usageWiringOptions?: Record<string, unknown> }} BackendLaneOptions */
/** @typedef {InstanceType<typeof import('../detection/hook-source')['HookRouter']>} BackendHookRouter */
/** @typedef {{ startPoller: () => void, restartIfConfigChanged: () => void, stopPoller: () => unknown, getStatus: () => Record<string, unknown>|null }} BackendPollingLane */
/** @typedef {BackendPollingLane & { setIssueStatus: (args: { projectId: string, issueId: string, action: string }) => Promise<Record<string, unknown>>, archiveInvestigation: (args: { id: string }) => Promise<Record<string, unknown>> }} BackendPosthogLane */
/** @typedef {{ buildDigest: (...args: unknown[]) => string, latestSeq: () => number|null, noteEditorEvent: (event: unknown) => unknown, noteActivity?: () => unknown, agentLogsEnabled: boolean, terminalEnabled: boolean, attachSessionTap: (session: BackendLaneSession) => void, detachSessionTap: (session: BackendLaneSession) => void, fsEnabled: boolean, noteSessionRoots: (session: BackendLaneSession) => void, releaseSessionRoots: (session: BackendLaneSession) => void, noteRepos: () => unknown, stop: () => unknown, snapshotMessage: () => Record<string, unknown> }} BackendIngestLane */
/** @typedef {{ noteActivity: () => unknown, stop: () => unknown, snapshotMessage: () => Record<string, unknown>, handleUpgrade: (request: object, socket: object, head: Buffer) => void }} BackendVisionsLane */


/**
 * @typedef {object} BackendLaneDependencies
 * @property {BackendLaneConfig} config
 * @property {{ configPath: string, config: BackendLaneConfig, getSettings: () => { debugMode?: boolean }, save: (mutator: (config: Record<string, unknown>) => void) => Record<string, unknown> | null }} configStore
 * @property {Map<string, BackendLaneSession>} sessions
 * @property {Map<string, BackendLaneSession>} reviewSessions
 * @property {Map<string, BackendLaneSession>} investigationSessions
 * @property {(id: string) => void} closeSessionDataClients
 * @property {BackendHookRouter} hookRouter
 * @property {() => number|null} getHookPort
 * @property {(message: Record<string, unknown>) => void} broadcastControl
 * @property {import('./backend-websockets').ControlBroadcast} broadcastLocalControl
 * @property {{ clients: Set<import('ws').WebSocket>, on: (event: string, listener: (socket: import('ws').WebSocket) => void) => unknown }} controlWss
 * @property {BackendLaneOptions} options
 * @property {Console} logger
 */

function resolveVisionsScopeProjects(projectIds, projects, warn) {
  if (!Array.isArray(projectIds) || projectIds.length === 0) return null;
  const projectsById = new Map();
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project || typeof project.id !== 'string') continue;
    projectsById.set(project.id, project);
  }
  const scopeProjects = [];
  for (const projectId of projectIds) {
    const project = projectsById.get(projectId);
    if (!project) {
      warn(`[visions] configured project id not found: ${projectId}`);
      continue;
    }
    const normalizedPath = normalizeShapePath(project.path);
    if (!normalizedPath) {
      warn(`[visions] configured project has no usable path: ${projectId}`);
      continue;
    }
    scopeProjects.push({ id: projectId, path: normalizedPath });
  }
  return scopeProjects.length === 0 ? null : scopeProjects;
}

/** @param {BackendLaneDependencies} dependencies */
function createBackendLanes(dependencies) {
  const {
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
    logger,
  } = dependencies;
  const spawnGate = createSpawnGate();
  const gitWorkspace = createGitWorkspace({ rerere: config.worktreeRerere !== false });
  const gitWorkspaceSync = createGitWorkspaceSync();
  const getProjectPathById = (projectId) => {
    const project = config.projects.find((candidate) => candidate.id === projectId);
    return project ? project.path : null;
  };
  const getProjectNameById = (projectId) => {
    const project = config.projects.find((candidate) => candidate.id === projectId);
    return project ? project.name : null;
  };

  const laneLedger = createLaneLedger({
    ledgerPath: configSiblingPath(configStore.configPath, 'usage-lanes.json'),
    retainDays: resolveUsageConfig(config.usage).warehouseRetainDays,
    logger,
  });
  void laneLedger.load();
  const recordLane = laneLedger.record;
  const branchGc = createBranchGcWiring({
    config,
    gitWorkspace,
    broadcast: broadcastControl,
    ...(options.branchGcWiringOptions || {}),
  });
  const prReview = createPrReviewWiring({
    config,
    reviewSessions,
    closeSessionDataClients,
    hookRouter,
    getHookPort,
    spawnGate,
    gitWorkspace,
    recordLane,
    getProjectPathById,
    getProjectNameById,
    broadcast: broadcastControl,
  });
  const posthog = createPosthogWiring({
    config,
    investigationSessions,
    closeSessionDataClients,
    hookRouter,
    getHookPort,
    spawnGate,
    recordLane,
    gitWorkspace,
    broadcast: broadcastControl,
  });

  let ingestConfig = resolveIngestConfig(config.ingest);
  let visionsConfig = resolveVisionsConfig(config.visions);
  const gitRepoRoots = () => {
    const directories = [];
    for (const session of sessions.values()) {
      for (const directory of [session.path, session.worktreeDir]) {
        if (typeof directory !== 'string' || !directory || directories.includes(directory)) continue;
        directories.push(directory);
      }
    }
    return directories;
  };
  const memoryConfig = resolveMemoryConfig(config.memory);
  const memoryStore = memoryConfig.enabled
    ? createMemoryStore({
      dir: configSiblingPath(configStore.configPath, 'memory'),
      dbPath: dbPathForConfig(configStore.configPath),
      config: memoryConfig,
      logger,
      knownProjects: () => configStore.config.projects,
      resolveProjectPath: gitWorkspace.resolveProjectPath,
      resolveProjectPathSync: gitWorkspaceSync.resolveProjectPath,
      debug: () => configStore.getSettings().debugMode === true,
    })
    : null;
  const memoryIngest = memoryStore
    ? createMemoryIngest({
      store: memoryStore,
      logger,
      laneMap: () => laneLedger.laneMap(),
      laneFloorMs: () => earliestLaneEntryMs(laneLedger),
      knownProjects: () => configStore.config.projects,
      debug: () => configStore.getSettings().debugMode === true,
    })
    : null;
  const memoryDistillSessions = new Map();
  const memoryDistiller = memoryStore
    ? createMemoryDistiller({
      store: memoryStore,
      config: resolveMemoryDistillConfig(config.memory ? config.memory.distill : null, { memoryEnabled: true }),
      logger,
      debug: () => configStore.getSettings().debugMode === true,
      spawnDistill: createMemoryDistillSpawn({
        sessions: memoryDistillSessions,
        closeSessionDataClients,
        hookRouter,
        getHookPort,
        spawnGate,
        recordLane,
        replayBufferKB: config.replayBufferKB,
      }),
    })
    : null;

  /** @type {ReturnType<typeof buildIngestLane>} */
  let ingestLane = null;
  /** @type {ReturnType<typeof buildVisionsLane>} */
  let visionsLane = null;
  const visionsSessions = new Map();

  function buildIngestLane() {
    if (!ingestConfig.enabled) return null;
    return createIngestLane({
      ...(options.ingestLaneOptions || {}),
      config: ingestConfig,
      logger,
      broadcast: broadcastLocalControl,
      laneMap: () => laneLedger.laneMap(),
      agentLogConsumers: memoryIngest && !memoryIngest.source ? [memoryIngest.consumer] : [],
      repoRoots: gitRepoRoots,
      editorRoots: () => (Array.isArray(config.projects) ? config.projects : [])
        .map((project) => project?.path)
        .filter(Boolean),
      configPath: configStore.configPath,
      debug: () => configStore.getSettings().debugMode === true,
      onActivity: () => visionsLane?.noteActivity(),
    });
  }

  function buildVisionsLane() {
    if (!visionsConfig.enabled) return null;
    const dispatchConfig = visionsConfig.dispatch;
    return createVisionsWiring({
      logger,
      broadcast: broadcastControl,
      debug: () => configStore.getSettings().debugMode === true,
      dispatchConfig,
      autoFix: visionsConfig.autoFix,
      intentStatePath: configSiblingPath(configStore.configPath, 'visions-intent.json'),
      dispatch: dispatchConfig.enabled
        ? createVisionsDispatcher({
          spawnSession: createVisionsSpawn({
            sessions: visionsSessions,
            closeSessionDataClients,
            hookRouter,
            getHookPort,
            spawnGate,
            recordLane,
            replayBufferKB: config.replayBufferKB,
          }),
          timeoutSeconds: dispatchConfig.dispatchTimeoutSeconds,
          model: dispatchConfig.model,
        })
        : null,
      contextDigest: (...args) => ingestLane?.buildDigest(...args) ?? null,
      contextSeq: () => ingestLane?.latestSeq() ?? null,
      scopeProjects: resolveVisionsScopeProjects(visionsConfig.projects, config.projects, logger.warn.bind(logger)),
      getMemoryStore: () => memoryStore,
      onEditorEvent: (event) => ingestLane?.noteEditorEvent(event),
      knownProjectIds: (Array.isArray(config.projects) ? config.projects : [])
        .map((project) => project?.id)
        .filter((id) => typeof id === 'string' && id),
    });
  }

  function ensureMemorySource() {
    if (!memoryIngest || ingestLane?.agentLogsEnabled) return;
    memoryIngest.startOwnSource();
  }

  function tapIngestForSession(session) {
    if (ingestLane?.terminalEnabled) ingestLane.attachSessionTap(session);
    if (ingestLane?.fsEnabled) ingestLane.noteSessionRoots(session);
  }

  ingestLane = buildIngestLane();
  visionsLane = buildVisionsLane();
  ensureMemorySource();
  let laneRestart = Promise.resolve();

  async function rebuildDynamicLanes() {
    const stopping = [visionsLane?.stop(), ingestLane?.stop()];
    visionsLane = null;
    ingestLane = null;
    await Promise.allSettled(stopping);
    ingestLane = buildIngestLane();
    visionsLane = buildVisionsLane();
    ensureMemorySource();
    if (ingestLane) {
      for (const session of sessions.values()) tapIngestForSession(session);
      void ingestLane.noteRepos();
    }
    logger.log(`[lanes] rebuilt: ingest ${ingestConfig.enabled ? 'on' : 'off'}, visions ${visionsConfig.enabled ? 'on' : 'off'}`);
  }

  function restartDynamicLanes() {
    const previousSignature = JSON.stringify({ ingest: ingestConfig, visions: visionsConfig });
    ingestConfig = resolveIngestConfig(config.ingest);
    visionsConfig = resolveVisionsConfig(config.visions);
    const nextSignature = JSON.stringify({ ingest: ingestConfig, visions: visionsConfig });
    if (nextSignature === previousSignature) return laneRestart;
    laneRestart = laneRestart
      .then(() => rebuildDynamicLanes())
      .catch((error) => logger.warn(`[lanes] rebuild failed: ${error.message}`));
    return laneRestart;
  }

  const visionsSetup = createVisionsSetup({
    getConfig: () => config,
    configStore,
    logger,
    debug: () => configStore.getSettings().debugMode === true,
    onConfigChanged: restartDynamicLanes,
  });
  const packService = createPackService({
    consumedPackNames: () => consumedPackNames(config),
    variantProjects: () => packVariantProjects(config),
    ...(options.packServiceOptions || {}),
  });
  packService.on('pack-updated', ({ name, version }) => {
    broadcastControl({ type: 'pack-updated', name, version });
    for (const session of sessions.values()) session.notePackUpdate(name, version);
  });
  const mill = createMillWiring({
    config,
    listSessions: () => [...sessions.values()].map((session) => session.toSnapshot()),
    getWatcherCount: () => packService._watcherCount(),
    ...(options.millWiringOptions || {}),
  });
  const usage = createUsageWiring({
    config,
    sessions,
    broadcast: broadcastControl,
    controlClientCount: () => controlWss.clients.size,
    warehousePath: configSiblingPath(configStore.configPath, 'usage-warehouse.json'),
    laneMap: () => laneLedger.laneMap(),
    budgetStatePath: configSiblingPath(configStore.configPath, 'usage-budget-state.json'),
    ...(options.usageWiringOptions || {}),
  });
  controlWss.on('connection', () => {
    void usage.start();
  });
  const distillSessions = new Map();
  const packDistiller = createPackDistiller({
    enabled: config.packDistiller ? config.packDistiller.enabled === true : false,
    intervalHours: config.packDistiller?.intervalHours || DEFAULT_INTERVAL_HOURS,
    timeoutSeconds: config.packDistiller?.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS,
    spawnDistill: createDistillSpawn({
      sessions: distillSessions,
      closeSessionDataClients,
      hookRouter,
      getHookPort,
      spawnGate,
      recordLane,
      replayBufferKB: config.replayBufferKB,
    }),
  });
  const packsAutoRebuildEnabled = config.packsAutoRebuild !== false;
  /** @type {Array<[string, unknown]>} */
  const fixedLaneEntries = [
    ['branch-gc', branchGc],
    ['pr-review', prReview],
    ['posthog', posthog],
    ['pack-service', packService],
    ['usage', usage],
    ['pack-distiller', packDistiller],
    ['memory-ingest', memoryIngest],
    ['memory-distill', memoryDistiller],
    ['memory-store', memoryStore],
  ];
  const fixedLanes = new Map(fixedLaneEntries);

  function current(name) {
    if (name === 'ingest') return ingestLane;
    if (name === 'visions') return visionsLane;
    return fixedLanes.get(name) || null;
  }

  // current() is the stringly-typed snapshot reader the control plane uses; these two are the typed
  // readers, so a caller that needs the lane's own API does not have to assert its way back to it.
  const currentIngest = () => ingestLane;
  const currentVisions = () => visionsLane;

  function startMemoryLanes() {
    if (memoryIngest) {
      memoryIngest.backfill().catch((error) => logger.warn(`[memory-ingest] backfill failed: ${error.message}`));
    }
    if (memoryDistiller) {
      memoryDistiller.start().catch((error) => logger.warn(`[memory-distill] start failed: ${error.message}`));
    }
  }

  function startRuntimeLanes() {
    const startSteps = [
      () => void visionsSetup.maybeApply(),
      () => branchGc.start(),
      () => prReview.startPoller(),
      () => posthog.startPoller(),
      () => {
        if (!packsAutoRebuildEnabled) return;
        packService.start().catch((error) => logger.warn(`[packs] auto-rebuild failed to start: ${error.message}`));
      },
      () => packDistiller.start().catch((error) => logger.warn(`[distill] failed to start: ${error.message}`)),
    ];
    for (const start of startSteps) start();
  }

  function restartServiceLanes() {
    const restartSteps = [
      () => branchGc.restartIfConfigChanged(),
      () => prReview.restartIfConfigChanged(),
      () => posthog.restartIfConfigChanged(),
      () => usage.restartIfConfigChanged(),
      () => {
        if (packsAutoRebuildEnabled) packService.restartIfConsumersChanged();
      },
    ];
    for (const restart of restartSteps) restart();
  }

  return {
    branchGc,
    current,
    currentIngest,
    currentVisions,
    distillSessions,
    gitWorkspace,
    gitWorkspaceSync,
    investigationSessions,
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
    restartDynamicLanes,
    restartServiceLanes,
    reviewSessions,
    spawnGate,
    startMemoryLanes,
    startRuntimeLanes,
    tapIngestForSession,
    usage,
    visionsSessions,
    visionsSetup,
  };
}

module.exports = { createBackendLanes, resolveVisionsScopeProjects };
