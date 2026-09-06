import type { WebSocket } from 'ws';
import type { HookRouter } from '../detection/hook-source.ts';
import type { Session } from '../session/sessions.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import { comparableDirectoryPath } from '../shared/paths.ts';
import { createBranchGcWiring } from './branch-gc-wiring.ts';
import { DEFAULT_CONFIG } from './config-store.ts';
import type { ConfigStore, GlissaConfig } from './config-store.ts';
import { configSiblingPath } from './pairings-store.ts';
import { createGitWorkspace, createGitWorkspaceSync } from './git-workspace.ts';
import { createIngestLane } from './ingest-wiring.ts';
import { dbPathForConfig } from './glissa-db.ts';
import { createMemoryDistillSpawn, createMemoryDistiller } from './memory-distill.ts';
import { createMemoryIngest, earliestLaneEntryMs } from './memory-ingest-wiring.ts';
import { createMemoryStore } from './memory-store.ts';
import { createMillMetricsStore } from './mill-metrics-store.ts';
import { createMillMetricsLane } from './mill-metrics-wiring.ts';
import { createMillWiring } from './mill-wiring.ts';
import { createPackService } from './pack-service.ts';
import {
  DEFAULT_INTERVAL_HOURS,
  DEFAULT_TIMEOUT_SECONDS,
  createDistillSpawn,
  createPackDistiller,
} from './pack-distiller.ts';
import { createPosthogWiring } from './posthog-wiring.ts';
import { createPrReviewWiring } from './pr-review-wiring.ts';
import { createSpawnGate } from './spawn-gate.ts';
import { createUsageWiring, resolveUsageConfig } from './usage-wiring.ts';
import { createLaneLedger } from './usage-lane-ledger.ts';
import { createTraceWiring } from './trace-wiring.ts';
import { createVisionsDispatcher, createVisionsSpawn } from './visions-dispatch.ts';
import { createVisionsSetup } from './visions-setup.ts';
import { createVisionsWiring } from './visions-wiring.ts';
import { resolveIngestConfig } from './core/ingest-core.ts';
import { resolveMemoryConfig } from './core/memory-core.ts';
import { resolveDistillConfig as resolveMemoryDistillConfig } from './core/memory-distill-core.ts';
import { isMillEnabled, packVariantProjects } from './core/pack-core.ts';
import { resolveVisionsConfig } from './core/visions-dispatch-core.ts';
import { resolveVisionsScopeProjects } from './core/visions-scope-core.ts';
import { isPlainObject, numberOrNull } from './core/usage-number-core.ts';
import { resolveMillMetricsConfig } from './core/mill-metrics-core.ts';

interface BackendLaneOptions {
  branchGcWiringOptions?: Record<string, unknown>;
  ingestLaneOptions?: Record<string, unknown>;
  packServiceOptions?: Record<string, unknown>;
  millMetricsStoreOptions?: Record<string, unknown>;
  millMetricsWiringOptions?: Record<string, unknown>;
  millWiringOptions?: Record<string, unknown>;
  usageWiringOptions?: Record<string, unknown>;
}

