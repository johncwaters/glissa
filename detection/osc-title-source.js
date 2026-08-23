'use strict';

// OSC-0 title source: the DEGRADED fallback status signal.
//
// The framing and the state latching here are agent-NEUTRAL; WHICH leading glyph means working or
// idle is the adapter's title profile (session/adapters/claude-code.js), moved out of here in M1 of
// docs/plan-agent-adapters.md. A source constructed without one gets the Claude Code profile.
//
// CONTRACT (honest fallback): this source emits ONLY `working` / `ready` / `unknown`.
// It NEVER emits `awaiting-input`: the title cannot authoritatively tell "needs input"
// from "finished". WAITING is the hook source's job. An unrecognized leading glyph is
// reported as `unknown` (with a one-time warning), never silently treated as `ready`.
//
// Generic window titles are ignored where the profile says so. Claude ALWAYS leads its activity
// title with a pictographic glyph (all > U+007F), so a title leading with a plain ASCII character is
// a window title set by the spawn shell or OS (e.g. `cmd.exe /c claude` setting "C:\...\cmd.exe").
// Such titles carry no status and are dropped silently, never flagged as `unknown`, since `unknown`
// is reserved for genuine new-glyph candidates worth triaging.

const { EventEmitter } = require('node:events');

const claudeCode = require('../session/adapters/claude-code');

const DEFAULT_STABILIZATION_MS = 1500;

const OSC_START = '\x1b]0;';
const BEL = '\x07';
const ST = '\x1b\\';

// Locate the next OSC-0 title in `buffer` at/after `fromIndex`.
// Returns { start, end, next, title } or null when no complete title is present.
function findOscTitle(buffer, fromIndex) {
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
  constructor({ stabilizationMs = DEFAULT_STABILIZATION_MS, titleProfile = claudeCode.titleProfile } = {}) {
    super();
    this._stabilizationMs = stabilizationMs;
    this._profile = titleProfile;
    this._hasSeenSpinner = false;
    this._lastKind = null; // 'working' | 'idle-pending' | 'ready' | 'unknown' | null
    this._lastChar = null;
    this._stabilizationTimer = null;
    this._pending = '';
    this._warnedUnknown = false;
    this._destroyed = false;
  }

  feed(chunk) {
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

  _processTitle(title) {
    const trimmed = title.replace(/^[\s\x00-\x1f]+/, '');
    if (!trimmed) return; // cleared/empty title, ignore
    const char = String.fromCodePoint(trimmed.codePointAt(0));

    if (this._profile.isSpinnerChar(char)) {
      this._hasSeenSpinner = true;
      this._lastChar = char;
      this._clearStabilization();
      if (this._lastKind !== 'working') {
        this._lastKind = 'working';
        this._emit('working', char);
      }
      return;
    }

    if (this._profile.isIdleChar(char)) {
      this._lastChar = char;
      // Only arm `ready` after we have actually seen the session work. A session
      // that opens directly on the idle glyph (never spun) must not report ready.
      if (this._hasSeenSpinner && this._lastKind !== 'ready') {
        this._lastKind = 'idle-pending';
        this._armStabilization(char);
      }
      return;
    }

    if (this._profile.dropsLeadingAscii && char.codePointAt(0) <= 0x7f) {
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
          `[osc-title-source] unknown leading title glyph U+${char.codePointAt(0).toString(16)} ` +
            `(${JSON.stringify(char)}), treating as 'unknown', not 'ready'. ` +
            (this._profile.unknownGlyphHint || ''),
        );
      }
      this._emit('unknown', char);
    }
  }

  _armStabilization(char) {
    this._clearStabilization();
    this._stabilizationTimer = setTimeout(() => {
      this._stabilizationTimer = null;
      if (this._destroyed) return;
      if (this._lastKind !== 'idle-pending') return; // a spinner re-armed since
      this._lastKind = 'ready';
      this._emit('ready', char);
    }, this._stabilizationMs);
  }

  _emit(signal, char) {
    this.emit('signal', {
      signal,
      char,
      codepoint: char ? char.codePointAt(0) : null,
      ts: Date.now(),
      source: 'title',
    });
  }

  _clearStabilization() {
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
  resyncWorkingLatch() {
    if (this._destroyed) return;
    if (this._lastKind !== 'working') return;
    this._lastKind = null;
  }

  reset() {
    if (this._destroyed) return;
    this._hasSeenSpinner = false;
    this._lastKind = null;
    this._lastChar = null;
    this._pending = '';
    this._clearStabilization();
  }

  destroy() {
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

function createOscTitleSource(opts) {
  return new OscTitleSource(opts);
}

// The glyph predicates moved to the Claude Code adapter; re-exported here for the pre-adapter pins.
module.exports = {
  createOscTitleSource,
  isBrailleChar: claudeCode.isBrailleChar,
  isSpinnerChar: claudeCode.isSpinnerChar,
  isKnownIdleChar: claudeCode.isKnownIdleChar,
};
