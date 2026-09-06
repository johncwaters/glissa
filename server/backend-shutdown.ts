import { createStopperCollector } from './core/shutdown-core.ts';
import type { StopperEntry } from './core/shutdown-core.ts';

interface ShutdownSession {
  destroy(): void;
  _killReap?: Promise<unknown> | null;
}

interface Stoppable {
  stop: () => unknown;
}

interface ShutdownMillMetricsPort {
  onSessionTeardown: (sessionId: string) => void;
}

interface BackendShutdownDependencies {
  cancelAutoResume: () => void;
  healthInterval: NodeJS.Timeout;
  getStopConfigWatch: () => (() => void) | null;
  remoteAuth: { stop: () => void } | null;
  stopUpdateCheck: () => void;
  stopUpdateApply?: () => unknown;
  notificationManager: { destroy: () => void };
  telegramChannel: { destroy: () => void };
  sessions: Map<string, ShutdownSession>;
  reviewSessions: Map<string, ShutdownSession>;
  investigationSessions: Map<string, ShutdownSession>;
  distillSessions: Map<string, ShutdownSession>;
  visionsSessions: Map<string, ShutdownSession>;
  memoryDistillSessions: Map<string, ShutdownSession>;
  branchGc: Stoppable;
  prReview: { stopPoller: () => unknown };
  posthog: { stopPoller: () => unknown };
  packService: Stoppable;
  usage: Stoppable;
  packDistiller: Stoppable;
  getIngestLane: () => Stoppable | null;
  getVisionsLane: () => Stoppable | null;
  memoryIngest: Stoppable | null;
  memoryDistiller: Stoppable | null;
  memoryStore: Stoppable | null;
  traceWiring?: Stoppable | null;
  millMetricsIdle?: (() => Promise<void>) | null;
  millMetricsPort?: ShutdownMillMetricsPort | null;
  telegramOutbox: { idle: () => unknown };
  heartbeat: { stop: () => void };
  controlWss: { close: () => void };
  dataWss: { close: () => void };
}

interface ShutdownOutcome {
  reaps: Promise<unknown>[];
  stoppers: StopperEntry[];
}

function closeMeasuredSessions(
  millMetricsPort: ShutdownMillMetricsPort | null | undefined,
  sessions: Map<string, ShutdownSession>,
): void {
  if (!millMetricsPort) return;
  for (const id of sessions.keys()) millMetricsPort.onSessionTeardown(id);
}

function destroySessions(sessionMaps: Map<string, ShutdownSession>[], pendingReaps: Promise<unknown>[]): void {
  for (const sessions of sessionMaps) {
    for (const session of sessions.values()) {
      session.destroy();
      if (session._killReap) pendingReaps.push(session._killReap);
    }
  }
}

function createBackendShutdown(dependencies: BackendShutdownDependencies): () => ShutdownOutcome {
  let isShuttingDown = false;

  return function shutdown(): ShutdownOutcome {
    if (isShuttingDown) return { reaps: [], stoppers: [] };
    isShuttingDown = true;
    const stoppers = createStopperCollector();
    dependencies.cancelAutoResume();
    clearInterval(dependencies.healthInterval);
    const stopConfigWatch = dependencies.getStopConfigWatch();
    if (stopConfigWatch) stopConfigWatch();
    if (dependencies.remoteAuth) dependencies.remoteAuth.stop();
    dependencies.stopUpdateCheck();
    if (dependencies.stopUpdateApply) stoppers.add('update-apply', () => dependencies.stopUpdateApply?.());

    dependencies.notificationManager.destroy();
    dependencies.telegramChannel.destroy();
    const pendingReaps: Promise<unknown>[] = [];
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
    const traceWiring = dependencies.traceWiring;
    if (traceWiring) {
      stoppers.add('trace', async () => {
        await Promise.allSettled([...pendingReaps]);
        return traceWiring.stop();
      });
    }

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

export { createBackendShutdown };
export type { BackendShutdownDependencies, ShutdownOutcome, ShutdownSession };
