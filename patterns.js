'use strict';

const { EventEmitter } = require('node:events');

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------

const RE_CSI     = /\u001b\[\??[0-9;]*[a-zA-Z]/g;          // NOSONAR — ANSI stripping requires control chars (includes DEC private mode \e[?...)
const RE_OSC_BEL = /\u001b\][^\u0007]*\u0007/g;           // NOSONAR
const RE_OSC_ST  = /\u001b\][^\u001b]*\u001b\\/g;         // NOSONAR
const RE_CHARSET = /\u001b[()][A-Z0-9]/g;                 // NOSONAR
const RE_KEYPAD  = /\u001b[>=<]/g;                         // NOSONAR
const RE_CTRL    = /[\u0000-\u0009\u000b-\u001f]/g;       // NOSONAR

function stripAnsi(str) {
  return str
    .replaceAll(RE_CSI, '')
    .replaceAll(RE_OSC_BEL, '')
    .replaceAll(RE_OSC_ST, '')
    .replaceAll(RE_CHARSET, '')
    .replaceAll(RE_KEYPAD, '')
    .replaceAll(RE_CTRL, '');
}

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
    this._silenceTimeoutMs = silenceTimeoutMs;
    this._confirmationMs = confirmationMs;
    this._pendingLine = '';
    this._silenceTimer = null;
    this._confirmTimer = null;
    this._armedMatch = null;            // { layer, pattern, line } waiting for silence confirmation
    this._debug = process.env.GLISSA_DEBUG_PATTERNS === '1';
  }

  updateSilenceTimeout(ms) {
    this._silenceTimeoutMs = ms;
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
    const stripped = stripAnsi(rawData);

    // New output arrived while a match is armed.
    // If the output is prompt UI chrome (e.g. "Esc to cancel"), it confirms
    // the prompt — re-arm (restart confirmation timer) instead of cancelling.
    if (this._armedMatch) {
      if (this._isPromptChrome(stripped)) {
        if (this._debug) {
          console.log(`[pattern-debug] armed match preserved (prompt chrome) ts=${Date.now()}`);
        }
        const match = this._armedMatch;
        this._armMatch(match);

        // Still need to update pending line bookkeeping
        const chromeCombined = this._pendingLine + stripped;
        const chromeParts = chromeCombined.split('\n');
        const chromePending = chromeParts.pop();
        this._pendingLine = chromePending.length > 500 ? chromePending.slice(-500) : chromePending;
        return;
      }

      if (this._debug) {
        console.log(`[pattern-debug] armed match cancelled (more output): ${JSON.stringify(this._armedMatch.pattern)} ts=${Date.now()}`);
      }
      this._clearConfirmTimer();
    }

    // Append to any previously buffered incomplete line
    const combined = this._pendingLine + stripped;

    // Split into lines. The last element is either '' (data ended on \n) or
    // an incomplete line fragment still waiting for a newline.
    const parts = combined.split('\n');
    const pending = parts.pop(); // may be ''
    // Cap pending line at 500 chars — ANSI cursor-rewrite UIs can accumulate
    // several KB of garbled text between newlines.
    this._pendingLine = pending.length > 500 ? pending.slice(-500) : pending;

    // Process all complete lines (layers 1 & 2) — arm, don't fire
    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      const result = this._checkLine(trimmed);
      if (result) {
        this._armMatch(result);
        return; // One armed match per feed call is sufficient
      }
    }

    // Check pending (incomplete) text against all layers — arm, don't fire
    const pendingTrimmed = this._pendingLine.trim();
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
    this._pendingLine = '';
  }

  // Public API for re-arming the silence timer without clearing _pendingLine.
  // Used by the session guard to retry detection after an input grace rejection.
  rearmSilenceTimer() {
    this._resetSilenceTimer();
  }

  // Returns true if the last PTY output was an incomplete line (no trailing newline).
  // After prolonged silence, this strongly signals a prompt waiting for input.
  hasPendingContent() {
    return this._pendingLine.trim().length > 0;
  }

  // Returns the current pending (incomplete) line, trimmed.
  getPendingLine() {
    return this._pendingLine.trim();
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
      const line = this._pendingLine.trim();
      if (line.length === 0) return;

      // Layer 3 filters — skip obvious non-prompt content
      if (line.length < 10) return;                              // too short to be a real prompt
      if (line.endsWith('://')) return;                           // trailing URL scheme fragment
      // Check raw _pendingLine for indentation (line is already trimmed)
      if (/^\s{2,}/.test(this._pendingLine) && line.length < 30) return; // indented short line (menu item)

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

  _isPromptChrome(stripped) {
    return PROMPT_CHROME.some(chrome => stripped.includes(chrome));
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

// ---------------------------------------------------------------------------
// Self-test (run with: node patterns.js)
// ---------------------------------------------------------------------------

if (require.main === module) {
  let passed = 0;
  let failed = 0;

  const assert = (label, actual, expected) => {
    if (actual === expected) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.error(`  FAIL  ${label}`);
      console.error(`        expected: ${JSON.stringify(expected)}`);
      console.error(`        got:      ${JSON.stringify(actual)}`);
      failed++;
    }
  };

  // ---- stripAnsi tests ----
  console.log('\nstripAnsi:');
  assert(
    'strips color codes',
    stripAnsi('\x1b[32mhello\x1b[0m'),
    'hello'
  );
  assert(
    'strips OSC title sequence',
    stripAnsi('\x1b]0;My Terminal\x07plain'),
    'plain'
  );
  assert(
    'strips OSC with ST terminator',
    stripAnsi('\x1b]2;title\x1b\\text'),
    'text'
  );
  assert(
    'strips cursor movement',
    stripAnsi('\x1b[2Jclear'),
    'clear'
  );
  assert(
    'preserves newlines',
    stripAnsi('line1\nline2'),
    'line1\nline2'
  );
  assert(
    'strips DEC private mode sequences',
    stripAnsi('\x1b[?2026htext\x1b[?2026l'),
    'text'
  );
  assert(
    'strips DEC cursor show/hide',
    stripAnsi('\x1b[?25hvisible\x1b[?25l'),
    'visible'
  );

  // ---- PatternDetector tests ----
  // All tests use short timers: silenceTimeoutMs=50, confirmationMs=30
  console.log('\nPatternDetector:');

  const makeDetector = (silenceMs, confirmMs) => {
    return new PatternDetector(
      silenceMs === undefined ? 50 : silenceMs,
      confirmMs === undefined ? 30 : confirmMs
    );
  };

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const runAllTests = async () => {

    // ---- Two-stage detection: pattern match + silence confirmation ----
    console.log('\nTwo-stage detection (Layer 1/2 + silence confirmation):');

    // Layer 1 — does NOT fire immediately (needs silence confirmation)
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Do you want to proceed?\n');
      assert('layer 1: no immediate fire', det, null);
      await delay(60);
      assert('layer 1: fires after silence — layer', det?.layer, 1);
      assert('layer 1: fires after silence — pattern', det?.pattern, 'Do you want to proceed?');
    }

    // Layer 1 — (y/n) with silence confirmation
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Allow write to config.json? (y/n)\n');
      assert('layer 1 (y/n): no immediate fire', det, null);
      await delay(60);
      assert('layer 1 (y/n): fires after silence — layer', det?.layer, 1);
      assert('layer 1 (y/n): fires after silence — pattern', det?.pattern, '(y/n)');
    }

    // Layer 2 — regex with silence confirmation
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Allow node_modules to be deleted?\n');
      assert('layer 2: no immediate fire', det, null);
      await delay(60);
      assert('layer 2: fires after silence — layer', det?.layer, 2);
    }

    // Layer 2 — /proceed\?\s*$/i
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Ready to proceed?\n');
      await delay(60);
      assert('layer 2 proceed?: fires — layer', det?.layer, 2);
    }

    // ---- FALSE POSITIVE PREVENTION: conversational text cancelled by more output ----
    console.log('\nFalse positive prevention (conversational text):');

    // Pattern in conversational text: more output cancels the armed match
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('simple text prompts ((y/n), Do you want to proceed?), not for Claude\n');
      assert('conversational: armed after first feed', det, null);
      // Simulate more output arriving before confirmation timer fires
      d.feed('Code\'s rich interactive selection UI.\n');
      await delay(60);
      assert('conversational: cancelled by continued output', det, null);
    }

    // Pattern in pending text cancelled by continued output
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Also, the (y/n) pattern in pending text');  // no newline — arms
      assert('pending conversational: armed after feed', det, null);
      // More output arrives — cancels armed match. The complete line also
      // contains (y/n) so it re-arms; the next feed cancels that too.
      d.feed(' should now fire immediately.\n');
      d.feed('Next paragraph of output continues.\n');
      await delay(60);
      assert('pending conversational: cancelled by continued output', det, null);
    }

    // ---- Blacklist and negative tests ----
    console.log('\nBlacklist and negative tests:');

    // Blacklist: "Terminate batch job (Y/N)?" must NOT trigger
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Terminate batch job (Y/N)?\n');
      await delay(60);
      assert('blacklist suppresses "Terminate batch job (Y/N)?"', det, null);
    }

    // "Default permission mode" must NOT trigger
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Default permission mode\n');
      await delay(60);
      assert('no false positive on "Default permission mode"', det, null);
    }

    // Anchored proceed\?\s*$ does NOT match mid-sentence
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('proceed? Let me check\n');
      await delay(60);
      assert('anchored proceed? does not match mid-sentence', det, null);
    }

    // ANSI is stripped before matching
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('\x1b[33mDo you want to proceed?\x1b[0m\n');
      await delay(60);
      assert('ANSI stripped before layer 1 — layer', det?.layer, 1);
    }

    // ---- Layer 3 — silence heuristic ----
    console.log('\nLayer 3 (silence heuristic):');

    // Fires after full silence timeout (no pattern match, needs longer wait)
    {
      const d = makeDetector(50, 30);
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Something unexpected?');
      assert('layer 3: no immediate fire', det, null);
      await delay(30);
      assert('layer 3: not yet at 30ms (below silence timeout)', det, null);
      await delay(40);
      assert('layer 3: fires after silence timeout — layer', det?.layer, 3);
      assert('layer 3: fires after silence timeout — pattern', det?.pattern, 'silence_heuristic');
    }

    // Layer 3 — colon variant
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Enter your choice:');
      await delay(100);
      assert('layer 3 colon — layer', det?.layer, 3);
    }

    // Does NOT fire for plain endings
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Build succeeded.');
      await delay(100);
      assert('layer 3 no fire for plain line', det, null);
    }

    // reset() clears all timers
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Do you want to proceed?\n');
      d.reset();
      await delay(60);
      assert('reset() suppresses armed match', det, null);
    }

    // Layer 3 filters
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('>:');
      await delay(100);
      assert('layer 3 filter: short fragment ">:" does not fire', det, null);
    }
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('?');
      await delay(100);
      assert('layer 3 filter: lone "?" does not fire', det, null);
    }
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Visit https://');
      await delay(100);
      assert('layer 3 filter: trailing "://" does not fire', det, null);
    }
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('  /help    Show help:');
      await delay(100);
      assert('layer 3 filter: indented short menu item does not fire', det, null);
    }
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('  Please enter the full path to your configuration file:');
      await delay(100);
      assert('layer 3 filter: indented long prompt fires — layer', det?.layer, 3);
    }
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Enter your API key:');
      await delay(100);
      assert('layer 3: "Enter your API key:" fires — layer', det?.layer, 3);
    }

    // ---- Pending line detection with silence confirmation ----
    console.log('\nPending line detection (with silence confirmation):');

    // Layer 1 on pending text — needs silence confirmation
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Do you want to proceed?');  // no newline
      assert('pending L1: no immediate fire', det, null);
      await delay(60);
      assert('pending L1: fires after silence — layer', det?.layer, 1);
      assert('pending L1: fires after silence — pending', det?.pending, true);
    }

    // (y/n) in pending text — needs silence confirmation
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Allow write to config.json? (y/n)');  // no newline
      assert('pending (y/n): no immediate fire', det, null);
      await delay(60);
      assert('pending (y/n): fires after silence — layer', det?.layer, 1);
      assert('pending (y/n): fires after silence — pattern', det?.pattern, '(y/n)');
    }

    // Partial L1 pattern does NOT fire
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('(y/');
      await delay(100);
      assert('pending: partial "(y/" does not fire', det, null);
    }

    // updateSilenceTimeout changes the Layer 3 timer
    {
      const d = makeDetector(200, 30);
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.updateSilenceTimeout(50);
      d.feed('Custom timeout test?');  // no L1 match → Layer 3
      assert('updateSilenceTimeout: no immediate fire', det, null);
      await delay(100);
      assert('updateSilenceTimeout: fires with new timeout — layer', det?.layer, 3);
    }

    // ---- Prompt chrome confirmation (armed match preserved) ----
    console.log('\nPrompt chrome confirmation:');

    // Chrome after armed match preserves detection
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Do you want to proceed?\n');
      assert('chrome: armed after prompt', det, null);
      d.feed('Esc to cancel \u00b7 Tab to amend \u00b7 ctrl+e to explain');
      assert('chrome: not cancelled by prompt chrome', det, null);
      await delay(60);
      assert('chrome: fires after silence — layer', det?.layer, 1);
      assert('chrome: fires after silence — pattern', det?.pattern, 'Do you want to proceed?');
    }

    // Multiple chrome chunks still preserve the match
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Allow this action?\n');
      d.feed('Esc to cancel');
      d.feed(' \u00b7 Tab to amend');
      assert('multi-chrome: still armed', det, null);
      await delay(60);
      assert('multi-chrome: fires — layer', det?.layer, 1);
    }

    // Non-chrome output still cancels armed match
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Do you want to proceed?\n');
      d.feed('Here is some more regular output.\n');
      await delay(60);
      assert('non-chrome: still cancels armed match', det, null);
    }

    // Chrome with DEC private mode escapes (realistic PTY data)
    {
      const d = makeDetector();
      let det = null;
      d.on('prompt-detected', (e) => { det = e; });
      d.feed('Do you want to proceed?\n');
      d.feed('\x1b[?2026hEsc to cancel\x1b[?2026l');
      assert('chrome+DEC: not cancelled', det, null);
      await delay(60);
      assert('chrome+DEC: fires after silence — layer', det?.layer, 1);
    }

    // ---- hasPendingContent / getPendingLine (Layer 4 support) ----
    console.log('\nhasPendingContent / getPendingLine:');

    // Pending content after incomplete line
    {
      const d = makeDetector();
      d.feed('> ');
      assert('hasPendingContent: true after incomplete line', d.hasPendingContent(), true);
      assert('getPendingLine: returns trimmed pending', d.getPendingLine(), '>');
    }

    // No pending content after complete line
    {
      const d = makeDetector();
      d.feed('All done.\n');
      assert('hasPendingContent: false after newline-terminated output', d.hasPendingContent(), false);
      assert('getPendingLine: empty after newline-terminated output', d.getPendingLine(), '');
    }

    // Pending content with short prompt character
    {
      const d = makeDetector();
      d.feed('❯ ');
      assert('hasPendingContent: true for short prompt char', d.hasPendingContent(), true);
    }

    // Reset clears pending content
    {
      const d = makeDetector();
      d.feed('Enter name: ');
      assert('hasPendingContent: true before reset', d.hasPendingContent(), true);
      d.reset();
      assert('hasPendingContent: false after reset', d.hasPendingContent(), false);
    }

    // Whitespace-only pending line is not considered content
    {
      const d = makeDetector();
      d.feed('   ');
      assert('hasPendingContent: false for whitespace-only', d.hasPendingContent(), false);
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  };

  runAllTests();
}
