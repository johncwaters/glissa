'use strict';

const { EventEmitter } = require('node:events');

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------

const RE_CSI     = /\u001b\[[0-9;]*[a-zA-Z]/g;            // NOSONAR — ANSI stripping requires control chars
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
    const isBlacklisted = LAYER2_BLACKLIST.some(bl => line.includes(bl));
    if (isBlacklisted) return null;

    for (const re of REGEX_PATTERNS) {
      if (re.test(line)) {
        return { layer: 2, pattern: re.toString(), line };
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

      // Layer 3 filters — skip obvious non-prompt content
      if (line.length < 10) return;                              // too short to be a real prompt
      if (line.endsWith('://')) return;                           // trailing URL scheme fragment
      // Check raw _pendingLine for indentation (line is already trimmed)
      if (/^\s{2,}/.test(this._pendingLine) && line.length < 30) return; // indented short line (menu item)

      // Layer 3 — line ends with '?' or ':'
      const last = line.at(-1);
      if (last === '?' || last === ':') {
        this.emit('prompt-detected', {
          layer: 3,
          pattern: 'silence_heuristic',
          line
        });
      }
    }, this._silenceTimeoutMs);
  }

  // Public API for re-arming the silence timer without clearing _pendingLine.
  // Used by the session guard to retry detection after an input grace rejection.
  rearmSilenceTimer() {
    this._resetSilenceTimer();
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

  // ---- PatternDetector tests ----
  console.log('\nPatternDetector:');

  const makeDetector = (ms) => {
    return new PatternDetector(ms === undefined ? 3000 : ms);
  };

  // Layer 1 — exact match
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('Do you want to proceed?\n');
    assert('layer 1 exact match — layer',   det?.layer,   1);
    assert('layer 1 exact match — pattern', det?.pattern, 'Do you want to proceed?');
  }

  // Layer 1 — (y/n) embedded in line
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('Allow write to config.json? (y/n)\n');
    assert('layer 1 (y/n) — layer',   det?.layer,   1);
    assert('layer 1 (y/n) — pattern', det?.pattern, '(y/n)');
  }

  // Layer 2 — regex match
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('Allow node_modules to be deleted?\n');
    assert('layer 2 regex — layer', det?.layer, 2);
  }

  // Layer 2 — /proceed\?\s*$/i (anchored)
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('Ready to proceed?\n');
    assert('layer 2 proceed? — layer', det?.layer, 2);
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
    assert('tightened do-you-want-to still matches — layer', det?.layer, 1);
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
    assert('ANSI stripped before layer 1 — layer', det?.layer, 1);
  }

  // Layer 3 — silence heuristic fires after timeout
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const runLayer3Tests = async () => {
    // Layer 3 — fires after silence
    const d = makeDetector(50);
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('Something unexpected?');
    assert('layer 3 no immediate fire', det, null);

    await delay(100);
    assert('layer 3 fires after silence — layer',   det?.layer,   3);
    assert('layer 3 fires after silence — pattern', det?.pattern, 'silence_heuristic');

    // Layer 3 — colon variant
    const d2 = makeDetector(50);
    let det2 = null;
    d2.on('prompt-detected', (e) => { det2 = e; });
    d2.feed('Enter your choice:');
    await delay(100);
    assert('layer 3 colon — layer', det2?.layer, 3);

    // Layer 3 — does NOT fire when line ends with plain word
    const d3 = makeDetector(50);
    let det3 = null;
    d3.on('prompt-detected', (e) => { det3 = e; });
    d3.feed('Build succeeded.');
    await delay(100);
    assert('layer 3 no fire for plain line', det3, null);

    // reset() clears pending timer
    const d4 = makeDetector(50);
    let det4 = null;
    d4.on('prompt-detected', (e) => { det4 = e; });
    d4.feed('Something unexpected?');
    d4.reset();
    await delay(100);
    assert('reset() suppresses layer 3', det4, null);

    // Layer 3 filter — short fragment should NOT fire
    const d5 = makeDetector(50);
    let det5 = null;
    d5.on('prompt-detected', (e) => { det5 = e; });
    d5.feed('>:');
    await delay(100);
    assert('layer 3 filter: short fragment ">:" does not fire', det5, null);

    // Layer 3 filter — short "?" alone should NOT fire
    const d6 = makeDetector(50);
    let det6 = null;
    d6.on('prompt-detected', (e) => { det6 = e; });
    d6.feed('?');
    await delay(100);
    assert('layer 3 filter: lone "?" does not fire', det6, null);

    // Layer 3 filter — trailing URL scheme should NOT fire
    const d7 = makeDetector(50);
    let det7 = null;
    d7.on('prompt-detected', (e) => { det7 = e; });
    d7.feed('Visit https://');
    await delay(100);
    assert('layer 3 filter: trailing "://" does not fire', det7, null);

    // Layer 3 filter — indented short menu item should NOT fire
    const d8 = makeDetector(50);
    let det8 = null;
    d8.on('prompt-detected', (e) => { det8 = e; });
    d8.feed('  /help    Show help:');
    await delay(100);
    assert('layer 3 filter: indented short menu item does not fire', det8, null);

    // Layer 3 filter — indented long prompt SHOULD fire
    const d9 = makeDetector(50);
    let det9 = null;
    d9.on('prompt-detected', (e) => { det9 = e; });
    d9.feed('  Please enter the full path to your configuration file:');
    await delay(100);
    assert('layer 3 filter: indented long prompt fires — layer', det9?.layer, 3);

    // Layer 3 — legitimate prompt "Enter your API key:" SHOULD fire
    const d10 = makeDetector(50);
    let det10 = null;
    d10.on('prompt-detected', (e) => { det10 = e; });
    d10.feed('Enter your API key:');
    await delay(100);
    assert('layer 3 filter: "Enter your API key:" fires — layer', det10?.layer, 3);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  };

  runLayer3Tests();
}
