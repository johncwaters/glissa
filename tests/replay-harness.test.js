'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseRecording, replayDetection, summarize } = require('../detection/replay');
const { createOscTitleSource } = require('../detection/osc-title-source');

const FIX = path.join(__dirname, 'fixtures');
const FAST = { stabilizationMs: 40, conflictWindowMs: 20, dedupWindowMs: 10 };

function load(file) {
  return parseRecording(fs.readFileSync(path.join(FIX, file), 'utf8'));
}

test('v2 fixture (complete via Stop): emits working + ready, never awaiting-input', async () => {
  const { version, records } = load('v2-complete-stop.jsonl');
  assert.equal(version, 2);
  const { signals } = await replayDetection(records, FAST);
  const c = summarize(signals);
  assert.ok(c.working >= 1, 'expected working');
  assert.ok(c.ready >= 1, 'expected ready');
  assert.equal(c['awaiting-input'] || 0, 0, 'no false WAITING');
});

test('v2 fixture (waiting via permission Notification): emits working + awaiting-input, never ready', async () => {
  const { records } = load('v2-waiting-permission.jsonl');
  const { signals } = await replayDetection(records, FAST);
  const c = summarize(signals);
  assert.ok(c.working >= 1, 'expected working');
  assert.ok(c['awaiting-input'] >= 1, 'expected awaiting-input');
  assert.equal(c.ready || 0, 0, 'no false COMPLETE');
});

test('v2 fixture (conflict Stop+permission): awaiting-input dominates, no ready', async () => {
  const { records } = load('v2-conflict-stop-then-notify.jsonl');
  const { signals } = await replayDetection(records, FAST);
  const c = summarize(signals);
  assert.ok(c['awaiting-input'] >= 1, 'expected awaiting-input');
  assert.equal(c.ready || 0, 0, 'ready must be suppressed by conflict rule');
});

test('real v1 recordings replay cleanly and never emit awaiting-input (title honest contract)', async () => {
  const v1files = fs.readdirSync(FIX).filter((f) => f.startsWith('v1-') && f.endsWith('.jsonl'));
  assert.ok(v1files.length >= 1, 'expected at least one v1 fixture');
  for (const f of v1files) {
    const { version, records } = load(f);
    assert.equal(version, 1, `${f} should be v1`);
    const { signals } = await replayDetection(records, FAST);
    const c = summarize(signals);
    assert.equal(c['awaiting-input'] || 0, 0, `${f}: title source must never emit awaiting-input`);
    // (no assertion on ready: real recordings may or may not contain a clean
    //  spinner->idle sequence; the contract under test is "no false WAITING".)
  }
});

test('perf: title source processes a large output stream cheaply (hot-path budget)', () => {
  // Build ~1 MB of mixed PTY output with occasional OSC-0 titles.
  const chunkPlain = `${'x'.repeat(900)}\r\n`;
  const spin = '\x1b]0;⠂ Claude Code\x07';
  const idle = '\x1b]0;✳ Claude Code\x07';
  const chunks = [];
  for (let i = 0; i < 1000; i++) {
    chunks.push(i % 50 === 0 ? spin + chunkPlain : i % 50 === 25 ? idle + chunkPlain : chunkPlain);
  }
  const totalBytes = chunks.reduce((n, c) => n + c.length, 0);
  const src = createOscTitleSource({ stabilizationMs: 5 });
  const start = process.hrtime.bigint();
  for (const c of chunks) src.feed(c);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  src.destroy();
  // ~1 MB of PTY output should parse in well under 100 ms (no tokenizer/assembler).
  assert.ok(elapsedMs < 100, `title-source feed too slow: ${elapsedMs.toFixed(1)}ms for ${totalBytes} bytes`);
});
