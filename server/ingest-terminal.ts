
import type { EventEmitter } from 'node:events';
import {
  DEFAULT_FLUSH_MS, appendChunk, createTerminalAccumulator, flushAccumulator, rebaseline,
} from './core/ingest-terminal-core.ts';
import type { TerminalIngestEvent } from './core/ingest-terminal-core.ts';
import { createLaneLog } from './lane-log.ts';
import type { LaneLogger } from './lane-log.ts';

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
  logger?: LaneLogger | null;
  nowFn?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
}

function createTerminalIngest({
  publish,
  sourceConfig = {},
  logger = console,
  nowFn = Date.now,
  setTimeoutFn = (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeoutFn = clearTimeout,
}: TerminalIngestOptions = {}) {
  if (typeof publish !== 'function') throw new Error('createTerminalIngest requires publish');
  const publishEvent = publish;
  const flushMs = typeof sourceConfig.flushMs === 'number' && Number.isFinite(sourceConfig.flushMs) && sourceConfig.flushMs > 0
    ? sourceConfig.flushMs
    : DEFAULT_FLUSH_MS;
  const tapsBySessionId = new Map<string, SessionTap>();

  const { note, warn } = createLaneLog({ prefix: '[ingest]', logger });

  function rootOf(sess: TappableSession): string | null {
    try {
      const cwd = typeof sess.effectiveCwd === 'function' ? sess.effectiveCwd() : null;
      return typeof cwd === 'string' && cwd ? cwd : null;
    } catch {
      return null;
    }
  }

  function attachSessionTap(sess: TappableSession | null | undefined): SessionTap | null {
    if (!sess || typeof sess.on !== 'function' || !sess.id) return null;
    const existing = tapsBySessionId.get(sess.id);
    if (existing && existing.session === sess) return existing;
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
    const onRebaseline = () => {
      cancelFlush();
      rebaseline(state);
    };
    const onExit = () => {
      cancelFlush();
      flush();
      rebaseline(state);
    };

    const detach = (): void => {
      if (detached) return;
      detached = true;
      cancelFlush();
      rebaseline(state);
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
      session: sess,
      detach,
      flushNow: flush,
      get isDetached() { return detached; },
    };
    tapsBySessionId.set(sess.id, tap);
    note(`terminal source: attached a tap to session ${sess.id} (${tapsBySessionId.size} tapped)`);
    return tap;
  }

  function detachSessionTap(sess: TappableSession | null | undefined): boolean {
    if (!sess || !sess.id) return false;
    const tap = tapsBySessionId.get(sess.id);
    if (!tap || tap.session !== sess) return false;
    tap.detach();
    return true;
  }

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
