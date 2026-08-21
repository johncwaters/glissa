/*
 * Terminal ingest source, IO shell (docs/plan-ingestion.md, M6). It taps a Session's existing public
 * EventEmitter surface and nothing else: no change to session/sessions.js, no reach into the PTY, no
 * detection involvement. Every decision about what survives a flush lives in ingest-terminal-core.js.
 *
 * Attaching a `data` listener turns on emit('data') for a session with no browser client attached
 * (sessions.js only emits when someone is listening). That cost is accepted and confined to the
 * sessions the tap covers, which is project sessions only: attachSessionTap is called from
 * wireSessionEvents in backend.js, and an ephemeral lane session never passes through it.
 */

'use strict';

const {
  DEFAULT_FLUSH_MS, appendChunk, createTerminalAccumulator, flushAccumulator, rebaseline,
} = require('./core/ingest-terminal-core');

function createTerminalIngest({
  publish,
  sourceConfig = {},
  logger = console,
  nowFn = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof publish !== 'function') throw new Error('createTerminalIngest requires publish');
  const flushMs = Number.isFinite(sourceConfig.flushMs) && sourceConfig.flushMs > 0
    ? sourceConfig.flushMs
    : DEFAULT_FLUSH_MS;
  const tapsBySessionId = new Map();

  function warn(message) {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`[ingest] ${message}`);
  }

  // The session's cwd is the project root this output belongs to; a session that cannot answer leaves
  // the event machine-scoped rather than guessing at a root.
  function rootOf(sess) {
    try {
      const cwd = typeof sess.effectiveCwd === 'function' ? sess.effectiveCwd() : null;
      return typeof cwd === 'string' && cwd ? cwd : null;
    } catch {
      return null;
    }
  }

  /**
   * One tap per session, idempotent in both directions: attaching the SAME session twice returns the
   * first tap, and detaching twice is a no-op. Session.destroy() calls removeAllListeners(), so detach
   * must tolerate the listeners already being gone, which is why every removal is guarded.
   */
  function attachSessionTap(sess) {
    if (!sess || typeof sess.on !== 'function' || !sess.id) return null;
    const existing = tapsBySessionId.get(sess.id);
    if (existing && existing.session === sess) return existing;
    /*
     * The map is keyed by the stable PROJECT id, and a config reload REPLACES the Session object under
     * that same id (backend.js _modifyChangedSessions: destroy the old, makeSession, wireSessionEvents).
     * destroy() removes every listener synchronously and emits no 'exit', so a stale entry here would
     * hand the caller a tap wired to a dead object and leave the NEW session untapped forever.
     */
    if (existing) existing.detach();

    const state = createTerminalAccumulator({ sessionId: sess.id, root: rootOf(sess), ...sourceConfig });
    let flushTimer = null;
    let detached = false;

    function cancelFlush() {
      if (!flushTimer) return;
      clearTimeoutFn(flushTimer);
      flushTimer = null;
    }

    function flush() {
      flushTimer = null;
      const event = flushAccumulator(state, { now: nowFn() });
      if (!event) return;
      try {
        publish(event);
      } catch (error) {
        warn(`publish failed for session ${sess.id}: ${error.message}`);
      }
    }

    function armFlush() {
      if (flushTimer || detached) return;
      flushTimer = setTimeoutFn(flush, flushMs);
      if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
    }

    const onData = (chunk) => {
      if (detached) return;
      appendChunk(state, chunk);
      armFlush();
    };
    // The screen was rewritten, so the pending bytes no longer describe appended output.
    const onRebaseline = () => {
      cancelFlush();
      rebaseline(state);
    };
    /*
     * A PTY exit is NOT the end of the Session object. restart(), forceRestart() and start() on a
     * dormant card all reuse it (control-handlers.js), while wireSessionEvents runs only when a session
     * is constructed, so unwiring here would silently stop ingesting the moment a card was restarted
     * and nothing would ever wire it back. The dead PTY's last bytes are flushed, the accumulator is
     * cleared, and the listeners STAY: only stop() and detachSessionTap take them off.
     */
    const onExit = () => {
      cancelFlush();
      flush();
    };

    function detach() {
      if (detached) return;
      detached = true;
      cancelFlush();
      rebaseline(state);
      // removeAllListeners may already have run inside destroy(); off() on a gone listener is a no-op,
      // and a session whose emitter is torn down entirely must not fail a shutdown.
      try {
        sess.off('data', onData);
        sess.off('rebaseline', onRebaseline);
        sess.off('exit', onExit);
      } catch (error) {
        warn(`detach for session ${sess.id} failed: ${error.message}`);
      }
      if (tapsBySessionId.get(sess.id) === tap) tapsBySessionId.delete(sess.id);
    }

    sess.on('data', onData);
    sess.on('rebaseline', onRebaseline);
    sess.on('exit', onExit);

    const tap = {
      sessionId: sess.id,
      // The session OBJECT, not just its id: a recreated project keeps the id and needs a fresh tap.
      session: sess,
      detach,
      flushNow: flush,
      get isDetached() { return detached; },
    };
    tapsBySessionId.set(sess.id, tap);
    return tap;
  }

  // Explicit teardown for a session leaving for good (backend.js _teardownSession), which destroys
  // without an exit event and would otherwise leave its entry behind holding a dead Session.
  function detachSessionTap(sess) {
    if (!sess || !sess.id) return false;
    const tap = tapsBySessionId.get(sess.id);
    if (!tap || tap.session !== sess) return false;
    tap.detach();
    return true;
  }

  // Whether THIS session object currently carries a tap (its `data` listener), so the health
  // snapshot's listener-count invariant can account for it instead of flagging a false leak.
  function hasSessionTap(sess) {
    if (!sess || !sess.id) return false;
    return tapsBySessionId.get(sess.id)?.session === sess;
  }

  function stop() {
    for (const tap of [...tapsBySessionId.values()]) tap.detach();
    tapsBySessionId.clear();
  }

  return {
    name: 'terminal',
    attachSessionTap,
    detachSessionTap,
    hasSessionTap,
    stop,
    get tapCount() { return tapsBySessionId.size; },
  };
}

module.exports = { createTerminalIngest };
