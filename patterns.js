'use strict';

const { EventEmitter } = require('events');

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')      // CSI sequences (colors, cursor)
    .replace(/\x1b\][^\x07]*\x07/g, '')           // OSC sequences (titles) with BEL
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')         // OSC with ST terminator
    .replace(/\x1b[()][A-Z0-9]/g, '')              // Charset sequences
    .replace(/\x1b[>=<]/g, '')                     // Keypad/cursor modes
    .replace(/[\x00-\x09\x0b-\x1f]/g, '');        // Control chars except \n
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
  constructor(silenceTimeoutMs = 3000) {
    super();
    this._silenceTimeoutMs = silenceTimeoutMs;
    this._pendingLine = '';
    this._silenceTimer = null;
  }

  // Feed raw PTY data. Strips ANSI, splits on newlines, checks each complete
  // line through layers 1 and 2 immediately. Incomplete trailing text is held
  // in _pendingLine and checked via the layer-3 silence heuristic.
  feed(rawData) {
    const stripped = stripAnsi(rawData);

    // Append to any previously buffered incomplete line
    const combined = this._pendingLine + stripped;

    // Split into lines. The last element is either '' (data ended on \n) or
    // an incomplete line fragment still waiting for a newline.
    const parts = combined.split('\n');
    this._pendingLine = parts.pop(); // may be ''

    // Process all complete lines immediately (layers 1 & 2)
    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      const result = this._checkLine(trimmed);
      if (result) {
        this._clearSilenceTimer();
        this.emit('prompt-detected', result);
        return; // One detection per feed call is sufficient
      }
    }

    // If there is pending (incomplete) text, arm/reset the silence timer
    // so that layer 3 fires if no further output arrives.
    if (this._pendingLine.trim().length > 0) {
      this._resetSilenceTimer();
    } else {
      // No pending line — clear any armed timer so we don't false-fire on
      // a line that ended cleanly without a question mark or colon.
      this._clearSilenceTimer();
    }
  }

  // Reset all state (call when the user has responded and the session resumes)
  reset() {
    this._clearSilenceTimer();
    this._pendingLine = '';
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
    const blacklisted = LAYER2_BLACKLIST.some(bl => line.includes(bl));
    if (!blacklisted) {
      for (const re of REGEX_PATTERNS) {
        if (re.test(line)) {
          return { layer: 2, pattern: re.toString(), line };
        }
      }
    }

    return null;
  }

  _resetSilenceTimer() {
    this._clearSilenceTimer();
    this._silenceTimer = setTimeout(() => {
      this._silenceTimer = null;
      const line = this._pendingLine.trim();
      if (line.length === 0) return;

      // Layer 3 — line ends with '?' or ':'
      const last = line[line.length - 1];
      if (last === '?' || last === ':') {
        this.emit('prompt-detected', {
          layer: 3,
          pattern: 'silence_heuristic',
          line
        });
      }
    }, this._silenceTimeoutMs);
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

  function assert(label, actual, expected) {
    if (actual === expected) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.error(`  FAIL  ${label}`);
      console.error(`        expected: ${JSON.stringify(expected)}`);
      console.error(`        got:      ${JSON.stringify(actual)}`);
      failed++;
    }
  }

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

  // ---- PatternDetector tests ----
  console.log('\nPatternDetector:');

  function makeDetector(ms) {
    return new PatternDetector(ms !== undefined ? ms : 3000);
  }

  // Layer 1 — exact match
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('Do you want to proceed?\n');
    assert('layer 1 exact match — layer',   det && det.layer,   1);
    assert('layer 1 exact match — pattern', det && det.pattern, 'Do you want to proceed?');
  }

  // Layer 1 — (y/n) embedded in line
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('Allow write to config.json? (y/n)\n');
    assert('layer 1 (y/n) — layer',   det && det.layer,   1);
    assert('layer 1 (y/n) — pattern', det && det.pattern, '(y/n)');
  }

  // Layer 2 — regex match
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('Allow node_modules to be deleted?\n');
    assert('layer 2 regex — layer', det && det.layer, 2);
  }

  // Layer 2 — /proceed\?\s*$/i (anchored)
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('Ready to proceed?\n');
    assert('layer 2 proceed? — layer', det && det.layer, 2);
  }

  // Layer 2 — blacklist: "Terminate batch job (Y/N)?" must NOT trigger
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('Terminate batch job (Y/N)?\n');
    assert('blacklist suppresses "Terminate batch job (Y/N)?"', det, null);
  }

  // Layer 2 — /permission/i removed: "Default permission mode" must NOT trigger
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('Default permission mode\n');
    assert('no false positive on "Default permission mode"', det, null);
  }

  // Layer 2 — tightened pattern still matches intended target
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('Do you want to proceed?\n');
    assert('tightened do-you-want-to still matches — layer', det && det.layer, 1);
  }

  // Layer 2 — anchored proceed\?\s*$ does NOT match mid-sentence "proceed?"
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('proceed? Let me check\n');
    assert('anchored proceed? does not match mid-sentence', det, null);
  }

  // ANSI is stripped before matching
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('\x1b[33mDo you want to proceed?\x1b[0m\n');
    assert('ANSI stripped before layer 1 — layer', det && det.layer, 1);
  }

  // Layer 3 — silence heuristic fires after timeout
  {
    const d = makeDetector(50); // 50 ms for fast test
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    // Feed incomplete line (no \n) ending with '?'
    d.feed('Something unexpected?');
    // Expect no immediate detection
    assert('layer 3 no immediate fire', det, null);

    // Wait for silence timeout then check
    setTimeout(() => {
      assert('layer 3 fires after silence — layer',   det && det.layer,   3);
      assert('layer 3 fires after silence — pattern', det && det.pattern, 'silence_heuristic');

      // Layer 3 — colon variant
      const d2 = makeDetector(50);
      let det2 = null;
      d2.on('prompt-detected', (e) => { det2 = e; });
      d2.feed('Enter your choice:');
      setTimeout(() => {
        assert('layer 3 colon — layer', det2 && det2.layer, 3);

        // Layer 3 — does NOT fire when line ends with plain word
        const d3 = makeDetector(50);
        let det3 = null;
        d3.on('prompt-detected', (e) => { det3 = e; });
        d3.feed('Build succeeded.');
        setTimeout(() => {
          assert('layer 3 no fire for plain line', det3, null);

          // reset() clears pending timer
          const d4 = makeDetector(50);
          let det4 = null;
          d4.on('prompt-detected', (e) => { det4 = e; });
          d4.feed('Something unexpected?');
          d4.reset();
          setTimeout(() => {
            assert('reset() suppresses layer 3', det4, null);

            console.log(`\n${passed} passed, ${failed} failed`);
            process.exit(failed > 0 ? 1 : 0);
          }, 100);
        }, 100);
      }, 100);
    }, 100);
  }
}
