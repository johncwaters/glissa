import { createNotifyGate, explainNotification } from '../session/core/notify-gate.ts';
import type { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import type { SessionState } from '../shared/states.ts';
import type { ControlMessageRecord } from './control-replay-core.ts';
import { decideWasActiveFlip } from './core/session-registry-core.ts';
import { INTERACTIVE_LANE } from './core/usage-lane-core.ts';
import type { MillMetricEndIntent } from './core/mill-metrics-core.ts';
import type { MillMetricsPort } from './mill-metrics-wiring.ts';
import { resolveCheckConfig, runPostTurnChecks } from './post-turn-checker.ts';

interface WiringProject extends Record<string, unknown> {
  id?: string;
  postTurnChecks?: unknown;
}

interface WiringConfig {
  projects: WiringProject[];
  postTurnChecks?: unknown;
}

type PacksDeliveredPayload = Parameters<MillMetricsPort['onPacksDelivered']>[1];
type PromptSubmittedPayload = Parameters<MillMetricsPort['onPromptSubmitted']>[1];

interface WiringIngestLane {
  fsEnabled: boolean;
  noteRepos: () => unknown;
  noteSessionRoots: (session: Session) => unknown;
}

interface SessionEventDependencies {
  configStore: { save: (mutator: (config: WiringConfig) => void) => unknown };
  config: WiringConfig;
  recordLane: (sessionId: string, lane: string, vendor?: string) => void;
  usage: { refreshSessions: () => void; nudgeSession: () => void };
  broadcastControl: (message: ControlMessageRecord) => void;
  telegramChannel: { noteStateChange: (id: string) => void; recheck: (id: string) => void };
  notificationManager: {
    acknowledge: (id: string) => void;
    trigger: (id: string, category: string, message: string) => void;
  };
  getIngestLane: () => WiringIngestLane | null;
  tapIngestForSession: (session: Session) => void;
  closeSessionDataClients: (id: string) => void;
  millMetricsPort?: MillMetricsPort | null;
  traceWiring?: { attachSession: (session: Session) => void } | null;
  logger: Pick<Console, 'error' | 'log' | 'warn'>;
}

const NOTIFY_MESSAGES: Record<string, (name: string) => string> = {
  waiting: (name) => `${name} needs your input`,
  complete: (name) => `${name} finished working`,
  failed: (name) => `${name} failed`,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function persistSessionField(
  configStore: { save: (mutator: (config: WiringConfig) => void) => unknown },
  liveConfig: WiringConfig,
  sessionId: string,
  field: string,
  value: unknown,
): void {
  const freshConfig = configStore.save((config) => {
    const project = config.projects.find((candidate) => candidate.id === sessionId);
    if (!project) return;
    project[field] = value;
  });
  if (!freshConfig) return;
  const project = liveConfig.projects.find((candidate) => candidate.id === sessionId);
  if (project) project[field] = value;
}

function createSessionEventWiring(dependencies: SessionEventDependencies): (session: Session) => void {
  return function wireSessionEvents(session: Session): void {
    dependencies.traceWiring?.attachSession(session);
    let postTurnDebounce: NodeJS.Timeout | null = null;
    const notifyGate = createNotifyGate();
    let lastPersistedWasActive: boolean | null = null;
    const persistProjectField = (field: string, value: unknown) => {
      persistSessionField(dependencies.configStore, dependencies.config, session.id, field, value);
    };

    session.on('claude-session-id', ({ id, vendor }: { id: string; vendor: string }) => {
      persistProjectField('resumeSessionId', id);
      dependencies.recordLane(id, INTERACTIVE_LANE, vendor);
      dependencies.usage.refreshSessions();
    });
    session.on('resume-cleared', () => {
      persistProjectField('resumeSessionId', null);
      dependencies.broadcastControl({ type: 'session-resume', id: session.id, resumeSessionId: null });
    });
    session.on('error', (error: unknown) => {
      dependencies.logger.error(`[${session.name}] error: ${errorMessage(error)}`);
    });
    session.on('exit', ({ exitCode, signal, reason }: { exitCode: number | null; signal: unknown; reason?: string }) => {
      if (postTurnDebounce) {
        clearTimeout(postTurnDebounce);
        postTurnDebounce = null;
      }
      const reasonText = reason ? `, reason=${reason}` : '';
      dependencies.logger.log(`[${session.name}] exited (code=${exitCode}, signal=${signal}${reasonText})`);
    });

    const resolvePostTurn = () => {
      const project = dependencies.config.projects.find((candidate) => candidate.id === session.id);
      return project ? resolveCheckConfig(dependencies.config.postTurnChecks, project.postTurnChecks) : null;
    };
    session.on('post-turn-check', () => {
      const config = resolvePostTurn();
      if (!config || !config.enabled) return;
      if (postTurnDebounce) clearTimeout(postTurnDebounce);
      postTurnDebounce = setTimeout(() => {
        postTurnDebounce = null;
        const runConfig = resolvePostTurn();
        if (!runConfig || !runConfig.enabled) return;
        runPostTurnChecks({ cwd: session.effectiveCwd(), config: runConfig, sessionId: session.id })
          .then((report) => {
            dependencies.broadcastControl({
              type: 'post-turn-result',
              id: session.id,
              session: session.name,
              ...report,
              timestamp: Date.now(),
            });
          })
          .catch((error: unknown) => dependencies.logger.warn(`[${session.name}] post-turn checks failed: ${errorMessage(error)}`));
      }, config.debounceMs);
    });
    session.on('post-turn-check', () => dependencies.usage.nudgeSession());

    session.on('state-change', ({ from, to, event, detail }: {
      from: SessionState;
      to: SessionState;
      event: string;
      detail: { signal?: string | null; endIntent?: MillMetricEndIntent } | null;
    }) => {
      dependencies.telegramChannel.noteStateChange(session.id);
      dependencies.broadcastControl({
        type: 'state-change',
        id: session.id,
        session: session.name,
        from,
        to,
        event,
        timestamp: Date.now(),
      });
      if (dependencies.millMetricsPort && (to === STATES.DONE || to === STATES.FAILED)) {
        dependencies.millMetricsPort.onSessionEnd(session.id, {
          transitionEvent: event,
          intent: detail?.endIntent,
          finalState: to,
        });
      }
      if (event === 'spawn_success' || event === 'spawn_fail') {
        dependencies.broadcastControl({ type: 'session-packs', id: session.id, packs: session.toSnapshot().packs });
      }

      const nextWasActive = decideWasActiveFlip(to, event, session.pendingRestart);
      if (nextWasActive !== null && nextWasActive !== lastPersistedWasActive) {
        lastPersistedWasActive = nextWasActive;
        persistProjectField('wasActive', nextWasActive);
      }
      if (from === STATES.WAITING || from === STATES.COMPLETE || from === STATES.DONE || from === STATES.FAILED) {
        dependencies.notificationManager.acknowledge(session.id);
      }

      const { category, reason } = explainNotification(
        to,
        notifyGate,
        event,
        { signal: detail?.signal ?? undefined, hookSeen: session.hookSeen },
      );
      session.recordNotifyDecision({
        ts: Date.now(),
        kind: 'notify',
        to,
        event: event || null,
        signal: detail?.signal || null,
        hookSeen: session.hookSeen,
        category,
        reason,
      });
      if (!category) return;
      const message = NOTIFY_MESSAGES[category];
      if (!message) return;
      dependencies.notificationManager.trigger(session.id, category, message(session.name));
    });

    const ingestLaneAtWiring = dependencies.getIngestLane();
    if (ingestLaneAtWiring?.fsEnabled) {
      session.on('state-change', () => {
        const ingestLane = dependencies.getIngestLane();
        if (ingestLane?.fsEnabled) ingestLane.noteSessionRoots(session);
      });
    }
    session.on('packs-delivered', (payload: PacksDeliveredPayload) => {
      if (dependencies.millMetricsPort) dependencies.millMetricsPort.onPacksDelivered(session.id, payload);
    });
    session.on('user-prompt', (payload: PromptSubmittedPayload) => {
      notifyGate.reset();
      if (dependencies.millMetricsPort) dependencies.millMetricsPort.onPromptSubmitted(session.id, payload);
    });
    const relay = (event: string, type: string) => session.on(event, (payload: Record<string, unknown> | undefined) => dependencies.broadcastControl({
      ...payload,
      type,
      id: session.id,
      session: session.name,
      timestamp: Date.now(),
    }));
    session.on('agents-change', (payload: Record<string, unknown>) => {
      dependencies.telegramChannel.recheck(session.id);
      dependencies.broadcastControl({
        ...payload,
        type: 'session-agents',
        id: session.id,
        session: session.name,
        timestamp: Date.now(),
      });
    });
    relay('wakeup-change', 'session-wakeup');
    relay('prompt-kind-change', 'session-prompt');
    relay('sleep', 'session-sleep');
    relay('wake', 'session-wake');

    session.on('merge-status', ({ mergeStatus, reason, parked }: {
      mergeStatus: string;
      reason?: string | null;
      parked?: boolean;
    }) => {
      dependencies.broadcastControl({
        type: 'session-merge-status',
        id: session.id,
        session: session.name,
        mergeStatus,
        reason: reason || null,
        parked: !!parked,
        timestamp: Date.now(),
      });
      dependencies.broadcastControl({ type: 'session-git', id: session.id, worktree: !!session.isWorktree });
    });
    session.on('worktree-changed', ({ sig }: { sig: string }) => {
      dependencies.broadcastControl({ type: 'session-changed', id: session.id, sig });
    });
    session.on('worktree-blocked', ({ branch, notice }: { branch: string | null; notice: unknown }) => {
      dependencies.broadcastControl({
        type: 'session-worktree-blocked',
        id: session.id,
        session: session.name,
        branch,
        notice,
        timestamp: Date.now(),
      });
    });
    session.on('worktree-warning', ({ branch, notice }: { branch: string | null; notice: string }) => {
      dependencies.broadcastControl({
        type: 'session-worktree-warning',
        id: session.id,
        session: session.name,
        branch,
        notice,
        timestamp: Date.now(),
      });
    });
    session.on('worktree-ready', ({ branch, base }: { branch: string | null; base?: string | null }) => {
      dependencies.broadcastControl({
        type: 'session-worktree-ready',
        id: session.id,
        session: session.name,
        branch,
        base,
        timestamp: Date.now(),
      });
      dependencies.broadcastControl({ type: 'session-git', id: session.id, worktree: !!session.isWorktree });
      const ingestLane = dependencies.getIngestLane();
      if (ingestLane) void ingestLane.noteRepos();
      if (ingestLane?.fsEnabled) ingestLane.noteSessionRoots(session);
    });
    session.on('rebaseline', () => dependencies.closeSessionDataClients(session.id));
    dependencies.tapIngestForSession(session);
  };
}

export { createSessionEventWiring, persistSessionField };
export type { SessionEventDependencies, WiringConfig, WiringIngestLane, WiringProject };
