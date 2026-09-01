import fs from 'node:fs';
import type { Server } from 'node:http';

import { pickAutoResume } from '../session/core/auto-resume.ts';
import type { Session } from '../session/sessions.ts';
import { isSameDirectoryPath } from '../shared/paths.ts';
import { STATES } from '../shared/states.ts';
import type { AgentId, RegistryProject } from './core/session-registry-core.ts';
import { diffProjects, shouldStartAfterModify } from './core/session-registry-core.ts';
import { configuredIntegrationBranch } from './core/integration-branch-core.ts';
import type { SessionWorktree, WorktreeArgs } from './git-workspace.ts';

interface RegistryConfig extends Record<string, unknown> {
  projects: RegistryProject[];
  integrationBranch?: string | null;
}

interface RegistryGitWorkspace {
  listSessionWorktrees: (input: WorktreeArgs) => SessionWorktree[];
  removeWorktreeByPath: (input: WorktreeArgs) => void;
}

interface RegistrySpawnGate {
  run: (callback: () => unknown) => Promise<unknown>;
}

interface RegistryIngestLane {
  noteRepos: () => unknown;
  detachSessionTap: (session: Session) => void;
  releaseSessionRoots: (session: Session) => void;
}

interface SessionRegistryDependencies {
  httpServer: Server;
  sessions: Map<string, Session>;
  config: RegistryConfig;
  configStore: { save: (mutator: (config: RegistryConfig) => void) => RegistryConfig | null };
  makeSession: (project: RegistryProject, config: RegistryConfig) => Session;
  wireSessionEvents: (session: Session) => void;
  closeSessionDataClients: (id: string) => void;
  notificationManager: { acknowledge: (id: string) => void };
  millMetricsPort?: { onSessionTeardown: (sessionId: string) => void } | null;
  getIngestLane: () => RegistryIngestLane | null;
  broadcastControl: (message: Record<string, unknown>) => void;
  applySettingsReload: (config: RegistryConfig) => void;
  spawnGate: RegistrySpawnGate;
  gitWorkspaceSync: RegistryGitWorkspace;
  reconcileSessionWorktrees: (input: ReconcileWorktreesOptions) => void;
  carryWorktreeAcrossRecreate: (oldSession: Session | null, newSession: Session) => unknown;
  ensureProjectIds: (projects: RegistryProject[]) => boolean;
  resolveAgentId: (agent: AgentId) => string;
  logger: Pick<Console, 'log' | 'warn'>;
}

