'use strict';

const { EventEmitter } = require('node:events');
const { AnsiTokenizer } = require('./ansi-tokenizer');
const { LineAssembler } = require('./line-assembler');

// ---------------------------------------------------------------------------
// Layer 1 — Exact string matches
// ---------------------------------------------------------------------------

const EXACT_MATCHES = [
  'Do you want to proceed?',
  'Allow this action?',
  'Press Enter to confirm',
  '(y/n)',
  '[yes/no]',
  // Additional known Claude Code permission prompts
  'Do you want to continue?',
  'Confirm? (y/n)',
  'Are you sure?',
  'Proceed? (y/n)',
  'Would you like to proceed?',
];

// ---------------------------------------------------------------------------
// Prompt UI chrome — Claude Code renders these hints immediately after a
// prompt question.  Their presence CONFIRMS an armed match rather than
// cancelling it.
// ---------------------------------------------------------------------------

const PROMPT_CHROME = [
  'Esc to cancel',
  'Tab to amend',
  'ctrl+e to explain',
  'y to approve',
  'Enter to run',
];

// ---------------------------------------------------------------------------
// Layer 2 — Regex patterns
// ---------------------------------------------------------------------------

const REGEX_PATTERNS = [
  /\(y\/n\)/i,
  /\[yes\/no\]/i,
  /proceed\?\s*$/i,
  /allow .+ to .+\?/i,
  /do you want to .+\?$/i,
  /would you like to .+\?/i,
  /are you sure\s*\?/i,
  /confirm\?\s*$/i,
];

const LAYER2_BLACKLIST = [
  'Terminate batch job',
];

// ---------------------------------------------------------------------------
// PatternDetector
// ---------------------------------------------------------------------------

class PatternDetector extends EventEmitter {
  /**
   * Two-stage detection: pattern match arms a short confirmation timer,
   * silence confirms the detection. This eliminates false positives from
   * conversational text because more output always follows (cancelling the
   * armed match), while actual prompts are followed by silence.
   *
   * @param {number} silenceTimeoutMs  Layer 3 heuristic silence timeout
   * @param {number} confirmationMs    Layer 1/2 match confirmation delay
   */
  constructor(silenceTimeoutMs = 1500, confirmationMs = 300) {
    super();
    this._tokenizer = new AnsiTokenizer();
    this._assembler = new LineAssembler({ maxLineLength: 500 });
    this._silenceTimeoutMs = silenceTimeoutMs;
    this._confirmationMs = confirmationMs;
    this._silenceTimer = null;
    this._confirmTimer = null;
    this._armedMatch = null;            // { layer, pattern, line } waiting for silence confirmation
    this._debug = process.env.GLISSA_DEBUG_PATTERNS === '1';
  }

  updateSilenceTimeout(ms) {
    this._silenceTimeoutMs = ms;
    // If a silence timer is already running, restart it with the new timeout
    // so the change takes effect immediately rather than after the old timer fires.
    if (this._silenceTimer !== null) {
      this._resetSilenceTimer();
    }
  }

  /**
   * Feed raw PTY data. Two-stage detection:
   *
   * 1. Pattern match (Layer 1/2) on complete lines or pending text → arms
   *    a short confirmation timer (_confirmationMs, default 300ms).
   * 2. If more output arrives before timer fires → cancel (conversational text).
   * 3. If silence holds → fire prompt-detected.
   * 4. Layer 3 (heuristic ?/:) uses the longer _silenceTimeoutMs timer.
   */
  feed(rawData) {
    const tokens = this._tokenizer.tokenize(rawData);
    this._assembler.feed(tokens);

    // New output arrived while a match is armed.
    // If the output is prompt UI chrome (e.g. "Esc to cancel"), it confirms
    // the prompt — re-arm (restart confirmation timer) instead of cancelling.
    if (this._armedMatch) {
      const textContent = tokens
        .filter(t => t.type === 'text')
        .map(t => t.content)
        .join('');
      if (this._isPromptChrome(textContent)) {
        if (this._debug) {
          console.log(`[pattern-debug] armed match preserved (prompt chrome) ts=${Date.now()}`);
        }
        this._armMatch(this._armedMatch);
        return;
      }

      if (this._debug) {
        console.log(`[pattern-debug] armed match cancelled (more output): ${JSON.stringify(this._armedMatch.pattern)} ts=${Date.now()}`);
      }
      this._clearConfirmTimer();
    }

    // Process completed lines (layers 1 & 2) — arm, don't fire
    for (const line of this._assembler.getCompletedLines()) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      const result = this._checkLine(trimmed);
      if (result) {
        this._armMatch(result);
        return; // One armed match per feed call is sufficient
      }
    }

