'use strict';

const { STATES } = require('../shared/states');
const { createNotifyGate, explainNotification } = require('../session/core/notify-gate');
const { INTERACTIVE_LANE } = require('./core/usage-lane-core');
const { decideWasActiveFlip } = require('./core/session-registry-core');
const { runPostTurnChecks, resolveCheckConfig } = require('./post-turn-checker');

/**
 * @typedef {object} SessionEventDependencies
 * @property {{ save: (mutator: (config: { projects: Array<Record<string, unknown>> }) => void) => Record<string, unknown>|null }} configStore
 * @property {{ projects: Array<{ id?: string, postTurnChecks?: Record<string, unknown> }>, postTurnChecks?: Record<string, unknown> }} config
 * @property {(sessionId: string, lane: string, vendor: string) => void} recordLane
 * @property {{ refreshSessions: () => void, nudgeSession: () => void }} usage
 * @property {(message: object) => void} broadcastControl
 * @property {{ noteStateChange: (id: string) => void, recheck: (id: string) => void }} telegramChannel
 * @property {{ acknowledge: (id: string) => void, trigger: (id: string, category: string, message: string) => void }} notificationManager
 * @property {() => any|null} getIngestLane
 * @property {(session: any) => void} tapIngestForSession
 * @property {(id: string) => void} closeSessionDataClients
 * @property {Pick<Console, 'error'|'log'|'warn'>} logger
 */

function persistSessionField(configStore, liveConfig, sessionId, field, value) {
  const freshConfig = configStore.save((config) => {
    const project = config.projects.find((candidate) => candidate.id === sessionId);
    if (!project) return;
    project[field] = value;
  });
  if (!freshConfig) return;
  const project = liveConfig.projects.find((candidate) => candidate.id === sessionId);
  if (project) project[field] = value;
}

/** @param {SessionEventDependencies} dependencies */
function createSessionEventWiring(dependencies) {
  return function wireSessionEvents(session) {
    /** @type {NodeJS.Timeout|null} */
    let postTurnDebounce = null;
    const notifyGate = createNotifyGate();
    /** @type {boolean|null} */
    let lastPersistedWasActive = null;
    const persistProjectField = (field, value) => {
      persistSessionField(dependencies.configStore, dependencies.config, session.id, field, value);
    };

    session.on('claude-session-id', ({ id, vendor }) => {
      persistProjectField('resumeSessionId', id);
      dependencies.recordLane(id, INTERACTIVE_LANE, vendor);
      dependencies.usage.refreshSessions();
    });
    session.on('resume-cleared', () => {
      persistProjectField('resumeSessionId', null);
      dependencies.broadcastControl({ type: 'session-resume', id: session.id, resumeSessionId: null });
    });
    session.on('error', (error) => {
      dependencies.logger.error(`[${session.name}] error: ${error.message}`);
    });
    session.on('exit', ({ exitCode, signal, reason }) => {
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
          .catch((error) => dependencies.logger.warn(`[${session.name}] post-turn checks failed: ${error.message}`));
      }, config.debounceMs);
    });
    session.on('post-turn-check', () => dependencies.usage.nudgeSession());

    session.on('state-change', ({ from, to, event, detail }) => {
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
        { signal: detail?.signal, hookSeen: session.hookSeen },
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
      const messages = {
        waiting: `${session.name} needs your input`,
        complete: `${session.name} finished working`,
        failed: `${session.name} failed`,
      };
      dependencies.notificationManager.trigger(session.id, category, messages[category]);
    });

    const ingestLaneAtWiring = dependencies.getIngestLane();
    if (ingestLaneAtWiring?.fsEnabled) {
      // Per-session listeners are registered once, so replacement lanes must be read live.
      session.on('state-change', () => {
        const ingestLane = dependencies.getIngestLane();
        if (ingestLane?.fsEnabled) ingestLane.noteSessionRoots(session);
      });
    }
    session.on('user-prompt', () => notifyGate.reset());
    const relay = (event, type) => session.on(event, (payload) => dependencies.broadcastControl({
      ...payload,
      type,
      id: session.id,
      session: session.name,
      timestamp: Date.now(),
    }));
    session.on('agents-change', (payload) => {
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

    session.on('merge-status', ({ mergeStatus, reason, parked }) => {
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
    session.on('worktree-changed', ({ sig }) => {
      dependencies.broadcastControl({ type: 'session-changed', id: session.id, sig });
    });
    session.on('worktree-blocked', ({ branch, notice }) => {
      dependencies.broadcastControl({
        type: 'session-worktree-blocked',
        id: session.id,
        session: session.name,
        branch,
        notice,
        timestamp: Date.now(),
      });
    });
    session.on('worktree-ready', ({ branch }) => {
      dependencies.broadcastControl({
        type: 'session-worktree-ready',
        id: session.id,
        session: session.name,
        branch,
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

module.exports = { createSessionEventWiring, persistSessionField };
