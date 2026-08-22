/*
 * Ingest lane IO shell (docs/plan-ingestion.md, M6), visions-shaped: constructed only when
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
  DEFAULT_DIGEST_BUDGET_CHARS, buildContextDigest, createIngestStore, enabledSourceNames, latestSeq,
  publishEvent, resolveIngestConfig, ringStats, snapshotEvents,
} = require('./core/ingest-core');
const { deriveSessionRoots, isActiveSessionState } = require('./core/ingest-fs-core');
const { createAgentLogIngest } = require('./ingest-agent-logs');
const { createFsIngest } = require('./ingest-fs');
const { createGitIngest } = require('./ingest-git');
const { createShellHistoryIngest } = require('./ingest-shell-history');
const { createTerminalIngest } = require('./ingest-terminal');
const { createLaneLog } = require('./lane-log');

const BATCH_INTERVAL_MS = 1000;
const MAX_EVENTS_PER_FRAME = 50;
const SNAPSHOT_EVENT_LIMIT = 100;

function createIngestLane({
  config = null,
  broadcast = null,
  logger = console,
  laneMap = null,
  agentLogOptions = null,
  fsOptions = null,
  shellHistoryOptions = null,
  // The daemon's own resolved config path, so the fs source can ignore the state files glissa writes
  // beside it; rationale at the consuming site in ingest-fs.js.
  configPath = null,
  // The git watch-set rule lives with the caller that can see live sessions (server/backend.js), not
  // here: this lane only ever knows which directories it was handed.
  repoRoots = null,
  // Told once per batch that carried events, so a consumer learns the machine moved without polling
  // (docs/plan-ingestion.md, M7.5). Absent by default, and then nothing is ever called.
  onActivity = null,
  nowFn = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  batchIntervalMs = BATCH_INTERVAL_MS,
  maxEventsPerFrame = MAX_EVENTS_PER_FRAME,
  snapshotEventLimit = SNAPSHOT_EVENT_LIMIT,
  // Per-batch chatter, off unless the operator turned debugMode on. Boolean or getter, and the privacy
  // rule (which bites hardest here, since an event summary IS captured output) lives in server/lane-log.js.
  debug = false,
} = {}) {
  const resolved = config?.sources ? config : resolveIngestConfig(config);
  const store = createIngestStore(resolved);
  const sources = enabledSourceNames(resolved);
  // Events published since the last frame went out. Bounded by the batch flush, never by this array.
  let pendingEvents = [];
  let stopped = false;

  const { debugNote, note, warn } = createLaneLog({ prefix: '[ingest]', logger, debugFlag: debug });

  function emit(message) {
    if (typeof broadcast !== 'function') return;
    try {
      broadcast(message);
    } catch (error) {
      warn(`broadcast failed: ${error.message}`);
    }
  }

  // Rides the batch the lane already pays for, so no new timer exists and a throwing consumer costs one
  // warning rather than the frame that carried it.
  function pokeActivity() {
    if (typeof onActivity !== 'function') return;
    // Debug only: one line per batch that carried anything, which is once a second on a busy machine.
    debugNote(() => 'activity poke');
    try {
      onActivity();
    } catch (error) {
      warn(`activity callback failed: ${error.message}`);
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
    // Debug only, and counts rather than content: a summary is captured output and never reaches a log.
    debugNote(() => `batch flushed: ${events.length} events (seq ${events[events.length - 1].seq}-${events[0].seq}), ${message.overflow} overflowed`);
    pokeActivity();
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

  // Synchronous by contract: the visions builds this exactly once per dispatch, and a digest that
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
      // The feedback-loop exclusion: without it a visions dispatch's own transcript rides into the
      // next visions prompt. See the mechanism note in ingest-agent-logs.js.
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

  const gitEnabled = resolved.enabled === true && resolved.sources.git.enabled === true;
  const git = gitEnabled
    ? createGitIngest({
      publish,
      sourceConfig: resolved.sources.git,
      reposProvider: repoRoots,
      logger,
      nowFn,
      setIntervalFn,
      clearIntervalFn,
      setTimeoutFn,
      clearTimeoutFn,
    })
    : null;
  if (git) adapters.push(git);

  const fsEnabled = resolved.enabled === true && resolved.sources.fs.enabled === true;
  const fsSource = fsEnabled
    ? createFsIngest({
      publish,
      sourceConfig: resolved.sources.fs,
      configPath,
      logger,
      nowFn,
      setTimeoutFn,
      clearTimeoutFn,
      ...(fsOptions || {}),
    })
    : null;
  if (fsSource) adapters.push(fsSource);

  /*
   * The one source reading data created OUTSIDE glissa's own surfaces, so it needs `enabled: true` of
   * its own even with the lane on and every other source running (docs/plan-ingestion.md, "Config").
   * The resolver already defaults it off; this construction gate is what makes that cost zero.
   */
  const shellHistoryEnabled = resolved.enabled === true && resolved.sources.shellHistory.enabled === true;
  const shellHistory = shellHistoryEnabled
    ? createShellHistoryIngest({
      publish,
      sourceConfig: resolved.sources.shellHistory,
      logger,
      nowFn,
      setIntervalFn,
      clearIntervalFn,
      setTimeoutFn,
      clearTimeoutFn,
      ...(shellHistoryOptions || {}),
    })
    : null;
  if (shellHistory) adapters.push(shellHistory);

  // Adapters that own their own discovery start themselves; the terminal source has nothing to start,
  // since its taps arrive one session at a time from wireSessionEvents.
  note(`lane started: ${sources.length > 0 ? sources.join(', ') : 'no sources enabled'}`);

  for (const adapter of adapters) {
    if (typeof adapter.start !== 'function') continue;
    try {
      // "starting", not "started": a synchronous throw is caught just below, and an async failure only
      // surfaces later as the source's own degradation warn.
      void adapter.start();
      note(`starting the ${adapter.name} source`);
    } catch (error) {
      warn(`starting the ${adapter.name} source failed: ${error.message}`);
    }
  }

  /**
   * Re-derive the git watch set now. Two callers, both load-bearing: backend.js calls it once the session
   * map is POPULATED, because this lane is constructed before that loop runs and the source would
   * otherwise see an empty watch set until its first poll (and that poll's first read is a baseline, so a
   * commit made in the boot window would be absorbed and never reported); and again on `worktree-ready`,
   * because a worktree provisioned a second ago is about to take the session's first commit.
   *
   * Returns the pass so a caller can await it; the source's own guard never rejects.
   */
  function noteRepos() {
    if (stopped || !git) return Promise.resolve();
    return git.reconcile();
  }

  /**
   * The fs source's ref-counting edge, driven by the session state machine rather than by a start hook:
   * a session is a live checkout worth watching from the moment it is INITIALIZING until it exits, and
   * that is exactly what `to` already says. Callable on every transition, because a repeat naming the
   * same directories costs a compare in the source and nothing else.
   *
   * Only project sessions ever reach here (backend.js calls it from wireSessionEvents), so an ephemeral
   * lane session's throwaway workdir is outside the watch set BY CONSTRUCTION, the same mechanism that
   * keeps the terminal tap and the git watch set off them.
   */
  function noteSessionRoots(sess) {
    if (stopped || !fsSource || !sess?.id) return false;
    if (!isActiveSessionState(sess.state)) return fsSource.releaseHolder(sess.id);
    return fsSource.addRoots(sess.id, deriveSessionRoots(sess));
  }

  // The other half: a session that exited, or is being torn down for good, drops its hold and the root
  // goes unwatched once nothing else holds it.
  function releaseSessionRoots(sess) {
    if (!fsSource || !sess?.id) return false;
    return fsSource.releaseHolder(sess.id);
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

  // False whenever the terminal source is off, so the health snapshot can ask unconditionally.
  function hasSessionTap(sess) {
    if (!terminal) return false;
    return terminal.hasSessionTap(sess);
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
        note(`the ${adapter.name} source stopped`);
      } catch (error) {
        warn(`stopping the ${adapter.name} source failed: ${error.message}`);
      }
    }
    note('lane stopped');
  }

  return {
    publish,
    snapshotMessage,
    buildDigest,
    attachSessionTap,
    detachSessionTap,
    hasSessionTap,
    noteRepos,
    noteSessionRoots,
    releaseSessionRoots,
    flushBatch,
    stop,
    sources,
    ringStats: () => ringStats(store),
    // The lane-level movement signal: the newest seq stamped, 0 before anything has been published.
    latestSeq: () => latestSeq(store),
    recentEvents: (limit = snapshotEventLimit) => snapshotEvents(store, { limit }),
    get agentLogs() { return agentLogs; },
    get agentLogsEnabled() { return agentLogsEnabled; },
    get git() { return git; },
    get gitEnabled() { return gitEnabled; },
    get fs() { return fsSource; },
    get fsEnabled() { return fsEnabled; },
    get shellHistory() { return shellHistory; },
    get shellHistoryEnabled() { return shellHistoryEnabled; },
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
