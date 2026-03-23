'use strict';

const { LineAssembler } = require('../line-assembler');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    console.error(`        expected: ${JSON.stringify(expected)}`);
    console.error(`        actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// Helper: build a text token
function text(content) { return { type: 'text', content }; }
function lf() { return { type: 'lf' }; }
function cr() { return { type: 'cr' }; }
function csi(params, final) { return { type: 'csi', params, final }; }
function osc(content) { return { type: 'osc', content }; }
function control(code) { return { type: 'control', code }; }

// ── Test: CR-overwrite (the core improvement) ────────────────────────────────
console.log('\n[CR-overwrite]');
{
  const a = new LineAssembler();
  // "Loading...\rPrompt?" → pending line should be "Prompt?"
  a.feed([text('Loading...'), cr(), text('Prompt?')]);
  assertEqual(a.getPendingLine(), 'Prompt?',
    '"Loading...\\rPrompt?" → pending line is "Prompt?"');

  // Shorter overwrite: "ABCDE\rXY" → "XY" (CR truncates the line, new text replaces from start)
  const a2 = new LineAssembler();
  a2.feed([text('ABCDE'), cr(), text('XY')]);
  assertEqual(a2.getRawPendingLine(), 'XY',
    '"ABCDE\\rXY" → raw pending line is "XY" (CR truncates old content)');
  assertEqual(a2.getPendingLine(), 'XY',
    '"ABCDE\\rXY" → trimmed pending line is "XY"');

  // Full overwrite: same length
  const a3 = new LineAssembler();
  a3.feed([text('Hello'), cr(), text('World')]);
  assertEqual(a3.getPendingLine(), 'World',
    '"Hello\\rWorld" → "World"');

  // CR then LF: completed line should be the overwritten content
  const a4 = new LineAssembler();
  a4.feed([text('Loading...'), cr(), text('Done'), lf()]);
  assertEqual(a4.getCompletedLines(), ['Done'],
    '"Loading...\\rDone\\n" → completed line is "Done"');
}

// ── Test: empty input ────────────────────────────────────────────────────────
console.log('\n[Empty input]');
{
  const a = new LineAssembler();
  a.feed([]);
  assertEqual(a.getCompletedLines(), [], 'empty tokens → no completed lines');
  assertEqual(a.getPendingLine(), '', 'empty tokens → empty pending line');
  assert(!a.hasPendingContent(), 'empty tokens → hasPendingContent() is false');
}

// ── Test: LF flushing ────────────────────────────────────────────────────────
console.log('\n[LF flushing]');
{
  const a = new LineAssembler();
  a.feed([text('hello'), lf(), text('world'), lf()]);
  assertEqual(a.getCompletedLines(), ['hello', 'world'],
    'two lines separated by LF → two completed lines');
  assertEqual(a.getPendingLine(), '', 'no pending content after trailing LF');

  // getCompletedLines() clears the buffer
  const a2 = new LineAssembler();
  a2.feed([text('line1'), lf()]);
  const first = a2.getCompletedLines();
  const second = a2.getCompletedLines();
  assertEqual(first, ['line1'], 'first call returns completed lines');
  assertEqual(second, [], 'second call returns empty (buffer cleared)');
}

// ── Test: rapid newlines ─────────────────────────────────────────────────────
console.log('\n[Rapid newlines]');
{
  const a = new LineAssembler();
  a.feed([lf(), lf(), lf()]);
  assertEqual(a.getCompletedLines(), ['', '', ''],
    'three consecutive LFs → three empty completed lines');
}

// ── Test: mixed CR/LF sequences ──────────────────────────────────────────────
console.log('\n[Mixed CR/LF sequences]');
{
  // Spinner pattern: "spinner\rspinner\rspinner\rPrompt?"
  const a = new LineAssembler();
  a.feed([
    text('|'), cr(),
    text('/'), cr(),
    text('-'), cr(),
    text('\\'), cr(),
    text('Prompt?'),
  ]);
  assertEqual(a.getPendingLine(), 'Prompt?',
    'spinner pattern (repeated CR-overwrite) → final value');

  // CRLF (both together): should flush as a completed line
  const a2 = new LineAssembler();
  a2.feed([text('line'), cr(), lf()]);
  assertEqual(a2.getCompletedLines(), ['line'],
    'CRLF (\\r\\n) → completed line with content (CR resets cursor, LF flushes)');

  // CR mid-line, then more content, then LF
  const a3 = new LineAssembler();
  a3.feed([text('foo'), cr(), text('bar'), lf(), text('baz')]);
  assertEqual(a3.getCompletedLines(), ['bar'],
    'CR-overwrite then LF produces correct completed line');
  assertEqual(a3.getPendingLine(), 'baz', 'content after LF is pending');
}

// ── Test: getPendingLine() vs getCompletedLines() ────────────────────────────
console.log('\n[getPendingLine vs getCompletedLines]');
{
  const a = new LineAssembler();
  a.feed([text('done'), lf(), text('pending')]);
  assertEqual(a.getCompletedLines(), ['done'],
    'getCompletedLines() returns only flushed lines');
  assertEqual(a.getPendingLine(), 'pending',
    'getPendingLine() returns current unflushed content');

  // getPendingLine trims whitespace
  const a2 = new LineAssembler();
  a2.feed([text('  hello  ')]);
  assertEqual(a2.getPendingLine(), 'hello',
    'getPendingLine() trims surrounding whitespace');

  // getRawPendingLine preserves whitespace
  const a3 = new LineAssembler();
  a3.feed([text('  hello  ')]);
  assertEqual(a3.getRawPendingLine(), '  hello  ',
    'getRawPendingLine() preserves leading/trailing whitespace');
}

// ── Test: hasPendingContent() ─────────────────────────────────────────────────
console.log('\n[hasPendingContent]');
{
  const a = new LineAssembler();
  assert(!a.hasPendingContent(), 'empty assembler → false');

  a.feed([text('   ')]);
  assert(!a.hasPendingContent(), 'whitespace-only pending → false');

  a.feed([text('x')]);
  assert(a.hasPendingContent(), 'content with non-whitespace → true');

  // After LF, content moves to completed — pending is empty
  const a2 = new LineAssembler();
  a2.feed([text('hello'), lf()]);
  assert(!a2.hasPendingContent(), 'after LF, no pending content');
}

// ── Test: reset() ────────────────────────────────────────────────────────────
console.log('\n[reset]');
{
  const a = new LineAssembler();
  a.feed([text('line1'), lf(), text('partial')]);
  a.reset();
  assertEqual(a.getCompletedLines(), [], 'reset clears completed lines');
  assertEqual(a.getPendingLine(), '', 'reset clears pending line');
  assert(!a.hasPendingContent(), 'reset clears pending content flag');

  // State after reset is fresh — can receive new content
  a.feed([text('fresh'), lf()]);
  assertEqual(a.getCompletedLines(), ['fresh'], 'assembler usable after reset');
}

// ── Test: cursor movement CSI C (forward) and D (back) ───────────────────────
console.log('\n[Cursor movement CSI C/D]');
{
  // CSI 3 C = move cursor forward 3
  const a = new LineAssembler();
  a.feed([text('AB'), csi([3], 'C'), text('X')]);
  // Cursor was at 2 after "AB", moves to 5, writes 'X' at position 5
  // Raw line: A B _ _ _ X
  const raw = a.getRawPendingLine();
  assertEqual(raw, 'AB   X', 'cursor forward 3 then write X → "AB   X"');

  // CSI D = move cursor back 1 (default)
  const a2 = new LineAssembler();
  a2.feed([text('ABC'), csi([], 'D'), text('X')]);
  // Cursor at 3, back 1 → cursor at 2, write 'X' at 2 overwrites 'C'
  assertEqual(a2.getPendingLine(), 'ABX', 'cursor back 1 overwrites last char');

  // CSI 2 D = move cursor back 2
  const a3 = new LineAssembler();
  a3.feed([text('ABCD'), csi([2], 'D'), text('XY')]);
  // Cursor at 4, back 2 → cursor at 2, write 'XY' at 2-3 overwrites 'CD'
  assertEqual(a3.getPendingLine(), 'ABXY', 'cursor back 2 overwrites last 2 chars');

  // Cursor back clamps at 0
  const a4 = new LineAssembler();
  a4.feed([text('Hi'), csi([999], 'D'), text('Z')]);
  assertEqual(a4.getPendingLine(), 'Zi', 'cursor back beyond start clamps at 0');
}

// ── Test: erase in line CSI K ─────────────────────────────────────────────────
console.log('\n[Erase in line CSI K]');
{
  // CSI 0 K (or CSI K) — erase from cursor to end
  const a = new LineAssembler();
  a.feed([text('Hello World'), csi([2], 'D'), csi([0], 'K')]);
  // "Hello World" cursor at 11, back 2 → cursor at 9, erase from 9 to end
  assertEqual(a.getPendingLine(), 'Hello Wor', 'erase to end of line (CSI 0 K)');

  // CSI K (no params — default 0) — erase from cursor to end
  const a2 = new LineAssembler();
  a2.feed([text('ABCDE'), csi([3], 'D'), csi([], 'K')]);
  // cursor at 5, back 3 → cursor at 2, erase 2..end
  assertEqual(a2.getPendingLine(), 'AB', 'erase to end with no params (CSI K)');

  // CSI 1 K — erase from start to cursor
  const a3 = new LineAssembler();
  a3.feed([text('ABCDE'), csi([3], 'D'), csi([1], 'K')]);
  // cursor at 5, back 3 → cursor at 2, erase 0..2 (inclusive)
  // Result: '   DE' (positions 0,1,2 become spaces)
  assertEqual(a3.getRawPendingLine(), '   DE', 'erase from start to cursor (CSI 1 K)');

  // CSI 2 K — erase entire line
  const a4 = new LineAssembler();
  a4.feed([text('Hello'), csi([2], 'K'), text('X')]);
  // Erase entire line (cursor stays at position 5), then write 'X' at position 5
  const raw4 = a4.getRawPendingLine();
  assertEqual(raw4, '     X', 'erase entire line (CSI 2 K), then write at cursor');
}

// ── Test: line length cap at 500 ─────────────────────────────────────────────
console.log('\n[Line length cap]');
{
  const a = new LineAssembler({ maxLineLength: 500 });
  const longText = 'A'.repeat(600);
  a.feed([text(longText)]);
  const raw = a.getRawPendingLine();
  assert(raw.length <= 500, `line capped at maxLineLength (got ${raw.length})`);
  assertEqual(raw.length, 500, 'line length is exactly 500');

  // Custom maxLineLength
  const a2 = new LineAssembler({ maxLineLength: 10 });
  a2.feed([text('12345678901234567890')]);
  const raw2 = a2.getRawPendingLine();
  assertEqual(raw2.length, 10, 'custom maxLineLength=10 enforced');
  assertEqual(raw2, '1234567890', 'content after cap is discarded');

  // Cursor movement doesn't bypass the cap
  const a3 = new LineAssembler({ maxLineLength: 5 });
  a3.feed([text('ABCDE'), csi([999], 'C'), text('X')]);
  assert(a3.getRawPendingLine().length <= 5, 'cursor forward beyond cap — write ignored');
}

// ── Test: ignored token types ─────────────────────────────────────────────────
console.log('\n[Ignored tokens]');
{
  const a = new LineAssembler();
  // OSC, control chars, and non-K/C/D CSI sequences should be ignored
  a.feed([
    text('Hello'),
    osc('0;title'),           // OSC ignored
    control(0x08),            // backspace control ignored
    csi([1, 32], 'm'),        // SGR (color) ignored
    csi([2, 'J'], 'J'),       // erase display — not K, ignored
    text(' World'),
  ]);
  assertEqual(a.getPendingLine(), 'Hello World',
    'OSC, control chars, and non-K/C/D CSI sequences are ignored');
}

// ── Test: multi-chunk state carryover ─────────────────────────────────────────
console.log('\n[Multi-chunk state carryover]');
{
  // Feed tokens in multiple calls — state should persist
  const a = new LineAssembler();
  a.feed([text('Hello')]);
  a.feed([text(' ')]);
  a.feed([text('World')]);
  assertEqual(a.getPendingLine(), 'Hello World',
    'state persists across multiple feed() calls');

  // CR across chunks
  const a2 = new LineAssembler();
  a2.feed([text('Loading...')]);
  a2.feed([cr()]);
  a2.feed([text('Prompt?')]);
  assertEqual(a2.getPendingLine(), 'Prompt?',
    'CR-overwrite works across separate feed() calls');

  // LF across chunks
  const a3 = new LineAssembler();
  a3.feed([text('line1')]);
  a3.feed([lf()]);
  a3.feed([text('line2')]);
  assertEqual(a3.getCompletedLines(), ['line1'], 'completed lines available after LF chunk');
  assertEqual(a3.getPendingLine(), 'line2', 'pending line correct after multi-chunk LF');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed.');
}
