
import { EventEmitter } from 'node:events';

import claudeCode from '../session/adapters/claude-code.ts';

const DEFAULT_STABILIZATION_MS = 1500;

const OSC_START = '\x1b]0;';
const BEL = '\x07';
const ST = '\x1b\\';

export interface TitleContext {
  cwdBasename?: string | null;
}

export interface TitleProfile {
  classifyTitle?(title: string, context: TitleContext): string;
  isSpinnerChar?(char: string): boolean;
  isIdleChar?(char: string): boolean;
  dropsLeadingAscii?: boolean;
  unknownGlyphHint?: string;
}

export interface TitleSignal {
  signal: string;
  char: string | null;
  codepoint: number | null;
  ts: number;
  source: string;
}

export interface OscTitleSourceOptions {
  stabilizationMs?: number;
  titleProfile?: TitleProfile;
}

function findOscTitle(buffer: string, fromIndex: number) {
  const start = buffer.indexOf(OSC_START, fromIndex);
  if (start === -1) return null;
  const contentStart = start + OSC_START.length;
  const belEnd = buffer.indexOf(BEL, contentStart);
  const stEnd = buffer.indexOf(ST, contentStart);
  if (belEnd === -1 && stEnd === -1) return null;
  const useBel = belEnd !== -1 && (stEnd === -1 || belEnd < stEnd);
  const end = useBel ? belEnd : stEnd;
  const termLen = useBel ? 1 : 2;
  return { start, end, next: end + termLen, title: buffer.slice(contentStart, end) };
}

class OscTitleSource extends EventEmitter {
  _stabilizationMs: number;
  _profile: TitleProfile;
  _context: TitleContext;
  _hasSeenSpinner: boolean;
  _lastKind: string | null;
  _lastChar: string | null;
  _stabilizationTimer: NodeJS.Timeout | null;
  _pending: string;
  _warnedUnknown: boolean;
  _destroyed: boolean;

  constructor({ stabilizationMs = DEFAULT_STABILIZATION_MS, titleProfile = claudeCode.titleProfile }: OscTitleSourceOptions = {}) {
    super();
    this._stabilizationMs = stabilizationMs;
    this._profile = titleProfile;
    this._context = {};
    this._hasSeenSpinner = false;
    this._lastKind = null;
    this._lastChar = null;
    this._stabilizationTimer = null;
    this._pending = '';
    this._warnedUnknown = false;
    this._destroyed = false;
  }

  feed(chunk: string): void {
    if (this._destroyed || !chunk) return;
    this._pending += chunk;
    if (this._pending.length > 8192) this._pending = this._pending.slice(-4096);

    let cursor = 0;
    while (true) {
      const osc = findOscTitle(this._pending, cursor);
      if (!osc) break;
      this._processTitle(osc.title);
      cursor = osc.next;
    }
    if (cursor > 0) this._pending = this._pending.slice(cursor);
  }

  _classifyTitle(trimmed: string, char: string): string {
    const profile = this._profile;
    if (profile.classifyTitle) return profile.classifyTitle(trimmed, this._context);
    if (profile.isSpinnerChar?.(char)) return 'working';
    if (profile.isIdleChar?.(char)) return 'ready';
    if (profile.dropsLeadingAscii && (char.codePointAt(0) ?? 0) <= 0x7f) return 'ignore';
    return 'unknown';
  }

  _processTitle(title: string): void {
    const trimmed = title.replace(/^[\s\x00-\x1f]+/, '');
    if (!trimmed) return;
    const char = String.fromCodePoint(trimmed.codePointAt(0) ?? 0);
    const kind = this._classifyTitle(trimmed, char);

    if (kind === 'ignore') return;

    if (kind === 'working') {
      this._hasSeenSpinner = true;
      this._lastChar = char;
      this._clearStabilization();
      if (this._lastKind !== 'working') {
        this._lastKind = 'working';
        this._emit('working', char);
      }
      return;
    }

    if (kind === 'awaiting-input') {
      this._lastChar = char;
      this._clearStabilization();
      if (this._lastKind !== 'awaiting-input') {
        this._lastKind = 'awaiting-input';
        this._emit('awaiting-input', char);
      }
      return;
    }

    if (kind === 'ready') {
      this._lastChar = char;
      if (this._hasSeenSpinner && this._lastKind !== 'ready') {
        this._lastKind = 'idle-pending';
        this._armStabilization(char);
      }
      return;
    }

    this._lastChar = char;
    if (this._lastKind !== 'unknown') {
      this._lastKind = 'unknown';
      this._clearStabilization();
      if (!this._warnedUnknown) {
        this._warnedUnknown = true;
        console.warn(
          `[osc-title-source] unknown leading title glyph U+${(char.codePointAt(0) ?? 0).toString(16)} ` +
            `(${JSON.stringify(char)}), treating as 'unknown', not 'ready'. ` +
            (this._profile.unknownGlyphHint || ''),
        );
      }
      this._emit('unknown', char);
    }
  }

  _armStabilization(char: string): void {
    this._clearStabilization();
    this._stabilizationTimer = setTimeout(() => {
      this._stabilizationTimer = null;
      if (this._destroyed) return;
      if (this._lastKind !== 'idle-pending') return;
      this._lastKind = 'ready';
      this._emit('ready', char);
    }, this._stabilizationMs);
  }

  _emit(signal: string, char: string | null): void {
    this.emit('signal', {
      signal,
      char,
      codepoint: char ? char.codePointAt(0) : null,
      ts: Date.now(),
      source: 'title',
    });
  }

  _clearStabilization(): void {
    if (this._stabilizationTimer !== null) {
      clearTimeout(this._stabilizationTimer);
      this._stabilizationTimer = null;
    }
  }

  resyncWorkingLatch(): void {
    if (this._destroyed) return;
    if (this._lastKind !== 'working') return;
    this._lastKind = null;
  }

  setContext(context: TitleContext | null | undefined): void {
    if (this._destroyed || !context) return;
    this._context = { ...this._context, ...context };
  }

  reset(): void {
    if (this._destroyed) return;
    this._hasSeenSpinner = false;
    this._lastKind = null;
    this._lastChar = null;
    this._pending = '';
    this._clearStabilization();
  }

  destroy(): void {
    this._destroyed = true;
    this._clearStabilization();
    this._pending = '';
    this.removeAllListeners();
  }

  getState() {
    return {
      hasSeenSpinner: this._hasSeenSpinner,
      lastKind: this._lastKind,
      lastChar: this._lastChar,
    };
  }
}

function createOscTitleSource(opts?: OscTitleSourceOptions): OscTitleSource {
  return new OscTitleSource(opts);
}

const { isBrailleChar, isSpinnerChar, isKnownIdleChar } = claudeCode;

export { createOscTitleSource, isBrailleChar, isSpinnerChar, isKnownIdleChar };
