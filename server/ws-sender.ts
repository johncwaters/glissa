
import type { OutputRingSlice } from '../session/core/output-ring.ts';

const OPEN = 1;

const CLEAR = '\x1bc\x1b[2J\x1b[3J\x1b[H';

const DEFAULTS = Object.freeze({
  maxSendBuffer: 65536,
  highWaterMark: 1 << 20,
  lowWaterMark: 1 << 18,
  stallCloseMs: 10000,
});

interface WsSenderSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface WsSenderSource {
  getBufferSince(offset: number): OutputRingSlice;
}

interface WsSenderOptions {
  maxSendBuffer?: number;
  highWaterMark?: number;
  lowWaterMark?: number;
  stallCloseMs?: number;
  setImmediateFn?: (fn: () => void) => unknown;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  source?: WsSenderSource | null;
  startOffset?: number;
}

interface WsSender {
  onData(data: string): void;
  markInputFlush(): void;
  sendImmediate(payload: string): boolean;
  destroy(): void;
}

function createWsSender(ws: WsSenderSocket, opts: WsSenderOptions = {}): WsSender {
  const cfg = {
    maxSendBuffer: opts.maxSendBuffer ?? DEFAULTS.maxSendBuffer,
    highWaterMark: opts.highWaterMark ?? DEFAULTS.highWaterMark,
    lowWaterMark: opts.lowWaterMark ?? DEFAULTS.lowWaterMark,
    stallCloseMs: opts.stallCloseMs ?? DEFAULTS.stallCloseMs,
  };
  const scheduleImmediate = opts.setImmediateFn || setImmediate;
  const setTimer = opts.setTimeoutFn || ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeoutFn || clearTimeout;

  const source = opts.source || null;

  let sendBuffer = '';
  let sendScheduled = false;
  let flushNextData = false;
  let stallTimer: NodeJS.Timeout | null = null;
  let destroyed = false;
  const initialOffset = opts.startOffset || 0;
  let sentOffset = initialOffset;
  let desynced = false;

  const bufferedAmount = () => ws.bufferedAmount || 0;
  const isOpen = () => ws.readyState === OPEN;
  const overHighWater = () => bufferedAmount() > cfg.highWaterMark;

  function armStallClose(): void {
    if (stallTimer !== null || destroyed) return;
    stallTimer = setTimer(() => {
      stallTimer = null;
      if (destroyed) return;
      maybeBackfill();
      if (isOpen() && bufferedAmount() > cfg.lowWaterMark) {
        try { ws.close(1013, 'backpressure'); } catch {  }
      }
    }, cfg.stallCloseMs);
    if (stallTimer && typeof stallTimer.unref === 'function') stallTimer.unref();
  }

  function clearStall(): void {
    if (stallTimer !== null) {
      clearTimer(stallTimer);
      stallTimer = null;
    }
  }

  function maybeBackfill(): void {
    if (!desynced || !source || destroyed || !isOpen()) return;
    if (overHighWater()) return;
    const { data, end, evicted } = source.getBufferSince(sentOffset);
    if (evicted) ws.send(CLEAR + data);
    if (!evicted && data) ws.send(data);
    sentOffset = end;
    desynced = false;
    sendBuffer = '';
    clearStall();
  }

  function flushSend(): void {
    sendScheduled = false;
    maybeBackfill();
    if (destroyed || sendBuffer.length === 0 || !isOpen()) return;
    if (overHighWater()) {
      sendBuffer = '';
      if (source) desynced = true;
      armStallClose();
      return;
    }
    clearStall();
    const buf = sendBuffer;
    sendBuffer = '';
    ws.send(buf);
    sentOffset += buf.length;
  }

  function scheduleFlush(): void {
    if (sendScheduled) return;
    sendScheduled = true;
    scheduleImmediate(flushSend);
  }

  function onData(data: string): void {
    if (destroyed || !isOpen()) return;
    if (desynced && !overHighWater()) {
      maybeBackfill();
      return;
    }
    sendBuffer += data;
    if (flushNextData) {
      flushNextData = false;
      flushSend();
      return;
    }
    if (sendBuffer.length >= cfg.maxSendBuffer) {
      flushSend();
      return;
    }
    scheduleFlush();
  }

  function markInputFlush(): void {
    flushNextData = true;
  }

  function sendImmediate(payload: string): boolean {
    if (destroyed || !payload || !isOpen()) return false;
    if (overHighWater()) {
      if (source) {
        if (sentOffset !== initialOffset || sendBuffer.length !== 0) {
          console.error(
            '[ws-sender] sendImmediate drop on a non-fresh socket: sentOffset=%d ' +
            'initialOffset=%d sendBuffer.length=%d, rewind base may be wrong; recovering anyway.',
            sentOffset, initialOffset, sendBuffer.length,
          );
        }
        sentOffset -= payload.length;
        desynced = true;
      }
      armStallClose();
      return false;
    }
    clearStall();
    ws.send(payload);
    return true;
  }

  function destroy(): void {
    destroyed = true;
    clearStall();
    sendBuffer = '';
    sendScheduled = false;
    flushNextData = false;
  }

  return { onData, markInputFlush, sendImmediate, destroy };
}

export { createWsSender, DEFAULTS };
export type { WsSender, WsSenderOptions, WsSenderSocket, WsSenderSource };
