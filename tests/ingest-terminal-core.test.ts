import test from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalAccumulator, TerminalIngestEvent } from '../server/core/ingest-terminal-core.ts';

import {
  DEFAULT_ACCUMULATOR_BYTES,
  DEFAULT_WINDOW_BYTES,
  TRUNCATION_NOTE,
  appendChunk,
  cleanOutput,
  createTerminalAccumulator,
  flushAccumulator,
  rebaseline,
  segmentLines,
  stripAnsi,
  summarize,
} from '../server/core/ingest-terminal-core.ts';

const NOW = 1700000000000;
const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);

const SPINNER = String.fromCharCode(0x273B);
const SPINNER_ALT = String.fromCharCode(0x2736);
const SPINNER_STAR = String.fromCharCode(0x2722);
const SPINNER_FLOWER = String.fromCharCode(0x273D);
const DOTS = String.fromCharCode(0x2026);
const RULE = String.fromCharCode(0x2500);
const MIDDOT = String.fromCharCode(0xB7);
const UP_ARROW = String.fromCharCode(0x2191);
const WARPING = `Warping${DOTS}`;

const cup = (row: number, col: number) => `${ESC}[${row};${col}H`;
const el = (mode: string | number) => `${ESC}[${mode}K`;
const ed = (mode: string | number) => `${ESC}[${mode}J`;

function accumulator(overrides = {}) {
  return createTerminalAccumulator({ sessionId: 's1', root: '/repo', ...overrides });
}

function flushAll(state: TerminalAccumulator, chunks: string[]) {
  const events: TerminalIngestEvent[] = [];
  for (const chunk of chunks) {
    appendChunk(state, chunk);
    const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
    if (event) events.push(event);
  }
  return events;
}

test('CSI colour and cursor sequences are stripped, the text between them is not', () => {
  const raw = `${ESC}[32mPASS${ESC}[0m tests/app.test.js${ESC}[2K${ESC}[1G`;
  assert.equal(stripAnsi(raw), 'PASS tests/app.test.js');
});

test('an OSC title sequence is stripped whole', () => {
  assert.equal(stripAnsi(`${ESC}]0;claude working${BELL}building`), 'building');
});

test('stray control bytes go, but tabs and newlines survive the strip', () => {
  const raw = `line one\n\tindented${String.fromCharCode(0)}${String.fromCharCode(8)}`;
  assert.equal(stripAnsi(raw), 'line one\n\tindented');
});

test('a lone carriage return means the line was rewritten, so only the last write survives', () => {
  assert.equal(cleanOutput('10%\r50%\r100% done\n'), '100% done');
});

test('crlf is a line break, not a rewrite', () => {
  assert.equal(cleanOutput('first\r\nsecond\r\n'), 'first\nsecond');
});

test('a run of blank lines collapses so a redraw does not fill the ring with nothing', () => {
  assert.equal(cleanOutput('start\n\n\n\n\nend'), 'start\n\nend');
});

test('the summary is one line: the tail of the output, folded', () => {
  assert.equal(summarize('first line\nsecond line'), 'first line second line');
  const long = 'abcdefghij'.repeat(10);
  assert.equal(summarize(long, 20), long.slice(-20));
});

test('the accumulator keeps only its newest bytes at the pre-strip cap', () => {
  const state = accumulator({ accumulatorBytes: 64 });
  for (let index = 0; index < 40; index += 1) appendChunk(state, `chunk-${index} `);
  assert.ok(state.pendingBytes <= 64, `held ${state.pendingBytes} bytes`);
  assert.equal(state.truncated, true);
  assert.ok(state.pending.endsWith('chunk-39 '));
});

test('a slice that lands mid-codepoint drops the partial character rather than decoding it as noise', () => {
  const state = accumulator({ accumulatorBytes: 8 });
  appendChunk(state, 'aaaa');

  appendChunk(state, 'ααααα');
  assert.ok(!state.pending.includes(String.fromCharCode(0xFFFD)));
  assert.ok(state.pendingBytes <= 8);
});

