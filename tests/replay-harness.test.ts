import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseRecording, replayDetection, summarize } from '../detection/replay.ts';
import { createOscTitleSource } from '../detection/osc-title-source.ts';

const FIX = path.join(import.meta.dirname, 'fixtures');
const FAST = { stabilizationMs: 40, conflictWindowMs: 20, dedupWindowMs: 10 };

function load(file: string) {
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
  const { version, agent, records } = load('v2-codex-approval-turn.jsonl');
  assert.equal(version, 2);
  assert.equal(agent, 'codex');

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

  const titlesOnly = records.filter((r) => r.type === 'data');
  const titleContext = { cwdBasename: 'project' };
  const asCodex = await replayDetection(titlesOnly, { ...FAST, agent: 'codex', titleContext });
  const asClaude = await replayDetection(titlesOnly, { ...FAST, agent: 'claude-code', titleContext });
  const kinds = (r: Awaited<ReturnType<typeof replayDetection>>) => new Set(r.signals.map((s) => s.signal));

  assert.deepEqual([...kinds(asCodex)].sort(), ['awaiting-input', 'ready', 'working']);
  assert.deepEqual([...kinds(asClaude)], ['working']);
});

test('grok fixture replays the live approval race from title WAITING to hook COMPLETE', async () => {
  const { version, agent, records } = load('v2-grok-approval-turn.jsonl');
  assert.equal(version, 2);
  assert.equal(agent, 'grok');
  const { signals } = await replayDetection(records, { ...FAST, agent });
  const order = signals.map((signal) => signal.signal);
  assert.ok(order.includes('resume'), 'UserPromptSubmit opens the work cycle');
  const awaitingAt = order.indexOf('awaiting-input');
  const readyAt = order.lastIndexOf('ready');
  assert.ok(awaitingAt >= 0, 'the approval reaches the card');
  assert.ok(readyAt > awaitingAt, 'Stop(end_turn) completes after approval');
  assert.equal(signals[awaitingAt].source, 'title');
  const authoritativeAwaiting = signals.find((signal, index) =>
    index > awaitingAt && signal.signal === 'awaiting-input' && signal.source === 'hook');
  assert.ok(authoritativeAwaiting, 'the hook supersedes the duplicate title signal');
  assert.equal(authoritativeAwaiting.confidence, 'high');
  assert.equal(signals[readyAt].source, 'hook');
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
  }
});

test('perf: title source processes a large output stream cheaply (hot-path budget)', () => {
  const chunkPlain = `${'x'.repeat(900)}\r\n`;
  const spin = '\x1b]0;⠂ Claude Code\x07';
  const idle = '\x1b]0;✳ Claude Code\x07';
  const chunks: string[] = [];
  for (let i = 0; i < 1000; i++) {
    chunks.push(i % 50 === 0 ? spin + chunkPlain : i % 50 === 25 ? idle + chunkPlain : chunkPlain);
  }
  const totalBytes = chunks.reduce((n, c) => n + c.length, 0);
  const src = createOscTitleSource({ stabilizationMs: 5 });
  const start = process.hrtime.bigint();
  for (const c of chunks) src.feed(c);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  src.destroy();

  assert.ok(elapsedMs < 100, `title-source feed too slow: ${elapsedMs.toFixed(1)}ms for ${totalBytes} bytes`);
});
