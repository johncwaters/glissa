'use strict';

const { STATES } = require('../../shared/states.ts');
const { normalizePackNames } = require('./pack-core.ts');

/**
 * Agent id a project may name, derived from config schema so the two cannot drift.
 * @typedef {import('zod').infer<typeof import('../../shared/contracts/config').ProjectConfig>['agent']} AgentId
 */

/**
 * @typedef {object} RegistryProject
 * @property {string} id
 * @property {string} name
 * @property {string} path
 * @property {AgentId} [agent]
 * @property {unknown} [packs]
 * @property {boolean} [codexBypassHookTrust]
 * @property {boolean} [dangerouslySkipPermissions]
 */

/** @param {RegistryProject} project */
function projectSkipsPermissions(project) {
  return project.dangerouslySkipPermissions !== false;
}

function decideWasActiveFlip(to, event, pendingRestart) {
  if (to === STATES.STARTING || to === STATES.RUNNING) return true;
  if (!pendingRestart && (event === 'user_kill' || to === STATES.DONE || to === STATES.FAILED)) return false;
  return null;
}

function shouldStartAfterModify(previousState) {
  return previousState !== STATES.DORMANT;
}

/**
 * @param {Map<string, any>} currentSessions
 * @param {RegistryProject[]} newProjects
 * @param {{ ensureProjectIds: (projects: RegistryProject[]) => unknown, resolveAgentId: (agent: AgentId) => string }} dependencies
 */
function diffProjects(currentSessions, newProjects, dependencies) {
  dependencies.ensureProjectIds(newProjects);
  const newProjectsById = new Map(newProjects.map((project) => [project.id, project]));
  const added = [];
  const removed = [];
  const modified = [];
  const renamed = [];
  const unchanged = [];

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
    const packsChanged = JSON.stringify(normalizePackNames(project.packs).names) !== JSON.stringify(session.packNames);
    const agentChanged = dependencies.resolveAgentId(project.agent) !== session.agentId;
    const hookTrustChanged = (project.codexBypassHookTrust === true) !== session.bypassHookTrust;
    if (pathChanged || permissionsChanged || packsChanged || agentChanged || hookTrustChanged) {
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

module.exports = {
  decideWasActiveFlip,
  diffProjects,
  projectSkipsPermissions,
  shouldStartAfterModify,
};
