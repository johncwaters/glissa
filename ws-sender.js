'use strict';

/*
 * Data-WebSocket sender — backpressure-aware, echo-prioritizing.
 *
 * Extracted from backend.js so the batching, the bufferedAmount backpressure,
 * and the echo fast-flush are unit-testable without a real socket. One sender
 * is bound to one ws (one data-WS client of one session).
 *
 * Backpressure (bounds server RSS by construction): above `highWaterMark`
 * bytes queued in the socket, we STOP sending and drop the local coalesce
 * buffer — the bytes are NOT lost, they stay in the session's ring buffer and
 * are replayed when the client reconnects. If the socket stays pinned above
 * water past `stallCloseMs`, we close it; the browser's auto-reconnect + replay
 * resync it cleanly. "Coalesce harder" would only relocate the unbounded growth
 * into this buffer, so we skip instead.
 *
 * Echo (keeps typing responsive): when the session just received user input,
 * the next PTY frame (the echo) is flushed immediately instead of waiting a
 * setImmediate tick behind coalesced bulk. The flush still honors backpressure.
 *
 * All scheduling seams (`setImmediate`, `setTimeout`) are injectable so tests
 * run deterministically.
 */

const OPEN = 1;

const DEFAULTS = Object.freeze({
  maxSendBuffer: 65536, // coalesce target and hard per-frame cap (bytes)
  highWaterMark: 1 << 20, // 1 MiB queued in socket -> skip sends
  lowWaterMark: 1 << 18, // 256 KiB -> backlog considered cleared
  stallCloseMs: 10000, // close a client pinned above water this long
});

function createWsSender(ws, opts = {}) {
  const cfg = {
    maxSendBuffer: opts.maxSendBuffer ?? DEFAULTS.maxSendBuffer,
    highWaterMark: opts.highWaterMark ?? DEFAULTS.highWaterMark,
    lowWaterMark: opts.lowWaterMark ?? DEFAULTS.lowWaterMark,
    stallCloseMs: opts.stallCloseMs ?? DEFAULTS.stallCloseMs,
  };
  const scheduleImmediate = opts.setImmediateFn || setImmediate;
  const setTimer = opts.setTimeoutFn || setTimeout;
  const clearTimer = opts.clearTimeoutFn || clearTimeout;

  let sendBuffer = '';
  let sendScheduled = false;
  let flushNextData = false;
  let stallTimer = null;
  let destroyed = false;

  const bufferedAmount = () => ws.bufferedAmount || 0;
  const isOpen = () => ws.readyState === OPEN;
  const overHighWater = () => bufferedAmount() > cfg.highWaterMark;

  function armStallClose() {
    if (stallTimer !== null || destroyed) return;
    stallTimer = setTimer(() => {
      stallTimer = null;
      if (destroyed) return;
      // Still backed up after the grace period -> drop the wedged client.
      // Recent output is safe in the session ring buffer; auto-reconnect replays it.
      if (isOpen() && bufferedAmount() > cfg.lowWaterMark) {
        try { ws.close(1013, 'backpressure'); } catch { /* already closing */ }
      }
    }, cfg.stallCloseMs);
    if (stallTimer && typeof stallTimer.unref === 'function') stallTimer.unref();
  }

  function clearStall() {
    if (stallTimer !== null) {
      clearTimer(stallTimer);
      stallTimer = null;
    }
  }

  // Send the coalesced buffer now, unless the socket is backed up.
  function flushSend() {
    sendScheduled = false;
    if (destroyed || sendBuffer.length === 0 || !isOpen()) return;
    if (overHighWater()) {
      // Drop the local slice (preserved in the ring buffer for replay) and let
      // the socket drain. Arm the wedged-client close.
      sendBuffer = '';
      armStallClose();
      return;
    }
    clearStall();
    const buf = sendBuffer;
    sendBuffer = '';
    ws.send(buf);
  }

  function scheduleFlush() {
    if (sendScheduled) return;
    sendScheduled = true;
    scheduleImmediate(flushSend);
  }

  // PTY output for this session's client.
  function onData(data) {
    if (destroyed || !isOpen()) return;
    sendBuffer += data;
    // Echo fast path: flush this frame now (appended in order, no reordering)
    // so the echo isn't held a tick behind bulk. Still skips under backpressure.
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

  // Mark that this session just received user input, so the next PTY frame
  // (the echo) flushes immediately.
  function markInputFlush() {
    flushNextData = true;
  }

  // Guarded one-shot send for the reconnect replay frame (sent before onData
  // wiring). Skips and arms the stall close if the socket is already backed up.
  function sendImmediate(payload) {
    if (destroyed || !payload || !isOpen()) return false;
    if (overHighWater()) {
      armStallClose();
      return false;
    }
    clearStall();
    ws.send(payload);
    return true;
  }

  function destroy() {
    destroyed = true;
    clearStall();
    sendBuffer = '';
    sendScheduled = false;
    flushNextData = false;
  }

  return { onData, markInputFlush, sendImmediate, destroy };
}

module.exports = { createWsSender, DEFAULTS };