test('past the window budget a chunk is DROPPED, never queued, and the event says so', () => {
  const state = accumulator({ accumulatorBytes: 1024, windowBytes: 100 });

  appendChunk(state, `${'a'.repeat(120)}\n`);
  const before = state.pendingBytes;
  appendChunk(state, `${'b'.repeat(5000)}\n`);
  assert.equal(state.pendingBytes, before, 'the over-budget chunk must not be appended');
  assert.ok(!state.pending.includes('b'));
  const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
  assert.ok(event.summary.endsWith(`[${TRUNCATION_NOTE}]`));
  assert.equal(event.detail.truncated, true);
  assert.ok(event.detail.droppedBytes >= 5000);
});

test('a flush inside every bound carries no truncation note', () => {
  const state = accumulator();
  appendChunk(state, 'npm test\n42 passing\n');
  const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
  assert.equal(event.summary, 'npm test 42 passing');
  assert.equal(event.detail.truncated, false);
  assert.equal(event.detail.droppedBytes, 0);
  assert.ok(!event.summary.includes(TRUNCATION_NOTE));
});

test('one flush window coalesces into exactly one event carrying the session and root scope', () => {
  const state = accumulator();
  appendChunk(state, 'first\n');
  appendChunk(state, 'second\n');
  appendChunk(state, 'third\n');
  const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
  assert.equal(event.source, 'terminal');
  assert.equal(event.kind, 'output');
  assert.equal(event.ts, NOW);
  assert.deepEqual(event.scope, { root: '/repo', sessionId: 's1' });
  assert.equal(event.detail.text, 'first\nsecond\nthird');
  assert.equal(flushAccumulator(state, { now: NOW }), null, 'a drained window publishes nothing');
});

test('a window of pure escape sequences cleans away to nothing and publishes no event', () => {
  const state = accumulator();
  appendChunk(state, `${ESC}[2J${ESC}[H${ESC}[?25l`);
  assert.equal(flushAccumulator(state, { now: NOW }), null);
});

test('a flush resets the window budget, so the next window starts with its full allowance', () => {
  const state = accumulator({ accumulatorBytes: 1024, windowBytes: 100 });
  appendChunk(state, `${'x'.repeat(200)}\n`);
  flushAccumulator(state, { now: NOW });
  assert.equal(state.windowBytesSeen, 0);
  appendChunk(state, 'after the flush\n');
  const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
  assert.equal(event.summary, 'after the flush');
});

test('rebaseline clears the accumulator: the screen was rewritten, so pending bytes describe nothing', () => {
  const state = accumulator();
  appendChunk(state, 'output that is about to be redrawn away');
  rebaseline(state);
  assert.equal(state.pending, '');
  assert.equal(state.pendingBytes, 0);
  assert.equal(state.truncated, false);
  assert.equal(flushAccumulator(state, { now: NOW }), null);
});

test('a multi-MB burst stays inside both caps and yields one bounded event', () => {
  const state = accumulator();
  const chunk = `${ESC}[32mbuilding module ${'z'.repeat(4000)}${ESC}[0m\n`;
  let pushed = 0;

  while (pushed < 3 * 1024 * 1024) {
    appendChunk(state, chunk);
    pushed += Buffer.byteLength(chunk, 'utf8');
    assert.ok(state.pendingBytes <= DEFAULT_ACCUMULATOR_BYTES, `accumulator grew to ${state.pendingBytes}`);
  }
  assert.ok(state.windowBytesSeen > DEFAULT_WINDOW_BYTES);
  const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
  assert.ok(event.summary.length <= 420, `summary is ${event.summary.length} chars`);
  assert.ok(event.detail.text.length <= 1000, `detail text is ${event.detail.text.length} chars`);
  assert.equal(event.detail.truncated, true);
  assert.equal(state.pendingBytes, 0);
});

test('a secret straddling the summary cut is scrubbed, not decapitated into a bare value', () => {
  const state = accumulator();

  appendChunk(state, `${'x'.repeat(200)} api_key=sk-live-DEADBEEFCAFEBABE${'z'.repeat(376)}\n`);
  const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
  assert.ok(!event.summary.includes('sk-live-DEADBEEFCAFEBABE'), `leaked: ${event.summary.slice(0, 60)}`);
  assert.ok(!event.detail.text.includes('sk-live-DEADBEEFCAFEBABE'));
});

