import test from 'node:test';
import assert from 'node:assert/strict';

import { createStatusSource } from '../detection/status-source.ts';
import type { MetaStatusSignal, ResolvedStatusSignal } from '../detection/status-source.ts';

function collect(src: ReturnType<typeof createStatusSource>): ResolvedStatusSignal[] {
  const out: ResolvedStatusSignal[] = [];
  src.on('status', (s) => out.push(s));
  return out;
}

test('working/resume/awaiting-input emit immediately', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1' });
  const out = collect(src);
  src.ingest({ signal: 'working', source: 'title' });
  src.ingest({ signal: 'awaiting-input', source: 'hook' });
  src.ingest({ signal: 'resume', source: 'hook' });
  assert.deepEqual(out.map((s) => s.signal), ['working', 'awaiting-input', 'resume']);
  src.destroy();
});

test('ready is held for the conflict window then emitted', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 60 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'hook' });
  t.mock.timers.tick(20);
  assert.equal(out.length, 0, 'ready not emitted yet (held)');
  t.mock.timers.tick(70);
  assert.equal(out.length, 1);
  assert.equal(out[0].signal, 'ready');
  assert.equal(out[0].confidence, 'high');
  src.destroy();
});

test('awaiting-input during conflict window cancels a pending ready (no spurious COMPLETE)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 80 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'hook' });
  t.mock.timers.tick(20);
  src.ingest({ signal: 'awaiting-input', source: 'hook' });
  t.mock.timers.tick(120);
  assert.deepEqual(out.map((s) => s.signal), ['awaiting-input'], 'ready must be suppressed');
  src.destroy();
});

test('double ready (Stop double-fire) collapses to a single emission', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 50 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'hook' });
  src.ingest({ signal: 'ready', source: 'hook' });
  t.mock.timers.tick(90);
  assert.equal(out.filter((s) => s.signal === 'ready').length, 1);
  src.destroy();
});

test('dedup collapses rapid duplicate resolved signals', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1', dedupWindowMs: 100 });
  const out = collect(src);
  src.ingest({ signal: 'working', source: 'title' });
  src.ingest({ signal: 'working', source: 'title' });
  assert.equal(out.filter((s) => s.signal === 'working').length, 1);
  src.destroy();
});

test('a high-confidence duplicate supersedes a recent low-confidence signal', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1', dedupWindowMs: 500 });
  const out = collect(src);
  src.ingest({ signal: 'awaiting-input', source: 'title', ts: 0 });
  src.ingest({ signal: 'awaiting-input', source: 'hook', ts: 20 });
  assert.deepEqual(out.map(({ source, confidence, ts }) => ({ source, confidence, ts })), [
    { source: 'title', confidence: 'low', ts: 0 },
    { source: 'hook', confidence: 'high', ts: 20 },
  ]);
  src.destroy();
});

test('a lower-confidence duplicate cannot supersede an authoritative signal', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1', dedupWindowMs: 500 });
  const out = collect(src);
  src.ingest({ signal: 'awaiting-input', source: 'hook', ts: 100 });
  src.ingest({ signal: 'awaiting-input', source: 'title', ts: 120 });
  assert.deepEqual(out.map((status) => status.source), ['hook']);
  src.destroy();
});

test('title ready and hook ready collapse (precedence/dedup)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 40, dedupWindowMs: 200 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'hook' });
  t.mock.timers.tick(60);
  src.ingest({ signal: 'ready', source: 'title' });
  t.mock.timers.tick(60);
  assert.equal(out.filter((s) => s.signal === 'ready').length, 1, 'second ready deduped');
  src.destroy();
});

test('unknown is forwarded as meta, never as a status transition', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1' });
  const status = collect(src);
  const meta: MetaStatusSignal[] = [];
  src.on('meta', (m) => meta.push(m));
  src.ingest({ signal: 'unknown', source: 'title' });
  assert.equal(status.length, 0);
  assert.equal(meta.length, 1);
  assert.equal(meta[0].signal, 'unknown');
  src.destroy();
});

test('working during the conflict window cancels a pending ready (fast re-prompt)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 80 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'hook' });
  t.mock.timers.tick(20);
  src.ingest({ signal: 'working', source: 'title' });
  t.mock.timers.tick(120);
  assert.deepEqual(out.map((s) => s.signal), ['working'], 'stale ready must not resolve');
  src.destroy();
});

test('resume during the conflict window cancels a pending ready (user re-prompted)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 80 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'hook' });
  t.mock.timers.tick(20);
  src.ingest({ signal: 'resume', source: 'hook' });
  t.mock.timers.tick(120);
  assert.deepEqual(out.map((s) => s.signal), ['resume'], 'stale ready must not resolve');
  src.destroy();
});

test('an explicit confidence override rides through to the resolved signal', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 30 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'hook', confidence: 'low' });
  t.mock.timers.tick(60);
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 'low', 'hook default must not overwrite the override');
  src.destroy();
});

test('a high-confidence duplicate upgrades a held low-confidence ready', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 60 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'title', ts: 0 });
  t.mock.timers.tick(10);
  src.ingest({ signal: 'ready', source: 'hook', ts: 10 });
  t.mock.timers.tick(90);
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 'high');
  assert.equal(out[0].source, 'hook');
  assert.equal(out[0].ts, 10);
  src.destroy();
});

test('a held ready retains its originating timestamp', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 60 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'hook', ts: 42 });
  t.mock.timers.tick(90);
  assert.equal(out[0].ts, 42);
  src.destroy();
});

test('destroy stops further emissions', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 30 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'hook' });
  src.destroy();
  t.mock.timers.tick(60);
  assert.equal(out.length, 0);
});
