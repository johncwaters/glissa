import { pushDecision } from "./core/decision-log.ts";
import type { DecisionEntry } from "./core/decision-log.ts";
import { DEFAULT_AGENT_ID } from "./adapters/index.ts";

const AUDIT_LOG_MAX = 200;

interface DecisionRecorder {
  writeDecision?: (entry: DecisionEntry) => void;
}

interface SessionObservabilityOptions {
  agentId: string;
  getRecorder: () => DecisionRecorder | null;
}

interface SessionObservability {
  auditLog: Record<string, unknown>[];
  pushAuditEntry(entry: Record<string, unknown>): void;
  recordDecision(entry: DecisionEntry): void;
  auditTail(count: number): Record<string, unknown>[];
  decisionTail(count: number): DecisionEntry[];
}

function createSessionObservability({ agentId, getRecorder }: SessionObservabilityOptions): SessionObservability {
  const auditLog: Record<string, unknown>[] = [];
  const decisions: DecisionEntry[] = [];

  function pushAuditEntry(entry: Record<string, unknown>): void {
    auditLog.push(entry);
    if (auditLog.length <= AUDIT_LOG_MAX) return;
    auditLog.splice(0, auditLog.length - AUDIT_LOG_MAX);
  }

  function recordDecision(entry: DecisionEntry): void {
    const stamped = agentId === DEFAULT_AGENT_ID ? entry : { ...entry, agent: agentId };
    const outcome = pushDecision(decisions, stamped);
    const recorder = getRecorder();
    if (outcome !== "appended" || !recorder?.writeDecision) return;
    recorder.writeDecision(stamped);
  }

  function auditTail(count: number): Record<string, unknown>[] {
    return auditLog.slice(-count);
  }

  function decisionTail(count: number): DecisionEntry[] {
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

export { createSessionObservability, AUDIT_LOG_MAX };
export type { DecisionRecorder, SessionObservability, SessionObservabilityOptions };