test('the secret is scrubbed at EVERY offset the cut could land on', () => {
  for (let lead = 340; lead <= 420; lead += 1) {
    const state = accumulator();
    appendChunk(state, `${'x'.repeat(lead)} api_key=sk-live-DEADBEEFCAFEBABE ${'z'.repeat(30)}\n`);
    const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
    assert.ok(!event.summary.includes('sk-live-DEADBEEFCAFEBABE'), `leaked in summary at lead=${lead}`);
    assert.ok(!event.detail.text.includes('sk-live-DEADBEEFCAFEBABE'), `leaked in detail at lead=${lead}`);
  }
});

test('the truncation note survives the scrub expanding the text it shares a budget with', () => {
  const state = accumulator({ accumulatorBytes: 1024, windowBytes: 100 });
  appendChunk(state, `${'x'.repeat(120)} password=hunter2 ${'y'.repeat(400)}\n`);
  appendChunk(state, `${'b'.repeat(5000)}\n`);
  const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
  assert.ok(event.summary.endsWith(`[${TRUNCATION_NOTE}]`), `note lost: ${event.summary.slice(-40)}`);
  assert.ok(event.summary.length <= 400, `summary is ${event.summary.length} chars`);
  assert.ok(!event.summary.includes('hunter2'));
});

test('the accumulator cap cuts on a line boundary, so a secret line is dropped whole or kept whole', () => {
  const state = accumulator({ accumulatorBytes: 200 });

  appendChunk(state, `${'x'.repeat(180)}\napi_key=sk-live-DEADBEEFCAFEBABE\n${'z'.repeat(150)}\n`);
  assert.ok(state.pendingBytes <= 200);
  assert.equal(state.pending.startsWith('sk-live-'), false, 'the cut must not orphan a bare value');
  const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
  assert.ok(!event.summary.includes('sk-live-DEADBEEFCAFEBABE'));
  assert.ok(!event.detail.text.includes('sk-live-DEADBEEFCAFEBABE'));
});

test('a window with no line break holds its bytes and publishes once the line finishes', () => {
  const state = accumulator({ accumulatorBytes: 64 });
  appendChunk(state, 'q'.repeat(500));
  assert.ok(state.pendingBytes > 0, 'one enormous line must still be held');
  assert.ok(state.pendingBytes <= 64);
  assert.equal(flushAccumulator(state, { now: NOW }), null, 'an unfinished line is not output yet');
  assert.ok(state.pendingBytes > 0, 'and holding it is what lets it finish later');

  appendChunk(state, '\n');
  const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
  assert.ok(event.summary.length > 0);

  assert.ok(event.summary.endsWith(`[${TRUNCATION_NOTE}]`), event.summary.slice(-40));
  assert.equal(state.pendingBytes, 0);
});

test('a repaint frame writes cells at positions, so it forms no line and publishes nothing', () => {
  const state = accumulator();
  const frame = [
    cup(1, 1), ed(2),
    cup(2, 3), SPINNER, cup(2, 5), WARPING,
    cup(9, 12), 'th', cup(9, 14), 'e',
    cup(24, 1), el(2), RULE.repeat(40),
  ].join('');

  assert.deepEqual(flushAll(state, Array.from({ length: 50 }, () => frame)), []);
});

test('the spinner cycling in one cell publishes nothing', () => {
  const state = accumulator();

  const raw = [SPINNER, SPINNER_ALT, '*', SPINNER_STAR]
    .map((glyph) => `${cup(2, 3)}${glyph}`)
    .join('');
  assert.deepEqual(flushAll(state, [raw, raw, raw]), []);
});

