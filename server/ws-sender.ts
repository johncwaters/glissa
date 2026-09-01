/*
 * Data-WebSocket sender: backpressure-aware, echo-prioritizing.
 *
 * Extracted from backend.ts so the batching, the bufferedAmount backpressure,
 * and the echo fast-flush are unit-testable without a real socket. One sender
 * is bound to one ws (one data-WS client of one session).
 *
 * Backpressure (bounds server RSS by construction): above `highWaterMark`
 * bytes queued in the socket, we STOP sending and drop the local coalesce
 * buffer (the bytes are NOT lost, they stay in the session's ring buffer and
 * are replayed when the client reconnects). If the socket stays pinned above
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

import type { OutputRingSlice } from '../session/core/output-ring.ts';

const OPEN = 1;

// Full reset (RIS) + clear screen + clear scrollback + cursor home. Emitted ONLY on the
// evicted-fallback backfill (when the missed range scrolled out of the ring), never on an
// exact resend, so good scrollback is preserved on the common recovery.
//
// RIS leads because the replay that follows it starts at whichever ring chunk boundary
// survived eviction: it can open mid-escape-sequence and it re-establishes none of the
// emulator state the evicted bytes set up. The erase sequences alone leave the parser
// mid-sequence and leave the alternate buffer, the scroll region, the SGR attributes and
// the application cursor mode exactly as they were, so replaying into a terminal already
// inside an alt-screen TUI renders mush. RIS puts the emulator where a fresh one starts,
// which is the state the replay is implicitly written against. The erase sequences are
// kept after it because RIS alone leaves the scrollback on some emulators.
const CLEAR = '\x1bc\x1b[2J\x1b[3J\x1b[H';

const DEFAULTS = Object.freeze({
  maxSendBuffer: 65536, // coalesce target and hard per-frame cap (bytes)
  highWaterMark: 1 << 20, // 1 MiB queued in socket -> skip sends
  lowWaterMark: 1 << 18, // 256 KiB -> backlog considered cleared
  stallCloseMs: 10000, // close a client pinned above water this long
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

  // Optional backfill source ({ getBufferSince(offset) }). When present, a drop under
  // backpressure is recoverable IN PLACE (no reconnect) by re-pulling the exact missed
  // range from the session ring. Absent => behaves exactly as before (drop-and-forget,
  // recovered only when the client reconnects).
  const source = opts.source || null;

  let sendBuffer = '';
  let sendScheduled = false;
  let flushNextData = false;
  let stallTimer: NodeJS.Timeout | null = null;
  let destroyed = false;
  // sentOffset = LIVE bytes (offset >= startOffset) durably handed to ws.send for this
  // client. Advanced FORWARD only by live flushSend sends and by maybeBackfill, NOT by
  // sendImmediate's success path, whose replay frame carries historical bytes BEFORE
  // startOffset. The SOLE backward movement is sendImmediate's drop branch, which rewinds
  // sentOffset to the dropped replay's base so maybeBackfill re-pulls history + live.
  const initialOffset = opts.startOffset || 0;
  let sentOffset = initialOffset;
  // desynced = a drop happened and a backfill is owed once the socket drains.
  let desynced = false;

  const bufferedAmount = () => ws.bufferedAmount || 0;
  const isOpen = () => ws.readyState === OPEN;
  const overHighWater = () => bufferedAmount() > cfg.highWaterMark;

  function armStallClose(): void {
    if (stallTimer !== null || destroyed) return;
    stallTimer = setTimer(() => {
      stallTimer = null;
      if (destroyed) return;
      // Quiet-drain re-check (third backfill trigger): if the socket drained since the
      // drop but output then went silent, neither onData/flushSend nor the close below
      // (which fires only while STILL pinned) would recover the missed tail. Run the
      // backfill here first. No new timer is introduced: this reuses the stall timer.
      maybeBackfill();
      // Still backed up after the grace period -> drop the wedged client.
      // Recent output is safe in the session ring buffer; auto-reconnect replays it.
      if (isOpen() && bufferedAmount() > cfg.lowWaterMark) {
        try { ws.close(1013, 'backpressure'); } catch { /* already closing */ }
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

  // Recover bytes dropped under backpressure, IN PLACE (no reconnect), by re-pulling the
  // exact missed range [sentOffset, end) from the session ring once the socket has
  // drained. Guarded by `desynced` so it runs at most once per drop episode; a no-op
  // when no source is wired. Three call sites trigger it: the top of flushSend, the
  // onData short-circuit, and the stall-close timer (the quiet-drain re-check).
  function maybeBackfill(): void {
    if (!desynced || !source || destroyed || !isOpen()) return;
    if (overHighWater()) return; // still pinned; a later trigger will retry
    // ORDER CONTRACT (mirror of sessions._handlePtyData): the session pushes a chunk
    // into the ring BEFORE it emits 'data', so when this runs from inside the 'data'
    // listener the just-arrived chunk is already included in getBufferSince.
    const { data, end, evicted } = source.getBufferSince(sentOffset);
    // Missed range scrolled out of the ring: converge via clear + full replay.
    if (evicted) ws.send(CLEAR + data);
    if (!evicted && data) ws.send(data);
    sentOffset = end;
    desynced = false;
    // The backfill just covered [oldSentOffset, end), which already includes any bytes
    // still queued in sendBuffer: every queued byte was pushed to the ring before onData
    // saw it (push-before-emit), so its offset is < end. Discard the now-covered local
    // slice so a pending scheduled flush (or the flushSend fall-through below the
    // top-of-function maybeBackfill call) cannot re-send it (double-send + overshoot).
    sendBuffer = '';
    clearStall();
  }

  // Send the coalesced buffer now, unless the socket is backed up.
  function flushSend(): void {
    sendScheduled = false;
    // Drain trigger: emit any owed backfill ([sentOffset, end)) before fresh bytes so
    // ordering holds (the send below is at offsets >= end). No-op unless desynced.
    maybeBackfill();
    if (destroyed || sendBuffer.length === 0 || !isOpen()) return;
    if (overHighWater()) {
      // Drop the local slice (recoverable from the ring via sentOffset) and let the
      // socket drain. PAIRING REQUIREMENT: setting `desynced` MUST be paired with
      // armStallClose() here: the stall timer doubles as the quiet-drain backfill
      // re-check, so a drop that armed no timer could strand the tail if output then
      // goes silent. armStallClose is idempotent, so this never re-arms per frame.
      // `desynced` is only meaningful with a source; without one the sender keeps its
      // original drop-and-forget behavior (recovered only on reconnect).
      sendBuffer = '';
      if (source) desynced = true;
      armStallClose();
      return;
    }
    clearStall();
    const buf = sendBuffer;
    sendBuffer = '';
    ws.send(buf);
    sentOffset += buf.length; // live bytes durably sent
  }

  function scheduleFlush(): void {
    if (sendScheduled) return;
    sendScheduled = true;
    scheduleImmediate(flushSend);
  }

  // PTY output for this session's client.
  function onData(data: string): void {
    if (destroyed || !isOpen()) return;
    // Backfill short-circuit: if a backfill is owed and the socket has drained, recover
    // the missed range and RETURN without appending. `data` is already in the ring
    // (push-before-emit, see sessions.ts ORDER CONTRACT), so getBufferSince covers it;
    // appending here too would double-send / overshoot. While still pinned we fall
    // through and drop as usual: the chunk stays in the ring for a later backfill.
    if (desynced && !overHighWater()) {
      maybeBackfill();
      return;
    }
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
  function markInputFlush(): void {
    flushNextData = true;
  }

  // Guarded one-shot send for the reconnect replay frame (sent before onData
  // wiring). Skips and arms the stall close if the socket is already backed up.
  function sendImmediate(payload: string): boolean {
    if (destroyed || !payload || !isOpen()) return false;
    if (overHighWater()) {
      // Same PAIRING REQUIREMENT as flushSend: mark desynced AND arm the stall timer so
      // a connect whose replay frame is dropped (then goes quiet) still re-checks.
      // Only meaningful with a source; otherwise unchanged (drop-and-forget).
      if (source) {
        // This runs on a FRESH socket (called once, before onData is wired), so sentOffset
        // is still initialOffset and sendBuffer is empty (that invariant is what makes the
        // rewind below land on the replay's exact base). If a future refactor calls
        // sendImmediate on a non-fresh socket, the rewind base is wrong: make that loud
        // (console.error, NOT throw: a throw here tears down the connection, against the
        // EventEmitter/log error contract) but still recover so production self-heals.
        if (sentOffset !== initialOffset || sendBuffer.length !== 0) {
          console.error(
            '[ws-sender] sendImmediate drop on a non-fresh socket: sentOffset=%d ' +
            'initialOffset=%d sendBuffer.length=%d, rewind base may be wrong; recovering anyway.',
            sentOffset, initialOffset, sendBuffer.length,
          );
        }
        // Rewind sentOffset to the dropped replay's base. The payload IS the historical
        // replay frame [sentOffset - payload.length, sentOffset), so the next maybeBackfill
        // re-pulls getBufferSince(base) = [base, end) (history + any live, or CLEAR + data
        // if evicted) instead of live-only, which would strand the cleared client's history.
        sentOffset -= payload.length;
        desynced = true;
      }
      armStallClose();
      return false;
    }
    clearStall();
    ws.send(payload);
    // NOTE: deliberately does NOT advance sentOffset. The replay frame is historical
    // output [base, startOffset) that precedes the live baseline; advancing here would
    // push sentOffset past `end` and make a later backfill skip real live bytes.
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
