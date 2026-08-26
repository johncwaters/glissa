"use strict";

const { pushDecision } = require("./core/decision-log");
const { DEFAULT_AGENT_ID } = require("./adapters");

const AUDIT_LOG_MAX = 200;

/**
 * @typedef {{ writeDecision?: (entry: Record<string, unknown>) => void }} DecisionRecorder
 */

/**
 * @param {{ agentId: string, getRecorder: () => DecisionRecorder | null }} options
 */
function createSessionObservability({ agentId, getRecorder }) {
  const auditLog = [];
  const decisions = [];

  /** @param {Record<string, unknown>} entry */
  function pushAuditEntry(entry) {
    auditLog.push(entry);
    if (auditLog.length <= AUDIT_LOG_MAX) return;
    auditLog.splice(0, auditLog.length - AUDIT_LOG_MAX);
  }

  /** @param {Record<string, unknown>} entry */
  function recordDecision(entry) {
    const stamped = agentId === DEFAULT_AGENT_ID ? entry : { ...entry, agent: agentId };
    const outcome = pushDecision(decisions, stamped);
    const recorder = getRecorder();
    if (outcome !== "appended" || !recorder?.writeDecision) return;
    recorder.writeDecision(stamped);
  }

  /** @param {number} count */
  function auditTail(count) {
    return auditLog.slice(-count);
  }

  /** @param {number} count */
  function decisionTail(count) {
    return decisions.slice(-count);
  }

  return {
    auditLog,
    pushAuditEntry,
    recordDecision,
    auditTail,
    decisionTail,
  };
}

module.exports = { createSessionObservability, AUDIT_LOG_MAX };
