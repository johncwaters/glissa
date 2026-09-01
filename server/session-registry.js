'use strict';

const fs = require('node:fs');
const { STATES } = require('../shared/states.ts');
const { isSameDirectoryPath } = require('../shared/paths.ts');
const { pickAutoResume } = require('../session/core/auto-resume');
const { diffProjects, shouldStartAfterModify } = require('./core/session-registry-core');
const { configuredIntegrationBranch } = require('./core/integration-branch-core');

/** @typedef {import('./core/session-registry-core').RegistryProject & Record<string, unknown>} RegistryProject */
/** @typedef {Record<string, unknown> & { projects: RegistryProject[], integrationBranch?: string|null }} RegistryConfig */
/** @typedef {{ id: string, cwd: string, branch: string, integrationBranch?: string, hasWork: boolean }} RegistryWorktree */
/** @typedef {{ id: string, name: string, path: string, state: string, stateSince: number, pendingRestart?: boolean, dangerouslySkipPermissions?: boolean, isWorktree?: boolean, resumeSessionId?: string|null, _killReap?: Promise<unknown>|null, start: () => unknown, destroy: () => void, toSnapshot: () => Record<string, unknown>, getWorktreeCarry?: () => Record<string, unknown>|null, adoptWorktree: (worktree: Record<string, unknown>) => void, discardWorktree?: () => unknown, discardWorktreeIfClean: () => unknown }} RegistrySession */
/** @typedef {{ listSessionWorktrees: (input: { projectPath: string, integrationBranch: string|null }) => RegistryWorktree[], removeWorktreeByPath: (input: { projectPath: string, cwd: string, branch: string }) => void }} RegistryGitWorkspace */

/**
 * @typedef {object} SessionRegistryDependencies
 * @property {import('http').Server} httpServer
 * @property {Map<string, RegistrySession>} sessions
 * @property {RegistryConfig} config
 * @property {{ save: (mutator: (config: RegistryConfig) => void) => RegistryConfig|null }} configStore
 * @property {(project: RegistryProject, config: RegistryConfig) => RegistrySession} makeSession
 * @property {(session: RegistrySession) => void} wireSessionEvents
 * @property {(id: string) => void} closeSessionDataClients
 * @property {{ acknowledge: (id: string) => void }} notificationManager
 * @property {MillMetricsPort|null} [millMetricsPort]
 * @property {() => { noteRepos: () => unknown, detachSessionTap: (session: RegistrySession) => void, releaseSessionRoots: (session: RegistrySession) => void }|null} getIngestLane
 * @property {(message: Record<string, unknown>) => void} broadcastControl
 * @property {(config: RegistryConfig) => void} applySettingsReload
 * @property {{ run: (callback: () => unknown) => Promise<unknown> }} spawnGate
 * @property {RegistryGitWorkspace} gitWorkspaceSync
 * @property {(input: { projects: RegistryProject[], sessions: Map<string, RegistrySession>, gitWorkspaceSync: RegistryGitWorkspace, integrationBranch: string|null }) => void} reconcileSessionWorktrees
 * @property {(oldSession: RegistrySession, newSession: RegistrySession) => unknown} carryWorktreeAcrossRecreate
 * @property {(projects: RegistryProject[]) => boolean} ensureProjectIds
 * @property {(agent: import('./core/session-registry-core').AgentId) => string} resolveAgentId
 * @property {Pick<Console, 'log'|'warn'>} logger
 */

/**
 * @param {Map<string, RegistrySession>} sessions
 * @param {RegistryConfig} config
 * @param {{ run: (callback: () => unknown) => Promise<unknown> }} spawnGate
 * @param {Pick<Console, 'warn'>} logger
 */
function runAutoResume(sessions, config, spawnGate, logger = console) {
  const ids = pickAutoResume(config.projects, config);
  const runs = [];
  for (const id of ids) {
    const session = sessions.get(id);
    if (!session) continue;
    runs.push(
      spawnGate.run(() => {
        if (session.state !== STATES.DORMANT) return null;
        return session.start();
      }).catch((error) => {
        logger.warn(`[boot] auto-resume failed for ${session.name}: ${error.message}`);
      }),
    );
  }
  return Promise.all(runs);
}

function carryWorktreeAcrossRecreate(oldSession, newSession) {
  const carry = oldSession?.getWorktreeCarry?.();
  if (!carry) return;
  if (isSameDirectoryPath(newSession.path, oldSession.path)) {
    try {
      newSession.adoptWorktree({
        worktreeDir: carry.worktreeDir,
        branch: carry.branch,
        base: carry.base,
      });
    } catch (error) {
      console.warn(`[config] worktree carry-over adopt failed for ${newSession.name}: ${error.message}`);
    }
    return;
  }
  return Promise.resolve(oldSession._killReap)
    .catch(() => {})
    .then(() => oldSession.discardWorktreeIfClean())
    .catch(() => {});
}

