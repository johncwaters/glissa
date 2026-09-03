import type { ProjectConfig } from '../../shared/contracts/config.ts';
import type { SessionState } from '../../shared/states.ts';
import { STATES } from '../../shared/states.ts';

export type AgentId = ProjectConfig['agent'];

export interface RegistryProject {
  [key: string]: unknown;
  id: string;
  name: string;
  path: string;
  agent?: AgentId;
  packs?: unknown;
  codexBypassHookTrust?: boolean;
  dangerouslySkipPermissions?: boolean;
}

export interface RegistrySession {
  ephemeral?: boolean;
  name?: string;
  path?: string;
  agentId?: string;
  dangerouslySkipPermissions?: boolean;
  bypassHookTrust?: boolean;
}

export interface RegistryDependencies {
  ensureProjectIds: (projects: RegistryProject[]) => unknown;
  resolveAgentId: (agent: AgentId) => string;
}

function projectSkipsPermissions(project: RegistryProject): boolean {
  return project.dangerouslySkipPermissions !== false;
}

function decideWasActiveFlip(to: SessionState, event: string, pendingRestart: boolean): boolean | null {
  if (to === STATES.STARTING || to === STATES.RUNNING) return true;
  if (!pendingRestart && (event === 'user_kill' || to === STATES.DONE || to === STATES.FAILED)) return false;
  return null;
}

function shouldStartAfterModify(previousState: string): boolean {
  return previousState !== STATES.DORMANT;
}

function diffProjects(
  currentSessions: Map<string, RegistrySession>,
  newProjects: RegistryProject[],
  dependencies: RegistryDependencies,
) {
  dependencies.ensureProjectIds(newProjects);
  const newProjectsById = new Map<string, RegistryProject>(newProjects.map((project) => [project.id, project]));
  const added: RegistryProject[] = [];
  const removed: string[] = [];
  const modified: RegistryProject[] = [];
  const renamed: RegistryProject[] = [];
  const unchanged: string[] = [];

  for (const [id, session] of currentSessions) {
    if (session.ephemeral) continue;
    if (!newProjectsById.has(id)) {
      removed.push(id);
      continue;
    }
    const project = newProjectsById.get(id);
    if (!project) continue;
    const pathChanged = project.path !== session.path;
    const permissionsChanged = projectSkipsPermissions(project) !== session.dangerouslySkipPermissions;
    const agentChanged = dependencies.resolveAgentId(project.agent) !== session.agentId;
    const hookTrustChanged = (project.codexBypassHookTrust === true) !== session.bypassHookTrust;
    if (pathChanged || permissionsChanged || agentChanged || hookTrustChanged) {
      modified.push(project);
      continue;
    }
    if (project.name !== session.name) {
      renamed.push(project);
      continue;
    }
    unchanged.push(id);
  }
  for (const [id, project] of newProjectsById) {
    if (!currentSessions.has(id)) added.push(project);
  }
  return { added, removed, modified, renamed, unchanged };
}

export { decideWasActiveFlip, diffProjects, projectSkipsPermissions, shouldStartAfterModify };