test('the interleaved label and cell writes publish nothing', () => {
  const state = accumulator();

  const raw = [
    cup(2, 3), SPINNER, cup(2, 5), WARPING, cup(9, 12), 'th',
    cup(2, 3), SPINNER_FLOWER, cup(2, 5), WARPING, cup(9, 14), 'e',
    cup(2, 5), WARPING, cup(9, 15), 'n',
    cup(2, 5), WARPING, cup(9, 16), 'a', cup(2, 20), '4',
  ].join('');
  assert.deepEqual(flushAll(state, [raw, raw]), []);
});

test('the token-count status region publishes nothing', () => {
  const state = accumulator();

  const raw = [
    cup(2, 5), WARPING, cup(2, 20), `501s ${MIDDOT} ${UP_ARROW} 37.1k token`,
    cup(2, 41), '2', cup(2, 5), WARPING, cup(2, 3), SPINNER,
    cup(2, 5), WARPING, cup(2, 42), 's', cup(2, 5), WARPING,
    cup(2, 43), '1t', cup(2, 3), SPINNER_ALT, cup(2, 44), '4',
  ].join('');
  assert.deepEqual(flushAll(state, [raw, raw]), []);
});

test('a wrapped paragraph redrawn region by region publishes nothing', () => {
  const state = accumulator();

  const raw = [
    cup(5, 1), 'F', cup(5, 10), '-start ',
    cup(6, 1), 'ailing of', cup(6, 20), 'Claude/Codex/Grok',
    cup(7, 1), 'transcripts,', cup(7, 20), 'agent-turn/agent-tool',
    cup(8, 1), 'events',
  ].join('');
  assert.deepEqual(flushAll(state, [raw, raw]), []);
});

test('single-cell overwrites publish nothing, however many land in one window', () => {
  const state = accumulator();

  const cells = ['j', 'u', 'n', '8', 'k', '7', 't', '8', '8', '5', 'i', 's', ',', '6', 'a', 'l'];
  const raw = cells.map((cell, index) => `${cup(3 + (index % 4), 10 + index)}${cell}`).join('');
  assert.deepEqual(flushAll(state, [raw, raw]), []);
});

test('the status bar rule and its label publish nothing', () => {
  const state = accumulator();

  const raw = `${cup(24, 1)}${el(2)}${RULE.repeat(60)}${cup(24, 62)}Model: Fable`;
  assert.deepEqual(flushAll(state, [raw, raw, raw]), []);
});

test('a mixed window publishes the clean lines and none of the repaint around them', () => {
  const state = accumulator();
  appendChunk(state, [
    cup(1, 1), ed(2), cup(2, 3), SPINNER, cup(2, 5), WARPING,
    cup(9, 12), 'th', cup(9, 14), 'e',
    cup(20, 1), 'the last painted row\n',
    'npm run build\r\n',
    '> glissa@1.0.0 build\r\n',
    cup(24, 1), el(2), RULE.repeat(20), 'Model: Fable\n',
    'built in 4.2s\r\n',
    cup(2, 3), SPINNER,
  ].join(''));
  const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
  assert.equal(event.detail.text, 'npm run build\n> glissa@1.0.0 build\nbuilt in 4.2s');
  assert.equal(event.summary, 'npm run build > glissa@1.0.0 build built in 4.2s');

  assert.ok(state.pendingBytes > 0);
  assert.equal(flushAccumulator(state, { now: NOW }), null);
});

test('plain CRLF shell output is untouched by any of this', () => {
  const state = accumulator();
  appendChunk(state, 'ls -la\r\ntotal 48\r\ndrwxr-xr-x  8 johnw  staff  256 Aug 21 10:00 .\r\n');
  const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
  assert.equal(event.detail.text, 'ls -la\ntotal 48\ndrwxr-xr-x  8 johnw  staff  256 Aug 21 10:00 .');
});

test('colour sequences are not motion, so a coloured build log publishes in full', () => {
  const state = accumulator();
  appendChunk(state, `${ESC}[32mPASS${ESC}[0m tests/app.test.js\n${ESC}[31mFAIL${ESC}[0m tests/b.test.js\n`);
  const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
  assert.equal(event.detail.text, 'PASS tests/app.test.js\nFAIL tests/b.test.js');
});