/**
 * @param {object} dependencies
 * @param {RegistryProject[]} dependencies.projects
 * @param {Map<string, RegistrySession>} dependencies.sessions
 * @param {RegistryGitWorkspace} dependencies.gitWorkspaceSync
 * @param {string|null} dependencies.integrationBranch
 * @param {(session: RegistrySession, worktree: RegistryWorktree) => void} [dependencies.onAdopt]
 * @param {(path: string) => boolean} [dependencies.worktreeDirExists]
 * @param {(message: string) => void} [dependencies.log]
 * @param {(message: string) => void} [dependencies.warn]
 */
function reconcileSessionWorktrees({
  projects,
  sessions,
  gitWorkspaceSync,
  integrationBranch,
  onAdopt,
  worktreeDirExists = fs.existsSync,
  log = console.log,
  warn = console.warn,
}) {
  const reconciledRoots = new Set();
  for (const project of projects) {
    if (!project.path || reconciledRoots.has(project.path)) continue;
    reconciledRoots.add(project.path);
    for (const worktree of gitWorkspaceSync.listSessionWorktrees({
      projectPath: project.path,
      integrationBranch,
    })) {
      const session = sessions.get(worktree.id);
      if (session && isSameDirectoryPath(session.path, project.path) && worktreeDirExists(worktree.cwd)) {
        session.adoptWorktree({
          worktreeDir: worktree.cwd,
          branch: worktree.branch,
          base: worktree.integrationBranch || integrationBranch,
          hasUnmergedWork: worktree.hasWork,
        });
        if (onAdopt) onAdopt(session, worktree);
        log(`[worktree] re-adopted ${worktree.hasWork ? 'pending-review' : 'clean'} worktree for ${session.name} (${worktree.branch})`);
        continue;
      }
      if (worktree.hasWork) {
        warn(`[worktree] keeping orphan worktree with unmerged work: ${worktree.branch} (${worktree.cwd})`);
        continue;
      }
      gitWorkspaceSync.removeWorktreeByPath({
        projectPath: project.path,
        cwd: worktree.cwd,
        branch: worktree.branch,
      });
    }
  }
}