interface ReconcileWorktreesOptions {
  projects: RegistryProject[];
  sessions: Map<string, Session>;
  gitWorkspaceSync: RegistryGitWorkspace;
  integrationBranch: string | null;
  onAdopt?: (session: Session, worktree: SessionWorktree) => void;
  worktreeDirExists?: (path: string) => boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

interface SessionRegistry {
  applyConfigReload(newConfig: RegistryConfig): void;
  cancelAutoResume(): void;
  getProjectNameById(projectId: string): string | null;
  getProjectPathById(projectId: string): string | null;
  getSession(id: string): Session | null;
  initialize(): void;
  teardownSession(id: string, logLabel: string): boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runAutoResume(
  sessions: Map<string, Session>,
  config: RegistryConfig,
  spawnGate: RegistrySpawnGate,
  logger: Pick<Console, 'warn'> = console,
): Promise<unknown[]> {
  const ids = pickAutoResume(config.projects, config);
  const runs: Promise<unknown>[] = [];
  for (const id of ids) {
    const session = sessions.get(id);
    if (!session) continue;
    runs.push(
      spawnGate.run(() => {
        if (session.state !== STATES.DORMANT) return null;
        return session.start();
      }).catch((error: unknown) => {
        logger.warn(`[boot] auto-resume failed for ${session.name}: ${errorMessage(error)}`);
      }),
    );
  }
  return Promise.all(runs);
}

function carryWorktreeAcrossRecreate(oldSession: Session | null, newSession: Session): unknown {
  const carry = oldSession?.getWorktreeCarry?.();
  if (!oldSession || !carry) return;
  if (isSameDirectoryPath(newSession.path, oldSession.path)) {
    try {
      newSession.adoptWorktree({
        worktreeDir: carry.worktreeDir,
        branch: carry.branch,
        base: carry.base,
      });
    } catch (error) {
      console.warn(`[config] worktree carry-over adopt failed for ${newSession.name}: ${errorMessage(error)}`);
    }
    return;
  }
  return Promise.resolve(oldSession._killReap)
    .catch(() => {})
    .then(() => oldSession.discardWorktreeIfClean())
    .catch(() => {});
}

function reconcileSessionWorktrees({
  projects,
  sessions,
  gitWorkspaceSync,
  integrationBranch,
  onAdopt,
  worktreeDirExists = fs.existsSync,
  log = console.log,
  warn = console.warn,
}: ReconcileWorktreesOptions): void {
  const reconciledRoots = new Set<string>();
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

function createSessionRegistry(dependencies: SessionRegistryDependencies): SessionRegistry {
  const { sessions, config } = dependencies;
  let pendingAutoResumeOnListening: (() => void) | null = null;

  function getSession(id: string): Session | null {
    return sessions.get(id) || null;
  }

  function getProjectPathById(projectId: string): string | null {
    const project = config.projects.find((candidate) => candidate.id === projectId);
    return project ? project.path : null;
  }

  function getProjectNameById(projectId: string): string | null {
    const project = config.projects.find((candidate) => candidate.id === projectId);
    return project ? project.name : null;
  }

  function noteRepos(): void {
    const ingestLane = dependencies.getIngestLane();
    if (ingestLane) void ingestLane.noteRepos();
  }

  function startAutoResume(): void {
    pendingAutoResumeOnListening = null;
    void runAutoResume(sessions, config, dependencies.spawnGate, dependencies.logger);
  }

  function scheduleAutoResume(): void {
    if (dependencies.httpServer.listening) {
      startAutoResume();
      return;
    }
    pendingAutoResumeOnListening = startAutoResume;
    dependencies.httpServer.once('listening', pendingAutoResumeOnListening);
  }

  function cancelAutoResume(): void {
    if (!pendingAutoResumeOnListening) return;
    dependencies.httpServer.off('listening', pendingAutoResumeOnListening);
    pendingAutoResumeOnListening = null;
  }

  function initialize(): void {
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
      dependencies.logger.warn(`[worktree] worktree reconcile failed: ${errorMessage(error)}`);
    }
    noteRepos();
    scheduleAutoResume();
  }

  function teardownSession(id: string, logLabel: string): boolean {
    const session = sessions.get(id);
    if (!session) return false;
    dependencies.closeSessionDataClients(id);

    dependencies.notificationManager.acknowledge(id);

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

  function addSessions(added: RegistryProject[], newConfig: RegistryConfig): void {
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

  function modifySessions(modified: RegistryProject[], newConfig: RegistryConfig): void {
    for (const project of modified) {
      const oldSession = sessions.get(project.id);
      if (!oldSession) continue;
      const wasDormant = !shouldStartAfterModify(oldSession.state);
      dependencies.closeSessionDataClients(project.id);
      dependencies.notificationManager.acknowledge(project.id);

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

  function renameSessions(renamed: RegistryProject[]): void {
    for (const project of renamed) {
      const session = sessions.get(project.id);
      if (!session) continue;
      const oldName = session.name;
      session.name = project.name;
      dependencies.broadcastControl({ type: 'session-renamed', id: project.id, oldName, newName: project.name });
      dependencies.logger.log(`[config] Renamed session: ${oldName} → ${project.name}`);
    }
  }

  function applyConfigReload(newConfig: RegistryConfig): void {
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
      dependencies.logger.warn(`[config] Failed to persist assigned project IDs on reload: ${errorMessage(error)}`);
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

export {
  carryWorktreeAcrossRecreate,
  createSessionRegistry,
  reconcileSessionWorktrees,
  runAutoResume,
};
export type {
  ReconcileWorktreesOptions,
  RegistryConfig,
  RegistryGitWorkspace,
  SessionRegistry,
  SessionRegistryDependencies,
};