test('an erase that reaches forward from the cursor does not cost the line it ends', () => {
  const state = accumulator();

  appendChunk(state, `${ESC}[32mPASS${ESC}[0m tests/app.test.js${el(0)}\n`);
  assert.equal((flushAccumulator(state, { now: NOW }) as TerminalIngestEvent).detail.text, 'PASS tests/app.test.js');
});

test('a progress bar rewriting its line in place publishes the line it settled on', () => {
  const state = accumulator();
  appendChunk(state, `\r${el(2)}downloading 10%\r${el(2)}downloading 60%\r${el(2)}downloading 100%\n`);
  assert.equal((flushAccumulator(state, { now: NOW }) as TerminalIngestEvent).detail.text, 'downloading 100%');
});

test('an alternate screen switch drops whatever was being collected, because that screen is gone', () => {
  const state = accumulator();
  appendChunk(state, `half a line${ESC}[?1049hfrom the other screen\n`);
  assert.equal(flushAccumulator(state, { now: NOW }), null);
});

test('a window that settles on the text already published does not publish it again', () => {
  const state = accumulator();
  appendChunk(state, 'watching for changes\n');
  assert.equal((flushAccumulator(state, { now: NOW }) as TerminalIngestEvent).detail.text, 'watching for changes');

  appendChunk(state, 'watching for changes\n');
  assert.equal(flushAccumulator(state, { now: NOW }), null, 'the same screen is not new output');

  appendChunk(state, 'rebuilding\n');
  assert.equal((flushAccumulator(state, { now: NOW }) as TerminalIngestEvent).detail.text, 'rebuilding');

  appendChunk(state, 'watching for changes\n');
  assert.equal((flushAccumulator(state, { now: NOW }) as TerminalIngestEvent).detail.text, 'watching for changes');
});

test('the duplicate gate is per accumulator, so one session cannot mute another', () => {
  const first = accumulator({ sessionId: 'a' });
  const second = accumulator({ sessionId: 'b' });
  appendChunk(first, 'same output\n');
  appendChunk(second, 'same output\n');
  assert.ok(flushAccumulator(first, { now: NOW }));
  assert.ok(flushAccumulator(second, { now: NOW }));
});

test('a rebaseline clears the duplicate gate, so the restarted process publishes its first line', () => {
  const state = accumulator();
  appendChunk(state, 'watching for changes\n');
  assert.equal((flushAccumulator(state, { now: NOW }) as TerminalIngestEvent).detail.text, 'watching for changes');

  rebaseline(state);
  appendChunk(state, 'watching for changes\n');
  const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
  assert.ok(event, 'the new stream must not be gated on the dead one');
  assert.equal(event.detail.text, 'watching for changes');
});

test('segmentLines keeps linear lines, drops repositioned fragments, and carries the tail', () => {
  const segmented = segmentLines(`first\n${cup(4, 9)}fragment\nsecond\nunfinished`);
  assert.deepEqual(segmented.lines, ['first', 'second']);
  assert.equal(segmented.carry, 'unfinished');
});

test('segmentLines carries the RAW tail, so its escape context survives into the next window', () => {
  const segmented = segmentLines(`done\n${cup(2, 3)}${SPINNER}`);
  assert.deepEqual(segmented.lines, ['done']);
  assert.equal(segmented.carry, `${cup(2, 3)}${SPINNER}`);

  assert.deepEqual(segmentLines(segmented.carry).lines, []);
});

test('a newline restores a known position, so output after a repaint is linear again', () => {
  assert.deepEqual(segmentLines(`${cup(1, 1)}painted\nlinear\n`).lines, ['linear']);
});

test('every erase mode is read off its parameter rather than guessed', () => {
  assert.deepEqual(segmentLines(`kept${el(0)}\n`).lines, ['kept']);
  assert.deepEqual(segmentLines(`kept${ESC}[K\n`).lines, ['kept'], 'no parameter means mode 0');
  assert.deepEqual(segmentLines(`gone${el(1)}\n`).lines, []);
  assert.deepEqual(segmentLines(`gone${el(2)}\n`).lines, []);
  assert.deepEqual(segmentLines(`kept${ed(0)}\n`).lines, ['kept']);
  assert.deepEqual(segmentLines(`gone${ed(2)}\n`).lines, []);
});

