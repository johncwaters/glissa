
import { EventEmitter } from 'node:events';

const DEFAULT_CONFLICT_WINDOW_MS = 750;
const DEFAULT_DEDUP_WINDOW_MS = 500;

const CONFIDENCE: Record<string, string> = { hook: 'high', title: 'low' };
const CONFIDENCE_RANK: Record<string, number> = { low: 0, high: 1 };

const IMMEDIATE = new Set(['working', 'awaiting-input', 'resume', 'session-start', 'session-end']);

const ACTIVITY = new Set(['working', 'resume']);

export interface RawStatusSignal {
  signal: string;
  source?: string;
  confidence?: string;
  ts?: number;
  [key: string]: unknown;
}

export interface ResolvedStatusSignal {
  sessionId: string | undefined;
  signal: string;
  source: string | null | undefined;
  confidence: string;
  ts: number;
}

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

  ingest(raw: RawStatusSignal | null | undefined): void {
    if (this._destroyed || !raw || !raw.signal) return;
    const { signal, source } = raw;
    const ts = raw.ts ?? Date.now();
    const confidence = raw.confidence || CONFIDENCE[source ?? ''] || 'low';

    if (signal === 'unknown') {
      this.emit('meta', { sessionId: this._sessionId, signal, source, ts });
      return;
    }

    if (signal === 'awaiting-input') {
      this._cancelPendingReady();
      this._resolve(signal, source, confidence, ts);
      return;
    }

    if (signal === 'ready') {
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
      if (ACTIVITY.has(signal)) this._cancelPendingReady();
      this._resolve(signal, source, confidence, ts);
      return;
    }
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
