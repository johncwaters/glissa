import * as agentTracker from "./core/agent-tracker.ts";
import { decideGateRelease } from "./core/gate-release.ts";
import { mapSignalToEvent } from "./core/status-mapper.ts";
import * as wakeupTracker from "./core/wakeup-tracker.ts";
import type { WakeupMap } from "./core/wakeup-tracker.ts";
import type { TaskRegistryBreakdown } from "./core/agent-tracker.ts";
import type { SessionState } from "../shared/states.ts";
import type { HookSignal } from "../detection/hook-source.ts";
import type { ResolvedStatusSignal } from "../detection/status-source.ts";
import type { DecisionEntry } from "./core/decision-log.ts";
import type { HookPayload } from "../shared/contracts/index.ts";

interface SessionPort {
  state: () => SessionState;
  isDestroyed: () => boolean;
  emit: (event: string, detail: Record<string, unknown>) => void;
  recordDecision: (entry: DecisionEntry) => void;
  transition: (event: string, detail: Record<string, unknown>) => unknown;
  resyncWorkingLatch: () => void;
}

interface BackgroundTrackingOptions {
  detectBackgroundAgents: boolean;
  agentTtlMs: number;
  shellTaskTtlMs: number;
  teammateTaskTtlMs: number;
  gateReleaseSettleMs: number;
  detectScheduledWakeups: boolean;
  port: SessionPort;
}

interface GateHeldReady {
  source: string | null | undefined;
  signal: string;
  confidence: string;
  state: SessionState;
  ts: number;
  seq: number;
}

type PendingWakeup = {
  at: number | null;
  kind: string;
  reason: string | null;
};

interface SessionBackgroundTracking {
  applyBackgroundTasks(payload: unknown): void;
  clearBgDeclared(): void;
  trackTaskLifecycle(raw: HookSignal): void;
  trackSubagent(raw: HookSignal): void;
  activeAgentCount(): number;
  emitAgentsChange(): void;
  clearAgents(): void;
  stashGateHeldReady(signal: ResolvedStatusSignal): void;
  clearGateHeldReady(): void;
  trackWakeup(raw: HookSignal): void;
  pendingWakeup(): PendingWakeup | null;
  clearWakeups(): void;
  noteStatus(signal: string): number;
  hasOrphanStopEvidence(): boolean;
  resetTurnEvidence(): void;
  agentBreakdown(): TaskRegistryBreakdown;
  heldReady(): GateHeldReady | null;
  lastActivitySeq(): number;
  wakeups(): WakeupMap;
  isBackgroundAgentDetectionEnabled(): boolean;
}

