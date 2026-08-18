'use strict';

// OSC-0 title source: the DEGRADED fallback status signal.
//
// Claude Code emits an activity glyph as the first char of its OSC-0 title:
//   - braille family U+2800..U+28FF or circle-halves U+25D0..U+25D3 => spinner ("working")
//   - a known idle glyph (e.g. U+2733 EIGHT SPOKED ASTERISK) => idle/ready
// Claude Code 2.1.228 changed the busy title spinner from braille to circle-halves.
// See docs/postmortem-terminal-detection.md and .omc/probes/common-patterns.md.
//
// CONTRACT (honest fallback): this source emits ONLY `working` / `ready` / `unknown`.
// It NEVER emits `awaiting-input`: the title cannot authoritatively tell "needs input"
// from "finished". WAITING is the hook source's job. An unrecognized leading glyph is
// reported as `unknown` (with a one-time warning), never silently treated as `ready`.
//
// Generic window titles are ignored. Claude ALWAYS leads its activity title with a
// pictographic glyph (braille spinner or a symbol, all > U+007F). A title that leads
// with a plain ASCII / text character is therefore NOT a Claude activity title: it is
// a window title set by the spawn shell or OS (e.g. on Windows, Glissa spawns
// `cmd.exe /c claude`, and cmd.exe sets the console title to "C:\...\cmd.exe"). Such
// titles carry no Claude status and are dropped silently, never flagged as `unknown`,
// since `unknown` is reserved for genuine new-glyph candidates worth triaging.

const { EventEmitter } = require('node:events');

const DEFAULT_STABILIZATION_MS = 1500;
const BRAILLE_MIN = 0x2800;
const BRAILLE_MAX = 0x28ff;
// Only U+25D0/U+25D1 live-probed (CC 2.1.234); the other two circle-halves frames can only ever mean spinning.
const KNOWN_SPINNER_CODEPOINTS = new Set([0x25d0, 0x25d1, 0x25d2, 0x25d3]);

// Known idle glyphs (extend as Step-0 probe confirms per Claude version).
// U+2733 ✳ is the documented-by-observation idle glyph.
const KNOWN_IDLE_CODEPOINTS = new Set([0x2733]);

const OSC_START = '\x1b]0;';
const BEL = '\x07';
const ST = '\x1b\\';

function isBrailleChar(char) {
  if (!char) return false;
  const code = char.codePointAt(0);
  return code >= BRAILLE_MIN && code <= BRAILLE_MAX;
}

function isSpinnerChar(char) {
  if (!char) return false;
  if (isBrailleChar(char)) return true;
  return KNOWN_SPINNER_CODEPOINTS.has(char.codePointAt(0));
}

function isKnownIdleChar(char) {
  if (!char) return false;
  return KNOWN_IDLE_CODEPOINTS.has(char.codePointAt(0));
}

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
  constructor({ stabilizationMs = DEFAULT_STABILIZATION_MS } = {}) {
    super();
    this._stabilizationMs = stabilizationMs;
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

    if (isSpinnerChar(char)) {
      this._hasSeenSpinner = true;
      this._lastChar = char;
      this._clearStabilization();
      if (this._lastKind !== 'working') {
        this._lastKind = 'working';
        this._emit('working', char);
      }
      return;
    }

    if (isKnownIdleChar(char)) {
      this._lastChar = char;
      // Only arm `ready` after we have actually seen the session work. A session
      // that opens directly on the idle glyph (never spun) must not report ready.
      if (this._hasSeenSpinner && this._lastKind !== 'ready') {
        this._lastKind = 'idle-pending';
        this._armStabilization(char);
      }
      return;
    }

    // Plain ASCII / text leading char => generic shell-or-OS window title, not a
    // Claude activity glyph (those are all > U+007F). Drop it silently: it has no
    // Claude status and must not be mistaken for a new idle glyph. This is the
    // common `cmd.exe /c claude` case where cmd sets the title to "C:\...\cmd.exe".
    if (char.codePointAt(0) <= 0x7f) {
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
            `If this is a new idle glyph, add it to KNOWN_IDLE_CODEPOINTS.`,
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

module.exports = {
  createOscTitleSource,
  isBrailleChar,
  isSpinnerChar,
  isKnownIdleChar,
};