test('the line a repaint fragment landed on is dropped whole, fragment and all', () => {
  const segmented = segmentLines(`${cup(3, 7)}fragment and then real output\nthe next line\n`);
  assert.deepEqual(segmented.lines, ['the next line']);
});

test('an omitted first erase parameter is mode 0, however many digits follow it', () => {
  assert.deepEqual(segmentLines(`kept${ESC}[;2K\n`).lines, ['kept']);
  assert.deepEqual(segmentLines(`kept${ESC}[;3J\n`).lines, ['kept']);
  assert.deepEqual(segmentLines(`kept${ESC}[0;2K\n`).lines, ['kept'], 'an explicit 0 is still forward');
  assert.deepEqual(segmentLines(`gone${ESC}[2;0K\n`).lines, [], 'and a leading 2 still reaches back');
});

test('each segmentation token keeps its own meaning with an OSC in the same window', () => {
  const osc = `${ESC}]0;claude working${BELL}`;
  assert.deepEqual(segmentLines(`${osc}plain line\n`).lines, ['plain line'], 'OSC alone is not motion');
  assert.deepEqual(segmentLines(`${osc}${cup(4, 2)}moved\n`).lines, [], 'motion still poisons');
  assert.deepEqual(segmentLines(`${osc}saved${ESC}7moved\n`).lines, [], 'DECSC still poisons');
  assert.deepEqual(segmentLines(`${osc}gone${ed(2)}\n`).lines, [], 'erase display still clears');
  assert.deepEqual(segmentLines(`${osc}gone${el(2)}\n`).lines, [], 'erase line still clears');
  assert.deepEqual(segmentLines(`${osc}gone${ESC}[?1049h\n`).lines, [], 'alt screen still clears');
  assert.deepEqual(segmentLines(`${osc}${ESC}[32mcoloured\n`).lines, ['coloured'], 'SGR taints nothing');
});

test('a blank line is real output, but a line something erased is not', () => {
  assert.deepEqual(segmentLines('first\n\nsecond\n').lines, ['first', '', 'second']);
  assert.deepEqual(segmentLines(`first\ngone${el(2)}\nsecond\n`).lines, ['first', 'second']);
  const RETURN = String.fromCharCode(13);
  assert.deepEqual(segmentLines(`10%${RETURN}${el(2)}\n`).lines, [], 'a line rewritten away is gone');
});

test('a paragraph break in a build log survives to the published text', () => {
  const state = accumulator();
  appendChunk(state, 'FAIL tests/app.test.js\n\n  expected 1 to equal 2\n');
  const event = flushAccumulator(state, { now: NOW }) as TerminalIngestEvent;
  assert.equal(event.detail.text, 'FAIL tests/app.test.js\n\n  expected 1 to equal 2');
});

test('a window of nothing but blank lines still publishes nothing', () => {
  const state = accumulator();
  appendChunk(state, '\n\n\n\n');
  assert.equal(flushAccumulator(state, { now: NOW }), null);
});

test('an OSC payload holding a literal newline reads the same however the flush window splits it', () => {
  const raw = `${ESC}]133;C;cmd\nline two\nline three${BELL}after the osc\n`;

  const whole = accumulator();
  appendChunk(whole, raw);
  const expected = (flushAccumulator(whole, { now: NOW }) as TerminalIngestEvent).detail.text;
  assert.equal(expected, 'line two\nline threeafter the osc');

  for (let split = 1; split < raw.length; split += 1) {
    const state = accumulator();
    const published = flushAll(state, [raw.slice(0, split), raw.slice(split)])
      .map((event) => event.detail.text)
      .join('\n');
    assert.equal(published, expected, `split at ${split} changed the output`);
  }
});

test('the carry never begins inside a sequence the walker matched', () => {
  const segmented = segmentLines(`${ESC}]0;title${BELL}done\n${ESC}]0;half a title`);
  assert.deepEqual(segmented.lines, ['done']);
  assert.equal(segmented.carry, `${ESC}]0;half a title`);
});
