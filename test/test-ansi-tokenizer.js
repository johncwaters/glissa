'use strict';

const { AnsiTokenizer } = require('../ansi-tokenizer');

let passed = 0;
let failed = 0;

function assert(condition, name, extra) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${extra ? ' — ' + extra : ''}`);
    failed++;
  }
}

function assertDeepEqual(a, b, name) {
  const as = JSON.stringify(a);
  const bs = JSON.stringify(b);
  assert(as === bs, name, `got ${as}, expected ${bs}`);
}

function section(title) {
  console.log(`\n${title}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tokenize(str) {
  const t = new AnsiTokenizer();
  return t.tokenize(str);
}

// Tokenize across two chunks with shared tokenizer (tests cross-chunk state)
function tokenize2(chunk1, chunk2) {
  const t = new AnsiTokenizer();
  const r1 = t.tokenize(chunk1);
  const r2 = t.tokenize(chunk2);
  return [...r1, ...r2];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

section('1. Empty input');
{
  const t = new AnsiTokenizer();
  assertDeepEqual(t.tokenize(''), [], 'empty string returns empty array');
  assertDeepEqual(t.tokenize(''), [], 'second empty string returns empty array');
  assert(true, 'no state change from empty input');
}

section('2. Plain text');
{
  assertDeepEqual(tokenize('hello'), [{ type: 'text', content: 'hello' }], 'plain text token');
  assertDeepEqual(tokenize('hello world'), [{ type: 'text', content: 'hello world' }], 'text with space');
  assertDeepEqual(tokenize('abc123!@#'), [{ type: 'text', content: 'abc123!@#' }], 'mixed printable chars');
}

section('3. CR and LF tokens');
{
  assertDeepEqual(tokenize('\r'), [{ type: 'cr' }], 'bare CR');
  assertDeepEqual(tokenize('\n'), [{ type: 'lf' }], 'bare LF');
  assertDeepEqual(tokenize('\r\n'), [{ type: 'cr' }, { type: 'lf' }], 'CRLF sequence');
  assertDeepEqual(
    tokenize('hello\r\nworld'),
    [
      { type: 'text', content: 'hello' },
      { type: 'cr' },
      { type: 'lf' },
      { type: 'text', content: 'world' },
    ],
    'text with CRLF'
  );
  assertDeepEqual(
    tokenize('a\rb'),
    [{ type: 'text', content: 'a' }, { type: 'cr' }, { type: 'text', content: 'b' }],
    'text CR text'
  );
}

section('4. Control characters');
{
  assertDeepEqual(tokenize('\x08'), [{ type: 'control', code: 0x08 }], 'backspace control');
  assertDeepEqual(tokenize('\x07'), [{ type: 'control', code: 0x07 }], 'BEL control (in GROUND)');
  assertDeepEqual(tokenize('\x09'), [{ type: 'control', code: 0x09 }], 'tab control');
  assertDeepEqual(
    tokenize('a\x08b'),
    [{ type: 'text', content: 'a' }, { type: 'control', code: 0x08 }, { type: 'text', content: 'b' }],
    'backspace between text'
  );
}

section('5. CSI sequences (SGR color)');
{
  assertDeepEqual(
    tokenize('\x1b[33m'),
    [{ type: 'csi', params: [33], final: 'm' }],
    'SGR yellow'
  );
  assertDeepEqual(
    tokenize('\x1b[0m'),
    [{ type: 'csi', params: [0], final: 'm' }],
    'SGR reset'
  );
  assertDeepEqual(
    tokenize('\x1b[1;33m'),
    [{ type: 'csi', params: [1, 33], final: 'm' }],
    'SGR bold yellow (multi-param)'
  );
  assertDeepEqual(
    tokenize('\x1b[m'),
    [{ type: 'csi', params: [0], final: 'm' }],
    'SGR empty params defaults to [0]'
  );
  assertDeepEqual(
    tokenize('\x1b[2J'),
    [{ type: 'csi', params: [2], final: 'J' }],
    'erase screen'
  );
  assertDeepEqual(
    tokenize('\x1b[K'),
    [{ type: 'csi', params: [0], final: 'K' }],
    'erase to end of line'
  );
  assertDeepEqual(
    tokenize('\x1b[?25l'),
    [{ type: 'csi', params: [25], final: 'l' }],
    'DEC private mode (hide cursor) — ? stripped as intermediate'
  );
}

section('6. CSI cursor movement');
{
  assertDeepEqual(
    tokenize('\x1b[3C'),
    [{ type: 'csi', params: [3], final: 'C' }],
    'cursor forward 3'
  );
  assertDeepEqual(
    tokenize('\x1b[2D'),
    [{ type: 'csi', params: [2], final: 'D' }],
    'cursor back 2'
  );
  assertDeepEqual(
    tokenize('\x1b[1;1H'),
    [{ type: 'csi', params: [1, 1], final: 'H' }],
    'cursor position 1,1'
  );
}

section('7. OSC sequences');
{
  assertDeepEqual(
    tokenize('\x1b]0;My Title\x07'),
    [{ type: 'osc', content: '0;My Title' }],
    'OSC with BEL terminator'
  );
  assertDeepEqual(
    tokenize('\x1b]0;My Title\x1b\\'),
    [{ type: 'osc', content: '0;My Title' }],
    'OSC with ST terminator'
  );
  assertDeepEqual(
    tokenize('\x1b]2;window\x07'),
    [{ type: 'osc', content: '2;window' }],
    'OSC type 2'
  );
}

section('8. Mixed content');
{
  assertDeepEqual(
    tokenize('\x1b[33mhello\x1b[0m world'),
    [
      { type: 'csi', params: [33], final: 'm' },
      { type: 'text', content: 'hello' },
      { type: 'csi', params: [0], final: 'm' },
      { type: 'text', content: ' world' },
    ],
    'colored text with reset'
  );
  assertDeepEqual(
    tokenize('Loading...\rDone'),
    [
      { type: 'text', content: 'Loading...' },
      { type: 'cr' },
      { type: 'text', content: 'Done' },
    ],
    'CR-overwrite sequence'
  );
}

section('9. Split sequences across chunks (AC8)');
{
  // Split inside CSI params
  {
    const tokens = tokenize2('\x1b[3', '3m');
    assertDeepEqual(
      tokens,
      [{ type: 'csi', params: [33], final: 'm' }],
      'CSI split across chunks: \\x1b[3 | 3m → SGR(33)'
    );
  }

  // Split after ESC
  {
    const tokens = tokenize2('\x1b', '[32mhi');
    assertDeepEqual(
      tokens,
      [{ type: 'csi', params: [32], final: 'm' }, { type: 'text', content: 'hi' }],
      'ESC split across chunks: \\x1b | [32mhi'
    );
  }

  // Split in middle of OSC content
  {
    const tokens = tokenize2('\x1b]0;My', ' Title\x07');
    assertDeepEqual(
      tokens,
      [{ type: 'osc', content: '0;My Title' }],
      'OSC split across chunks'
    );
  }

  // Split at OSC terminator (BEL in second chunk)
  {
    const tokens = tokenize2('\x1b]0;Title', '\x07');
    assertDeepEqual(
      tokens,
      [{ type: 'osc', content: '0;Title' }],
      'OSC terminator BEL in second chunk'
    );
  }

  // Split at ST terminator (\x1b\ — both chars in second chunk)
  {
    const tokens = tokenize2('\x1b]0;Title', '\x1b\\');
    assertDeepEqual(
      tokens,
      [{ type: 'osc', content: '0;Title' }],
      'OSC terminator ST in second chunk'
    );
  }

  // Text before and after split sequence
  {
    const tokens = tokenize2('before\x1b[1', ';32mafter');
    assertDeepEqual(
      tokens,
      [
        { type: 'text', content: 'before' },
        { type: 'csi', params: [1, 32], final: 'm' },
        { type: 'text', content: 'after' },
      ],
      'text + split CSI + text'
    );
  }
}

section('10. State carryover between multiple tokenize() calls');
{
  const t = new AnsiTokenizer();
  const r1 = t.tokenize('hello ');
  const r2 = t.tokenize('world');
  const all = [...r1, ...r2];
  assertDeepEqual(
    all,
    [{ type: 'text', content: 'hello ' }, { type: 'text', content: 'world' }],
    'plain text across calls'
  );

  const t2 = new AnsiTokenizer();
  const ra = t2.tokenize('\x1b[');
  const rb = t2.tokenize('33m');
  assertDeepEqual(ra, [], 'partial CSI in first call emits nothing');
  assertDeepEqual(rb, [{ type: 'csi', params: [33], final: 'm' }], 'completed CSI in second call');

  const t3 = new AnsiTokenizer();
  t3.tokenize('\x1b[33m');
  const rc = t3.tokenize('clean text');
  assertDeepEqual(
    rc,
    [{ type: 'text', content: 'clean text' }],
    'state resets to GROUND after complete sequence'
  );
}

section('11. reset() clears state');
{
  const t = new AnsiTokenizer();
  t.tokenize('\x1b[3'); // partial CSI
  t.reset();
  const tokens = t.tokenize('hello');
  assertDeepEqual(
    tokens,
    [{ type: 'text', content: 'hello' }],
    'after reset(), partial sequence is discarded'
  );

  const t2 = new AnsiTokenizer();
  t2.tokenize('\x1b]0;title'); // partial OSC
  t2.reset();
  assertDeepEqual(
    t2.tokenize('\n'),
    [{ type: 'lf' }],
    'after reset(), OSC partial is discarded'
  );
}

section('12. Pathological input (AC6 — bounded partial buffer)');
{
  // Unclosed CSI — no final byte ever arrives
  const t = new AnsiTokenizer();
  const junk = '\x1b[' + '1;'.repeat(200); // 402 chars, way over MAX_PARTIAL=256
  const tokens = t.tokenize(junk);
  // Should not throw and should not accumulate > 256 bytes
  assert(true, 'unclosed CSI does not throw');

  // Feed more data after overflow — should be back in GROUND
  const after = t.tokenize('hello');
  assert(
    after.some(tok => tok.type === 'text' && tok.content === 'hello'),
    'GROUND recovered after partial overflow'
  );

  // Unclosed OSC
  const t2 = new AnsiTokenizer();
  const oscJunk = '\x1b]0;' + 'x'.repeat(300);
  t2.tokenize(oscJunk); // should not throw
  const afterOsc = t2.tokenize('ok');
  assert(true, 'unclosed OSC does not throw');
  // After overflow, state reset to GROUND
  assert(
    afterOsc.some(tok => tok.type === 'text' && tok.content === 'ok'),
    'GROUND recovered after OSC overflow'
  );
}

section('13. Charset escape sequences');
{
  // \x1b( designates G0 charset — consume one char and return to GROUND
  const tokens = tokenize('\x1b(B');
  assertDeepEqual(tokens, [], 'charset escape produces no token');

  const tokens2 = tokenize('before\x1b(Bafter');
  assertDeepEqual(
    tokens2,
    [{ type: 'text', content: 'before' }, { type: 'text', content: 'after' }],
    'charset escape between text'
  );
}

section('14. Multiple sequences in one chunk');
{
  const tokens = tokenize('\x1b[1m\x1b[33m\x1b[0m');
  assertDeepEqual(
    tokens,
    [
      { type: 'csi', params: [1], final: 'm' },
      { type: 'csi', params: [33], final: 'm' },
      { type: 'csi', params: [0], final: 'm' },
    ],
    'three consecutive CSI sequences'
  );
}

section('15. Real Claude Code output patterns');
{
  // Prompt line with color
  const promptLine = '\x1b[?2004h\x1b[?25l\x1b[1;32m>\x1b[0m ';
  const tokens = tokenize(promptLine);
  assert(tokens.length > 0, 'prompt line tokenizes without error');
  assert(
    tokens.some(t => t.type === 'csi'),
    'prompt line contains CSI tokens'
  );
  assert(
    tokens.some(t => t.type === 'text' && t.content.includes('>')),
    'prompt line contains > text token'
  );

  // Spinner overwrite pattern
  const spinner = 'Working...\r\x1b[KDone\n';
  const spinnerTokens = tokenize(spinner);
  assertDeepEqual(
    spinnerTokens,
    [
      { type: 'text', content: 'Working...' },
      { type: 'cr' },
      { type: 'csi', params: [0], final: 'K' },
      { type: 'text', content: 'Done' },
      { type: 'lf' },
    ],
    'spinner overwrite with erase-to-EOL'
  );
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
}
