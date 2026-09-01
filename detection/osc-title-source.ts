// OSC-0 title source: the DEGRADED fallback status signal.
//
// The framing and the state latching here are agent-NEUTRAL; WHICH leading glyph means working or
// idle is the adapter's title profile (session/adapters/claude-code.js), moved out of here in M1 of
// docs/plan-agent-adapters.md. A source constructed without one gets the Claude Code profile.
//
// CONTRACT (honest fallback): this source emits `working` / `ready` / `unknown`, and
// `awaiting-input` ONLY for a profile whose agent writes an explicit awaiting-input title STATE
// (codex's blinking "[ ! ] Action Required"). Claude Code has none, so its titles can never tell
// "needs input" from "finished" and WAITING stays the hook source's job there. An unrecognized
// leading glyph is reported as `unknown` (with a one-time warning), never silently treated as `ready`.
//
// Generic window titles are ignored where the profile says so. Claude ALWAYS leads its activity
// title with a pictographic glyph (all > U+007F), so a title leading with a plain ASCII character is
// a window title set by the spawn shell or OS (e.g. `cmd.exe /c claude` setting "C:\...\cmd.exe").
// Such titles carry no status and are dropped silently, never flagged as `unknown`, since `unknown`
// is reserved for genuine new-glyph candidates worth triaging.

import { EventEmitter } from 'node:events';

import claudeCode from '../session/adapters/claude-code.js';

const DEFAULT_STABILIZATION_MS = 1500;

const OSC_START = '\x1b]0;';
const BEL = '\x07';
const ST = '\x1b\\';

// What the profile needs about the session whose titles it is reading (codex compares the idle title
// against the cwd basename).
export interface TitleContext {
  cwdBasename?: string | null;
}

// Method shorthand on purpose: an adapter's profile is a plain JS object whose predicates are inferred,
// and bivariant parameter checking is what lets all three adapters satisfy one type.
export interface TitleProfile {
  classifyTitle?(title: string, context: TitleContext): string;
  isSpinnerChar?(char: string): boolean;
  isIdleChar?(char: string): boolean;
  dropsLeadingAscii?: boolean;
  unknownGlyphHint?: string;
}

// What the 'signal' event carries.
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

// Locate the next OSC-0 title in `buffer` at/after `fromIndex`.
// Returns { start, end, next, title } or null when no complete title is present.
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
    // What the profile needs about THIS session to read a title (codex compares the idle title
    // against the cwd basename). Set by the session at every spawn, since a worktree changes it.
    this._context = {};
    this._hasSeenSpinner = false;
    this._lastKind = null; // 'working' | 'idle-pending' | 'ready' | 'awaiting-input' | 'unknown' | null
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

  // Which of working / ready / awaiting-input / ignore / unknown this title means. A profile may
  // classify the WHOLE title (codex, whose idle and awaiting-input titles both lead with plain
  // ASCII); one that only knows leading glyphs (Claude Code) is classified here from its predicates,
  // in the order the pre-profile source applied them.
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
    if (!trimmed) return; // cleared/empty title, ignore
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
      // An explicit state the agent wrote, so it needs no stabilization and no spinner first; it
      // also cancels a pending idle, which by definition described the moment before the prompt.
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
      // Only arm `ready` after we have actually seen the session work. A session
      // that opens directly on the idle glyph (never spun) must not report ready.
      if (this._hasSeenSpinner && this._lastKind !== 'ready') {
        this._lastKind = 'idle-pending';
        this._armStabilization(char);
      }
      return;
    }

    // Unrecognized non-ASCII glyph: could be a NEW Claude idle/activity glyph from
    // a future version. NEVER treat as ready. Report once so it can be triaged.
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
      if (this._lastKind !== 'idle-pending') return; // a spinner re-armed since
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

  // Re-open the working-kind dedup latch so the NEXT spinner frame re-emits `working`.
  // Called by the session wrapper when the state machine enters a quiescent state
  // (IDLE/COMPLETE): if the PTY is in fact still spinning (a premature hook `ready`),
  // the next real frame re-wakes the card instead of being swallowed by the edge
  // trigger in _processTitle. Strictly weaker than reset(): preserves _hasSeenSpinner
  // and _lastChar, and touches nothing unless the latched kind is `working` (no
  // stabilization timer can be armed in that state - every spinner frame clears it).
  resyncWorkingLatch(): void {
    if (this._destroyed) return;
    if (this._lastKind !== 'working') return;
    this._lastKind = null;
  }

  // Merged, not replaced: a caller that knows one field must not blank the others.
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

// The glyph predicates moved to the Claude Code adapter; re-exported here for the pre-adapter pins.
const { isBrailleChar, isSpinnerChar, isKnownIdleChar } = claudeCode;

export { createOscTitleSource, isBrailleChar, isSpinnerChar, isKnownIdleChar };
