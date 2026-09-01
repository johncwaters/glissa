/*
 * Terminal ingest source, IO shell (docs/plan-ingestion.md, M6). It taps a Session's existing public
 * EventEmitter surface and nothing else: no change to session/sessions.ts, no reach into the PTY, no
 * detection involvement. Every decision about what survives a flush lives in ingest-terminal-core.js.
 *
 * Attaching a `data` listener turns on emit('data') for a session with no browser client attached
 * (sessions.js only emits when someone is listening). That cost is accepted and confined to the
 * sessions the tap covers, which is project sessions only: attachSessionTap is called from
 * wireSessionEvents in backend.js, and an ephemeral lane session never passes through it.
 */

import type { EventEmitter } from 'node:events';
import {
  DEFAULT_FLUSH_MS, appendChunk, createTerminalAccumulator, flushAccumulator, rebaseline,
} from './core/ingest-terminal-core.ts';
import type { TerminalIngestEvent } from './core/ingest-terminal-core.ts';
import { createLaneLog } from './lane-log.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TappableSession {
  id: string;
  on: EventEmitter['on'];
  off: EventEmitter['off'];
  effectiveCwd?: () => string | null;
}

interface SessionTap {
  sessionId: string;
  session: TappableSession;
  detach(): void;
  flushNow(): void;
  readonly isDetached: boolean;
}

interface TerminalIngestOptions {
  publish?: (event: TerminalIngestEvent) => unknown;
  sourceConfig?: { flushMs?: number };
  logger?: Console;
  nowFn?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

function createTerminalIngest({
  publish,
  sourceConfig = {},
  logger = console,
  nowFn = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}: TerminalIngestOptions = {}) {
  if (typeof publish !== 'function') throw new Error('createTerminalIngest requires publish');
  const publishEvent = publish;
  const flushMs = typeof sourceConfig.flushMs === 'number' && Number.isFinite(sourceConfig.flushMs) && sourceConfig.flushMs > 0
    ? sourceConfig.flushMs
    : DEFAULT_FLUSH_MS;
  const tapsBySessionId = new Map<string, SessionTap>();

  const { note, warn } = createLaneLog({ prefix: '[ingest]', logger });

  // The session's cwd is the project root this output belongs to; a session that cannot answer leaves
  // the event machine-scoped rather than guessing at a root.
  function rootOf(sess: TappableSession): string | null {
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
  function attachSessionTap(sess: TappableSession | null | undefined): SessionTap | null {
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
    let flushTimer: NodeJS.Timeout | null = null;
    let detached = false;

    function cancelFlush(): void {
      if (!flushTimer) return;
      clearTimeoutFn(flushTimer);
      flushTimer = null;
    }

    const flush = (): void => {
      flushTimer = null;
      const event = flushAccumulator(state, { now: nowFn() });
      if (!event) return;
      try {
        publishEvent(event);
      } catch (error) {
        warn(`publish failed for session ${sess.id}: ${errorMessage(error)}`);
      }
    };

    function armFlush(): void {
      if (flushTimer || detached) return;
      flushTimer = setTimeoutFn(flush, flushMs);
      if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
    }

    const onData = (chunk: string) => {
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
      // The dead process will never finish the line it was halfway through, and the accumulator now
      // HOLDS an unterminated line rather than publishing it, so that remnant would otherwise prefix
      // the first line the restarted process writes.
      rebaseline(state);
    };

    const detach = (): void => {
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
        warn(`detach for session ${sess.id} failed: ${errorMessage(error)}`);
      }
      if (tapsBySessionId.get(sess.id) === tap) tapsBySessionId.delete(sess.id);
      note(`terminal source: detached the tap on session ${sess.id} (${tapsBySessionId.size} tapped)`);
    };

    sess.on('data', onData);
    sess.on('rebaseline', onRebaseline);
    sess.on('exit', onExit);

    const tap: SessionTap = {
      sessionId: sess.id,
      // The session OBJECT, not just its id: a recreated project keeps the id and needs a fresh tap.
      session: sess,
      detach,
      flushNow: flush,
      get isDetached() { return detached; },
    };
    tapsBySessionId.set(sess.id, tap);
    note(`terminal source: attached a tap to session ${sess.id} (${tapsBySessionId.size} tapped)`);
    return tap;
  }

  // Explicit teardown for a session leaving for good (backend.js _teardownSession), which destroys
  // without an exit event and would otherwise leave its entry behind holding a dead Session.
  function detachSessionTap(sess: TappableSession | null | undefined): boolean {
    if (!sess || !sess.id) return false;
    const tap = tapsBySessionId.get(sess.id);
    if (!tap || tap.session !== sess) return false;
    tap.detach();
    return true;
  }

  // Whether THIS session object currently carries a tap (its `data` listener), so the health
  // snapshot's listener-count invariant can account for it instead of flagging a false leak.
  function hasSessionTap(sess: TappableSession | null | undefined): boolean {
    if (!sess || !sess.id) return false;
    return tapsBySessionId.get(sess.id)?.session === sess;
  }

  function stop(): void {
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

export { createTerminalIngest };
export type { SessionTap, TappableSession, TerminalIngestOptions };
