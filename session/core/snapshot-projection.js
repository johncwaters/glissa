"use strict";

/**
 * @typedef {object} SnapshotSource
 * @property {string} id
 * @property {string} name
 * @property {string} path
 * @property {string} agent
 * @property {string} state
 * @property {number} stateSince
 * @property {boolean} sleeping
 * @property {boolean} dangerouslySkipPermissions
 * @property {boolean} ephemeral
 * @property {boolean} isWorktree
 * @property {string | null} resumeSessionId
 * @property {number} activeAgents
 * @property {Array<{ name: string, version: string }>} packs
 * @property {Record<string, unknown> | null} pendingWakeup
 * @property {string | null} pendingPromptKind
 * @property {string} mergeStatus
 * @property {string | null} mergeReason
 * @property {string | null} worktreeNotice
 * @property {string | null} effectiveBase
 * @property {Array<Record<string, unknown>>} auditLog
 * @property {Record<string, unknown>} detection
 * @property {Array<Record<string, unknown>>} decisions
 */

/**
 * @param {SnapshotSource} source
 */
function projectSessionSnapshots(source) {
  const wire = {
    id: source.id,
    name: source.name,
    path: source.path,
    agent: source.agent,
    state: source.state,
    stateSince: source.stateSince,
    sleeping: source.sleeping,
    dangerouslySkipPermissions: source.dangerouslySkipPermissions,
    ephemeral: source.ephemeral,
    isWorktree: source.isWorktree,
    resumeSessionId: source.resumeSessionId,
    activeAgents: source.activeAgents,
    packs: source.packs.map(({ name, version }) => ({ name, version })),
    pendingWakeup: source.pendingWakeup,
    pendingPromptKind: source.pendingPromptKind,
    mergeStatus: source.mergeStatus,
    mergeReason: source.mergeReason,
    worktreeNotice: source.worktreeNotice,
    effectiveBase: source.effectiveBase ?? null,
    auditLog: source.auditLog.slice(-100),
  };
  const debug = {
    state: wire.state,
    transitions: wire.auditLog.slice(-5).map((entry) => ({
      from: entry.from,
      to: entry.to,
      event: entry.event,
      timestamp: entry.timestamp,
      detail: entry.detail,
    })),
    detection: source.detection,
    packs: wire.packs,
    decisions: source.decisions.slice(-15),
  };
  return { wire, debug };
}

module.exports = { projectSessionSnapshots };
