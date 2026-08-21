/*
 * Ingest lane IO shell (docs/plan-ingestion.md, M6), navigator-shaped: constructed only when
 * config.ingest.enabled is true, `broadcast` injected, one connect-time snapshot repairing any client,
 * and a stop() that cancels every timer and detaches every tap.
 *
 * publish() NEVER broadcasts. Wire amplification is the failure mode this lane exists to avoid, so
 * activity deltas batch on a 1s interval into at most one frame carrying at most 50 events, and the
 * overflow inside an interval collapses to a count. A client that misses frames is repaired by the
 * snapshot, which is also why the deltas are deliberately absent from REPLAYABLE_EXACT.
 */

'use strict';

const {
  DEFAULT_DIGEST_BUDGET_CHARS, buildContextDigest, createIngestStore, enabledSourceNames, publishEvent,
  resolveIngestConfig, ringStats, snapshotEvents,
} = require('./core/ingest-core');
const { createAgentLogIngest } = require('./ingest-agent-logs');
const { createTerminalIngest } = require('./ingest-terminal');

const BATCH_INTERVAL_MS = 1000;
const MAX_EVENTS_PER_FRAME = 50;
const SNAPSHOT_EVENT_LIMIT = 100;

function createIngestLane({
  config = null,
  broadcast = null,
  logger = console,
  laneMap = null,
  agentLogOptions = null,
  nowFn = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  batchIntervalMs = BATCH_INTERVAL_MS,
  maxEventsPerFrame = MAX_EVENTS_PER_FRAME,
  snapshotEventLimit = SNAPSHOT_EVENT_LIMIT,
} = {}) {
  const resolved = config?.sources ? config : resolveIngestConfig(config);
  const store = createIngestStore(resolved);
  const sources = enabledSourceNames(resolved);
  // Events published since the last frame went out. Bounded by the batch flush, never by this array.
  let pendingEvents = [];
  let stopped = false;

  function warn(message) {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`[ingest] ${message}`);
  }

  function emit(message) {
    if (typeof broadcast !== 'function') return;
    try {
      broadcast(message);
    } catch (error) {
      warn(`broadcast failed: ${error.message}`);
    }
  }

  /**
   * One frame per interval at most. The NEWEST events survive an overflow, because the feed reads
   * newest-first and a count is a better answer than a stale page: everything the count stands for is
   * still in the rings and still reaches the digest and the next snapshot.
   */
  function flushBatch() {
    if (pendingEvents.length === 0) return null;
    const batched = pendingEvents;
    pendingEvents = [];
    const newestFirst = [...batched].sort((left, right) => right.seq - left.seq);
    const events = newestFirst.slice(0, maxEventsPerFrame);
    const message = {
      type: 'ingest-activity',
      events,
      overflow: Math.max(0, newestFirst.length - events.length),
      ts: nowFn(),
    };
    emit(message);
    return message;
  }

  let batchTimer = setIntervalFn(flushBatch, batchIntervalMs);
  if (batchTimer && typeof batchTimer.unref === 'function') batchTimer.unref();

  /**
   * The one write path every adapter calls. Normalization, the publish-time scrub, seq stamping and
   * ring eviction all happen in the pure core; this only queues the stored event for the next frame.
   */
  function publish(raw) {
    if (stopped) return null;
    const event = publishEvent(store, raw, nowFn());
    if (!event) return null;
    pendingEvents.push(event);
    return event;
  }

  // Connect-time repair, the plan-limits precedent: one current-state frame, not a replay of deltas.
  function snapshotMessage() {
    return {
      type: 'ingest-snapshot',
      events: snapshotEvents(store, { limit: snapshotEventLimit }),
      sources,
      ts: nowFn(),
    };
  }

  // Synchronous by contract: the navigator builds this exactly once per dispatch, and a digest that
  // awaited between ring reads could describe two different moments.
  function buildDigest({ scopes = null, budgetChars = DEFAULT_DIGEST_BUDGET_CHARS, now = null } = {}) {
    return buildContextDigest(store, { scopes, budgetChars, now: now == null ? nowFn() : now });
  }

  const adapters = [];
  const terminalEnabled = resolved.enabled === true && resolved.sources.terminal.enabled === true;
  const terminal = terminalEnabled
    ? createTerminalIngest({
      publish,
      sourceConfig: resolved.sources.terminal,
      logger,
      nowFn,
      setTimeoutFn,
      clearTimeoutFn,
    })
    : null;
  if (terminal) adapters.push(terminal);

  const agentLogsEnabled = resolved.enabled === true && resolved.sources.agentLogs.enabled === true;
  const agentLogs = agentLogsEnabled
    ? createAgentLogIngest({
      publish,
      sourceConfig: resolved.sources.agentLogs,
      // The feedback-loop exclusion: without it a navigator dispatch's own transcript rides into the
      // next navigator prompt. See the mechanism note in ingest-agent-logs.js.
      laneMap,
      logger,
      nowFn,
      setIntervalFn,
      clearIntervalFn,
      setTimeoutFn,
      clearTimeoutFn,
      ...(agentLogOptions || {}),
    })
    : null;
  if (agentLogs) adapters.push(agentLogs);

  // Adapters that own their own discovery start themselves; the terminal source has nothing to start,
  // since its taps arrive one session at a time from wireSessionEvents.
  for (const adapter of adapters) {
    if (typeof adapter.start !== 'function') continue;
    try {
      void adapter.start();
    } catch (error) {
      warn(`starting the ${adapter.name} source failed: ${error.message}`);
    }
  }

  // A no-op when the terminal source is off, so a caller never has to ask twice before wiring a session.
  function attachSessionTap(sess) {
    if (stopped || !terminal) return null;
    return terminal.attachSessionTap(sess);
  }

  // The other half, for a session being torn down for good rather than restarted or recreated.
  function detachSessionTap(sess) {
    if (!terminal) return false;
    return terminal.detachSessionTap(sess);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (batchTimer) clearIntervalFn(batchTimer);
    batchTimer = null;
    pendingEvents = [];
    for (const adapter of adapters) {
      try {
        adapter.stop();
      } catch (error) {
        warn(`stopping the ${adapter.name} source failed: ${error.message}`);
      }
    }
  }

  return {
    publish,
    snapshotMessage,
    buildDigest,
    attachSessionTap,
    detachSessionTap,
    flushBatch,
    stop,
    sources,
    ringStats: () => ringStats(store),
    recentEvents: (limit = snapshotEventLimit) => snapshotEvents(store, { limit }),
    get agentLogs() { return agentLogs; },
    get agentLogsEnabled() { return agentLogsEnabled; },
    get terminalEnabled() { return terminalEnabled; },
    get tapCount() { return terminal ? terminal.tapCount : 0; },
    get pendingEventCount() { return pendingEvents.length; },
    get isStopped() { return stopped; },
  };
}

module.exports = {
  BATCH_INTERVAL_MS,
  MAX_EVENTS_PER_FRAME,
  SNAPSHOT_EVENT_LIMIT,
  createIngestLane,
};