/** @param {SessionRegistryDependencies} dependencies */
function createSessionRegistry(dependencies) {
  const { sessions, config } = dependencies;
  /** @type {(() => void)|null} */
  let pendingAutoResumeOnListening = null;

  function getSession(id) {
    return sessions.get(id) || null;
  }

  function getProjectPathById(projectId) {
    const project = config.projects.find((candidate) => candidate.id === projectId);
    return project ? project.path : null;
  }

  function getProjectNameById(projectId) {
    const project = config.projects.find((candidate) => candidate.id === projectId);
    return project ? project.name : null;
  }

  function noteRepos() {
    const ingestLane = dependencies.getIngestLane();
    if (ingestLane) void ingestLane.noteRepos();
  }

  function initialize() {
    for (const project of config.projects) {
      const session = dependencies.makeSession(project, config);
      sessions.set(project.id, session);
      dependencies.wireSessionEvents(session);
    }
    noteRepos();
    try {
      dependencies.reconcileSessionWorktrees({
        projects: config.projects,
        sessions,
        gitWorkspaceSync: dependencies.gitWorkspaceSync,
        integrationBranch: configuredIntegrationBranch(config),
      });
    } catch (error) {
      dependencies.logger.warn(`[worktree] worktree reconcile failed: ${error.message}`);
    }
    noteRepos();
    scheduleAutoResume();
  }

  function startAutoResume() {
    pendingAutoResumeOnListening = null;
    runAutoResume(sessions, config, dependencies.spawnGate, dependencies.logger);
  }

  function scheduleAutoResume() {
    if (dependencies.httpServer.listening) {
      startAutoResume();
      return;
    }
    pendingAutoResumeOnListening = startAutoResume;
    dependencies.httpServer.once('listening', pendingAutoResumeOnListening);
  }

  function cancelAutoResume() {
    if (!pendingAutoResumeOnListening) return;
    dependencies.httpServer.off('listening', pendingAutoResumeOnListening);
    pendingAutoResumeOnListening = null;
  }

  function teardownSession(id, logLabel) {
    const session = sessions.get(id);
    if (!session) return false;
    dependencies.closeSessionDataClients(id);
    // Acknowledge before destroy because destroy removes the listeners that complete notification cleanup.
    dependencies.notificationManager.acknowledge(id);
    // Same reason: a removed session never transitions to DONE, so the measurement lane is told here or
    // its accumulator is stranded and the pack scorecard keeps counting a delivery that is long gone.
    if (dependencies.millMetricsPort) dependencies.millMetricsPort.onSessionTeardown(id);
    const ingestLane = dependencies.getIngestLane();
    if (ingestLane) ingestLane.detachSessionTap(session);
    if (ingestLane) ingestLane.releaseSessionRoots(session);
    session.destroy();
    Promise.resolve(session._killReap)
      .catch(() => {})
      .then(() => session.discardWorktree?.())
      .catch(() => {});
    sessions.delete(id);
    dependencies.broadcastControl({ type: 'session-removed', id, session: session.name });
    dependencies.logger.log(`${logLabel}: ${session.name}`);
    return true;
  }

  function addSessions(added, newConfig) {
    for (const project of added) {
      const session = dependencies.makeSession(project, { ...config, ...newConfig });
      sessions.set(project.id, session);
      dependencies.wireSessionEvents(session);
      dependencies.broadcastControl({
        type: 'session-added',
        id: project.id,
        session: project.name,
        path: project.path,
        state: session.state,
        stateSince: session.stateSince,
        skipPerms: !!session.dangerouslySkipPermissions,
        worktree: !!session.isWorktree,
        resumeSessionId: session.resumeSessionId || null,
      });
      session.start();
      dependencies.logger.log(`[config] Added session: ${project.name}`);
    }
    noteRepos();
  }

  function modifySessions(modified, newConfig) {
    for (const project of modified) {
      const oldSession = sessions.get(project.id);
      if (!oldSession) continue;
      const wasDormant = !shouldStartAfterModify(oldSession.state);
      dependencies.closeSessionDataClients(project.id);
      dependencies.notificationManager.acknowledge(project.id);
      // Same reason as teardownSession: the replaced session never transitions, so its accumulator is
      // closed here or the measurement lane keeps counting a delivery that no longer exists.
      if (dependencies.millMetricsPort) dependencies.millMetricsPort.onSessionTeardown(project.id);
      oldSession.destroy();
      const newSession = dependencies.makeSession(project, { ...config, ...newConfig });
      sessions.set(project.id, newSession);
      dependencies.wireSessionEvents(newSession);
      dependencies.carryWorktreeAcrossRecreate(oldSession, newSession);
      dependencies.broadcastControl({
        type: 'session-modified',
        id: project.id,
        session: project.name,
        path: project.path,
        state: newSession.state,
        stateSince: newSession.stateSince,
        skipPerms: !!newSession.dangerouslySkipPermissions,
        worktree: !!newSession.isWorktree,
        resumeSessionId: newSession.resumeSessionId || null,
      });
      if (!wasDormant) newSession.start();
      dependencies.logger.log(`[config] Modified session: ${project.name}${wasDormant ? ' (left dormant)' : ''}`);
    }
  }

  function renameSessions(renamed) {
    for (const project of renamed) {
      const session = sessions.get(project.id);
      if (!session) continue;
      const oldName = session.name;
      session.name = project.name;
      dependencies.broadcastControl({ type: 'session-renamed', id: project.id, oldName, newName: project.name });
      dependencies.logger.log(`[config] Renamed session: ${oldName} → ${project.name}`);
    }
  }

  function applyConfigReload(newConfig) {
    const assigned = dependencies.ensureProjectIds(newConfig.projects);
    const diff = diffProjects(sessions, newConfig.projects, {
      ensureProjectIds: dependencies.ensureProjectIds,
      resolveAgentId: dependencies.resolveAgentId,
    });
    for (const id of diff.removed) teardownSession(id, '[config] Removed session');
    addSessions(diff.added, newConfig);
    modifySessions(diff.modified, newConfig);
    renameSessions(diff.renamed);
    config.projects = newConfig.projects;
    dependencies.applySettingsReload(newConfig);
    if (!assigned) return;
    try {
      dependencies.configStore.save((freshConfig) => { freshConfig.projects = newConfig.projects; });
    } catch (error) {
      dependencies.logger.warn(`[config] Failed to persist assigned project IDs on reload: ${error.message}`);
    }
  }

  return {
    applyConfigReload,
    cancelAutoResume,
    getProjectNameById,
    getProjectPathById,
    getSession,
    initialize,
    teardownSession,
  };
}

module.exports = {
  carryWorktreeAcrossRecreate,
  createSessionRegistry,
  reconcileSessionWorktrees,
  runAutoResume,
};
