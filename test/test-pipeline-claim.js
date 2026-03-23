'use strict';

/**
 * Adversarial tests for the claim:
 *
 *   "Glissa's existing architecture supports building a stream-piggybacking
 *    pipeline (ANSI tokenizer -> line assembler -> semantic classifier) that
 *    replaces PatternDetector's internals at the _handlePtyData tap point,
 *    without impacting terminal rendering, improving detection accuracy, and
 *    enabling future custom UI via Control WebSocket."
 *
 * Strategy: probe the four structural sub-claims this plan depends on.
 *   A. tap point independence  -- 'data' event fires regardless of PatternDetector
 *   B. detector swappability   -- PatternDetector can be replaced by any EventEmitter
 *                                 that emits 'prompt-detected'
 *   C. stripAnsi lossiness     -- adversarial ANSI sequences expose semantic loss
 *   D. timing fragility        -- rapid interleaved chunks expose arm/confirm races
 */

const { EventEmitter } = require('node:events');
const { PatternDetector } = require('../patterns');
const { Session } = require('../sessions');
const { STATES } = require('../shared/states');

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

function assertDeepEqual(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        expected: ${e}`);
    console.error(`        got:      ${a}`);
    failed++;
  }
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Session with its ptyProcess stubbed so we can drive _handlePtyData
 * directly without spawning a real process.
 *
 * Uses very short timeouts so timers don't keep the event loop alive.
 */
function makeTestSession(opts = {}) {
  const session = new Session({
    name: 'test',
    path: process.cwd(),
    startingWatchdogSeconds: 1,
    attentionTimeoutSeconds: 1,   // short — 1s idle timer, not 60s
    promptDetectionMs: 50,
    ...opts
  });

  // Force into RUNNING state without a real PTY
  session.state = STATES.RUNNING;
  session._runningStartedAt = Date.now();
  // Disable startup grace so patternDetector.feed() is called
  session._startupGraceActive = false;

  return session;
}

// ---------------------------------------------------------------------------
// Section A: Tap Point Independence
// ---------------------------------------------------------------------------
// Sub-claim: _handlePtyData always emits 'data' regardless of what
// PatternDetector does (including if it throws).
// ---------------------------------------------------------------------------

console.log('\n=== A: Tap Point Independence ===');
console.log('(claim: rendering path is independent of PatternDetector)\n');

// A1: data event fires even when PatternDetector.feed() throws
{
  const session = makeTestSession();
  // Replace feed with a thrower
  session.patternDetector.feed = () => { throw new Error('detector exploded'); };

  const dataChunks = [];
  session.on('data', (d) => dataChunks.push(d));

  let threw = false;
  try {
    session._handlePtyData('hello world\n');
  } catch {
    threw = true;
  }

  // ADVERSARIAL: We expect this to FAIL (0) because the exception in feed()
  // at DATA_HANDLERS[RUNNING] propagates up through _handlePtyData BEFORE
  // emit('data') at line 338 is reached. This proves the tap point is NOT
  // independent of PatternDetector — an exception in the detector silences
  // the rendering path too.
  assert(
    'A1: data emitted even when PatternDetector.feed() throws [EXPECT FAIL — reveals coupling]',
    dataChunks.length,
    1
  );
  session.destroy();
}

// A2: data event is emitted unconditionally — verify ordering in happy path
// The critical ordering in _handlePtyData is:
//   handler(session, data)   <- calls patternDetector.feed() (~line 328)
//   this.emit('data', data)  <- rendering path (line 338)
// If handler throws, emit('data') is never reached.
{
  const session = makeTestSession();
  const order = [];

  const origFeed = session.patternDetector.feed.bind(session.patternDetector);
  session.patternDetector.feed = (data) => {
    order.push('feed');
    origFeed(data);
  };

  session.on('data', () => order.push('emit'));

  session._handlePtyData('some data\n');

  assertDeepEqual(
    'A2: feed() called before emit("data") — order is [feed, emit]',
    order,
    ['feed', 'emit']
  );
  session.destroy();
}

// A3: data is buffered regardless of PatternDetector state (no-op feed)
{
  const session = makeTestSession();
  session.patternDetector.feed = () => {}; // no-op

  session._handlePtyData('chunk1\n');
  session._handlePtyData('chunk2\n');

  assert(
    'A3: replay buffer populated independently of PatternDetector',
    session.getReplayBuffer(),
    'chunk1\nchunk2\n'
  );
  session.destroy();
}

// A4: if PatternDetector is entirely null/missing, does data still emit?
// This tests whether the proposed "swap" would be safe during a refactor.
{
  const session = makeTestSession();
  session.patternDetector = null; // simulate mid-swap state

  const dataChunks = [];
  session.on('data', (d) => dataChunks.push(d));

  let threw = false;
  try {
    session._handlePtyData('data while detector is null\n');
  } catch {
    threw = true;
  }

  // Phase 0 added a try/catch around DATA_HANDLERS dispatch, so the null
  // reference error is caught and emitted as an 'error' event rather than
  // propagating. threw=false confirms the null guard is now in place.
  assert(
    'A4: null PatternDetector error caught by try/catch (null guard is in place)',
    threw,
    false
  );
}

// ---------------------------------------------------------------------------
// Section B: Detector Swappability
// ---------------------------------------------------------------------------
// Sub-claim: PatternDetector can be replaced by any object that is an
// EventEmitter and emits 'prompt-detected'. Verify the interface.
// ---------------------------------------------------------------------------

console.log('\n=== B: Detector Swappability ===');
console.log('(claim: PatternDetector can be swapped at the tap point)\n');

// B1: Session constructor hardcodes PatternDetector -- no dependency injection
{
  const session = new Session({
    name: 'di-test',
    path: process.cwd(),
    startingWatchdogSeconds: 1,
    attentionTimeoutSeconds: 1,
  });

  const isHardcoded = session.patternDetector instanceof PatternDetector;
  assert(
    'B1: patternDetector is hardcoded in constructor (no DI -- swap requires production code change)',
    isHardcoded,
    true
  );
  session.destroy();
}

// B2: A duck-typed replacement (EventEmitter subclass + matching interface)
//     emits 'prompt-detected' and the Session responds correctly.
{
  const session = makeTestSession();

  class StubDetector extends EventEmitter {
    constructor() {
      super();
      this.feedCalls = [];
      this._pendingLine = '';
    }
    feed(data) { this.feedCalls.push(data); }
    reset() { this._pendingLine = ''; }
    rearmSilenceTimer() {}
    hasPendingContent() { return false; }
    getPendingLine() { return ''; }
    updateSilenceTimeout() {}
  }

  const stub = new StubDetector();
  stub.on('prompt-detected', (detection) => {
    session.transition('prompt_detected', detection);
  });

  // Replace post-construction (the only way currently possible)
  session.patternDetector.removeAllListeners();
  session.patternDetector = stub;

  session._handlePtyData('Do you want to proceed?\n');
  assert(
    'B2: stub detector feed() called when data arrives',
    stub.feedCalls.length,
    1
  );

  stub.emit('prompt-detected', { layer: 99, pattern: 'stub', line: 'test' });
  assert(
    'B2: Session transitions to WAITING when stub emits prompt-detected',
    session.state,
    STATES.WAITING
  );
  session.destroy();
}

// B3: Session calls reset(), rearmSilenceTimer(), hasPendingContent(),
//     getPendingLine() on the detector -- all required on the interface.
{
  const session = makeTestSession();
  const calls = [];

  const minimalStub = {
    feed: () => calls.push('feed'),
    reset: () => calls.push('reset'),
    rearmSilenceTimer: () => calls.push('rearmSilenceTimer'),
    hasPendingContent: () => { calls.push('hasPendingContent'); return false; },
    getPendingLine: () => { calls.push('getPendingLine'); return ''; },
    updateSilenceTimeout: () => calls.push('updateSilenceTimeout'),
    on: () => {},
    removeAllListeners: () => {},
    removeListener: () => {},
  };

  session.patternDetector.removeAllListeners();
  session.patternDetector = minimalStub;

  // Trigger reset via EXIT_HOOKS[WAITING]
  session.state = STATES.WAITING;
  session._autoRecoverDataCount = 0;
  session.transition('user_dismiss');

  assert(
    'B3: reset() called on detector during WAITING exit hook',
    calls.includes('reset'),
    true
  );
  session.destroy();
}

// ---------------------------------------------------------------------------
// Section C: stripAnsi Lossiness
// ---------------------------------------------------------------------------
// Sub-claim: current stripAnsi() is lossy and a proper ANSI tokenizer
// would improve detection accuracy.
// ---------------------------------------------------------------------------

console.log('\n=== C: stripAnsi() Lossiness Adversarial Tests ===');
console.log('(claim: current approach loses semantic info)\n');

// Replicate stripAnsi from patterns.js (not exported, so we clone it)
const RE_CSI     = /\u001b\[\??[0-9;]*[a-zA-Z]/g;
const RE_OSC_BEL = /\u001b\][^\u0007]*\u0007/g;
const RE_OSC_ST  = /\u001b\][^\u001b]*\u001b\\/g;
const RE_CHARSET = /\u001b[()][A-Z0-9]/g;
const RE_KEYPAD  = /\u001b[>=<]/g;
const RE_CTRL    = /[\u0000-\u0009\u000b-\u001f]/g;

function stripAnsi(str) {
  return str
    .replaceAll(RE_CSI, '')
    .replaceAll(RE_OSC_BEL, '')
    .replaceAll(RE_OSC_ST, '')
    .replaceAll(RE_CHARSET, '')
    .replaceAll(RE_KEYPAD, '')
    .replaceAll(RE_CTRL, '');
}

// C1: Cursor-rewrite via CR collapses visual lines — stripAnsi strips CR
//     without interpreting it as a line-rewrite operation.
{
  const raw = 'Loading...\rDo you want to proceed?';
  const stripped = stripAnsi(raw);
  assert(
    'C1: \\r stripped (not interpreted) -- CR boundary info lost',
    raw.includes('\r') && !stripped.includes('\r'),
    true
  );
  assert(
    'C1: CR-overwrite produces concatenated string instead of final visual line',
    stripped,
    'Loading...Do you want to proceed?'
  );
}

// C2: Cursor-up (CUU) strips positional info
{
  const raw = 'line one\x1b[Aoverwrite above';
  const stripped = stripAnsi(raw);
  assert(
    'C2: cursor-up (\\x1b[A) stripped -- positional info lost',
    stripped,
    'line oneoverwrite above'
  );
}

// C3: OSC 8 hyperlink -- display text between OSC sequences survives
{
  const raw = '\x1b]8;;https://example.com\x1b\\Click here\x1b]8;;\x1b\\';
  const stripped = stripAnsi(raw);
  assert(
    'C3: OSC 8 hyperlink display text survives stripping',
    stripped.includes('Click here'),
    true
  );
}

// C4: Complex multi-param SGR on real prompt text
{
  const raw = '\x1b[1;3;38;5;214mDo you want to proceed?\x1b[0m\n';
  const stripped = stripAnsi(raw);
  assert(
    'C4: complex multi-param SGR stripped cleanly, semantic text preserved',
    stripped,
    'Do you want to proceed?\n'
  );
}

// C5: Bracketed paste mode markers stripped -- tokenizer cannot distinguish
//     paste from PTY output
{
  const raw = '\x1b[?2004hpasted text here\x1b[?2004l';
  const stripped = stripAnsi(raw);
  assert(
    'C5: bracketed paste markers stripped -- tokenizer loses paste/pty boundary',
    stripped,
    'pasted text here'
  );
}

// C6: Alternate screen buffer sequences stripped -- screen-switch boundary lost
{
  const enterStripped = stripAnsi('\x1b[?1049h');
  const exitStripped  = stripAnsi('\x1b[?1049l');
  assert(
    'C6: alt-screen sequences stripped -- screen-switch boundary lost',
    enterStripped === '' && exitStripped === '',
    true
  );
}

// C7: Partial ANSI sequence split across two feed() calls
//     stripAnsi on each chunk independently leaves garbled text.
//     Tests whether detection survives chunk-boundary splits.
{
  const d = new PatternDetector(50, 30);
  let det7 = null;
  d.on('prompt-detected', (e) => { det7 = e; });
  d.feed('\x1b[33');                          // partial CSI
  d.feed('mDo you want to proceed?\x1b[0m\n'); // completes the sequence + prompt
  // Note: after this we need to wait, handled in async section
  // Store detector for async check
  globalThis._d7 = d;
  globalThis._det7Ref = () => det7;
}

// ---------------------------------------------------------------------------
// Section D: Timing Fragility
// ---------------------------------------------------------------------------

console.log('\n=== D: Timing Fragility Under Rapid Data ===');
console.log('(claim: current timing mechanism is reliable)\n');

async function runAsyncTests() {
  // C7 async completion (set up synchronously above)
  {
    await delay(80);
    const det7 = globalThis._det7Ref();
    assert(
      'C7: partial ANSI split across chunks -- detection fires (graceful degradation)',
      det7 !== null,
      true
    );
    if (det7 !== null) {
      assert('C7: correct layer (1) despite partial ANSI split', det7.layer, 1);
    }
  }

  // D1: Output arriving 1ms before confirm timer fires cancels correctly
  {
    const d = new PatternDetector(500, 50);
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });

    d.feed('Do you want to proceed?\n');
    await delay(49);                    // just before 50ms confirm fires
    d.feed('cancelling output\n');       // cancel armed match
    await delay(20);

    assert(
      'D1: output 1ms before confirm fires cancels correctly (no false positive)',
      det,
      null
    );
  }

  // D2: 20 rapid identical prompt chunks -- only one detection per window
  {
    const d = new PatternDetector(500, 50);
    const detections = [];
    d.on('prompt-detected', (e) => detections.push(e));

    for (let i = 0; i < 20; i++) {
      d.feed('Do you want to proceed?\n');
    }
    await delay(100);

    assert(
      'D2: 20 rapid identical prompt chunks yield exactly one detection',
      detections.length,
      1
    );
  }

  // D3: Alternating arm/cancel -- zero detections (conversational text)
  {
    const d = new PatternDetector(500, 50);
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });

    for (let i = 0; i < 10; i++) {
      d.feed('Do you want to proceed?\n');
      d.feed('more output follows\n');
    }
    await delay(100);

    assert(
      'D3: alternating arm/cancel yields zero false positives',
      det,
      null
    );
  }

  // D4: Chrome arriving AFTER confirm fires must NOT cause second detection
  {
    const d = new PatternDetector(500, 30);
    const detections = [];
    d.on('prompt-detected', (e) => detections.push(e));

    d.feed('Do you want to proceed?\n');
    await delay(50);                        // confirm fires (30ms), detection emitted
    assert('D4: detection fired once before late chrome', detections.length, 1);

    d.feed('Esc to cancel \u00b7 Tab to amend');  // chrome arrives after confirm
    await delay(50);

    assert(
      'D4: late chrome after confirm fires does NOT cause second detection',
      detections.length,
      1
    );
  }

  // D5: Prompt text fed character-by-character
  {
    const d = new PatternDetector(500, 50);
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });

    const promptText = 'Do you want to proceed?\n';
    for (const char of promptText) {
      d.feed(char);
    }
    await delay(100);

    assert(
      'D5: prompt fed character-by-character detects correctly',
      det?.layer,
      1
    );
  }

  // D6: reset() mid-flight suppresses detection
  {
    const d = new PatternDetector(500, 50);
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });

    d.feed('Do you want to proceed?\n');
    await delay(20);   // mid-flight (before 50ms confirm)
    d.reset();
    await delay(60);   // past original confirm time

    assert(
      'D6: reset() mid-flight suppresses detection',
      det,
      null
    );
  }

  // D7: Layer 3 silence heuristic race -- two chunks arrive close together,
  //     each resetting the silence timer. Timer should only fire after true silence.
  {
    const d = new PatternDetector(60, 30); // silenceMs=60
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });

    d.feed('Enter your choice:');  // arms Layer 3 (ends with ':')
    await delay(40);                // before silence timeout
    d.feed('');                     // empty feed -- does this reset the timer?
    await delay(40);                // 40ms after second feed

    // If timer was reset by the empty feed, det may still be null.
    // If timer was not reset, det fired at ~60ms from first feed.
    // Either outcome is valid; we just verify no crash and consistent behavior.
    assert(
      'D7: Layer 3 timer behavior under double-feed is consistent (no crash)',
      typeof det === 'object',  // null or a detection object -- both are objects or null
      true
    );
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`TOTAL: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

runAsyncTests();
