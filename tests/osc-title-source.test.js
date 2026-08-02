'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOscTitleSource,
  isBrailleChar,
  isKnownIdleChar,
} = require('../detection/osc-title-source');

function bulletTitle(char) {
  return `\x1b]0;${char} Claude Code\x07`;
}

function collect(src) {
  const signals = [];
  src.on('signal', (s) => signals.push(s));
  return signals;
}

test('isBrailleChar recognises braille range U+2800-U+28FF', () => {
  assert.equal(isBrailleChar('⠂'), true);
  assert.equal(isBrailleChar('⣿'), true);
  assert.equal(isBrailleChar('✳'), false);
  assert.equal(isBrailleChar('A'), false);
  assert.equal(isBrailleChar(''), false);
  assert.equal(isBrailleChar(null), false);
});

test('isKnownIdleChar recognises U+2733 only', () => {
  assert.equal(isKnownIdleChar('✳'), true);
  assert.equal(isKnownIdleChar('A'), false);
  assert.equal(isKnownIdleChar('⠂'), false);
});

test('idle glyph without prior spinner does NOT emit ready', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createOscTitleSource({ stabilizationMs: 60 });
  const signals = collect(src);
  src.feed(bulletTitle('✳'));
  t.mock.timers.tick(150);
  assert.equal(signals.filter((s) => s.signal === 'ready').length, 0);
  src.destroy();
});

test('spinner emits working immediately (drives RUNNING/resume)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createOscTitleSource({ stabilizationMs: 60 });
  const signals = collect(src);
  src.feed(bulletTitle('⠂'));
  t.mock.timers.tick(10);
  assert.equal(signals[0].signal, 'working');
  assert.equal(signals[0].source, 'title');
  src.destroy();
});

test('spinner then stabilized idle emits ready exactly once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createOscTitleSource({ stabilizationMs: 60 });
  const signals = collect(src);
  src.feed(bulletTitle('⠂'));
  src.feed(bulletTitle('⠐'));
  src.feed(bulletTitle('✳'));
  t.mock.timers.tick(150);
  const ready = signals.filter((s) => s.signal === 'ready');
  assert.equal(ready.length, 1);
  assert.equal(ready[0].char, '✳');
  // working emitted once despite two spinner frames
  assert.equal(signals.filter((s) => s.signal === 'working').length, 1);
  src.destroy();
});

test('spinner returning mid-stabilization cancels ready', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createOscTitleSource({ stabilizationMs: 80 });
  const signals = collect(src);
  src.feed(bulletTitle('⠂'));
  src.feed(bulletTitle('✳'));
  t.mock.timers.tick(30);
  src.feed(bulletTitle('⠐'));
  t.mock.timers.tick(120);
  assert.equal(signals.filter((s) => s.signal === 'ready').length, 0);
  src.destroy();
});

test('OSC split across chunks still detected', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createOscTitleSource({ stabilizationMs: 50 });
  const signals = collect(src);
  src.feed('\x1b]0;⠂ Claude');
  src.feed(' Code\x07');
  src.feed('\x1b]0;');
  src.feed('✳ Claude Code\x07');
  t.mock.timers.tick(120);
  assert.equal(signals.filter((s) => s.signal === 'ready').length, 1);
  src.destroy();
});

test('reset clears state - idle alone after reset does not emit ready', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createOscTitleSource({ stabilizationMs: 50 });
  const signals = collect(src);
  src.feed(bulletTitle('⠂'));
  src.feed(bulletTitle('✳'));
  t.mock.timers.tick(120);
  assert.equal(signals.filter((s) => s.signal === 'ready').length, 1);
  src.reset();
  src.feed(bulletTitle('✳'));
  t.mock.timers.tick(120);
  assert.equal(signals.filter((s) => s.signal === 'ready').length, 1, 'no new ready after reset');
  src.destroy();
});

test('continuous spinner does NOT emit ready (false-positive regression)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createOscTitleSource({ stabilizationMs: 80 });
  const signals = collect(src);
  for (let i = 0; i < 10; i++) {
    src.feed(bulletTitle('⠂'));
    t.mock.timers.tick(15);
    src.feed(bulletTitle('⠐'));
    t.mock.timers.tick(15);
  }
  assert.equal(signals.filter((s) => s.signal === 'ready').length, 0);
  src.destroy();
});

test('pending buffer truncation does not corrupt subsequent parsing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createOscTitleSource({ stabilizationMs: 50 });
  const signals = collect(src);
  src.feed(`\x1b]0;noterm${'x'.repeat(9000)}`);
  src.feed('\x1b]0;⠂ Claude Code\x07');
  src.feed('\x1b]0;✳ Claude Code\x07');
  t.mock.timers.tick(120);
  assert.equal(signals.filter((s) => s.signal === 'ready').length, 1);
  src.destroy();
});

test('destroy prevents subsequent emissions', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createOscTitleSource({ stabilizationMs: 50 });
  const signals = collect(src);
  src.destroy();
  src.feed(bulletTitle('⠂'));
  src.feed(bulletTitle('✳'));
  t.mock.timers.tick(120);
  assert.equal(signals.length, 0);
});

test('unknown NON-ASCII glyph emits unknown, never ready', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createOscTitleSource({ stabilizationMs: 50 });
  const signals = collect(src);
  src.feed(bulletTitle('⠂')); // working first
  src.feed(bulletTitle('★')); // unrecognized symbol (U+2605) - candidate new glyph
  t.mock.timers.tick(120);
  assert.equal(signals.filter((s) => s.signal === 'unknown').length, 1);
  assert.equal(signals.filter((s) => s.signal === 'ready').length, 0);
  src.destroy();
});

test('ASCII window title (cmd.exe /c claude) emits NO signal', (t) => {
  // On Windows, Glissa spawns `cmd.exe /c claude`, and cmd sets the console title
  // to its command line ("C:\...\cmd.exe"). The leading 'C' is a generic window
  // title, not a Claude activity glyph - it must be dropped silently, never `unknown`.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createOscTitleSource({ stabilizationMs: 50 });
  const signals = collect(src);
  src.feed('\x1b]0;C:\\WINDOWS\\system32\\cmd.exe\x07');
  src.feed('\x1b]0;~/work - bash\x07');
  t.mock.timers.tick(120);
  assert.equal(signals.length, 0, 'ASCII window titles produce no signals at all');
  src.destroy();
});

test('non-Claude OSC titles never emit ready', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createOscTitleSource({ stabilizationMs: 50 });
  const signals = collect(src);
  src.feed('\x1b]0;~/work - bash\x07');
  src.feed('\x1b]0;random title\x07');
  t.mock.timers.tick(120);
  assert.equal(signals.filter((s) => s.signal === 'ready').length, 0);
  src.destroy();
});

test('source NEVER emits awaiting-input (honest fallback contract)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createOscTitleSource({ stabilizationMs: 40 });
  const signals = collect(src);
  src.feed(bulletTitle('⠂'));
  src.feed(bulletTitle('✳'));
  src.feed('\x1b]0;? prompt-ish\x07');
  t.mock.timers.tick(120);
  assert.equal(signals.filter((s) => s.signal === 'awaiting-input').length, 0);
  src.destroy();
});
