'use strict';

/**
 * test-patterns.js — PatternDetector test suite
 *
 * Replaces the deleted inline self-test block from patterns.js.
 * Covers interface-level detection tests and pipeline-specific tests.
 *
 * Run: node test-patterns.js
 */

const { PatternDetector } = require('../patterns');
const { isLayer4Chrome } = require('../sessions');

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

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// All tests use short timers: silenceTimeoutMs=50, confirmationMs=30
const makeDetector = (silenceMs, confirmMs) => {
  return new PatternDetector(
    silenceMs === undefined ? 50 : silenceMs,
    confirmMs === undefined ? 30 : confirmMs
  );
};

async function runAllTests() {

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

  // ANSI is stripped before matching (SGR around prompt text)
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
    d.feed('Something unexpected:');
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
    d.feed('Custom timeout test:');  // no L1 match → Layer 3
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

  // OSC-only data (e.g. title bar update) should NOT cancel armed match
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('Do you want to proceed?\n');
    d.feed('\x1b]0;Some window title\x07');
    assert('OSC-only: not cancelled', det, null);
    await delay(60);
    assert('OSC-only: fires after silence — layer', det?.layer, 1);
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

  // ---- Pipeline-specific tests ----
  console.log('\nPipeline-specific tests:');

  // AC7: CR-overwrite — "Loading...\rPrompt?" → detects "Prompt?" not concatenation
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('Loading...\rDo you want to proceed?');
    assert('AC7: CR-overwrite arms detection (no immediate fire)', det, null);
    await delay(60);
    assert('AC7: CR-overwrite fires after silence — layer', det?.layer, 1);
    assert('AC7: CR-overwrite fires after silence — pattern', det?.pattern, 'Do you want to proceed?');
  }

  // AC7b: CR-overwrite pending line reflects final content
  {
    const d = makeDetector();
    d.feed('Loading...\rDone     ');
    assert('AC7b: pending line after CR-overwrite is overwritten content', d.getPendingLine(), 'Done');
  }

  // AC8: Split ANSI sequence across chunks — detection still works
  {
    const d = makeDetector();
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });
    d.feed('\x1b[33');                           // partial CSI — no complete token yet
    d.feed('mDo you want to proceed?\x1b[0m\n'); // completes sequence + prompt
    assert('AC8: split ANSI — no immediate fire', det, null);
    await delay(60);
    assert('AC8: split ANSI across chunks — detection fires', det !== null, true);
    assert('AC8: split ANSI — correct layer', det?.layer, 1);
  }

  // AC9: Empty input produces no state change or detection
  {
    const d = makeDetector();
    let eventCount = 0;
    d.on('prompt-detected', () => { eventCount++; });
    d.feed('');
    assert('AC9: empty input — no pending content', d.hasPendingContent(), false);
    assert('AC9: empty input — getPendingLine is empty', d.getPendingLine(), '');
    await delay(60);
    assert('AC9: empty input — no events emitted', eventCount, 0);
  }

  // AC10: Hot-reload updateSilenceTimeout mid-stream — no state loss
  {
    const d = makeDetector(200, 30);
    let det = null;
    d.on('prompt-detected', (e) => { det = e; });

    // Feed partial data (Layer 3 candidate, no L1/L2 match)
    d.feed('Configuring environment:');
    assert('AC10: partial data armed Layer 3', d.hasPendingContent(), true);

    // Hot-reload with shorter timeout while buffered
    d.updateSilenceTimeout(50);

    // State preserved: pending line still there
    assert('AC10: pending content preserved after updateSilenceTimeout', d.hasPendingContent(), true);
    assert('AC10: pending line preserved after updateSilenceTimeout', d.getPendingLine(), 'Configuring environment:');

    // Wait for new (shorter) silence timeout to fire
    await delay(120);
    assert('AC10: detection fires after updated timeout — layer', det?.layer, 3);
  }

  // ---- Layer 4 chrome filter (isLayer4Chrome) ----
  console.log('\nLayer 4 chrome filter (isLayer4Chrome):');

  // False positives from real captures — all should be filtered
  assert('L4 filter: box-drawing separator',
    isLayer4Chrome('──────────────────────────────────────────────────────────────────────────────────────────────────────────────'), true);

  assert('L4 filter: separator + Pasting text + spinner',
    isLayer4Chrome('──────────────────────────────────────────────────────────────────────────────────────────────────────────────Pasting text…                                                                           ◐ medium · /effort⏵⏵ accept edits on (shift+tab to cycle)'), true);

  assert('L4 filter: spinner + effort indicator',
    isLayer4Chrome('◐ medium · /effort'), true);

  assert('L4 filter: OMC HUD + Claude Code chrome',
    isLayer4Chrome('[OMC#4.9.0] | 5h:75%(2h22m) wk:3…  Claude Code  as switched from npm to nat…⏵⏵ accept edits on (shift+tab to…'), true);

  assert('L4 filter: garbled screen redraw (sparse digits)',
    isLayer4Chrome('7                                      5'), true);

  assert('L4 filter: garbled screen redraw with session info',
    isLayer4Chrome('8                         session:0m | ctx:0%'), true);

  // -- Wide-spaced user typing (PTY keystroke echo) --
  assert('L4 filter: wide-spaced typing "T h o s e   t h r e e   t h i n g s ."',
    isLayer4Chrome('T h o s e   t h r e e   t h i n g s .'), true);

  assert('L4 filter: wide-spaced typing "S o   w e   d o n \' t   l o s e   p r o g r e s s"',
    isLayer4Chrome('S o   w e   d o n \' t   l o s e   p r o g r e s s'), true);

  assert('L4 filter: wide-spaced typing "a s d f"',
    isLayer4Chrome('a s d f'), true);

  assert('L4 filter: wide-spaced typing with corrections',
    isLayer4Chrome('d o w n   o u r   s p r i n t   s p   t a n d a r d s   f r o   m   m     m   o u r   w i k i'), true);

  // -- Short garbled fragments --
  assert('L4 filter: single digit "4"',
    isLayer4Chrome('4'), true);

  assert('L4 filter: single letter "n"',
    isLayer4Chrome('n'), true);

  assert('L4 filter: short fragment ":0%"',
    isLayer4Chrome(':0%'), true);

  assert('L4 filter: short fragment "0%"',
    isLayer4Chrome('0%'), true);

  // -- URLs --
  assert('L4 filter: full URL',
    isLayer4Chrome('https://devblogs.microsoft.com/devops/no-new-azure-devops-oauth-apps/'), true);

  assert('L4 filter: URL in mixed content',
    isLayer4Chrome('r k i n g .   [Pasted text #4 +165 lines]'), true);

  assert('L4 filter: https URL fragment',
    isLayer4Chrome('https://clerk.com/docs/reference/frontend-api/2025-11-10/tag/sign-ins'), true);

  // -- Task checkbox rendering --
  assert('L4 filter: task list with checkboxes',
    isLayer4Chrome('✔ Update root and Level 1 AGENTS.md files   ◼ Update/creat  src/ subtree AGENTS.md files'), true);

  assert('L4 filter: task list with multiple symbols',
    isLayer4Chrome('✔ Creat  wiki struct re with Diataxis navigation   ✔ Write "What is Myr" explanation doc'), true);

  // -- System messages --
  assert('L4 filter: bypass permissions warning',
    isLayer4Chrome('WARNING: Claude Code running in Bypass Permissions mode'), true);

  assert('L4 filter: pasted text indicator',
    isLayer4Chrome('[Pasted text #4 +165 lines]'), true);

  assert('L4 filter: OMC cancel hint fragment',
    isLayer4Chrome('l:cancel | c'), true);

  // -- HUD counter fragments --
  assert('L4 filter: HUD counters "T:42 A 1 S:2"',
    isLayer4Chrome('T:42 A 1 S:2'), true);

  assert('L4 filter: HUD time patterns "4m  4m  4m"',
    isLayer4Chrome('5  4m  4m  4m'), true);

  assert('L4 filter: HUD fragment ":8% | T:38"',
    isLayer4Chrome(':8% | T:38'), true);

  assert('L4 filter: HUD fragment ":2 S:2"',
    isLayer4Chrome(':2 S:2'), true);

  // -- Auto-update messages (uncommitted fix) --
  assert('L4 filter: auto-update failed message',
    isLayer4Chrome('✗ Auto-update failed · Try claude doctor or npm i -g @ant…'), true);

  assert('L4 filter: switched from npm message',
    isLayer4Chrome('Claude Code has switched from npm to native installer. Run `claude install`…'), true);

  // True prompts — should NOT be filtered
  assert('L4 pass: real prompt "Enter password:"',
    isLayer4Chrome('Enter password:'), false);

  assert('L4 pass: real prompt "Do you want to proceed?"',
    isLayer4Chrome('Do you want to proceed?'), false);

  assert('L4 pass: real prompt "Select an option (1-5):"',
    isLayer4Chrome('Select an option (1-5):'), false);

  assert('L4 pass: bash prompt "user@host:~$"',
    isLayer4Chrome('user@host:~$'), false);

  assert('L4 pass: real prompt "Please confirm:"',
    isLayer4Chrome('Please confirm:'), false);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runAllTests();
