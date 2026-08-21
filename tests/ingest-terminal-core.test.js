'use strict';

// The terminal ingest pure core (docs/plan-ingestion.md, M6): the accumulator's pre-strip cap, ANSI
// stripping, the drop-not-queue window budget with its truncation note, the rebaseline clear, and the
// multi-MB burst that has to stay inside every one of those bounds.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_ACCUMULATOR_BYTES,
  DEFAULT_WINDOW_BYTES,
  TRUNCATION_NOTE,
  appendChunk,
  cleanOutput,
  createTerminalAccumulator,
  flushAccumulator,
  rebaseline,
  stripAnsi,
  summarize,
} = require('../server/core/ingest-terminal-core');

const NOW = 1700000000000;
const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);

function accumulator(overrides = {}) {
  return createTerminalAccumulator({ sessionId: 's1', root: '/repo', ...overrides });
}

// --- ANSI and cleanup -----------------------------------------------------

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

// --- Accumulator ----------------------------------------------------------

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
  // Three bytes each, so a byte-exact tail cut would land inside one of them.
  appendChunk(state, 'ααααα');
  assert.ok(!state.pending.includes(String.fromCharCode(0xFFFD)));
  assert.ok(state.pendingBytes <= 8);
});

test('past the window budget a chunk is DROPPED, never queued, and the event says so', () => {
  const state = accumulator({ accumulatorBytes: 1024, windowBytes: 100 });
  appendChunk(state, 'a'.repeat(120));
  const before = state.pendingBytes;
  appendChunk(state, 'b'.repeat(5000));
  assert.equal(state.pendingBytes, before, 'the over-budget chunk must not be appended');
  assert.ok(!state.pending.includes('b'));
  const event = flushAccumulator(state, { now: NOW });
  assert.ok(event.summary.endsWith(`[${TRUNCATION_NOTE}]`));
  assert.equal(event.detail.truncated, true);
  assert.ok(event.detail.droppedBytes >= 5000);
});

test('a flush inside every bound carries no truncation note', () => {
  const state = accumulator();
  appendChunk(state, 'npm test\n42 passing\n');
  const event = flushAccumulator(state, { now: NOW });
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
  const event = flushAccumulator(state, { now: NOW });
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
  appendChunk(state, 'x'.repeat(200));
  flushAccumulator(state, { now: NOW });
  assert.equal(state.windowBytesSeen, 0);
  appendChunk(state, 'after the flush\n');
  const event = flushAccumulator(state, { now: NOW });
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
  // 3MB through the tap in one window, the npm-install storm the plan bounds at the adapter boundary.
  while (pushed < 3 * 1024 * 1024) {
    appendChunk(state, chunk);
    pushed += Buffer.byteLength(chunk, 'utf8');
    assert.ok(state.pendingBytes <= DEFAULT_ACCUMULATOR_BYTES, `accumulator grew to ${state.pendingBytes}`);
  }
  assert.ok(state.windowBytesSeen > DEFAULT_WINDOW_BYTES);
  const event = flushAccumulator(state, { now: NOW });
  assert.ok(event.summary.length <= 420, `summary is ${event.summary.length} chars`);
  assert.ok(event.detail.text.length <= 1000, `detail text is ${event.detail.text.length} chars`);
  assert.equal(event.detail.truncated, true);
  assert.equal(state.pendingBytes, 0);
});

// --- The scrub runs before the cut, not after ---
// Every slice in this module cuts from the FRONT, so a cut through `name=secret` strips the name the
// scrub matches on. Scrubbing afterwards cannot repair that, which is why it happens first.

test('a secret straddling the summary cut is scrubbed, not decapitated into a bare value', () => {
  const state = accumulator();
  // Sized so the 400-char summary tail begins INSIDE the assignment, past `api_key=`.
  appendChunk(state, `${'x'.repeat(200)} api_key=sk-live-DEADBEEFCAFEBABE${'z'.repeat(376)}`);
  const event = flushAccumulator(state, { now: NOW });
  assert.ok(!event.summary.includes('sk-live-DEADBEEFCAFEBABE'), `leaked: ${event.summary.slice(0, 60)}`);
  assert.ok(!event.detail.text.includes('sk-live-DEADBEEFCAFEBABE'));
});

test('the secret is scrubbed at EVERY offset the cut could land on', () => {
  // The bug only shows at the offsets where the tail begins between the name and the value, so sweep
  // the whole neighbourhood rather than trusting one lucky alignment.
  for (let lead = 340; lead <= 420; lead += 1) {
    const state = accumulator();
    appendChunk(state, `${'x'.repeat(lead)} api_key=sk-live-DEADBEEFCAFEBABE ${'z'.repeat(30)}`);
    const event = flushAccumulator(state, { now: NOW });
    assert.ok(!event.summary.includes('sk-live-DEADBEEFCAFEBABE'), `leaked in summary at lead=${lead}`);
    assert.ok(!event.detail.text.includes('sk-live-DEADBEEFCAFEBABE'), `leaked in detail at lead=${lead}`);
  }
});

test('the truncation note survives the scrub expanding the text it shares a budget with', () => {
  const state = accumulator({ accumulatorBytes: 1024, windowBytes: 100 });
  appendChunk(state, `${'x'.repeat(120)} password=hunter2 ${'y'.repeat(400)}`);
  appendChunk(state, 'b'.repeat(5000));
  const event = flushAccumulator(state, { now: NOW });
  assert.ok(event.summary.endsWith(`[${TRUNCATION_NOTE}]`), `note lost: ${event.summary.slice(-40)}`);
  assert.ok(event.summary.length <= 400, `summary is ${event.summary.length} chars`);
  assert.ok(!event.summary.includes('hunter2'));
});

test('the accumulator cap cuts on a line boundary, so a secret line is dropped whole or kept whole', () => {
  const state = accumulator({ accumulatorBytes: 200 });
  // The byte-exact cut lands inside the assignment; only a line-aligned cut can keep the name with it.
  appendChunk(state, `${'x'.repeat(180)}\napi_key=sk-live-DEADBEEFCAFEBABE\n${'z'.repeat(150)}\n`);
  assert.ok(state.pendingBytes <= 200);
  assert.equal(state.pending.startsWith('sk-live-'), false, 'the cut must not orphan a bare value');
  const event = flushAccumulator(state, { now: NOW });
  assert.ok(!event.summary.includes('sk-live-DEADBEEFCAFEBABE'));
  assert.ok(!event.detail.text.includes('sk-live-DEADBEEFCAFEBABE'));
});

test('a window with no line break at all keeps its bytes rather than emptying itself', () => {
  const state = accumulator({ accumulatorBytes: 64 });
  appendChunk(state, 'q'.repeat(500));
  assert.ok(state.pendingBytes > 0, 'one enormous line must still report something');
  assert.ok(state.pendingBytes <= 64);
  assert.ok(flushAccumulator(state, { now: NOW }).summary.length > 0);
});