function createSessionBackgroundTracking({
  detectBackgroundAgents,
  agentTtlMs,
  shellTaskTtlMs,
  teammateTaskTtlMs,
  gateReleaseSettleMs,
  detectScheduledWakeups,
  port,
}: BackgroundTrackingOptions): SessionBackgroundTracking {
  const tasks = agentTracker.createTaskRegistry({ agentTtlMs, shellTaskTtlMs, teammateTaskTtlMs });

  let gateHeldReady: GateHeldReady | null = null;
  let gateHeldReadyTimer: NodeJS.Timeout | null = null;

  let gateQuietSince: number | null = null;

  let signalSeq = 0;
  let lastActivitySeq = 0;

  let agentBreakdown: TaskRegistryBreakdown = { counted: 0, declared: 0, idleNames: 0, idleTasks: 0 };

  const wakeups: WakeupMap = new Map();
  let wakeupSeq = 0;

  function activeAgentCount(): number {
    if (!detectBackgroundAgents) {
      agentBreakdown = { counted: 0, declared: 0, idleNames: 0, idleTasks: 0 };
      return 0;
    }
    const active = tasks.activeCount();
    agentBreakdown = tasks.getBreakdown();
    return active;
  }

  function clearGateTimer(): void {
    if (!gateHeldReadyTimer) return;
    clearTimeout(gateHeldReadyTimer);
    gateHeldReadyTimer = null;
  }

  function clearGateHeldReady(): void {
    gateHeldReady = null;
    gateQuietSince = null;
    clearGateTimer();
  }

  function armGateTimer(ms: number): void {
    clearGateTimer();
    gateHeldReadyTimer = setTimeout(() => {
      gateHeldReadyTimer = null;
      evaluateGateHeldReady();
    }, ms);
    if (typeof gateHeldReadyTimer.unref === "function") gateHeldReadyTimer.unref();
  }

  function gateRecheckMs(now: number): number {
    const fullInterval = Math.min(agentTtlMs, shellTaskTtlMs, teammateTaskTtlMs) + 50;
    const remaining = tasks.msUntilNextDrain(now);
    if (remaining === null) return fullInterval;
    return Math.min(remaining + 50, fullInterval);
  }

  function evaluateGateHeldReady(): void {
    const held = gateHeldReady;
    if (!held || port.isDestroyed()) return;
    const now = Date.now();
    const activeAgents = activeAgentCount();

    if (activeAgents === 0 && gateQuietSince === null) gateQuietSince = now;
    const { decision, waitMs } = decideGateRelease({
      heldState: held.state,
      currentState: port.state(),
      activeAgents,
      stashSeq: held.seq,
      lastActivitySeq,
      stashTs: held.ts,
      quietSince: gateQuietSince || 0,
      now,
      settleMs: gateReleaseSettleMs,
    });

    port.recordDecision({
      ts: now,
      kind: "gate",
      decision,
      waitMs,
      active: activeAgents,
      heldSeq: held.seq,
      lastActivitySeq,
      quietMs: now - held.ts,
    });
    if (decision === "cancel") {
      clearGateHeldReady();
      return;
    }
    if (decision === "gated") {
      gateQuietSince = null;
      armGateTimer(gateRecheckMs(now));
      return;
    }
    if (decision === "wait") {
      armGateTimer(waitMs);
      return;
    }
    const event = mapSignalToEvent(held.signal, port.state(), held.confidence, 0);
    clearGateHeldReady();
    if (event) port.transition(event, { source: held.source, signal: held.signal, deferred: true });
  }

  function emitAgentsChange(): void {
    port.emit("agents-change", { activeAgents: activeAgentCount() });
    evaluateGateHeldReady();
  }

  function withAgentCount(mutate: () => void): void {
    const before = activeAgentCount();
    mutate();
    if (activeAgentCount() !== before) emitAgentsChange();
  }

  function applyBackgroundTasks(payload: unknown): void {
    if (!detectBackgroundAgents) return;
    const entries = agentTracker.extractBackgroundTasks(payload);
    if (entries === null) return;
    withAgentCount(() => tasks.reconcileDeclared(entries));
  }

  function clearBgDeclared(): void {
    if (!tasks.hasDeclared()) return;
    withAgentCount(() => tasks.clearDeclared());
  }

  function trackTaskLifecycle(raw: HookSignal): void {
    if (!detectBackgroundAgents) return;
    withAgentCount(() => applyTaskLifecycle(raw));
  }

  function applyTaskLifecycle(raw: HookSignal): void {
    const payload: HookPayload = raw.payload || {};
    const taskId = typeof payload.task_id === "string" && payload.task_id ? payload.task_id : null;
    const name = typeof payload.teammate_name === "string" ? payload.teammate_name : "";
    if (raw.signal === "task-created") {
      clearGateHeldReady();
      tasks.noteTaskCreated({ taskId, name });
      return;
    }
    if (raw.signal === "task-completed") {
      tasks.noteTaskCompleted({ taskId, name });
      return;
    }

    if (!name) return;
    tasks.noteTeammateIdle(name, Date.now());
  }

  function trackSubagent(raw: HookSignal): void {
    if (!detectBackgroundAgents) return;
    const declaredAgentId = raw.payload?.agent_id;
    const agentId = typeof declaredAgentId === "string" ? declaredAgentId : null;
    if (raw.signal === "subagent-start") {
      clearGateHeldReady();

      if (typeof agentId === "string") {
        withAgentCount(() => tasks.regateByAgentId(agentId));
      }
    }
    if (agentId && raw.signal === "subagent-start") {
      const changed = tasks.noteAgentStart(agentId, raw.ts || Date.now());
      if (changed) emitAgentsChange();
    }
    if (agentId && raw.signal === "subagent-stop") {
      if (gateHeldReady) {
        gateQuietSince = null;
        evaluateGateHeldReady();
      }
      const changed = tasks.noteAgentStop(agentId);
      if (changed) emitAgentsChange();
    }

    if (raw.signal === "subagent-stop") applyBackgroundTasks(raw.payload);
  }

  function stashGateHeldReady(signal: ResolvedStatusSignal): void {
    const now = Date.now();
    gateHeldReady = {
      source: signal.source,
      signal: signal.signal,
      confidence: signal.confidence,
      state: port.state(),
      ts: now,
      seq: signalSeq,
    };

    gateQuietSince = null;
    port.resyncWorkingLatch();
    evaluateGateHeldReady();
  }

  function clearAgents(): void {
    const had = activeAgentCount() > 0;
    tasks.clear();
    if (had) emitAgentsChange();
  }

  function trackWakeup(raw: HookSignal): void {
    if (!detectScheduledWakeups) return;
    const payload: HookPayload = raw.payload || {};
    const ts = raw.ts || Date.now();
    if (raw.signal === "wakeup-scheduled") {
      const toolInput = payload.tool_input;
      const input: Record<string, unknown> = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
        ? (toolInput as Record<string, unknown>)
        : {};
      const delaySec = Number(input.delaySeconds);
      if (!Number.isFinite(delaySec) || delaySec <= 0) return;
      const key = `w${++wakeupSeq}`;
      const reason = typeof input.reason === "string" && input.reason ? input.reason : null;
      if (wakeupTracker.addWakeup(wakeups, key, { kind: "wakeup", fireAt: ts + delaySec * 1000, reason, ts })) {
        emitWakeupChange();
      }
      return;
    }
    if (raw.signal === "cron-created") {
      const key = wakeupTracker.extractCronTaskId(payload) || `c${++wakeupSeq}`;
      if (wakeupTracker.addWakeup(wakeups, key, { kind: "cron", fireAt: null, reason: null, ts })) {
        emitWakeupChange();
      }
      return;
    }

    const key = wakeupTracker.extractCronTaskId(payload);
    if (!key) return;
    if (wakeupTracker.removeWakeup(wakeups, key)) emitWakeupChange();
  }

  function pendingWakeup(): PendingWakeup | null {
    if (!detectScheduledWakeups) return null;
    wakeupTracker.pruneWakeups(wakeups, Date.now());
    const entry = wakeupTracker.earliestWakeup(wakeups);
    if (!entry) return null;
    return { at: entry.fireAt, kind: entry.kind, reason: entry.reason };
  }

  function emitWakeupChange(): void {
    port.emit("wakeup-change", { pendingWakeup: pendingWakeup() });
  }

  function clearWakeups(): void {
    if (wakeups.size === 0) return;
    wakeups.clear();
    emitWakeupChange();
  }

  function noteStatus(signal: string): number {
    signalSeq += 1;
    if (signal !== "ready") lastActivitySeq = signalSeq;
    return signalSeq;
  }

  return {
    applyBackgroundTasks,
    clearBgDeclared,
    trackTaskLifecycle,
    trackSubagent,
    activeAgentCount,
    emitAgentsChange,
    clearAgents,
    stashGateHeldReady,
    clearGateHeldReady,
    trackWakeup,
    pendingWakeup,
    clearWakeups,
    noteStatus,
    hasOrphanStopEvidence: () => tasks.hasOrphanStopEvidence(),
    resetTurnEvidence: () => tasks.resetTurnEvidence(),
    agentBreakdown: () => agentBreakdown,
    heldReady: () => gateHeldReady,
    lastActivitySeq: () => lastActivitySeq,
    wakeups: () => wakeups,
    isBackgroundAgentDetectionEnabled: () => detectBackgroundAgents,
  };
}

export { createSessionBackgroundTracking };
export type { BackgroundTrackingOptions, GateHeldReady, PendingWakeup, SessionBackgroundTracking, SessionPort };