interface BackendLaneDependencies {
  config: GlissaConfig;
  configStore: ConfigStore;
  sessions: Map<string, Session>;
  reviewSessions: Map<string, Session>;
  investigationSessions: Map<string, Session>;
  closeSessionDataClients: (id: string) => void;
  hookRouter: HookRouter;
  getHookPort: () => number | null;
  broadcastControl: ControlBroadcast;
  broadcastLocalControl: ControlBroadcast;
  controlWss: {
    clients: Set<WebSocket>;
    on(event: 'connection', listener: (socket: WebSocket) => void): unknown;
  };
  options: BackendLaneOptions;
  logger: Console;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SessionTokenTotals {
  tokens: number | null;
  costUSD: number | null;
  identity: string | null;
}

function tokensFromUsage(
  usage: { sessionTotals: (sessionId: string) => { tokens?: unknown; costUSD?: unknown } | null | undefined },
  sessions: Map<string, { resumeSessionId?: string | null }>,
  sessionId: string,
): SessionTokenTotals | null {
  const resumed = sessions.get(sessionId)?.resumeSessionId;
  const identity = typeof resumed === 'string' && resumed ? resumed : null;
  const totals = usage.sessionTotals(sessionId);
  if (!totals) return identity ? { tokens: null, costUSD: null, identity } : null;
  return {
    tokens: numberOrNull(totals.tokens),
    costUSD: numberOrNull(totals.costUSD),
    identity,
  };
}

function createBackendLanes(dependencies: BackendLaneDependencies) {
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
  const getProjectPathById = (projectId: string) => {
    const project = config.projects.find((candidate) => candidate.id === projectId);
    return project ? project.path : null;
  };
  const getProjectNameById = (projectId: string) => {
    const project = config.projects.find((candidate) => candidate.id === projectId);
    return project ? project.name ?? null : null;
  };

  const laneLedger = createLaneLedger({
    ledgerPath: configSiblingPath(configStore.configPath, 'usage-lanes.json'),
    retainDays: resolveUsageConfig(config.usage).warehouseRetainDays,
    logger,
  });
  void laneLedger.load();
  const recordLane = laneLedger.record;
  const allLiveSessions = (): Session[] => [
    ...sessions.values(),
    ...reviewSessions.values(),
    ...investigationSessions.values(),
    ...visionsSessions.values(),
    ...distillSessions.values(),
    ...memoryDistillSessions.values(),
  ];
  const branchGc = createBranchGcWiring({
    config,
    gitWorkspace,
    broadcast: broadcastControl,
    liveSessionIds: () => new Set(allLiveSessions().map((session) => session.id)),
    liveWorktreePaths: async () => new Set(await Promise.all(allLiveSessions()
      .flatMap((session) => [session.worktreeDir, session.path])
      .filter((sessionDirectory): sessionDirectory is string => Boolean(sessionDirectory))
      .map((sessionDirectory) => comparableDirectoryPath(sessionDirectory)))),
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
  const gitRepoRoots = (): string[] => {
    const directories: string[] = [];
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
  const isTraceEnabled = config.trace?.enabled ?? DEFAULT_CONFIG.trace.enabled;
  const traceWiring = isTraceEnabled
    ? createTraceWiring({
      configPath: configStore.configPath,
      logger,
    })
    : null;
  const memoryDistillSessions = new Map<string, Session>();
  const memoryDistiller = memoryStore
    ? createMemoryDistiller({
      store: memoryStore,
      config: resolveMemoryDistillConfig(isPlainObject(config.memory) ? config.memory.distill : null, { memoryEnabled: true }),
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

  let ingestLane: ReturnType<typeof createIngestLane> | null = null;
  let visionsLane: ReturnType<typeof createVisionsWiring> | null = null;
  const visionsSessions = new Map<string, Session>();

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
        .filter((projectPath): projectPath is string => typeof projectPath === 'string' && projectPath !== ''),
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
      intentThreadTtlMs: visionsConfig.intent.threadTtlMs,
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
      contextDigest: (...args: Parameters<NonNullable<typeof ingestLane>['buildDigest']>) => ingestLane?.buildDigest(...args) ?? null,
      contextSeq: () => ingestLane?.latestSeq() ?? null,
      scopeProjects: resolveVisionsScopeProjects({
        configuredIds: visionsConfig.projects, projects: config.projects, warn: logger.warn.bind(logger),
      }),
      getMemoryStore: () => memoryStore,
      onEditorEvent: (event: { method?: string; uri?: string }) => ingestLane?.noteEditorEvent(event),
      knownProjectIds: (Array.isArray(config.projects) ? config.projects : [])
        .map((project) => project?.id)
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    });
  }

  function ensureMemorySource(): void {
    if (!memoryIngest || ingestLane?.agentLogsEnabled) return;
    memoryIngest.startOwnSource();
  }

  function tapIngestForSession(session: Session): void {
    if (ingestLane?.terminalEnabled) ingestLane.attachSessionTap(session);
    if (ingestLane?.fsEnabled) ingestLane.noteSessionRoots(session);
  }

  ingestLane = buildIngestLane();
  visionsLane = buildVisionsLane();
  ensureMemorySource();
  let laneRestart: Promise<void> = Promise.resolve();

  async function rebuildDynamicLanes(): Promise<void> {
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

  function restartDynamicLanes(): Promise<void> {
    const previousSignature = JSON.stringify({ ingest: ingestConfig, visions: visionsConfig });
    ingestConfig = resolveIngestConfig(config.ingest);
    visionsConfig = resolveVisionsConfig(config.visions);
    const nextSignature = JSON.stringify({ ingest: ingestConfig, visions: visionsConfig });
    if (nextSignature === previousSignature) return laneRestart;
    laneRestart = laneRestart
      .then(() => rebuildDynamicLanes())
      .catch((error: unknown) => logger.warn(`[lanes] rebuild failed: ${errorMessage(error)}`));
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
    variantProjects: () => packVariantProjects(config),
    ...(options.packServiceOptions || {}),
  });
  packService.on('pack-updated', ({ name, version }: { name: string; version: string }) => {
    broadcastControl({ type: 'pack-updated', name, version });
    for (const session of sessions.values()) session.notePackUpdate(name, version);
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
  const millMetrics = createMillMetricsLane({
    resolveConfig: () => resolveMillMetricsConfig(config.millMetrics),
    createStore: ({ retainDays }) => createMillMetricsStore({
      recordsPath: configSiblingPath(configStore.configPath, 'mill-metrics.json'),
      eventsDir: configSiblingPath(configStore.configPath, 'mill-metrics'),
      retainDays,
      logger,
      ...(options.millMetricsStoreOptions || {}),
    }),
    tokensForSession: (sessionId) => tokensFromUsage(usage, sessions, sessionId),
    logger,
    ...(options.millMetricsWiringOptions || {}),
  });
  const mill = createMillWiring({
    config,
    listSessions: () => [...sessions.values()].map((session) => session.toSnapshot()),
    getWatcherCount: () => packService._watcherCount(),
    measurement: () => millMetrics.scorecards(),
    ...(options.millWiringOptions || {}),
  });
  controlWss.on('connection', () => {
    void usage.start();
  });
  const distillSessions = new Map<string, Session>();
  const packDistillerBlock = isPlainObject(config.packDistiller) ? config.packDistiller : null;
  const packDistiller = createPackDistiller({
    enabled: packDistillerBlock ? packDistillerBlock.enabled === true : false,
    intervalHours: Number(packDistillerBlock?.intervalHours) || DEFAULT_INTERVAL_HOURS,
    timeoutSeconds: Number(packDistillerBlock?.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS,
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
  const millEnabled = () => isMillEnabled(config);
  const fixedLaneEntries = {
    'branch-gc': branchGc,
    'pr-review': prReview,
    posthog,
    'pack-service': packService,
    usage,
    'pack-distiller': packDistiller,
    'memory-ingest': memoryIngest,
    'memory-distill': memoryDistiller,
    'memory-store': memoryStore,
    trace: traceWiring,
  };
  const fixedLanes = new Map<string, unknown>(Object.entries(fixedLaneEntries));
  type LaneMap = typeof fixedLaneEntries & { ingest: typeof ingestLane; visions: typeof visionsLane };

  function current<K extends keyof LaneMap>(name: K): LaneMap[K];
  function current(name: string): unknown {
    if (name === 'ingest') return ingestLane;
    if (name === 'visions') return visionsLane;
    return fixedLanes.get(name) || null;
  }

  const currentIngest = () => ingestLane;
  const currentVisions = () => visionsLane;

  function startMemoryLanes(): void {
    if (memoryIngest) {
      memoryIngest.backfill().catch((error: unknown) => logger.warn(`[memory-ingest] backfill failed: ${errorMessage(error)}`));
    }
    if (memoryDistiller) {
      memoryDistiller.start().catch((error: unknown) => logger.warn(`[memory-distill] start failed: ${errorMessage(error)}`));
    }
  }

  function startRuntimeLanes(): void {
    const startSteps = [
      () => void visionsSetup.maybeApply(),
      () => branchGc.start(),
      () => prReview.startPoller(),
      () => posthog.startPoller(),
      () => {
        if (!millEnabled()) return;
        packService.start().catch((error: unknown) => logger.warn(`[packs] auto-rebuild failed to start: ${errorMessage(error)}`));
      },
      () => packDistiller.start().catch((error: unknown) => logger.warn(`[distill] failed to start: ${errorMessage(error)}`)),
      () => traceWiring?.start().catch((error: unknown) => logger.warn(`[trace] start failed: ${errorMessage(error)}`)),
    ];
    for (const start of startSteps) start();
  }

  function restartServiceLanes(): void {
    const restartSteps = [
      () => branchGc.restartIfConfigChanged(),
      () => prReview.restartIfConfigChanged(),
      () => posthog.restartIfConfigChanged(),
      () => usage.restartIfConfigChanged(),
      () => void millMetrics.restartIfConfigChanged(),
      () => {
        if (!millEnabled()) {
          void packService.pause();
          return;
        }
        void packService.resume();
        void packService.restartIfConsumersChanged();
      },
    ];
    for (const restart of restartSteps) restart();
  }

  return {
    allLiveSessions,
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
    millMetrics,
    packDistiller,
    packService,
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
    traceWiring,
    usage,
    visionsSessions,
    visionsSetup,
  };
}

export { createBackendLanes, tokensFromUsage };
export type { BackendLaneDependencies, BackendLaneOptions };
