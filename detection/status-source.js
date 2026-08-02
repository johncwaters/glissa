'use strict';

// StatusSource - merges raw signals from the hook source (authoritative) and the
// OSC-title source (degraded fallback) into ONE normalized status stream that the
// session state machine consumes.
//
// Emitted signal vocabulary (consumed by sessions.js per the section 4a matrix):
//   working | ready | awaiting-input | resume | session-start | session-end
//
// Rules:
//   - Precedence: hook > title. (`confidence` is 'high' for hooks, 'low' for title.)
//     A raw signal may carry an explicit `confidence` override: the hook source demotes
//     idle_prompt-derived readys to 'low' (an idle nudge confirms quiescence, it does
//     not prove a turn finished), so the mapper only completes them from RUNNING.
//   - Conflict window W: `awaiting-input` strictly dominates `ready`. A `ready` is
//     held for W; if an `awaiting-input` lands during W, the `ready` is cancelled.
//     This prevents a spurious COMPLETE -> WAITING flip (and its false toast) when a
//     turn ends on an attention prompt (`Stop`/idle racing `Notification`).
//   - `working`/`resume` also cancel a held `ready`: activity arriving inside W means
//     the turn did NOT settle (the user re-prompted, or the agent resumed), so letting
//     the stale ready resolve would fire a false COMPLETE mid-work.
//   - Dedup: rapid duplicate resolved signals are coalesced (absorbs the Stop
//     double-fire bug #3465 and repeated title readys).
//   - `unknown` (title only) is NOT a state signal - forwarded as a 'meta' event for
//     telemetry / degraded-badge use, never a transition.

const { EventEmitter } = require('node:events');

const DEFAULT_CONFLICT_WINDOW_MS = 750;
const DEFAULT_DEDUP_WINDOW_MS = 500;

const CONFIDENCE = { hook: 'high', title: 'low' };

// Signals that take effect immediately (no buffering).
const IMMEDIATE = new Set(['working', 'awaiting-input', 'resume', 'session-start', 'session-end']);

// Signals that mean "activity in progress": each invalidates a held ready.
const ACTIVITY = new Set(['working', 'resume']);

class StatusSource extends EventEmitter {
  constructor({ sessionId, conflictWindowMs = DEFAULT_CONFLICT_WINDOW_MS, dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS } = {}) {
    super();
    this._sessionId = sessionId;
    this._conflictWindowMs = conflictWindowMs;
    this._dedupWindowMs = dedupWindowMs;
    this._pendingReadyTimer = null;
    this._pendingReadySource = null;
    this._pendingReadyConfidence = null;
    this._last = null; // { signal, ts }
    this._destroyed = false;
  }

  // Push a raw signal: { signal, source: 'hook'|'title', confidence?, ts?, ... }
  ingest(raw) {
    if (this._destroyed || !raw || !raw.signal) return;
    const { signal, source } = raw;
    const ts = raw.ts || Date.now();
    const confidence = raw.confidence || CONFIDENCE[source] || 'low';

    // Telemetry-only signals never drive transitions.
    if (signal === 'unknown') {
      this.emit('meta', { sessionId: this._sessionId, signal, source, ts });
      return;
    }

    if (signal === 'awaiting-input') {
      // Dominates a pending ready within the conflict window.
      this._cancelPendingReady();
      this._resolve(signal, source, confidence, ts);
      return;
    }

    if (signal === 'ready') {
      // Hold for the conflict window so a racing awaiting-input can win.
      // Idempotent: a second `ready` (e.g. Stop double-fire) does not stack timers,
      // but a higher-confidence duplicate upgrades the held one (hook beats title).
      if (this._pendingReadyTimer !== null) {
        if (confidence === 'high' && this._pendingReadyConfidence !== 'high') {
          this._pendingReadySource = source;
          this._pendingReadyConfidence = confidence;
        }
        return;
      }
      this._pendingReadySource = source;
      this._pendingReadyConfidence = confidence;
      this._pendingReadyTimer = setTimeout(() => {
        this._pendingReadyTimer = null;
        const src = this._pendingReadySource;
        const conf = this._pendingReadyConfidence;
        this._pendingReadySource = null;
        this._pendingReadyConfidence = null;
        if (this._destroyed) return;
        this._resolve('ready', src, conf, Date.now());
      }, this._conflictWindowMs);
      return;
    }

    if (IMMEDIATE.has(signal)) {
      // Activity invalidates a held ready: the turn it announced did not settle.
      if (ACTIVITY.has(signal)) this._cancelPendingReady();
      this._resolve(signal, source, confidence, ts);
      return;
    }
    // Unknown vocabulary - ignore defensively.
  }

  _resolve(signal, source, confidence, ts) {
    // Dedup rapid duplicates of the same resolved signal.
    if (this._last && this._last.signal === signal && ts - this._last.ts < this._dedupWindowMs) {
      return;
    }
    this._last = { signal, ts };
    this.emit('status', {
      sessionId: this._sessionId,
      signal,
      source,
      confidence,
      ts,
    });
  }

  _cancelPendingReady() {
    if (this._pendingReadyTimer !== null) {
      clearTimeout(this._pendingReadyTimer);
      this._pendingReadyTimer = null;
      this._pendingReadySource = null;
      this._pendingReadyConfidence = null;
    }
  }

  reset() {
    this._cancelPendingReady();
    this._last = null;
  }

  destroy() {
    this._destroyed = true;
    this._cancelPendingReady();
    this.removeAllListeners();
  }
}

function createStatusSource(opts) {
  return new StatusSource(opts);
}

module.exports = { createStatusSource };