    // Check pending (incomplete) text against all layers — arm, don't fire
    const pendingTrimmed = this._assembler.getPendingLine();
    if (pendingTrimmed.length > 0) {
      if (this._debug) {
        console.log(`[pattern-debug] feed() pendingLine: ${JSON.stringify(pendingTrimmed)} ts=${Date.now()}`);
      }

      const result = this._checkLine(pendingTrimmed);
      if (result) {
        result.pending = true;
        this._armMatch(result);
        return;
      }

      // No pattern match — arm Layer 3 silence timer as fallback
      this._resetSilenceTimer();
    } else {
      // No pending line — clear timers
      this._clearSilenceTimer();
    }
  }

  // Reset all state (call when the user has responded and the session resumes)
  reset() {
    this._clearSilenceTimer();
    this._clearConfirmTimer();
    this._tokenizer.reset();
    this._assembler.reset();
  }

  // Public API for re-arming the silence timer without clearing assembler state.
  // Used by the session guard to retry detection after an input grace rejection.
  rearmSilenceTimer() {
    this._resetSilenceTimer();
  }

  // Returns true if the last PTY output was an incomplete line (no trailing newline).
  // After prolonged silence, this strongly signals a prompt waiting for input.
  hasPendingContent() {
    return this._assembler.hasPendingContent();
  }

  // Returns the current pending (incomplete) line, trimmed.
  getPendingLine() {
    return this._assembler.getPendingLine();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  // Check a single stripped line against layers 1 and 2.
  // Returns a detection object or null.
  _checkLine(line) {
    // Layer 1 — exact substring match
    for (const exact of EXACT_MATCHES) {
      if (line.includes(exact)) {
        return { layer: 1, pattern: exact, line };
      }
    }

    // Layer 2 — regex (skip if line matches blacklist)
    const isBlacklisted = LAYER2_BLACKLIST.some(bl => line.includes(bl));
    if (isBlacklisted) return null;

    for (const re of REGEX_PATTERNS) {
      if (re.test(line)) {
        return { layer: 2, pattern: re.toString(), line };
      }
    }

    return null;
  }

  // Arm a pattern match for confirmation. Starts a short timer; if no new
  // output arrives before it fires, the detection is confirmed.
  _armMatch(result) {
    this._clearSilenceTimer();   // Layer 3 not needed when we have a pattern match
    this._clearConfirmTimer();
    this._armedMatch = result;

    if (this._debug) {
      console.log(`[pattern-debug] armed: layer=${result.layer} pattern=${JSON.stringify(result.pattern)} ts=${Date.now()}`);
    }

    this._confirmTimer = setTimeout(() => {
      this._confirmTimer = null;
      const match = this._armedMatch;
      this._armedMatch = null;
      if (match) {
        if (this._debug) {
          console.log(`[pattern-debug] confirmed (silence held): layer=${match.layer} pattern=${JSON.stringify(match.pattern)} ts=${Date.now()}`);
        }
        this.emit('prompt-detected', match);
      }
    }, this._confirmationMs);
  }

  _resetSilenceTimer() {
    this._clearSilenceTimer();
    this._silenceTimer = setTimeout(() => {
      this._silenceTimer = null;
      const line = this._assembler.getPendingLine();
      if (line.length === 0) return;

      // Layer 3 filters — skip obvious non-prompt content
      if (line.length < 10) return;                              // too short to be a real prompt
      if (line.endsWith('://')) return;                           // trailing URL scheme fragment
      // Check raw pending line for indentation (line is already trimmed)
      const rawLine = this._assembler.getRawPendingLine();
      if (/^\s{2,}/.test(rawLine) && line.length < 30) return;  // indented short line (menu item)

      // Layer 3 — line ends with '?' or ':'
      const last = line.at(-1);
      if (last === '?' || last === ':') {
        if (this._debug) {
          console.log(`[pattern-debug] Layer 3 fired: ${JSON.stringify(line)} ts=${Date.now()}`);
        }
        this.emit('prompt-detected', {
          layer: 3,
          pattern: 'silence_heuristic',
          line
        });
      }
    }, this._silenceTimeoutMs);
  }

  _isPromptChrome(text) {
    return PROMPT_CHROME.some(chrome => text.includes(chrome));
  }

  _clearConfirmTimer() {
    this._armedMatch = null;
    if (this._confirmTimer !== null) {
      clearTimeout(this._confirmTimer);
      this._confirmTimer = null;
    }
  }

  _clearSilenceTimer() {
    if (this._silenceTimer !== null) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { PatternDetector };
