"use strict";

const agentTracker = require("./core/agent-tracker.ts");
const { decideGateRelease } = require("./core/gate-release.ts");
const { mapSignalToEvent } = require("./core/status-mapper.ts");
const wakeupTracker = require("./core/wakeup-tracker.ts");

/**
 * @typedef {{ state: () => import('../shared/states').SessionState, isDestroyed: () => boolean, emit: (event: string, detail: Record<string, unknown>) => void, recordDecision: (entry: Record<string, unknown>) => void, transition: (event: string, detail: Record<string, unknown>) => unknown, resyncWorkingLatch: () => void }} SessionPort
 * @typedef {{ detectBackgroundAgents: boolean, agentTtlMs: number, shellTaskTtlMs: number, teammateTaskTtlMs: number, gateReleaseSettleMs: number, detectScheduledWakeups: boolean, port: SessionPort }} BackgroundTrackingOptions
 * @typedef {{ source: string, signal: string, confidence?: string, state: import('../shared/states').SessionState, ts: number, seq: number }} GateHeldReady
 */

/** @param {BackgroundTrackingOptions} options */
function createSessionBackgroundTracking({
  detectBackgroundAgents,
  agentTtlMs,
  shellTaskTtlMs,
  teammateTaskTtlMs,
  gateReleaseSettleMs,
  detectScheduledWakeups,
  port,
}) {
  /*
   * ONE registry for every store behind "is background work still running": the counted
   * SubagentStart/Stop ids, the authoritative background_tasks declaration and its age, the task
   * ids settled by TaskCompleted, the teammates idle by name, and the last snapshot's teammate ids.
   * They are one logical registry reconciled from several signal families that each see a different
   * slice of the same truth (the 2026-08 review counted them as five separate ledgers driving five
   * expiry rules off three TTLs), so session/core/agent-tracker.js owns them together, applies every
   * TTL in one reaper, and answers max(counted, declared) as a query.
   */
  const tasks = agentTracker.createTaskRegistry({ agentTtlMs, shellTaskTtlMs, teammateTaskTtlMs });
  // A main-agent `ready` suppressed by the activeAgents gate, held so the card can still
  // complete when the background count later drains WITHOUT another Stop (idle teammate
  // declared in background_tasks, dropped SubagentStop bounded only by the TTL). Without
  // this latch the suppressed ready is gone forever and the card pins WORKING until some
  // new signal happens to arrive. Cleared by any newer activity (working/resume/
  // awaiting-input), any state change since the stash, /clear, and PTY exit/(re)start.
  // Released in evaluateGateHeldReady, which re-validates the hold against live evidence
  // (session/core/gate-release.js) instead of trusting a drained count alone.
  /** @type {GateHeldReady | null} */
  let gateHeldReady = null;
  /** @type {NodeJS.Timeout | null} */
  let gateHeldReadyTimer = null;
  // When the hold was first observed free of background work, or null while it is still gating.
  // Evaluations are event/TTL driven, so the first look that SEES the drain is what starts the
  // settle window: carrying a timestamp from the last still-gated look released a held ready
  // instantly at the drain, before the mailbox wake could disprove it (false COMPLETE, 2026-08-14).
  /** @type {number | null} */
  let gateQuietSince = null;
  // Arrival order of the signals reaching _onStatus, and the sequence number of the last
  // non-ready (activity) one. A hold stashed BEFORE that activity is stale: the main agent
  // opened a new turn, so it must never complete the card (incident 2026-07-30; see
  // session/core/gate-release.js). Sequence rather than clock: signals share milliseconds.
  let signalSeq = 0;
  let lastActivitySeq = 0;
  // Components behind the last activeAgentCount() result, so a trace entry can say WHICH source
  // gated a ready (counted sub-agents vs a declared background_tasks snapshot) instead of a total.
  let agentBreakdown = { counted: 0, declared: 0, idleNames: 0, idleTasks: 0 };
  // Pending scheduled revivals, keyed by cron task id or a synthetic one-shot key. Advisory
  // only (see trackWakeup); lazily pruned (fireAt + grace / cron TTL); never a transition.
  const wakeups = new Map();
  let wakeupSeq = 0;

  // Pruned count of live background sub-agents. Lazy prune (no per-session timer) bounds a dropped
  // SubagentStop. Returns 0 when detection is off so the gate is inert.
  function activeAgentCount() {
    if (!detectBackgroundAgents) {
      agentBreakdown = { counted: 0, declared: 0, idleNames: 0, idleTasks: 0 };
      return 0;
    }
    const active = tasks.activeCount();
    agentBreakdown = tasks.getBreakdown();
    return active;
  }

  function clearGateTimer() {
    if (!gateHeldReadyTimer) return;
    clearTimeout(gateHeldReadyTimer);
    gateHeldReadyTimer = null;
  }

  function clearGateHeldReady() {
    gateHeldReady = null;
    gateQuietSince = null;
    clearGateTimer();
  }

  function armGateTimer(ms) {
    clearGateTimer();
    gateHeldReadyTimer = setTimeout(() => {
      gateHeldReadyTimer = null;
      evaluateGateHeldReady();
    }, ms);
    if (typeof gateHeldReadyTimer.unref === "function") gateHeldReadyTimer.unref();
  }

  // How long a still-gated hold should wait before re-checking. The TTLs it waits on age from
  // their own timestamps (the declaring Stop, each SubagentStart), so a full interval measured
  // from now bounded the stuck-WORKING window at up to 2x the TTL: a snapshot 60s into its 90s
  // teammate TTL got a fresh 90s. Capped by the old full interval so this can only ever shorten
  // the wait; msUntilNextDrain returns strictly positive values, so no floor is needed.
  function gateRecheckMs(now) {
    const fullInterval = Math.min(agentTtlMs, shellTaskTtlMs, teammateTaskTtlMs) + 50;
    const remaining = tasks.msUntilNextDrain(now);
    if (remaining === null) return fullInterval;
    return Math.min(remaining + 50, fullInterval);
  }

  // Re-validate the held ready and act on the verdict. Runs whenever the background count changes
  // (a drain) and whenever the timer re-checks; the timer covers the TTL-only drain, where no
  // further hook ever arrives and only the lazy prune in activeAgentCount moves the count.
  function evaluateGateHeldReady() {
    const held = gateHeldReady;
    if (!held || port.isDestroyed()) return;
    const now = Date.now();
    const activeAgents = activeAgentCount();
    // First look that sees the drain: the settle window runs from HERE, never from an earlier look.
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
    // Recorded before acting, so a cancel/release leaves its evidence even though the branches
    // below drop the hold the entry describes.
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
      // Still gating, so no quiet window has started yet; the look that sees the drain starts it.
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

  function emitAgentsChange() {
    // Internal event; the backend listener already has the session (id/name), so carry only the count.
    port.emit("agents-change", { activeAgents: activeAgentCount() });
    evaluateGateHeldReady();
  }

  // Run one piece of background-work bookkeeping and emit a single 'agents-change' delta only if
  // the live count actually moved. Every mutator of the counted map, the declared snapshot and the
  // idle sets goes through here, so the emit rule lives in one place.
  function withAgentCount(mutate) {
    const before = activeAgentCount();
    mutate();
    if (activeAgentCount() !== before) emitAgentsChange();
  }

  // Reconcile against an authoritative `background_tasks` payload array. A declaration of
  // 0 running entries also drains the counted id map (bounds a dropped SubagentStop
  // immediately instead of waiting for the TTL prune). The idle set is pruned to ids still
  // declared: an id gone from Claude's registry no longer needs remembering. Absent field
  // (older Claude) changes nothing.
  function applyBackgroundTasks(payload) {
    if (!detectBackgroundAgents) return;
    const entries = agentTracker.extractBackgroundTasks(payload);
    if (entries === null) return;
    withAgentCount(() => tasks.reconcileDeclared(entries));
  }

  function clearBgDeclared() {
    if (!tasks.hasDeclared()) return;
    withAgentCount(() => tasks.clearDeclared());
  }

  // Apply one TaskCreated/TaskCompleted/TeammateIdle signal to the idle bookkeeping.
  // Never a transition; a drain can release a gate-held ready via emitAgentsChange.
  function trackTaskLifecycle(raw) {
    if (!detectBackgroundAgents) return;
    withAgentCount(() => applyTaskLifecycle(raw));
  }

  function applyTaskLifecycle(raw) {
    const payload = raw.payload || {};
    const taskId = typeof payload.task_id === "string" && payload.task_id ? payload.task_id : null;
    const name = typeof payload.teammate_name === "string" ? payload.teammate_name : "";
    if (raw.signal === "task-created") {
      // New background work: like subagent-start, it invalidates a held ready, and a
      // reactivated teammate (new task) must gate again.
      clearGateHeldReady();
      tasks.noteTaskCreated({ taskId, name });
      return;
    }
    if (raw.signal === "task-completed") {
      tasks.noteTaskCompleted({ taskId, name });
      return;
    }
    // teammate-idle: name only, no task_id, and a declared entry can NOT be matched to a name
    // (its `description` is the spawn prompt, live-verified), so the idle is recorded BY NAME and
    // subtracted from the declared teammate count, letting several simultaneous idle teammates each
    // drain the gate by one. A nameless payload can never be re-gated (no a<name>- prefix match), so
    // recording it would be a pure false-drain vector with no way back; ground truth says the payload
    // always carries teammate_name, so drop it rather than guess a synthetic key.
    if (!name) return;
    tasks.noteTeammateIdle(name, Date.now());
  }

  // Apply one subagent-start/stop signal to the live set. Off (kill switch) or a payload with no
  // agent_id is ignored, so the count stays 0 and behavior is exactly as before. Emits an
  // 'agents-change' delta only when the live count actually changed.
  function trackSubagent(raw) {
    if (!detectBackgroundAgents) return;
    const agentId = raw.payload?.agent_id;
    if (raw.signal === "subagent-start") {
      // Fresh background work is newer activity: a held ready from before it must not release
      // when only the OLDER ids drain (subagent-start never reaches _onStatus's clearing path).
      clearGateHeldReady();
      // Teammate agent_ids embed the spawn name (live-captured: "a<name>-<hex>"). This is the
      // only re-gating signal for a teammate the lead wakes via mailbox: no TaskCreated ever
      // fires for a named-agent teammate (memory: named-agent-teammate-hook-sequence).
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
    // SubagentStop also carries `background_tasks` (v2.1.145+): reconcile even when the
    // id was missing/unknown, so a drain is authoritative rather than TTL-bounded.
    if (raw.signal === "subagent-stop") applyBackgroundTasks(raw.payload);
  }

  // Hold a main-agent ready that only the background-agent gate suppressed;
  // decideGateRelease (session/core/gate-release.js) decides whether it may ever fire.
  // The latch re-open makes "activity since the stash" observable at all, since the
  // edge-triggered title source would otherwise never re-report a still-spinning title
  // (full rationale: AGENTS.md, Background sub-agents / completion gate).
  function stashGateHeldReady(signal) {
    const now = Date.now();
    gateHeldReady = {
      source: signal.source,
      signal: signal.signal,
      confidence: signal.confidence,
      state: port.state(),
      ts: now,
      seq: signalSeq,
    };
    // Each hold's settle tracking starts clean; the first evaluation below observes the real count.
    gateQuietSince = null;
    port.resyncWorkingLatch();
    evaluateGateHeldReady();
  }

  // Drop all live ids + the declared snapshot + the task-lifecycle bookkeeping (PTY exit,
  // (re)start). Emits a clearing delta only if something was live.
  function clearAgents() {
    const had = activeAgentCount() > 0;
    tasks.clear();
    if (had) emitAgentsChange();
  }

  // Apply one scheduled-revival signal to the pending-wakeup set. ADVISORY metadata only: a Stop
  // with a pending wakeup IS a finished turn, so unlike activeAgents this NEVER gates a transition.
  // Cancellation is invisible (Esc fires no hook, claude-code#58235), so entries are self-expiring
  // via the lazy prune in pendingWakeup. Payload field names are extracted defensively; the exact
  // shapes are an open probe item (plan WS2 step 0) and a miss simply drops the signal.
  function trackWakeup(raw) {
    if (!detectScheduledWakeups) return;
    const payload = raw.payload || {};
    const ts = raw.ts || Date.now();
    if (raw.signal === "wakeup-scheduled") {
      const input = payload.tool_input || {};
      const delaySec = Number(input.delaySeconds);
      if (!Number.isFinite(delaySec) || delaySec <= 0) return;
      const key = `w${++wakeupSeq}`; // collision-free synthetic key (one-shot, never re-referenced)
      const reason = typeof input.reason === "string" && input.reason ? input.reason : null;
      if (wakeupTracker.addWakeup(wakeups, key, { kind: "wakeup", fireAt: ts + delaySec * 1000, reason, ts })) {
        emitWakeupChange();
      }
      return;
    }
    if (raw.signal === "cron-created") {
      // No cron-expression parsing in v1: tracked without a fire time, bounded by the cron TTL.
      // A synthetic-key fallback entry (id fields not yet pinned, plan WS2 step 0) can never be
      // matched by its CronDelete; it is TTL/PTY-exit bound only. Advisory chip, acceptable.
      const key = wakeupTracker.extractCronTaskId(payload) || `c${++wakeupSeq}`;
      if (wakeupTracker.addWakeup(wakeups, key, { kind: "cron", fireAt: null, reason: null, ts })) {
        emitWakeupChange();
      }
      return;
    }
    // cron-deleted
    const key = wakeupTracker.extractCronTaskId(payload);
    if (!key) return;
    if (wakeupTracker.removeWakeup(wakeups, key)) emitWakeupChange();
  }

  // Pruned earliest pending revival, or null. Returns null when detection is off.
  function pendingWakeup() {
    if (!detectScheduledWakeups) return null;
    wakeupTracker.pruneWakeups(wakeups, Date.now());
    const entry = wakeupTracker.earliestWakeup(wakeups);
    if (!entry) return null;
    return { at: entry.fireAt, kind: entry.kind, reason: entry.reason };
  }

  function emitWakeupChange() {
    port.emit("wakeup-change", { pendingWakeup: pendingWakeup() });
  }

  // Drop all pending revivals (PTY exit, (re)start): scheduled tasks are session-scoped and die
  // with the PTY. Emits a clearing delta only if something was pending.
  function clearWakeups() {
    if (wakeups.size === 0) return;
    wakeups.clear();
    emitWakeupChange();
  }

  function noteStatus(signal) {
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

module.exports = { createSessionBackgroundTracking };
