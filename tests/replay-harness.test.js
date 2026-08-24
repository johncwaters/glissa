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

test('codex fixture (approval turn): the recorded sequence replays through the codex adapter', async () => {
  // Cut from a real recording made by test/probe-codex-session.js against codex-cli 0.147.0: the boot
  // spinner, one prompt, the PermissionRequest, the blinking Action Required title, and Stop.
  const { version, agent, records } = load('v2-codex-approval-turn.jsonl');
  assert.equal(version, 2);
  assert.equal(agent, 'codex');
  // The recording was made in a directory named `project`, which is what its idle title carries.
  const { signals } = await replayDetection(records, { ...FAST, agent, titleContext: { cwdBasename: 'project' } });
  const order = signals.map((s) => s.signal);
  assert.ok(order.includes('resume'), 'UserPromptSubmit opens the work cycle');
  const awaitingAt = order.indexOf('awaiting-input');
  const readyAt = order.lastIndexOf('ready');
  assert.ok(awaitingAt >= 0, 'the approval must reach the card');
  assert.ok(readyAt > awaitingAt, 'the turn completes only AFTER the approval, never before');
  assert.equal(signals[awaitingAt].source, 'hook', 'PermissionRequest wins the race against the title');
});

test('the same codex recording read with the Claude title glyphs loses the title tier, which is why replay is adapter-aware', async () => {
  const { records } = load('v2-codex-approval-turn.jsonl');
  // Hooks are dropped so the comparison is the TITLE tier alone; with them in, the authoritative
  // signal arrives first and both readings look the same.
  const titlesOnly = records.filter((r) => r.type === 'data');
  const titleContext = { cwdBasename: 'project' };
  const asCodex = await replayDetection(titlesOnly, { ...FAST, agent: 'codex', titleContext });
  const asClaude = await replayDetection(titlesOnly, { ...FAST, agent: 'claude-code', titleContext });
  const kinds = (r) => new Set(r.signals.map((s) => s.signal));
  // Codex's idle title is the bare cwd basename and its awaiting-input title leads with '[', both of
  // which the Claude profile drops as shell-written window titles: read with the wrong vocabulary the
  // card sits WORKING through the approval and past the end of the turn.
  assert.deepEqual([...kinds(asCodex)].sort(), ['awaiting-input', 'ready', 'working']);
  assert.deepEqual([...kinds(asClaude)], ['working']);
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
