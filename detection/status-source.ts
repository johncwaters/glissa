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

import { EventEmitter } from 'node:events';

const DEFAULT_CONFLICT_WINDOW_MS = 750;
const DEFAULT_DEDUP_WINDOW_MS = 500;

const CONFIDENCE: Record<string, string> = { hook: 'high', title: 'low' };
const CONFIDENCE_RANK: Record<string, number> = { low: 0, high: 1 };

// Signals that take effect immediately (no buffering).
const IMMEDIATE = new Set(['working', 'awaiting-input', 'resume', 'session-start', 'session-end']);

// Signals that mean "activity in progress": each invalidates a held ready.
const ACTIVITY = new Set(['working', 'resume']);

export interface RawStatusSignal {
  signal: string;
  source?: string;
  confidence?: string;
  ts?: number;
  [key: string]: unknown;
}

// What the 'status' event carries: one resolved signal the session state machine acts on.
export interface ResolvedStatusSignal {
  sessionId: string | undefined;
  signal: string;
  source: string | null | undefined;
  confidence: string;
  ts: number;
}

// What the 'meta' event carries: telemetry that never drives a transition.
export interface MetaStatusSignal {
  sessionId: string | undefined;
  signal: string;
  source: string | undefined;
  ts: number;
}

export interface StatusSourceOptions {
  sessionId?: string;
  conflictWindowMs?: number;
  dedupWindowMs?: number;
}

class StatusSource extends EventEmitter {
  _sessionId: string | undefined;
  _conflictWindowMs: number;
  _dedupWindowMs: number;
  _pendingReadyTimer: NodeJS.Timeout | null;
  _pendingReadySource: string | null;
  _pendingReadyConfidence: string | null;
  _pendingReadyTs: number | null;
  _last: { signal: string; confidence: string; ts: number } | null;
  _destroyed: boolean;

  constructor({ sessionId, conflictWindowMs = DEFAULT_CONFLICT_WINDOW_MS, dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS }: StatusSourceOptions = {}) {
    super();
    this._sessionId = sessionId;
    this._conflictWindowMs = conflictWindowMs;
    this._dedupWindowMs = dedupWindowMs;
    this._pendingReadyTimer = null;
    this._pendingReadySource = null;
    this._pendingReadyConfidence = null;
    this._pendingReadyTs = null;
    this._last = null;
    this._destroyed = false;
  }

  // Push a raw signal: { signal, source: 'hook'|'title', confidence?, ts?, ... }
  ingest(raw: RawStatusSignal | null | undefined): void {
    if (this._destroyed || !raw || !raw.signal) return;
    const { signal, source } = raw;
    const ts = raw.ts ?? Date.now();
    const confidence = raw.confidence || CONFIDENCE[source ?? ''] || 'low';

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
          this._pendingReadySource = source ?? null;
          this._pendingReadyConfidence = confidence;
          this._pendingReadyTs = ts;
        }
        return;
      }
      this._pendingReadySource = source ?? null;
      this._pendingReadyConfidence = confidence;
      this._pendingReadyTs = ts;
      this._pendingReadyTimer = setTimeout(() => {
        this._pendingReadyTimer = null;
        const src = this._pendingReadySource;
        const conf = this._pendingReadyConfidence;
        const originTs = this._pendingReadyTs;
        this._pendingReadySource = null;
        this._pendingReadyConfidence = null;
        this._pendingReadyTs = null;
        if (this._destroyed) return;
        if (conf === null || originTs === null) return;
        this._resolve('ready', src, conf, originTs);
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

  _resolve(signal: string, source: string | null | undefined, confidence: string, ts: number): void {
    const isRapidDuplicate = this._last
      && this._last.signal === signal
      && ts - this._last.ts < this._dedupWindowMs;
    const isHigherConfidence = (CONFIDENCE_RANK[confidence] ?? 0)
      > (CONFIDENCE_RANK[this._last?.confidence ?? ''] ?? 0);
    if (isRapidDuplicate && !isHigherConfidence) {
      return;
    }
    this._last = { signal, confidence, ts };
    this.emit('status', {
      sessionId: this._sessionId,
      signal,
      source,
      confidence,
      ts,
    });
  }

  _cancelPendingReady(): void {
    if (this._pendingReadyTimer !== null) {
      clearTimeout(this._pendingReadyTimer);
      this._pendingReadyTimer = null;
      this._pendingReadySource = null;
      this._pendingReadyConfidence = null;
      this._pendingReadyTs = null;
    }
  }

  reset(): void {
    this._cancelPendingReady();
    this._last = null;
  }

  destroy(): void {
    this._destroyed = true;
    this._cancelPendingReady();
    this.removeAllListeners();
  }
}

function createStatusSource(opts?: StatusSourceOptions): StatusSource {
  return new StatusSource(opts);
}

export { createStatusSource };
